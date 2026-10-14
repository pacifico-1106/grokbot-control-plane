/**
 * L-7: wake the AI employee from a per-employee LINE 1:1.
 * Flag stays on the webhook (LINE_CONVERSATION_ENABLED default OFF). This
 * module only delivers the wake: conversation token + text to the employee,
 * never stored or logged. Stop / leave is re-checked here (same G5 as Slack
 * postWake) so a hold placed after ingress still blocks the webhook.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dispatchLineConversationWake, type LineWakeDeps, type LineWakeEvent } from "@/lib/comm/line-wake";
import type { OperableResult } from "@/lib/safety/hold";

const ORG = "ec000000-0000-4000-8000-000000000001";
const EMP = "ec100000-0000-4000-8000-000000000001";
const ACCT = "ec200000-0000-4000-8000-000000000001";
const USER = "U" + "a".repeat(32);
const WAKE = "https://wake.example.com/line";

let fetches: Array<{ url: string; init: RequestInit }>;
let hold: OperableResult | "throw";
let holdCalls: Array<{ orgId?: string | null; employeeId?: string | null; phase: string }>;
let audits: Array<Record<string, unknown>>;
let bindingUrl: string;
const origFetch = globalThis.fetch;
const origError = console.error;

beforeEach(() => {
  fetches = [];
  hold = { ok: true };
  holdCalls = [];
  audits = [];
  bindingUrl = WAKE;
  console.error = (...a: unknown[]) => { audits.push({ log: a }); };
});
afterEach(() => {
  globalThis.fetch = origFetch;
  console.error = origError;
});

const event = (over: Partial<LineWakeEvent> = {}): LineWakeEvent => ({
  orgId: ORG,
  employeeId: EMP,
  accountId: ACCT,
  conversationId: USER,
  senderId: USER,
  text: "秘密の本文 0901234567",
  eventKey: "01HZZZZZZZZZZZZZZZZZZZZZZ1",
  conversationToken: "spc1.test-token",
  conversationTokenExpiresAt: "2026-10-15T00:00:00.000Z",
  ...over,
});

const deps = (): Partial<LineWakeDeps> => ({
  getBinding: async () => ({ wakeWebhookUrl: bindingUrl } as never),
  getWakeWebhookSecret: async () => "wake-secret",
  fetch: (async (url: unknown, init?: RequestInit) => {
    fetches.push({ url: String(url), init: init || {} });
    return new Response("{}", { status: 200 });
  }) as typeof fetch,
  checkOperable: async (i) => {
    holdCalls.push(i);
    if (hold === "throw") throw new Error("db down");
    return hold;
  },
  appendAudit: async (e) => { audits.push(e as Record<string, unknown>); },
});

describe("deliver the wake", () => {
  test("POSTs the conversation token and the text to the employee's wake webhook", async () => {
    await dispatchLineConversationWake(event(), deps());
    expect(fetches).toHaveLength(1);
    expect(fetches[0].url).toBe(WAKE);
    expect(fetches[0].init.method).toBe("POST");
    const headers = fetches[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer wake-secret");
    const body = JSON.parse(String(fetches[0].init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      surface: "line",
      kind: "conversation",
      trigger: "line_dm",
      orgId: ORG,
      employeeId: EMP,
      accountId: ACCT,
      conversationId: USER,
      senderId: USER,
      text: "秘密の本文 0901234567",
      eventKey: "01HZZZZZZZZZZZZZZZZZZZZZZ1",
      conversationToken: "spc1.test-token",
    });
    expect(holdCalls).toEqual([{ orgId: ORG, employeeId: EMP, phase: "wake" }]);
    expect(JSON.stringify(audits)).toContain("woke");
  });

  test("missing wake URL → nothing posted; audited without the body", async () => {
    bindingUrl = "";
    await dispatchLineConversationWake(event(), deps());
    expect(fetches).toEqual([]);
    expect(JSON.stringify(audits)).toContain("wake_webhook_missing");
    expect(JSON.stringify(audits)).not.toContain("秘密の本文");
    expect(JSON.stringify(audits)).not.toContain("0901234567");
  });

  test("HTTP 500 → wake_failed; the text is not logged", async () => {
    const d = deps();
    d.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await dispatchLineConversationWake(event(), d);
    expect(JSON.stringify(audits)).toContain("wake_failed");
    expect(JSON.stringify(audits)).not.toContain("秘密の本文");
    expect(JSON.stringify(audits)).not.toContain("0901234567");
  });
});

describe("stop / leave at wake (G5)", () => {
  test("employee on hold → no webhook is posted", async () => {
    hold = { ok: false, code: "employee_on_hold", holdId: "h1", kind: "stopped" };
    await dispatchLineConversationWake(event(), deps());
    expect(fetches).toEqual([]);
    expect(holdCalls).toEqual([{ orgId: ORG, employeeId: EMP, phase: "wake" }]);
  });

  test("hold state unknown or the check throws → no webhook (fail stop)", async () => {
    hold = { ok: false, code: "hold_state_unavailable", holdId: null, kind: null };
    await dispatchLineConversationWake(event({ eventKey: "k-a" }), deps());
    hold = "throw";
    await dispatchLineConversationWake(event({ eventKey: "k-b" }), deps());
    expect(fetches).toEqual([]);
  });
});

describe("no message body is stored", () => {
  test("audit rows and console never carry the inbound text", async () => {
    await dispatchLineConversationWake(event(), deps());
    const dumped = JSON.stringify(audits);
    expect(dumped).not.toContain("秘密の本文");
    expect(dumped).not.toContain("0901234567");
  });
});
