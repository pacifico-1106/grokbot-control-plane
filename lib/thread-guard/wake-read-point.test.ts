/**
 * 木村 #293 review item 2: when the AI passes neither readThroughTs nor an
 * inbound ts, the read point is the inbound ts of the latest wake Staffpass
 * delivered to that employee in that thread (THREAD_SINGLE_FLIGHT_ENABLED ON).
 * Here: a successful Slack mention wake records it (hash-only key, per org ×
 * employee × thread); flag OFF / a failed wake records nothing. Demo mode,
 * dummy secrets, fetch recorded, no network.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { DEMO_ORG, getRuntimeEmployees } = await import("@/lib/demo-data");
const { bindEmployeeSlackIdentity, revokeEmployeeSlackIdentity } = await import("@/lib/data/slack-identities");
const { updateWakeWebhook } = await import("@/lib/data");
const { handleSlackEventsRequest } = await import("@/lib/slack/mention-ingress");
const { threadKeyFor } = await import("@/lib/thread-guard/guard");
const store = (await import("@/lib/thread-guard/store")) as Record<string, unknown>;
const { __resetThreadGuardStoreForTests } = await import("@/lib/thread-guard/store");

const SIGNING_SECRET = "slack-events-signing-secret-for-wake-rp";
const WAKE_URL = "https://wake.example.com/hook-rp";
const BOUND_USER = "U_WAKERP";
const TEAM = "T_DEMO";
const CHANNEL = "C_WAKERP";
const TS = "1787911800.300001";
const ENV = ["THREAD_SINGLE_FLIGHT_ENABLED", "SLACK_SIGNING_SECRET", "WEBHOOK_HARDENING_ENABLED"];
const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;
let wakeStatus = 200;
let restoreEmp: (() => Promise<void>) | null = null;

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.WEBHOOK_HARDENING_ENABLED;
  process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
  wakeStatus = 200;
  globalThis.fetch = (async (input: unknown) =>
    String(input) === WAKE_URL ? new Response("{}", { status: wakeStatus }) : Response.json({ ok: true })) as typeof fetch;
  const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm")!;
  const previous = emp.allowedAccounts;
  emp.allowedAccounts = [{ service: "slack", accountId: BOUND_USER }];
  await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
  await bindEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id, slackUserId: BOUND_USER, slackTeamId: TEAM, displayName: "RP", userToken: "xoxp-test" });
  await updateWakeWebhook(emp.id, { orgId: DEMO_ORG.id, url: WAKE_URL, secret: "wake-rp-secret" });
  restoreEmp = async () => {
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
    await updateWakeWebhook(emp.id, { orgId: DEMO_ORG.id, url: null, secret: "" });
    emp.allowedAccounts = previous;
  };
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await restoreEmp?.();
  __resetThreadGuardStoreForTests();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

async function mention(eventId = `Ev_rp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`) {
  const body = { type: "event_callback", team_id: TEAM, event_id: eventId,
    event: { type: "message", user: "U_HUMAN_RP", text: `<@${BOUND_USER}> お願い`, ts: TS, channel: CHANNEL } };
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  await handleSlackEventsRequest({ rawBody, timestamp, signature });
}
const read = (employeeId: string, threadId?: string, orgId = DEMO_ORG.id) => {
  const readWakePoint = store.readWakePoint as undefined | ((i: unknown) => Promise<{ ok: boolean; micros?: bigint | null }>);
  if (typeof readWakePoint !== "function") throw new Error("readWakePoint missing");
  return readWakePoint({ orgId, employeeId, threadKey: threadKeyFor({ orgId, surface: "slack", slackChannelId: CHANNEL, threadId })! });
};

describe("a delivered Slack mention wake records the employee's read point", () => {
  test("flag ON: recorded for the reply thread (threadId = wake ts) and the channel root", async () => {
    process.env.THREAD_SINGLE_FLIGHT_ENABLED = "true";
    await mention();
    const micros = BigInt(1787911800300001);
    expect(await read("emp_comm", TS)).toEqual({ ok: true, micros });
    expect(await read("emp_comm", undefined)).toEqual({ ok: true, micros });
    // BOLA: another employee / another org never sees it
    expect(await read("emp_comm2", TS)).toEqual({ ok: true, micros: null });
    expect(await read("emp_comm", TS, "00000000-0000-4000-8000-0000000bb0b1")).toEqual({ ok: true, micros: null });
  });
  test("a failed wake records nothing", async () => {
    process.env.THREAD_SINGLE_FLIGHT_ENABLED = "true";
    wakeStatus = 500;
    await mention();
    expect(await read("emp_comm", TS)).toEqual({ ok: true, micros: null });
  });
  test("flag OFF: nothing recorded (store untouched)", async () => {
    delete process.env.THREAD_SINGLE_FLIGHT_ENABLED;
    await mention();
    expect(await read("emp_comm", TS)).toEqual({ ok: true, micros: null });
  });
});
