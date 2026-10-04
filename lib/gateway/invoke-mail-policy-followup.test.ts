/**
 * Follow-up hardening at the Gateway invoke / fulfill boundary (after #223 / #227).
 * - item 1 (invoke wiring): every primary recipient field reaches the policy.
 * - item 3: approved items are re-checked right before execution (fulfill and
 *   approved re-invoke). A now-denied / rejected / demoted send is stopped,
 *   audited, and returns a clear error.
 * - item 4: per-tool `deny` rejects immediately for every outbound-send tool,
 *   and `deny` survives normalizeToolApprovalDefaults (it used to be dropped).
 * Demo mode, dummy recipients, Slack fetch mocked, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import {
  fulfillApprovedInvoke,
  parseFulfillment,
  parseInvokeSnapshot,
} from "@/lib/approvals/fulfill";
import { getApprovalById, listAuditEvents, resolveApproval } from "@/lib/data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { resetDemoMailPolicy, setOrgMailPolicy } from "@/lib/data/mail-policy";
import { normalizeMailPolicy } from "@/lib/mail-policy/validate";
import { normalizeToolApprovalDefaults } from "@/lib/employees/approval-presets";
import { mapEmployeeRow } from "@/lib/data/mappers";
import {
  GATEWAY_TOOL_DEFS,
  NON_OUTBOUND_TOOL_REASONS,
  OUTBOUND_SEND_TOOL_IDS,
  isOutboundSendTool,
  listGatewayToolIds,
  toolRequiresHumanApproval,
} from "@/lib/gateway/tools";
import type { Employee, GatewayInvokeRequest, MailPolicyRule } from "@/lib/types";

const CONSENT = { highRiskConsentAt: "2026-10-01T00:00:00Z", highRiskConsentBy: "admin@dummy.example" };

async function setPolicy(rules: Partial<MailPolicyRule>[], consent = false) {
  await setOrgMailPolicy(
    DEMO_ORG.id,
    normalizeMailPolicy({
      policyId: "mpp_followup_invoke",
      policyName: "Followup invoke",
      rules: rules.map((r, i) => ({ id: `mpr_${i}`, sendMode: "draft_only", ...r })),
      ...(consent ? CONSENT : {}),
    })
  );
}

type Patch = Partial<Pick<Employee, "approvalPolicy" | "toolApprovalDefaults" | "actionLimits" | "scopes">>;
const restorers: Array<() => void> = [];

function patchEmployee(id: string, patch: Patch) {
  const emp = getRuntimeEmployees().find((item) => item.id === id);
  expect(emp).toBeTruthy();
  const previous: Patch = {
    approvalPolicy: emp!.approvalPolicy,
    toolApprovalDefaults: emp!.toolApprovalDefaults,
    actionLimits: emp!.actionLimits,
    scopes: emp!.scopes,
  };
  Object.assign(emp!, patch);
  restorers.push(() => Object.assign(emp!, previous));
}

const originalFetch = globalThis.fetch;
afterEach(async () => {
  while (restorers.length) restorers.pop()!();
  resetDemoMailPolicy();
  globalThis.fetch = originalFetch;
  await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

const jid = (s: string) => `job_followup_${s}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

function mailBody(args: Record<string, unknown>, jobId = jid("mail"), extra: Partial<GatewayInvokeRequest> = {}): GatewayInvokeRequest {
  return {
    tool: "mail.send",
    purpose: "sales.outreach",
    jobId,
    args: { assetRef: "kb/public-faq", subject: "フォロー", body: "ご確認ください。", ...args },
    ...extra,
  };
}

const invokeSales = (body: GatewayInvokeRequest) =>
  runGatewayInvoke({ employeeId: "emp_sales", credentialId: "cred_sales", body });

function mockSlack() {
  let count = 0;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  globalThis.fetch = (async (input) => {
    if (String(input).includes("chat.postMessage")) {
      count += 1;
      return Response.json({ ok: true, channel: "C_INTERNAL", ts: "1787911800.000099" });
    }
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
  return { count: () => count };
}

const RISK_BASED = { approvalPolicy: "risk_based" as const, actionLimits: undefined };

/** Bodies that reach the approval gate for every outbound-send tool (dummy values). */
const OUTBOUND_CASES: Array<{ tool: string; employeeId: string; credentialId: string; body: GatewayInvokeRequest; scopes?: string[] }> = [
  { tool: "mail.send", employeeId: "emp_sales", credentialId: "cred_sales", body: mailBody({ to: "buyer@customer.example" }) },
  ...(["slack.post", "slack.post_external", "comm.reply", "comm.send"] as const).map((tool) => ({
    tool,
    employeeId: "emp_comm",
    credentialId: "cred_comm",
    body: {
      tool,
      purpose: "comm.internal",
      jobId: jid(tool),
      conversation: { surface: "slack" as const, orgId: DEMO_ORG.id, slackChannelId: "C_INTERNAL", threadId: "1787911797.502889" },
      informationClass: "confidential" as const,
      args: { slackChannelId: "C_INTERNAL", text: "社内連絡です。", threadId: "1787911797.502889" },
    },
  })),
  {
    tool: "sns.publish",
    employeeId: "emp_sns",
    credentialId: "cred_sns",
    body: { tool: "sns.publish", purpose: "sns.publish", jobId: jid("sns"), args: { surface: "x", text: "告知の下書きです。" } },
  },
  {
    tool: "drive.share_external",
    employeeId: "emp_sales",
    credentialId: "cred_sales",
    scopes: ["tools:read", "tools:invoke", "drive:share_external", "files:write", "mail:send", "slack:post"],
    body: { tool: "drive.share_external", purpose: "sales.outreach", jobId: jid("drive"), args: { fileId: "file_dummy" } },
  },
];

describe("item 4: registry classification of outbound-send tools", () => {
  test("every registry tool is classified exactly once (covered or not-covered with a reason)", () => {
    const covered = new Set<string>(OUTBOUND_SEND_TOOL_IDS);
    const notCovered = new Set(Object.keys(NON_OUTBOUND_TOOL_REASONS));
    for (const id of listGatewayToolIds()) {
      expect(covered.has(id) !== notCovered.has(id)).toBe(true);
    }
    expect(covered.size + notCovered.size).toBe(Object.keys(GATEWAY_TOOL_DEFS).length);
    for (const reason of Object.values(NON_OUTBOUND_TOOL_REASONS)) expect(reason.length).toBeGreaterThan(3);
  });

  test("covered list is exactly the send / post / share tools", () => {
    expect([...OUTBOUND_SEND_TOOL_IDS].sort()).toEqual(
      ["agentmail.send", "comm.reply", "comm.send", "drive.share_external", "mail.send", "slack.post", "slack.post_external", "sns.publish"]
    );
    // aliases resolve to the same decision
    expect(isOutboundSendTool("mail.draft")).toBe(false);
    expect(isOutboundSendTool("calendar.confirm")).toBe(false);
  });
});

describe("item 4: deny survives normalization (before: silently became always_human)", () => {
  test("differential: for every registry tool, a stored deny is never looser than what main produced", () => {
    // main dropped deny → the strict default (always_human for choosable tools, no hint otherwise).
    const mainNormalize = (raw: Record<string, unknown>) => {
      const out = normalizeToolApprovalDefaults({});
      for (const [k, v] of Object.entries(raw)) if (v !== "deny" && k in out && (v === "auto" || v === "risk_based" || v === "always_human")) out[k] = v;
      return out;
    };
    for (const id of listGatewayToolIds()) {
      const def = GATEWAY_TOOL_DEFS[id];
      const before = mainNormalize({ [id]: "deny" });
      const after = normalizeToolApprovalDefaults({ [id]: "deny" });
      // approval requirement is identical or stricter …
      if (toolRequiresHumanApproval(def, before)) expect(toolRequiresHumanApproval(def, after)).toBe(true);
      // … and an outbound-send tool now carries the deny that rejects immediately.
      if (isOutboundSendTool(id)) expect(after[id]).toBe("deny");
      // a non-outbound tool keeps deny only if it is choosable (forced approval, as before)
      else if (after[id] === "deny") expect(id in before).toBe(true);
    }
  });

  test("normalizeToolApprovalDefaults keeps deny for choosable and outbound tools (plus always_human for audience-gated)", () => {
    const n = normalizeToolApprovalDefaults({
      "mail.send": "deny",
      "calendar.confirm": "deny",
      "slack.post": "deny",
      "comm.reply": "deny",
      "agentmail.send": "deny",
      "slack.post_external": "auto",
      "files.read": "deny",
      "comm.send": "always_human",
    });
    expect(n["mail.send"]).toBe("deny");
    expect(n["calendar.confirm"]).toBe("deny");
    expect(n["slack.post"]).toBe("deny");
    expect(n["comm.reply"]).toBe("deny");
    expect(n["agentmail.send"]).toBe("deny");
    expect(n["slack.post_external"]).toBeUndefined(); // only deny is accepted for non-choosable tools
    // since 2026-10-04 (#249) always_human is kept for the audience-gated tools (stricter-only)
    expect(n["comm.send"]).toBe("always_human");
    expect(n["files.read"]).toBeUndefined(); // not choosable / not outbound
    expect(n["sns.publish"]).toBe("always_human"); // strict default kept
  });

  test("DB row mapper keeps a stored deny", () => {
    const emp = mapEmployeeRow({
      id: "emp_x", org_id: DEMO_ORG.id, display_name: "x", status: "active", scopes: [],
      tool_approval_defaults: { "mail.send": "deny", "slack.post": "deny" },
    });
    expect(emp.toolApprovalDefaults?.["mail.send"]).toBe("deny");
    expect(emp.toolApprovalDefaults?.["slack.post"]).toBe("deny");
  });
});

describe("item 4: per-tool deny rejects immediately for every outbound-send tool", () => {
  for (const c of OUTBOUND_CASES) {
    test(`${c.tool}: control without deny reaches the gate; with deny → 403 (no approval card)`, async () => {
      await setPolicy([{ audience: "any", sendMode: "needs_approval" }]);
      patchEmployee(c.employeeId, { ...(c.scopes ? { scopes: c.scopes as Employee["scopes"] } : {}) });
      const control = await runGatewayInvoke({ employeeId: c.employeeId, credentialId: c.credentialId, body: { ...c.body, jobId: jid(`${c.tool}_ctl`) } });
      // Before this change the same request with deny got exactly this (approval / allowed), never 403.
      expect([200, 402]).toContain(control.httpStatus);

      patchEmployee(c.employeeId, { toolApprovalDefaults: { [c.tool]: "deny" } as Employee["toolApprovalDefaults"] });
      const denied = await runGatewayInvoke({ employeeId: c.employeeId, credentialId: c.credentialId, body: { ...c.body, jobId: jid(`${c.tool}_deny`) } });
      expect(denied.httpStatus).toBe(403);
      expect(denied.body.code).toBe(c.tool === "mail.send" ? "mail_send_denied_by_tool_setting" : "tool_denied_by_tool_setting");
      expect(denied.body.needs_approval).toBe(false);
      expect(denied.body.approvalId).toBeUndefined();
    });
  }

  test("agentmail.send stays rejected as reserved (never sent) regardless of deny", async () => {
    patchEmployee("emp_sales", { scopes: ["mail:send", "agentmail:send", "tools:invoke"] as Employee["scopes"], toolApprovalDefaults: { "agentmail.send": "deny" } as Employee["toolApprovalDefaults"] });
    const r = await invokeSales({ tool: "agentmail.send", purpose: "sales.outreach", jobId: jid("am"), args: { to: "buyer@customer.example", subject: "s", body: "b" } });
    expect(r.body.ok).toBe(false);
    expect(r.httpStatus).toBeGreaterThanOrEqual(400);
  });

  test("deny on a non-outbound tool keeps the previous behaviour (approval, not 403)", async () => {
    patchEmployee("emp_sales", { ...RISK_BASED, toolApprovalDefaults: { "calendar.confirm": "deny" } as Employee["toolApprovalDefaults"] });
    const r = await invokeSales({ tool: "calendar.confirm", purpose: "sales.outreach", jobId: jid("cal"), args: { datetime: "2026-10-10T10:00:00+09:00", counterpart: "buyer@customer.example" } });
    expect(r.httpStatus).toBe(402);
  });
});

describe("item 1 at invoke: every primary recipient field reaches the policy", () => {
  test("denied address in `recipient` behind a clean `to` → 403 (before: 200 auto-sent)", async () => {
    patchEmployee("emp_sales", { ...RISK_BASED, toolApprovalDefaults: undefined });
    await setPolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }], true);
    const r = await invokeSales(mailBody({ to: "buyer@customer.example", recipient: "z@blocked.example" }));
    expect(r.httpStatus).toBe(403);
    expect(r.body.code).toBe("mail_domain_denied");
  });

  test("subdomain of a denied domain in body.email → 403 (before: 200 auto-sent)", async () => {
    patchEmployee("emp_sales", { ...RISK_BASED, toolApprovalDefaults: undefined });
    await setPolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }], true);
    const r = await invokeSales(mailBody({ to: "buyer@customer.example" }, jid("bodyemail"), { email: "z@mx.blocked.example" }));
    expect(r.httpStatus).toBe(403);
    expect(r.body.code).toBe("mail_domain_denied");
  });

  test("approval card shows every recipient field", async () => {
    await setPolicy([{ audience: "any", sendMode: "needs_approval" }]);
    const r = await invokeSales(mailBody({ to: "buyer@customer.example", recipient: "second@customer.example" }));
    expect(r.httpStatus).toBe(402);
    const stored = await getApprovalById(String(r.body.approvalId), DEMO_ORG.id);
    expect((stored?.metadata.artifact as Record<string, unknown>).to).toBe("buyer@customer.example, second@customer.example");
  });

  test("control: all-clean multi-field mail under consented auto still auto-sends", async () => {
    patchEmployee("emp_sales", { ...RISK_BASED, toolApprovalDefaults: undefined });
    await setPolicy([{ audience: "any", sendMode: "auto", toDomainDenylist: ["blocked.example"] }], true);
    const r = await invokeSales(mailBody({ to: "buyer@customer.example", recipient: "y@badblocked.example" }));
    expect(r.httpStatus).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

async function approveMail(args: Record<string, unknown>) {
  await setPolicy([{ audience: "any", sendMode: "needs_approval" }]);
  const jobId = jid("approve");
  const body = mailBody(args, jobId);
  const queued = await invokeSales(body);
  expect(queued.httpStatus).toBe(402);
  const approved = await resolveApproval(String(queued.body.approvalId), "approved", "ando@example.com", DEMO_ORG.id);
  expect(approved?.status).toBe("approved");
  return { approved: approved!, body, approvalId: String(queued.body.approvalId) };
}

async function auditFor(approvalId: string, code: string) {
  const events = await listAuditEvents(DEMO_ORG.id, 500);
  return events.find((e) => e.metadata?.approvalId === approvalId && e.metadata?.code === code);
}

describe("item 3: approved items are re-checked right before execution (fulfill)", () => {
  test("mail policy now denies the recipient → stopped, audited, clear error (before: stub-sent ok)", async () => {
    const { approved, approvalId } = await approveMail({ to: "buyer@customer.example" });
    await setPolicy([{ audience: "any", sendMode: "needs_approval", toDomainDenylist: ["customer.example"] }]);
    const f = await fulfillApprovedInvoke(approved);
    expect(f?.ok).toBe(false);
    expect(f?.error).toBe("fulfill_blocked_mail_policy");
    const stored = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(parseFulfillment(stored?.metadata)?.error).toBe("fulfill_blocked_mail_policy");
    const audit = await auditFor(approvalId, "fulfill_blocked_mail_policy");
    expect(audit?.metadata?.reason).toBe("mail_domain_denied");
    expect(audit?.metadata?.phase).toBe("approval.fulfill");
  });

  test("mail policy reverted to the default (external draft_only) → stopped as demoted", async () => {
    const { approved, approvalId } = await approveMail({ to: "buyer@customer.example" });
    resetDemoMailPolicy();
    const f = await fulfillApprovedInvoke(approved);
    expect(f?.error).toBe("fulfill_blocked_mail_policy");
    expect((await auditFor(approvalId, "fulfill_blocked_mail_policy"))?.metadata?.reason).toBe("mail_send_demoted_to_draft");
  });

  test("cc is part of the snapshot and re-checked (subdomain deny added after approval)", async () => {
    const { approved, approvalId } = await approveMail({ to: "buyer@customer.example", cc: ["c@eu.partner.example"], attachments: [{ name: "a.pdf" }] });
    const snapshot = parseInvokeSnapshot((await getApprovalById(approvalId, DEMO_ORG.id))?.metadata);
    expect(snapshot?.args.cc).toEqual(["c@eu.partner.example"]);
    expect(snapshot?.args.hasAttachments).toBe(true);
    await setPolicy([{ audience: "any", sendMode: "needs_approval", toDomainDenylist: ["partner.example"] }]);
    const f = await fulfillApprovedInvoke(approved);
    expect(f?.error).toBe("fulfill_blocked_mail_policy");
  });

  test("tool setting changed to deny after approval → stopped (before: stub-sent ok)", async () => {
    const { approved, approvalId } = await approveMail({ to: "buyer@customer.example" });
    patchEmployee("emp_sales", { toolApprovalDefaults: { "mail.send": "deny" } as Employee["toolApprovalDefaults"] });
    const f = await fulfillApprovedInvoke(approved);
    expect(f?.ok).toBe(false);
    expect(f?.error).toBe("fulfill_blocked_tool_denied");
    expect(await auditFor(approvalId, "fulfill_blocked_tool_denied")).toBeTruthy();
  });

  test("a stop is not terminal: once settings allow it again, the approved item can be executed", async () => {
    const { approved } = await approveMail({ to: "buyer@customer.example" });
    patchEmployee("emp_sales", { toolApprovalDefaults: { "mail.send": "deny" } as Employee["toolApprovalDefaults"] });
    expect((await fulfillApprovedInvoke(approved))?.error).toBe("fulfill_blocked_tool_denied");
    while (restorers.length) restorers.pop()!();
    const again = await fulfillApprovedInvoke(approved);
    expect(again?.ok).toBe(true);
    expect(again?.delivery).toBe("stub");
  });

  test("control: unchanged settings → approved mail is executed (stub)", async () => {
    const { approved } = await approveMail({ to: "buyer@customer.example" });
    const f = await fulfillApprovedInvoke(approved);
    expect(f?.ok).toBe(true);
    expect(f?.delivery).toBe("stub");
  });

  test("Slack: comm.reply approved, then deny → no post, stopped (before: posted)", async () => {
    const body: GatewayInvokeRequest = { ...OUTBOUND_CASES[3].body, jobId: jid("comm_fulfill") };
    const queued = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });
    expect(queued.httpStatus).toBe(402);
    await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-followup-test" } });
    const slack = mockSlack();
    const approved = await resolveApproval(String(queued.body.approvalId), "approved", "ando@example.com", DEMO_ORG.id);
    patchEmployee("emp_comm", { toolApprovalDefaults: { "comm.reply": "deny" } as Employee["toolApprovalDefaults"] });
    const f = await fulfillApprovedInvoke(approved!);
    expect(f?.error).toBe("fulfill_blocked_tool_denied");
    expect(slack.count()).toBe(0);
  });

  test("Slack control: comm.reply approved without deny → posted once", async () => {
    const body: GatewayInvokeRequest = { ...OUTBOUND_CASES[3].body, jobId: jid("comm_fulfill_ok") };
    const queued = await runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body });
    await upsertConversationAdapter({ orgId: DEMO_ORG.id, surface: "slack", enabled: true, secrets: { botToken: "xoxb-followup-test" } });
    const slack = mockSlack();
    const approved = await resolveApproval(String(queued.body.approvalId), "approved", "ando@example.com", DEMO_ORG.id);
    const f = await fulfillApprovedInvoke(approved!);
    expect(f?.ok).toBe(true);
    expect(slack.count()).toBe(1);
  });
});

describe("item 3: approved re-invoke (approvalId) is re-checked too", () => {
  test("mail.send re-invoke after the policy started rejecting → 409, not sent (before: 200 sent)", async () => {
    const { body, approvalId } = await approveMail({ to: "buyer@customer.example" });
    await setPolicy([{ audience: "any", sendMode: "needs_approval", toDomainDenylist: ["customer.example"] }]);
    const r = await invokeSales({ ...body, approvalId });
    expect(r.httpStatus).toBe(409);
    expect(r.body.code).toBe("approved_send_blocked_by_policy");
    expect(r.body.blockedReason).toBe("mail_domain_denied");
    expect(await auditFor(approvalId, "approved_send_blocked_by_policy")).toBeTruthy();
  });

  test("mail.send re-invoke after the policy became draft_only → 409 (before: 200 sent)", async () => {
    const { body, approvalId } = await approveMail({ to: "buyer@customer.example" });
    resetDemoMailPolicy();
    const r = await invokeSales({ ...body, approvalId });
    expect(r.httpStatus).toBe(409);
    expect(r.body.blockedReason).toBe("mail_send_demoted_to_draft");
  });

  test("control: re-invoke with unchanged policy still completes", async () => {
    const { body, approvalId } = await approveMail({ to: "buyer@customer.example" });
    await setPolicy([{ audience: "any", sendMode: "needs_approval" }]);
    const r = await invokeSales({ ...body, approvalId });
    expect(r.httpStatus).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

describe("item 3: approved re-invoke judges the approved snapshot and the request", () => {
  test("re-invoke without args still completes when the approved mail is still allowed", async () => {
    const { body, approvalId } = await approveMail({ to: "buyer@customer.example" });
    await setPolicy([{ audience: "any", sendMode: "needs_approval" }]);
    const r = await invokeSales({ tool: "mail.send", purpose: body.purpose, jobId: body.jobId, approvalId });
    expect(r.httpStatus).toBe(200);
  });

  test("re-invoke without args is still stopped when the approved recipient is now denied", async () => {
    const { body, approvalId } = await approveMail({ to: "buyer@customer.example" });
    await setPolicy([{ audience: "any", sendMode: "needs_approval", toDomainDenylist: ["customer.example"] }]);
    const r = await invokeSales({ tool: "mail.send", purpose: body.purpose, jobId: body.jobId, approvalId });
    expect(r.httpStatus).toBe(409);
    expect(r.body.blockedReason).toBe("mail_domain_denied");
  });

  test("re-invoke that adds a denied recipient to the approved mail → 409 (before: 200 sent)", async () => {
    const { body, approvalId } = await approveMail({ to: "buyer@customer.example" });
    await setPolicy([{ audience: "any", sendMode: "needs_approval", toDomainDenylist: ["blocked.example"] }]);
    const r = await invokeSales({ ...body, args: { ...body.args, bcc: ["z@mx.blocked.example"] }, approvalId });
    expect(r.httpStatus).toBe(409);
    // Since the approved-content pin (2026-10-04), any added recipient is
    // rejected as a mismatch before the policy re-check runs.
    expect(r.body.code).toBe("approved_send_content_mismatch");
    expect(r.body.mismatchedFields).toEqual(["args.bcc"]);
  });
});
