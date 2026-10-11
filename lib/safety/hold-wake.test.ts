/** S2 G5: postWake (every Slack mention / IM / re-wake path) is stopped by a hold. Demo mode, fetch stubbed. */
import { afterEach, beforeEach, expect, test } from "bun:test";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-holdwake";
const { DEMO_ORG } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");
const { listAuditEvents } = await import("@/lib/data");
const { __postWakeForTests: postWake } = await import("@/lib/slack/mention-ingress");

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const HID = "00000000-0000-4000-8000-0000000000a1";
const realFetch = globalThis.fetch;
let calls: string[] = [];
beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url instanceof Request ? url.url : url));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  hold.demoSetEmployeeHold(EMP, null);
  hold.demoSetOrgHold(ORG, null);
  hold.__setHoldReaderForTests(null);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  hold.demoSetEmployeeHold(EMP, null);
  hold.demoSetOrgHold(ORG, null);
  hold.__setHoldReaderForTests(null);
});

const target = { employeeId: EMP, orgId: ORG, slackUserId: "U1", slackTeamId: "T1", displayName: "営業AI", grokBotAgentId: "agent_1", wakeWebhookUrl: "https://hooks.example.com/wake/sales", hasWakeWebhook: true };
const payload = (id: string) => ({ channel: "C1", ts: "1.1", thread_ts: null, text: "hello", speakerId: "U9", user: "U9", eventId: id }) as never;
const suppressed = async (id: string) =>
  (await listAuditEvents(ORG)).filter((a) => a.action === "employee.hold.wake_suppressed" && (a.metadata as Record<string, unknown>).eventId === id);

for (const [name, setup, code] of [
  ["employee held", () => hold.demoSetEmployeeHold(EMP, { kind: "stopped", holdId: HID }), "employee_on_hold"],
  ["org held", () => hold.demoSetOrgHold(ORG, { kind: "stopped", holdId: HID }), "org_on_hold"],
  ["hold state unreadable", () => hold.__setHoldReaderForTests({ employee: async () => { throw new Error("db"); }, org: async () => { throw new Error("db"); } }), "hold_state_unavailable"],
] as const) {
  test(`${name} → no wake is sent; wake_suppressed audited (${code})`, async () => {
    setup();
    const id = `Ev_${code}`;
    await postWake(target, payload(id), "mention");
    expect(calls.filter((u) => u.includes("hooks.example.com"))).toEqual([]);
    const rows = await suppressed(id);
    expect(rows.length).toBe(1);
    expect((rows[0].metadata as Record<string, unknown>).reason).toBe(code);
  });
}

test("control: no hold → the wake is posted", async () => {
  await postWake(target, payload("Ev_control"), "mention");
  expect(calls.some((u) => u.includes("hooks.example.com"))).toBe(true);
  expect((await suppressed("Ev_control")).length).toBe(0);
});
