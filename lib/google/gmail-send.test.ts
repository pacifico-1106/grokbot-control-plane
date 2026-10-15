import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bindEmployeeGoogleIdentity, revokeEmployeeGoogleIdentity } from "@/lib/data/google-identities";
import { DEMO_ORG } from "@/lib/demo-data";
import { GOOGLE_SCOPE_GMAIL_SEND } from "./scopes";
import { sendMailViaGmail } from "./gmail-send";
import { minimalPdf } from "@/lib/mail/test-pdf";

const EMP = "emp_sales";
const KEY = "test-mail-attachment-encryption-key-32b";
let savedLive: string | undefined;
let savedKey: string | undefined;
let savedFetch: typeof fetch;

beforeEach(() => {
  savedLive = process.env.MAIL_SEND_GMAIL_LIVE;
  savedKey = process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  savedFetch = globalThis.fetch;
  process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = KEY;
  process.env.GOOGLE_OAUTH_CLIENT_ID = "client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret-that-is-long-enough-32ch";
});

afterEach(async () => {
  globalThis.fetch = savedFetch;
  if (savedLive === undefined) delete process.env.MAIL_SEND_GMAIL_LIVE;
  else process.env.MAIL_SEND_GMAIL_LIVE = savedLive;
  if (savedKey === undefined) delete process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY;
  else process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = savedKey;
  await revokeEmployeeGoogleIdentity({ employeeId: EMP, orgId: DEMO_ORG.id });
});

function mockGoogle(opts: { sendStatus?: number; sendBody?: unknown; throwSend?: boolean; tokenOk?: boolean }) {
  const calls: Array<{ url: string; body?: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, body });
    if (url.includes("oauth2.googleapis.com/token")) {
      if (opts.tokenOk === false) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });
    }
    if (url.includes("gmail.googleapis.com")) {
      if (opts.throwSend) throw new Error("network");
      return new Response(JSON.stringify(opts.sendBody ?? { id: "msg_1", threadId: "1a13940ce0564833" }), {
        status: opts.sendStatus ?? 200,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return calls;
}

async function bindTando() {
  await bindEmployeeGoogleIdentity({
    employeeId: EMP,
    orgId: DEMO_ORG.id,
    googleSub: "sub-tando",
    googleEmail: "tando@tokyo307inc.com",
    grantedScopes: `openid email ${GOOGLE_SCOPE_GMAIL_SEND}`,
    refreshToken: "refresh-tando",
  });
}

describe("sendMailViaGmail", () => {
  test("flag OFF does not call Gmail", async () => {
    delete process.env.MAIL_SEND_GMAIL_LIVE;
    await bindTando();
    const calls = mockGoogle({});
    const r = await sendMailViaGmail({
      employeeId: EMP,
      from: "tando@tokyo307inc.com",
      to: "info@s-value.co.jp",
      subject: "s",
      body: "b",
      attachments: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("mail_gmail_live_disabled");
    expect(calls).toHaveLength(0);
  });

  test("From must equal the mailbox", async () => {
    process.env.MAIL_SEND_GMAIL_LIVE = "true";
    await bindTando();
    const calls = mockGoogle({});
    const r = await sendMailViaGmail({
      employeeId: EMP,
      from: "other@tokyo307inc.com",
      to: "info@s-value.co.jp",
      subject: "s",
      body: "b",
      attachments: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("mail_from_mailbox_mismatch");
    expect(calls).toHaveLength(0);
  });

  test("sends raw MIME plus threadId when flag ON", async () => {
    process.env.MAIL_SEND_GMAIL_LIVE = "true";
    await bindTando();
    const calls = mockGoogle({});
    const pdf = minimalPdf("overview");
    const r = await sendMailViaGmail({
      employeeId: EMP,
      from: "tando@tokyo307inc.com",
      to: "info@s-value.co.jp",
      subject: "Staffpass サービス概要",
      body: "PDF を添付します。",
      threadId: "1a13940ce0564833",
      inReplyTo: "<CA+thread@mail.gmail.com>",
      attachments: [{ filename: "Staffpass_サービス概要.pdf", mimeType: "application/pdf", buffer: pdf }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.messageId).toBe("msg_1");
    const gmail = calls.find((c) => c.url.includes("gmail.googleapis.com"));
    expect(gmail).toBeTruthy();
    const payload = JSON.parse(gmail!.body || "{}") as { raw?: string; threadId?: string };
    expect(payload.threadId).toBe("1a13940ce0564833");
    expect(payload.raw).toBeTruthy();
    expect(gmail!.body).not.toContain("PDF を添付します");
  });

  test("timeout / network is unknown and not a definite failure", async () => {
    process.env.MAIL_SEND_GMAIL_LIVE = "true";
    await bindTando();
    mockGoogle({ throwSend: true });
    const r = await sendMailViaGmail({
      employeeId: EMP,
      from: "tando@tokyo307inc.com",
      to: "info@s-value.co.jp",
      subject: "s",
      body: "b",
      attachments: [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("post_outcome_unknown");
      expect(r.unknown).toBe(true);
    }
  });
});
