/**
 * Approved mail.send re-invoke (approvalId) is pinned to exactly what was
 * approved: every recipient field (to / recipient / email / body.email /
 * conversation.email / cc / bcc), subject, body and every other mail arg.
 * Any difference → 409 approved_send_content_mismatch (fail-closed, audited).
 * Approvals without a pin (created before this change) → 409
 * approved_send_pin_missing (fail-closed: ask for a new approval).
 * Demo mode, dummy addresses, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { getApprovalById, listAuditEvents, resolveApproval } from "@/lib/data";
import { updateApprovalMetadata } from "@/lib/data/approvals";
import { resetDemoMailPolicy, setOrgMailPolicy } from "@/lib/data/mail-policy";
import { normalizeMailPolicy } from "@/lib/mail-policy/validate";
import type { GatewayInvokeRequest, MailPolicyRule } from "@/lib/types";

async function setPolicy(rules: Partial<MailPolicyRule>[]) {
  await setOrgMailPolicy(
    DEMO_ORG.id,
    normalizeMailPolicy({
      policyId: "mpp_pin",
      policyName: "Pin",
      rules: rules.map((r, i) => ({ id: `mpr_pin_${i}`, sendMode: "draft_only", ...r })),
    })
  );
}

afterEach(() => {
  resetDemoMailPolicy();
});

const jid = (s: string) => `job_pin_${s}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

const invokeSales = (body: GatewayInvokeRequest) =>
  runGatewayInvoke({ employeeId: "emp_sales", credentialId: "cred_sales", body });

const BASE_ARGS = {
  assetRef: "kb/public-faq",
  to: "buyer@customer.example",
  cc: ["cc1@customer.example", "cc2@customer.example"],
  bcc: ["audit@customer.example"],
  subject: "お見積りのご案内",
  body: "いつもお世話になっております。お見積りをお送りします。",
};

async function approveMail(
  args: Record<string, unknown> = BASE_ARGS,
  extra: Partial<GatewayInvokeRequest> = {}
) {
  await setPolicy([{ audience: "any", sendMode: "needs_approval" }]);
  const body: GatewayInvokeRequest = {
    tool: "mail.send",
    purpose: "sales.outreach",
    jobId: jid("approve"),
    args: { ...args },
    ...extra,
  };
  const queued = await invokeSales(body);
  expect(queued.httpStatus).toBe(402);
  const approvalId = String(queued.body.approvalId);
  const approved = await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id);
  expect(approved?.status).toBe("approved");
  return { body, approvalId };
}

async function auditFor(approvalId: string, code: string) {
  const events = await listAuditEvents(DEMO_ORG.id, 500);
  return events.find((e) => e.metadata?.approvalId === approvalId && e.metadata?.code === code);
}

async function expectMismatch(
  r: Awaited<ReturnType<typeof invokeSales>>,
  approvalId: string,
  fields: string[]
) {
  expect(r.httpStatus).toBe(409);
  expect(r.body.ok).toBe(false);
  expect(r.body.code).toBe("approved_send_content_mismatch");
  expect(r.body.mismatchedFields).toEqual(fields);
  const audit = await auditFor(approvalId, "approved_send_content_mismatch");
  expect(audit).toBeTruthy();
  expect(audit?.metadata?.mismatchedFields).toEqual(fields);
  expect(audit?.metadata?.phase).toBe("reinvoke");
}

describe("approved mail.send re-invoke: content pinned to the approval", () => {
  test("control: identical request → 200 sent", async () => {
    const { body, approvalId } = await approveMail();
    const r = await invokeSales({ ...body, approvalId });
    expect(r.httpStatus).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  test("control: same content with object keys in a different order → 200", async () => {
    const { body, approvalId } = await approveMail({ ...BASE_ARGS, attachments: [{ name: "q.pdf", size: 10 }] });
    const reordered = { body: BASE_ARGS.body, subject: BASE_ARGS.subject, bcc: BASE_ARGS.bcc, cc: BASE_ARGS.cc, to: BASE_ARGS.to, assetRef: BASE_ARGS.assetRef, attachments: [{ size: 10, name: "q.pdf" }] };
    const r = await invokeSales({ ...body, args: reordered, approvalId });
    expect(r.httpStatus).toBe(200);
  });

  test("changed to → 409 (before: 200 sent to the new address)", async () => {
    const { body, approvalId } = await approveMail();
    const r = await invokeSales({ ...body, args: { ...body.args, to: "other@customer.example" }, approvalId });
    await expectMismatch(r, approvalId, ["args.to"]);
  });

  test("bcc added to an approval that had none → 409 even though the policy allows the domain", async () => {
    const { body, approvalId } = await approveMail({ ...BASE_ARGS, bcc: undefined });
    const r = await invokeSales({ ...body, args: { ...body.args, bcc: ["hidden@customer.example"] }, approvalId });
    await expectMismatch(r, approvalId, ["args.bcc"]);
  });

  test("cc changed (one address swapped) → 409", async () => {
    const { body, approvalId } = await approveMail();
    const r = await invokeSales({ ...body, args: { ...body.args, cc: ["cc1@customer.example", "cc3@customer.example"] }, approvalId });
    await expectMismatch(r, approvalId, ["args.cc"]);
  });

  test("approved cc omitted on re-invoke → 409", async () => {
    const { body, approvalId } = await approveMail();
    const { cc: _cc, ...rest } = body.args as Record<string, unknown>;
    const r = await invokeSales({ ...body, args: rest, approvalId });
    await expectMismatch(r, approvalId, ["args.cc"]);
  });

  test("recipient / email fields added → 409", async () => {
    const { body, approvalId } = await approveMail();
    const r = await invokeSales({ ...body, args: { ...body.args, recipient: "x@customer.example", email: "y@customer.example" }, approvalId });
    await expectMismatch(r, approvalId, ["args.email", "args.recipient"]);
  });

  test("top-level email / conversation.email added → 409", async () => {
    const { body, approvalId } = await approveMail();
    const r = await invokeSales({
      ...body,
      email: "top@customer.example",
      conversation: { surface: "mail", orgId: DEMO_ORG.id, email: "conv@customer.example" },
      approvalId,
    });
    await expectMismatch(r, approvalId, ["conversation.email", "email"]);
  });

  test("subject changed → 409", async () => {
    const { body, approvalId } = await approveMail();
    const r = await invokeSales({ ...body, args: { ...body.args, subject: "【至急】お見積り" }, approvalId });
    await expectMismatch(r, approvalId, ["args.subject"]);
  });

  test("body changed by one character → 409", async () => {
    const { body, approvalId } = await approveMail();
    const r = await invokeSales({ ...body, args: { ...body.args, body: `${BASE_ARGS.body}！` }, approvalId });
    await expectMismatch(r, approvalId, ["args.body"]);
  });

  test("same text moved from body to text → 409 (no field substitution)", async () => {
    const { body, approvalId } = await approveMail();
    const { body: text, ...rest } = body.args as Record<string, unknown>;
    const r = await invokeSales({ ...body, args: { ...rest, text }, approvalId });
    await expectMismatch(r, approvalId, ["args.body", "args.text"]);
  });

  test("other mail args (from / replyTo / attachments) are pinned too", async () => {
    const { body, approvalId } = await approveMail();
    const r = await invokeSales({
      ...body,
      args: { ...body.args, from: "ceo@staffpass.example", replyTo: "x@evil.example", attachments: [{ name: "a.pdf" }] },
      approvalId,
    });
    await expectMismatch(r, approvalId, ["args.attachments", "args.from", "args.replyTo"]);
  });

  test("very long body (beyond the 100k snapshot clip): exact copy → 200, last char changed → 409", async () => {
    const long = `${"あ".repeat(120_000)}END`;
    const { body, approvalId } = await approveMail({ ...BASE_ARGS, body: long });
    const changed = await invokeSales({ ...body, args: { ...body.args, body: `${long.slice(0, -1)}X` }, approvalId });
    await expectMismatch(changed, approvalId, ["args.body"]);
    const same = await invokeSales({ ...body, args: { ...body.args, body: long }, approvalId });
    expect(same.httpStatus).toBe(200);
  });

  test("the error and audit carry field names only, never the addresses or text", async () => {
    const { body, approvalId } = await approveMail();
    const r = await invokeSales({ ...body, args: { ...body.args, to: "leak-check@other.example" }, approvalId });
    expect(r.httpStatus).toBe(409);
    expect(JSON.stringify(r.body)).not.toContain("leak-check@other.example");
    expect(JSON.stringify(r.body)).not.toContain("buyer@customer.example");
    const audit = await auditFor(approvalId, "approved_send_content_mismatch");
    expect(JSON.stringify(audit?.metadata)).not.toContain("leak-check@other.example");
  });

  test("the pin is stored as digests only (no plaintext copy of the mail)", async () => {
    const { approvalId } = await approveMail();
    const stored = await getApprovalById(approvalId, DEMO_ORG.id);
    const pin = stored?.metadata.mailSendPin as { v: number; fields: Record<string, string> };
    expect(pin?.v).toBe(1);
    expect(Object.keys(pin.fields).sort()).toEqual(["args.assetRef", "args.bcc", "args.body", "args.cc", "args.subject", "args.to"]);
    for (const digest of Object.values(pin.fields)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(pin)).not.toContain("customer.example");
  });

  test("documented: re-invoke without any mail content executes the approved mail as-is → 200", async () => {
    const { body, approvalId } = await approveMail();
    const r = await invokeSales({ tool: "mail.send", purpose: body.purpose, jobId: body.jobId, approvalId });
    expect(r.httpStatus).toBe(200);
    const empty = await invokeSales({ tool: "mail.send", purpose: body.purpose, jobId: body.jobId, args: {}, approvalId });
    expect(empty.httpStatus).toBe(200);
  });

  test("partial content (only some fields resent) → 409", async () => {
    const { body, approvalId } = await approveMail();
    const r = await invokeSales({ tool: "mail.send", purpose: body.purpose, jobId: body.jobId, args: { assetRef: BASE_ARGS.assetRef, to: BASE_ARGS.to }, approvalId });
    await expectMismatch(r, approvalId, ["args.bcc", "args.body", "args.cc", "args.subject"]);
  });

  test("pin check runs before sending even when the mail policy would allow everything", async () => {
    const { body, approvalId } = await approveMail();
    await setPolicy([{ audience: "any", sendMode: "needs_approval" }]);
    const r = await invokeSales({ ...body, args: { ...body.args, to: "buyer2@customer.example" }, approvalId });
    expect(r.body.code).toBe("approved_send_content_mismatch");
  });
});

describe("approvals created before this change (no pin) fail closed", () => {
  test("identical request but no pin on the approval → 409 approved_send_pin_missing (before: 200)", async () => {
    const { body, approvalId } = await approveMail();
    const stored = await getApprovalById(approvalId, DEMO_ORG.id);
    await updateApprovalMetadata(stored!, { mailSendPin: null });
    const r = await invokeSales({ ...body, approvalId });
    expect(r.httpStatus).toBe(409);
    expect(r.body.code).toBe("approved_send_pin_missing");
    const audit = await auditFor(approvalId, "approved_send_pin_missing");
    expect(audit?.metadata?.phase).toBe("reinvoke");
  });

  test("no pin + re-invoke without args → 409 as well", async () => {
    const { body, approvalId } = await approveMail();
    const stored = await getApprovalById(approvalId, DEMO_ORG.id);
    await updateApprovalMetadata(stored!, { mailSendPin: null });
    const r = await invokeSales({ tool: "mail.send", purpose: body.purpose, jobId: body.jobId, approvalId });
    expect(r.httpStatus).toBe(409);
    expect(r.body.code).toBe("approved_send_pin_missing");
  });

  test("an unreadable / unknown-version pin is treated as missing", async () => {
    const { body, approvalId } = await approveMail();
    const stored = await getApprovalById(approvalId, DEMO_ORG.id);
    await updateApprovalMetadata(stored!, { mailSendPin: { v: 2, fields: {} } });
    const r = await invokeSales({ ...body, approvalId });
    expect(r.body.code).toBe("approved_send_pin_missing");
  });
});

describe("other tools are unaffected", () => {
  test("calendar.confirm re-invoke with approvalId and no args still completes", async () => {
    const jobId = jid("cal");
    const body: GatewayInvokeRequest = { tool: "calendar.confirm", purpose: "sales.outreach", jobId, args: { datetime: "2026-10-10T10:00:00+09:00" } };
    const queued = await invokeSales(body);
    expect(queued.httpStatus).toBe(402);
    const approvalId = String(queued.body.approvalId);
    await resolveApproval(approvalId, "approved", "ando@example.com", DEMO_ORG.id);
    const r = await invokeSales({ tool: "calendar.confirm", purpose: body.purpose, jobId, approvalId });
    expect(r.httpStatus).toBe(200);
  });
});
