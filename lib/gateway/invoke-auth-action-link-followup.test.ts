/**
 * #426 follow-up (M1 / M2 / L1).
 *
 * Fail-first: these cases describe the intended contract and must fail on
 * main@6d5efab8 until the follow-up lands.
 *
 * M1: consume only after provider send succeeds; CAS so only one in-flight send.
 * M2: Slack speakerId missing or unresolved → reject, no approval ticket.
 * L1: approvalId replay uses fulfillMailSend-equivalent (MAIL_SEND_GMAIL_LIVE).
 *
 * SECRET_AUTH_ACTION_LINK_ENABLED stays OFF in production; FLAG OFF behavior
 * must match main. oobCode / apiKey must never appear in DB or logs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_ORG } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { resetDemoMailPolicy, setOrgMailPolicy } from "@/lib/data/mail-policy";
import { normalizeMailPolicy } from "@/lib/mail-policy/validate";
import { getApprovalById, listApprovals, resolveApproval } from "@/lib/data";
import { setOrgInternalAudienceRule, clearDemoRule } from "@/lib/data/internal-audience-rule";
import { bindEmployeeGoogleIdentity, revokeEmployeeGoogleIdentity } from "@/lib/data/google-identities";
import { GOOGLE_SCOPE_GMAIL_SEND } from "@/lib/google/scopes";

const INTERNAL_DOMAIN = "tokyo307inc.com";
const DUMMY_API_KEY = "AIzaSyDummyKeyForTestingPurposesABC12345";
const OOB = "oobCodeForTesting123";
const SPEAKER = "U0AUTHFLW01";
const MAILBOX = "tando@tokyo307inc.com";
const FROM = MAILBOX;
const TO = "user@tokyo307inc.com";
const EMP = "emp_sales";

let savedFlag: string | undefined;
let savedOrgIds: string | undefined;
let savedLive: string | undefined;
let savedKey: string | undefined;
let savedFetch: typeof fetch;

beforeEach(() => {
  savedFlag = process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
  savedOrgIds = process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  savedLive = process.env.MAIL_SEND_GMAIL_LIVE;
  savedKey = process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  savedFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = savedFetch;
  if (savedFlag === undefined) delete process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
  else process.env.SECRET_AUTH_ACTION_LINK_ENABLED = savedFlag;
  if (savedOrgIds === undefined) delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  else process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS = savedOrgIds;
  if (savedLive === undefined) delete process.env.MAIL_SEND_GMAIL_LIVE;
  else process.env.MAIL_SEND_GMAIL_LIVE = savedLive;
  if (savedKey === undefined) delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  else process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = savedKey;
  resetDemoMailPolicy();
  clearDemoRule();
  const { resetDemoVoterBindings } = await import("@/lib/approval-workflow/voter-binding");
  resetDemoVoterBindings();
  await revokeEmployeeGoogleIdentity({ employeeId: EMP, orgId: DEMO_ORG.id }).catch(() => undefined);
});

async function withNeedsApprovalMailPolicy<T>(fn: () => Promise<T>): Promise<T> {
  await setOrgInternalAudienceRule(DEMO_ORG.id, { emailDomains: [INTERNAL_DOMAIN] }, "test");
  await setOrgMailPolicy(
    DEMO_ORG.id,
    normalizeMailPolicy({
      policyId: "mpp_auth_link_followup",
      policyName: "Needs approval for auth link follow-up",
      rules: [
        { id: "mpr_internal", audience: "internal", sendMode: "needs_approval" },
        { id: "mpr_external", audience: "external", sendMode: "needs_approval" },
      ],
    })
  );
  try {
    return await fn();
  } finally {
    resetDemoMailPolicy();
    clearDemoRule();
  }
}

function makeAuthLinkBody(): string {
  return [
    "パスワードを再設定するには、以下のリンクをクリックしてください。",
    `https://oneplace.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=${OOB}&apiKey=${DUMMY_API_KEY}&lang=ja`,
    "このリンクは24時間有効です。",
  ].join("\n");
}

function mailArgs(overrides: Record<string, unknown> = {}) {
  return {
    to: TO,
    from: FROM,
    subject: "パスワード再設定",
    body: makeAuthLinkBody(),
    ...overrides,
  };
}

async function bindSpeaker(memberId = "mem_1") {
  const { createPendingVoterBinding, verifyVoterBinding, resetDemoVoterBindings } = await import(
    "@/lib/approval-workflow/voter-binding"
  );
  resetDemoVoterBindings();
  const input = {
    orgId: DEMO_ORG.id,
    provider: "slack" as const,
    channelKey: "C_AUTH_FLW",
    externalUserId: SPEAKER,
    memberId,
  };
  const created = await createPendingVoterBinding(input);
  if (!created.ok) throw new Error(created.reason);
  const verified = await verifyVoterBinding({ ...input, verificationCode: created.verificationCode });
  if (!verified.ok) throw new Error(verified.reason);
}

function invokeMail(opts: {
  jobSuffix: string;
  approvalId?: string;
  speakerId?: string | null;
  args?: Record<string, unknown>;
  jobId?: string;
}) {
  const jobId = opts.jobId ?? `job_auth_flw_${opts.jobSuffix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const body: Record<string, unknown> = {
    tool: "mail.send",
    purpose: "sales.outreach",
    jobId,
    args: opts.args ?? mailArgs(),
  };
  if (opts.approvalId) body.approvalId = opts.approvalId;
  if (opts.speakerId !== undefined && opts.speakerId !== null) body.speakerId = opts.speakerId;
  return runGatewayInvoke({
    employeeId: EMP,
    credentialId: "cred_sales",
    body: body as Parameters<typeof runGatewayInvoke>[0]["body"],
  });
}

async function createApprovedAuthLink(jobSuffix: string) {
  await bindSpeaker();
  const originalBody = makeAuthLinkBody();
  const args = mailArgs({ body: originalBody });
  const jobId = `job_auth_flw_${jobSuffix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const created = await withNeedsApprovalMailPolicy(() =>
    invokeMail({ jobSuffix, speakerId: SPEAKER, args, jobId })
  );
  expect(created.httpStatus).toBe(402);
  const approvalId = created.body.approvalId as string;
  expect(approvalId).toBeTruthy();
  const approved = await resolveApproval(approvalId, "approved", "owner@tokyo307inc.com", DEMO_ORG.id, {
    memberId: "mem_1",
  });
  expect(approved?.status).toBe("approved");
  return { approvalId, args, jobId };
}

function assertNoSecrets(value: unknown) {
  const json = JSON.stringify(value);
  expect(json).not.toContain(OOB);
  expect(json).not.toContain(DUMMY_API_KEY);
}

function mockGmail(opts: { sendStatus?: number; throwSend?: boolean } = {}) {
  let gmailPosts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });
    }
    if (url.includes("gmail.googleapis.com")) {
      gmailPosts += 1;
      if (opts.throwSend) throw new Error("timeout");
      return new Response(JSON.stringify({ id: `msg_auth_${gmailPosts}`, threadId: "thread_auth" }), {
        status: opts.sendStatus ?? 200,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return {
    get posts() {
      return gmailPosts;
    },
  };
}

async function bindMailbox() {
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-mail-attachment-encryption-key-32b";
  process.env.GOOGLE_OAUTH_CLIENT_ID = "client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret-that-is-long-enough-32ch";
  await bindEmployeeGoogleIdentity({
    employeeId: EMP,
    orgId: DEMO_ORG.id,
    googleSub: "sub-tando",
    googleEmail: MAILBOX,
    grantedScopes: `openid email ${GOOGLE_SCOPE_GMAIL_SEND}`,
    refreshToken: "refresh-tando",
  });
}

function fulfillmentOf(approval: Awaited<ReturnType<typeof getApprovalById>>) {
  return (approval?.metadata?.authLinkFulfillment ?? {}) as {
    consumed?: boolean;
    status?: string;
    sending?: boolean;
  };
}

describe("FLAG OFF regression: follow-up must not change main", () => {
  beforeEach(() => {
    delete process.env.SECRET_AUTH_ACTION_LINK_ENABLED;
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("Firebase reset link is still google_api_key / secret_detected_in_payload", async () => {
    const before = (await listApprovals(DEMO_ORG.id)).filter((a) => a.status === "pending").length;
    const result = await withNeedsApprovalMailPolicy(() =>
      invokeMail({ jobSuffix: "flag_off", speakerId: SPEAKER })
    );
    expect(result.httpStatus).toBe(400);
    expect(result.body.code).toBe("secret_detected_in_payload");
    expect(result.body.pattern).toBe("google_api_key");
    const after = (await listApprovals(DEMO_ORG.id)).filter((a) => a.status === "pending").length;
    expect(after).toBe(before);
    assertNoSecrets(result.body);
  });
});

describe("M2: speakerId unresolved → fail-closed, no ticket", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("missing speakerId rejects without creating an approval", async () => {
    const before = (await listApprovals(DEMO_ORG.id)).filter((a) => a.status === "pending").length;
    const result = await withNeedsApprovalMailPolicy(() => invokeMail({ jobSuffix: "m2_no_speaker" }));
    expect(result.httpStatus).toBe(400);
    expect(result.body.ok).toBe(false);
    expect(result.body.code).toBe("auth_link_requester_unresolved");
    expect(result.body.reason).toBe("not_declared");
    expect(result.body.needs_approval).not.toBe(true);
    expect(result.body.approvalId).toBeFalsy();
    const after = (await listApprovals(DEMO_ORG.id)).filter((a) => a.status === "pending").length;
    expect(after).toBe(before);
    assertNoSecrets(result.body);
  });

  test("speakerId with no voter binding rejects without creating an approval", async () => {
    const { resetDemoVoterBindings } = await import("@/lib/approval-workflow/voter-binding");
    resetDemoVoterBindings();
    const before = (await listApprovals(DEMO_ORG.id)).filter((a) => a.status === "pending").length;
    const result = await withNeedsApprovalMailPolicy(() =>
      invokeMail({ jobSuffix: "m2_unbound", speakerId: "U0AUTHUNKNWN" })
    );
    expect(result.httpStatus).toBe(400);
    expect(result.body.ok).toBe(false);
    expect(result.body.code).toBe("auth_link_requester_unresolved");
    expect(result.body.reason).toBe("no_active_binding");
    expect(result.body.needs_approval).not.toBe(true);
    expect(result.body.approvalId).toBeFalsy();
    const after = (await listApprovals(DEMO_ORG.id)).filter((a) => a.status === "pending").length;
    expect(after).toBe(before);
    assertNoSecrets(result.body);
  });
});

describe("M1: consume only after send; CAS sending lock", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("pin mismatch does not consume and does not take the sending lock", async () => {
    const { approvalId, args, jobId } = await createApprovedAuthLink("m1_pin");
    const mismatch = await withNeedsApprovalMailPolicy(() =>
      invokeMail({
        jobSuffix: "m1_pin_bad",
        approvalId,
        jobId,
        speakerId: SPEAKER,
        args: { ...args, subject: "改ざんされた件名" },
      })
    );
    expect(mismatch.httpStatus).toBe(409);
    expect(mismatch.body.code).toBe("approved_send_content_mismatch");
    const approval = await getApprovalById(approvalId, DEMO_ORG.id);
    const f = fulfillmentOf(approval);
    expect(f.consumed).not.toBe(true);
    expect(f.status).not.toBe("sending");
    expect(f.sending).not.toBe(true);
    assertNoSecrets(approval?.metadata);
  });

  test("after pin mismatch, the same approvalId can still send once", async () => {
    const { approvalId, args, jobId } = await createApprovedAuthLink("m1_retry_pin");
    await withNeedsApprovalMailPolicy(() =>
      invokeMail({
        jobSuffix: "m1_retry_pin_bad",
        approvalId,
        jobId,
        speakerId: SPEAKER,
        args: { ...args, subject: "改ざんされた件名" },
      })
    );
    const retry = await withNeedsApprovalMailPolicy(() =>
      invokeMail({ jobSuffix: "m1_retry_pin_ok", approvalId, jobId, speakerId: SPEAKER, args })
    );
    expect(retry.httpStatus).toBe(200);
    expect(retry.body.ok).toBe(true);
    const approval = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(fulfillmentOf(approval).consumed).toBe(true);
  });

  test("two concurrent re-invokes send only once (CAS)", async () => {
    await bindMailbox();
    process.env.MAIL_SEND_GMAIL_LIVE = "true";
    const gmail = mockGmail();
    const { approvalId, args, jobId } = await createApprovedAuthLink("m1_cas");
    const [first, second] = await Promise.all([
      withNeedsApprovalMailPolicy(() =>
        invokeMail({ jobSuffix: "m1_cas_a", approvalId, jobId, speakerId: SPEAKER, args })
      ),
      withNeedsApprovalMailPolicy(() =>
        invokeMail({ jobSuffix: "m1_cas_b", approvalId, jobId, speakerId: SPEAKER, args })
      ),
    ]);
    const statuses = [first.httpStatus, second.httpStatus].sort();
    const oks = [first, second].filter((r) => r.httpStatus === 200 && r.body.ok === true);
    const rejects = [first, second].filter((r) => r.httpStatus !== 200);
    expect(oks).toHaveLength(1);
    expect(rejects).toHaveLength(1);
    expect(["auth_link_already_sent", "auth_link_send_in_progress"]).toContain(rejects[0]!.body.code);
    expect(gmail.posts).toBe(1);
    expect(statuses[0]).toBe(200);
    const approval = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(fulfillmentOf(approval).consumed).toBe(true);
    assertNoSecrets([first.body, second.body, approval?.metadata]);
  });

  test("provider failure releases the sending lock so a retry can run", async () => {
    await bindMailbox();
    process.env.MAIL_SEND_GMAIL_LIVE = "true";
    mockGmail({ sendStatus: 403 });
    const { approvalId, args, jobId } = await createApprovedAuthLink("m1_fail");
    const failed = await withNeedsApprovalMailPolicy(() =>
      invokeMail({ jobSuffix: "m1_fail_1", approvalId, jobId, speakerId: SPEAKER, args })
    );
    expect(failed.body.ok).toBe(false);
    expect(failed.body.code).not.toBe("auth_link_already_sent");
    const afterFail = await getApprovalById(approvalId, DEMO_ORG.id);
    const f = fulfillmentOf(afterFail);
    expect(f.consumed).not.toBe(true);
    expect(f.status).not.toBe("sending");
    expect(f.sending).not.toBe(true);

    mockGmail({ sendStatus: 200 });
    const retry = await withNeedsApprovalMailPolicy(() =>
      invokeMail({ jobSuffix: "m1_fail_2", approvalId, jobId, speakerId: SPEAKER, args })
    );
    expect(retry.httpStatus).toBe(200);
    expect(retry.body.ok).toBe(true);
    const afterRetry = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(fulfillmentOf(afterRetry).consumed).toBe(true);
  });
});

describe("L1: approvalId replay uses fulfillMailSend / MAIL_SEND_GMAIL_LIVE", () => {
  beforeEach(() => {
    process.env.SECRET_AUTH_ACTION_LINK_ENABLED = "true";
    delete process.env.SECRET_AUTH_ACTION_LINK_ORG_IDS;
  });

  test("MAIL_SEND_GMAIL_LIVE=true calls Gmail and consumes only after success", async () => {
    await bindMailbox();
    process.env.MAIL_SEND_GMAIL_LIVE = "true";
    const gmail = mockGmail();
    const { approvalId, args, jobId } = await createApprovedAuthLink("l1_live");
    const sent = await withNeedsApprovalMailPolicy(() =>
      invokeMail({ jobSuffix: "l1_live_send", approvalId, jobId, speakerId: SPEAKER, args })
    );
    expect(sent.httpStatus).toBe(200);
    expect(sent.body.ok).toBe(true);
    expect(gmail.posts).toBe(1);
    expect(sent.body.result?.delivery).toBe("mail");
    expect(sent.body.result?.sent).toBe(true);
    const approval = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(fulfillmentOf(approval).consumed).toBe(true);
    assertNoSecrets([sent.body, approval?.metadata, approval?.summary]);
  });

  test("MAIL_SEND_GMAIL_LIVE=OFF uses stub delivery (not a hardcoded invoke sent:true skip)", async () => {
    delete process.env.MAIL_SEND_GMAIL_LIVE;
    const gmail = mockGmail();
    const { approvalId, args, jobId } = await createApprovedAuthLink("l1_stub");
    const sent = await withNeedsApprovalMailPolicy(() =>
      invokeMail({ jobSuffix: "l1_stub_send", approvalId, jobId, speakerId: SPEAKER, args })
    );
    expect(sent.httpStatus).toBe(200);
    expect(sent.body.ok).toBe(true);
    expect(gmail.posts).toBe(0);
    expect(sent.body.result?.delivery).toBe("stub");
    const approval = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(fulfillmentOf(approval).consumed).toBe(true);
  });
});

describe("migration + rollback for auth-link send CAS", () => {
  test("additive RPC migration exists with matching rollback", () => {
    const migDir = join(process.cwd(), "supabase/migrations");
    const verDir = join(process.cwd(), "supabase/verification");
    const mig = readdirSync(migDir).find((f) => f.endsWith("_auth_link_send_claim.sql"));
    expect(mig).toBeTruthy();
    const sql = readFileSync(join(migDir, mig!), "utf8");
    expect(sql).toContain("create or replace function public.claim_auth_link_send(");
    expect(sql).toContain("create or replace function public.release_auth_link_send(");
    expect(sql).toContain("create or replace function public.consume_auth_link_send(");
    expect(sql).toContain("security invoker");
    expect(sql).toMatch(/revoke all on function public\.claim_auth_link_send/i);
    expect(sql).toMatch(/grant execute on function public\.claim_auth_link_send/i);
    expect(sql).toContain("service_role");
    expect(sql).not.toMatch(/create table|alter table/i);
    const rb = readdirSync(verDir).find((f) => f.endsWith("_auth_link_send_claim_rollback.sql"));
    expect(rb).toBeTruthy();
    const rollback = readFileSync(join(verDir, rb!), "utf8");
    expect(rollback).toContain("drop function if exists public.claim_auth_link_send");
    expect(rollback).toContain("drop function if exists public.release_auth_link_send");
    expect(rollback).toContain("drop function if exists public.consume_auth_link_send");
  });
});
