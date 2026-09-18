/**
 * Unit tests for G7 Slack Connect→own-tenant wake routing data layer.
 *
 * Tests fail-closed design: empty, single (success), and ambiguous (>1) cases.
 * Feature flag behavior is tested separately in mention-ingress.test.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import {
  deleteConnectWakeBind,
  getConnectWakeBind,
  isConnectWakeRoutingEnabled,
  listConnectWakeBindsByTargetOrg,
  resetDemoConnectWakeBinds,
  resolveConnectWakeTarget,
  upsertConnectWakeBind,
} from "@/lib/data/slack-connect-wake-binds";
import { updateWakeWebhook } from "@/lib/data";

const RECEIVING_TEAM = "T_CONNECT_HOST";
const MENTIONED_USER = "W_CONNECT_GUEST";
const WAKE_URL = "https://example.test/wake/connect";

afterEach(() => {
  resetDemoConnectWakeBinds();
  delete process.env.G7_CONNECT_WAKE_ROUTING;
});

describe("G7 Connect wake binds data layer", () => {
  test("isConnectWakeRoutingEnabled returns false by default", () => {
    delete process.env.G7_CONNECT_WAKE_ROUTING;
    expect(isConnectWakeRoutingEnabled()).toBe(false);
  });

  test("isConnectWakeRoutingEnabled returns true when G7_CONNECT_WAKE_ROUTING=1", () => {
    process.env.G7_CONNECT_WAKE_ROUTING = "1";
    expect(isConnectWakeRoutingEnabled()).toBe(true);
  });

  test("isConnectWakeRoutingEnabled returns false for other values", () => {
    process.env.G7_CONNECT_WAKE_ROUTING = "0";
    expect(isConnectWakeRoutingEnabled()).toBe(false);
    process.env.G7_CONNECT_WAKE_ROUTING = "true";
    expect(isConnectWakeRoutingEnabled()).toBe(false);
    process.env.G7_CONNECT_WAKE_ROUTING = "yes";
    expect(isConnectWakeRoutingEnabled()).toBe(false);
  });

  test("getConnectWakeBind returns null when no binds exist (fail-closed)", async () => {
    const result = await getConnectWakeBind({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });
    expect(result).toBeNull();
  });

  test("getConnectWakeBind returns bind when exactly one exists", async () => {
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");

    const bind = await upsertConnectWakeBind({
      receivingOrgId: DEMO_ORG.id,
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
      targetOrgId: emp.orgId,
      targetEmployeeId: emp.id,
    });

    expect(bind.receivingTeamId).toBe(RECEIVING_TEAM);
    expect(bind.mentionedSlackUserId).toBe(MENTIONED_USER);
    expect(bind.targetEmployeeId).toBe(emp.id);

    const result = await getConnectWakeBind({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });

    expect(result).not.toBeNull();
    expect(result?.targetEmployeeId).toBe(emp.id);
  });

  test("getConnectWakeBind lookup is case-insensitive", async () => {
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");

    await upsertConnectWakeBind({
      receivingOrgId: DEMO_ORG.id,
      receivingTeamId: "t_connect_host",
      mentionedSlackUserId: "w_connect_guest",
      targetOrgId: emp.orgId,
      targetEmployeeId: emp.id,
    });

    const result = await getConnectWakeBind({
      receivingTeamId: "T_CONNECT_HOST",
      mentionedSlackUserId: "W_CONNECT_GUEST",
    });

    expect(result).not.toBeNull();
    expect(result?.targetEmployeeId).toBe(emp.id);
  });

  test("getConnectWakeBind returns null when bind is disabled", async () => {
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");

    await upsertConnectWakeBind({
      receivingOrgId: DEMO_ORG.id,
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
      targetOrgId: emp.orgId,
      targetEmployeeId: emp.id,
      enabled: false,
    });

    const result = await getConnectWakeBind({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });

    expect(result).toBeNull();
  });

  test("getConnectWakeBind returns null when empty teamId or userId", async () => {
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");

    await upsertConnectWakeBind({
      receivingOrgId: DEMO_ORG.id,
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
      targetOrgId: emp.orgId,
      targetEmployeeId: emp.id,
    });

    const result1 = await getConnectWakeBind({
      receivingTeamId: "",
      mentionedSlackUserId: MENTIONED_USER,
    });
    expect(result1).toBeNull();

    const result2 = await getConnectWakeBind({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: "",
    });
    expect(result2).toBeNull();
  });

  test("resolveConnectWakeTarget returns target for valid bind with active employee", async () => {
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");

    await updateWakeWebhook(emp.id, {
      orgId: emp.orgId,
      url: WAKE_URL,
      secret: "test-secret",
    });

    await upsertConnectWakeBind({
      receivingOrgId: DEMO_ORG.id,
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
      targetOrgId: emp.orgId,
      targetEmployeeId: emp.id,
    });

    const target = await resolveConnectWakeTarget({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });

    expect(target).not.toBeNull();
    expect(target?.employeeId).toBe(emp.id);
    expect(target?.wakeWebhookUrl).toBe(WAKE_URL);

    await updateWakeWebhook(emp.id, { orgId: emp.orgId, url: null, secret: "" });
  });

  test("resolveConnectWakeTarget returns null when no bind exists", async () => {
    const target = await resolveConnectWakeTarget({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });

    expect(target).toBeNull();
  });

  test("upsertConnectWakeBind throws when employee not found", async () => {
    await expect(
      upsertConnectWakeBind({
        receivingOrgId: DEMO_ORG.id,
        receivingTeamId: RECEIVING_TEAM,
        mentionedSlackUserId: MENTIONED_USER,
        targetOrgId: DEMO_ORG.id,
        targetEmployeeId: "emp_nonexistent",
      })
    ).rejects.toThrow("employee_not_found");
  });

  test("upsertConnectWakeBind throws when required fields empty", async () => {
    await expect(
      upsertConnectWakeBind({
        receivingOrgId: "",
        receivingTeamId: RECEIVING_TEAM,
        mentionedSlackUserId: MENTIONED_USER,
        targetOrgId: DEMO_ORG.id,
        targetEmployeeId: "emp_comm",
      })
    ).rejects.toThrow("invalid_connect_wake_bind");
  });

  test("deleteConnectWakeBind removes the bind", async () => {
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");

    const bind = await upsertConnectWakeBind({
      receivingOrgId: DEMO_ORG.id,
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
      targetOrgId: emp.orgId,
      targetEmployeeId: emp.id,
    });

    const before = await getConnectWakeBind({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });
    expect(before).not.toBeNull();

    await deleteConnectWakeBind({ id: bind.id });

    const after = await getConnectWakeBind({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });
    expect(after).toBeNull();
  });

  test("listConnectWakeBindsByTargetOrg returns binds for the org", async () => {
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");

    await upsertConnectWakeBind({
      receivingOrgId: DEMO_ORG.id,
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
      targetOrgId: emp.orgId,
      targetEmployeeId: emp.id,
    });

    const binds = await listConnectWakeBindsByTargetOrg(emp.orgId);
    expect(binds.length).toBe(1);
    expect(binds[0].targetEmployeeId).toBe(emp.id);
  });

  test("listConnectWakeBindsByTargetOrg returns empty for unknown org", async () => {
    const binds = await listConnectWakeBindsByTargetOrg("org_nonexistent");
    expect(binds.length).toBe(0);
  });
});

describe("G7 Connect wake binds ambiguous case (fail-closed)", () => {
  test("getConnectWakeBind returns null when multiple binds match (ambiguous)", async () => {
    const employees = getRuntimeEmployees().filter((e) => e.status === "active");
    if (employees.length < 2) throw new Error("need at least 2 active employees");

    const emp1 = employees[0];
    const emp2 = employees[1];

    await upsertConnectWakeBind({
      receivingOrgId: DEMO_ORG.id,
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
      targetOrgId: emp1.orgId,
      targetEmployeeId: emp1.id,
    });

    const firstResult = await getConnectWakeBind({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });
    expect(firstResult).not.toBeNull();

    await upsertConnectWakeBind({
      receivingOrgId: "org_other",
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
      targetOrgId: emp2.orgId,
      targetEmployeeId: emp2.id,
    });

    const ambiguousResult = await getConnectWakeBind({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });
    expect(ambiguousResult).toBeNull();
  });
});
