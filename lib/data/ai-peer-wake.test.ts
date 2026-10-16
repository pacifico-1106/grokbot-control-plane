import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  claimPeerWake,
  deleteAllowlist,
  isMemberActor,
  isPairAllowed,
  listAllowlist,
  resetDemoAiPeerWake,
  resumePeerWakeThread,
  stopPeerWakeThread,
  threadKeyFor,
  upsertAllowlist,
} from "@/lib/data/ai-peer-wake";
import { DEMO_ORG } from "@/lib/demo-data";

beforeEach(() => resetDemoAiPeerWake());
afterEach(() => resetDemoAiPeerWake());

describe("ai-peer-wake data (demo)", () => {
  test("member actor accepts member: ids; AI prefix is refused", () => {
    expect(isMemberActor("member:mem_1")).toBe(true);
    expect(isMemberActor("member:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe(true);
    expect(isMemberActor("ai:emp_comm")).toBe(false);
    expect(isMemberActor("ops:root")).toBe(false);
  });

  test("thread key uses thread_ts, or a root window", () => {
    expect(threadKeyFor({ threadTs: "1787911797.502889", eventTs: "1787911800.000001", windowSeconds: 1800 })).toBe("1787911797.502889");
    const a = threadKeyFor({ threadTs: null, eventTs: "1787911800.000001", windowSeconds: 1800 });
    const b = threadKeyFor({ threadTs: null, eventTs: "1787912999.000001", windowSeconds: 1800 });
    const c = threadKeyFor({ threadTs: null, eventTs: "1787913000.000001", windowSeconds: 1800 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("allowlist is fail-closed and org/channel scoped", async () => {
    expect(await isPairAllowed({ orgId: DEMO_ORG.id, fromEmployeeId: "emp_comm", toEmployeeId: "emp_sns", slackChannelId: "C_CLOUD" })).toEqual({ state: "denied" });
    await upsertAllowlist({
      orgId: DEMO_ORG.id,
      fromEmployeeId: "emp_comm",
      toEmployeeId: "emp_sns",
      slackChannelId: "C_CLOUD",
      createdBy: "member:mem_1",
    });
    expect(await isPairAllowed({ orgId: DEMO_ORG.id, fromEmployeeId: "emp_comm", toEmployeeId: "emp_sns", slackChannelId: "C_CLOUD" })).toEqual({ state: "allowed" });
    expect(await isPairAllowed({ orgId: DEMO_ORG.id, fromEmployeeId: "emp_comm", toEmployeeId: "emp_sns", slackChannelId: "C_OTHER" })).toEqual({ state: "denied" });
    expect(await isPairAllowed({ orgId: "org_other", fromEmployeeId: "emp_comm", toEmployeeId: "emp_sns", slackChannelId: "C_CLOUD" })).toEqual({ state: "denied" });
  });

  test("allowlist all-channels row matches any channel", async () => {
    await upsertAllowlist({
      orgId: DEMO_ORG.id,
      fromEmployeeId: "emp_comm",
      toEmployeeId: "emp_sns",
      createdBy: "member:mem_1",
    });
    expect(await isPairAllowed({ orgId: DEMO_ORG.id, fromEmployeeId: "emp_comm", toEmployeeId: "emp_sns", slackChannelId: "C_ANY" })).toEqual({ state: "allowed" });
  });

  test("self pair and cross-org employee are refused", async () => {
    await expect(upsertAllowlist({
      orgId: DEMO_ORG.id,
      fromEmployeeId: "emp_comm",
      toEmployeeId: "emp_comm",
      createdBy: "member:mem_1",
    })).rejects.toThrow("self_pair");
    await expect(upsertAllowlist({
      orgId: DEMO_ORG.id,
      fromEmployeeId: "emp_comm",
      toEmployeeId: "missing",
      createdBy: "member:mem_1",
    })).rejects.toThrow("employee_not_found");
  });

  test("AI actor cannot upsert", async () => {
    await expect(upsertAllowlist({
      orgId: DEMO_ORG.id,
      fromEmployeeId: "emp_comm",
      toEmployeeId: "emp_sns",
      createdBy: "ai:emp_comm",
    })).rejects.toThrow("actor_not_member");
  });

  test("delete is org-scoped", async () => {
    const row = await upsertAllowlist({
      orgId: DEMO_ORG.id,
      fromEmployeeId: "emp_comm",
      toEmployeeId: "emp_sns",
      createdBy: "member:mem_1",
    });
    expect(await deleteAllowlist({ orgId: "org_other", id: row.id })).toBe(false);
    expect((await listAllowlist(DEMO_ORG.id)).some((r) => r.id === row.id)).toBe(true);
    expect(await deleteAllowlist({ orgId: DEMO_ORG.id, id: row.id })).toBe(true);
    expect(await listAllowlist(DEMO_ORG.id)).toEqual([]);
  });

  test("claim then stop (member only); resume resets the count", async () => {
    const first = await claimPeerWake({
      orgId: DEMO_ORG.id,
      teamId: "T_DEMO",
      channelId: "C_CLOUD",
      threadTs: "1787911797.502889",
      eventTs: "1787911800.000001",
      cap: 4,
      windowSeconds: 1800,
    });
    expect(first.state).toBe("allowed");
    if (first.state !== "allowed") return;
    const aiStop = await stopPeerWakeThread({ orgId: DEMO_ORG.id, stopRef: first.stopRef, stoppedBy: "ai:emp_comm" });
    expect(aiStop.state).toBe("denied");
    const stopped = await stopPeerWakeThread({ orgId: DEMO_ORG.id, stopRef: first.stopRef, stoppedBy: "member:mem_1" });
    expect(stopped.state).toBe("stopped");
    const again = await claimPeerWake({
      orgId: DEMO_ORG.id,
      teamId: "T_DEMO",
      channelId: "C_CLOUD",
      threadTs: "1787911797.502889",
      eventTs: "1787911800.000002",
      cap: 4,
      windowSeconds: 1800,
    });
    expect(again.state).toBe("stopped");
    if (stopped.state !== "stopped") return;
    const resumed = await resumePeerWakeThread({ orgId: DEMO_ORG.id, id: stopped.thread.id, resumedBy: "member:mem_1" });
    expect(resumed.state).toBe("resumed");
    const after = await claimPeerWake({
      orgId: DEMO_ORG.id,
      teamId: "T_DEMO",
      channelId: "C_CLOUD",
      threadTs: "1787911797.502889",
      eventTs: "1787911800.000003",
      cap: 4,
      windowSeconds: 1800,
    });
    expect(after.state).toBe("allowed");
    if (after.state === "allowed") expect(after.count).toBe(1);
  });

  test("another org cannot stop by stopRef", async () => {
    const first = await claimPeerWake({
      orgId: DEMO_ORG.id,
      teamId: "T_DEMO",
      channelId: "C_CLOUD",
      threadTs: "1787911797.502889",
      eventTs: "1787911800.000001",
      cap: 4,
      windowSeconds: 1800,
    });
    if (first.state !== "allowed") throw new Error("expected claim");
    const cross = await stopPeerWakeThread({ orgId: "org_other", stopRef: first.stopRef, stoppedBy: "member:mem_1" });
    expect(cross.state).toBe("not_found");
  });
});
