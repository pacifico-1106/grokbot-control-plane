/**
 * Unit tests for G7 cross-team wake routing data layer — Option A locked (2026-09-19).
 *
 * Tests fail-closed design: empty, single (success), and ambiguous (>1) cases.
 * Feature flag behavior is tested separately in mention-ingress.test.ts.
 *
 * SMOKE TARGET (Design Lock 2026-09-18):
 * First smoke path: TOKYO307 #aitest → explicit binding → Mirai Tomori wake.
 * These tests use generic fixtures (T_CONNECT_HOST, W_CONNECT_GUEST);
 * real channel/user IDs for 307 #aitest smoke TBD in admin MCP tooling.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import {
  deleteCrossTeamWakeBinding,
  getCrossTeamWakeBinding,
  isCrossTeamWakeRoutingEnabled,
  listCrossTeamWakeBindingsByTargetOrg,
  resetDemoCrossTeamWakeBindings,
  resolveCrossTeamWakeTarget,
  upsertCrossTeamWakeBinding,
} from "@/lib/data/cross-team-wake-bindings";
import { updateWakeWebhook } from "@/lib/data";

const RECEIVING_TEAM = "T_CONNECT_HOST";
const MENTIONED_USER = "W_CONNECT_GUEST";
const WAKE_URL = "https://example.test/wake/connect";

afterEach(() => {
  resetDemoCrossTeamWakeBindings();
  delete process.env.G7_CONNECT_WAKE_ROUTING;
});

describe("G7 cross-team wake bindings data layer", () => {
  test("isCrossTeamWakeRoutingEnabled returns false by default", () => {
    delete process.env.G7_CONNECT_WAKE_ROUTING;
    expect(isCrossTeamWakeRoutingEnabled()).toBe(false);
  });

  test("isCrossTeamWakeRoutingEnabled returns true when G7_CONNECT_WAKE_ROUTING=1", () => {
    process.env.G7_CONNECT_WAKE_ROUTING = "1";
    expect(isCrossTeamWakeRoutingEnabled()).toBe(true);
  });

  test("isCrossTeamWakeRoutingEnabled returns false for other values", () => {
    process.env.G7_CONNECT_WAKE_ROUTING = "0";
    expect(isCrossTeamWakeRoutingEnabled()).toBe(false);
    process.env.G7_CONNECT_WAKE_ROUTING = "true";
    expect(isCrossTeamWakeRoutingEnabled()).toBe(false);
    process.env.G7_CONNECT_WAKE_ROUTING = "yes";
    expect(isCrossTeamWakeRoutingEnabled()).toBe(false);
  });

  test("getCrossTeamWakeBinding returns null when no bindings exist (fail-closed)", async () => {
    const result = await getCrossTeamWakeBinding({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });
    expect(result).toBeNull();
  });

  test("getCrossTeamWakeBinding returns binding when exactly one exists", async () => {
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");

    const binding = await upsertCrossTeamWakeBinding({
      receivingOrgId: DEMO_ORG.id,
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
      targetOrgId: emp.orgId,
      targetEmployeeId: emp.id,
    });

    expect(binding.receivingTeamId).toBe(RECEIVING_TEAM);
    expect(binding.mentionedSlackUserId).toBe(MENTIONED_USER);
    expect(binding.targetEmployeeId).toBe(emp.id);

    const result = await getCrossTeamWakeBinding({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });

    expect(result).not.toBeNull();
    expect(result?.targetEmployeeId).toBe(emp.id);
  });

  test("getCrossTeamWakeBinding lookup is case-insensitive", async () => {
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");

    await upsertCrossTeamWakeBinding({
      receivingOrgId: DEMO_ORG.id,
      receivingTeamId: "t_connect_host",
      mentionedSlackUserId: "w_connect_guest",
      targetOrgId: emp.orgId,
      targetEmployeeId: emp.id,
    });

    const result = await getCrossTeamWakeBinding({
      receivingTeamId: "T_CONNECT_HOST",
      mentionedSlackUserId: "W_CONNECT_GUEST",
    });

    expect(result).not.toBeNull();
    expect(result?.targetEmployeeId).toBe(emp.id);
  });

  test("getCrossTeamWakeBinding returns null when binding is disabled", async () => {
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");

    await upsertCrossTeamWakeBinding({
      receivingOrgId: DEMO_ORG.id,
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
      targetOrgId: emp.orgId,
      targetEmployeeId: emp.id,
      enabled: false,
    });

    const result = await getCrossTeamWakeBinding({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });

    expect(result).toBeNull();
  });

  test("getCrossTeamWakeBinding returns null when empty teamId or userId", async () => {
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");

    await upsertCrossTeamWakeBinding({
      receivingOrgId: DEMO_ORG.id,
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
      targetOrgId: emp.orgId,
      targetEmployeeId: emp.id,
    });

    const result1 = await getCrossTeamWakeBinding({
      receivingTeamId: "",
      mentionedSlackUserId: MENTIONED_USER,
    });
    expect(result1).toBeNull();

    const result2 = await getCrossTeamWakeBinding({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: "",
    });
    expect(result2).toBeNull();
  });

  test("resolveCrossTeamWakeTarget returns target for valid binding with active employee", async () => {
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");

    await updateWakeWebhook(emp.id, {
      orgId: emp.orgId,
      url: WAKE_URL,
      secret: "test-secret",
    });

    await upsertCrossTeamWakeBinding({
      receivingOrgId: DEMO_ORG.id,
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
      targetOrgId: emp.orgId,
      targetEmployeeId: emp.id,
    });

    const target = await resolveCrossTeamWakeTarget({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });

    expect(target).not.toBeNull();
    expect(target?.employeeId).toBe(emp.id);
    expect(target?.wakeWebhookUrl).toBe(WAKE_URL);

    await updateWakeWebhook(emp.id, { orgId: emp.orgId, url: null, secret: "" });
  });

  test("resolveCrossTeamWakeTarget returns null when no binding exists", async () => {
    const target = await resolveCrossTeamWakeTarget({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });

    expect(target).toBeNull();
  });

  test("upsertCrossTeamWakeBinding throws when employee not found", async () => {
    await expect(
      upsertCrossTeamWakeBinding({
        receivingOrgId: DEMO_ORG.id,
        receivingTeamId: RECEIVING_TEAM,
        mentionedSlackUserId: MENTIONED_USER,
        targetOrgId: DEMO_ORG.id,
        targetEmployeeId: "emp_nonexistent",
      })
    ).rejects.toThrow("employee_not_found");
  });

  test("upsertCrossTeamWakeBinding throws when required fields empty", async () => {
    await expect(
      upsertCrossTeamWakeBinding({
        receivingOrgId: "",
        receivingTeamId: RECEIVING_TEAM,
        mentionedSlackUserId: MENTIONED_USER,
        targetOrgId: DEMO_ORG.id,
        targetEmployeeId: "emp_comm",
      })
    ).rejects.toThrow("invalid_cross_team_wake_binding");
  });

  test("deleteCrossTeamWakeBinding removes the binding", async () => {
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");

    const binding = await upsertCrossTeamWakeBinding({
      receivingOrgId: DEMO_ORG.id,
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
      targetOrgId: emp.orgId,
      targetEmployeeId: emp.id,
    });

    const before = await getCrossTeamWakeBinding({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });
    expect(before).not.toBeNull();

    await deleteCrossTeamWakeBinding({ id: binding.id });

    const after = await getCrossTeamWakeBinding({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });
    expect(after).toBeNull();
  });

  test("listCrossTeamWakeBindingsByTargetOrg returns bindings for the org", async () => {
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");

    await upsertCrossTeamWakeBinding({
      receivingOrgId: DEMO_ORG.id,
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
      targetOrgId: emp.orgId,
      targetEmployeeId: emp.id,
    });

    const bindings = await listCrossTeamWakeBindingsByTargetOrg(emp.orgId);
    expect(bindings.length).toBe(1);
    expect(bindings[0].targetEmployeeId).toBe(emp.id);
  });

  test("listCrossTeamWakeBindingsByTargetOrg returns empty for unknown org", async () => {
    const bindings = await listCrossTeamWakeBindingsByTargetOrg("org_nonexistent");
    expect(bindings.length).toBe(0);
  });
});

describe("G7 cross-team wake bindings ambiguous case (fail-closed)", () => {
  test("getCrossTeamWakeBinding returns null when multiple bindings match (ambiguous)", async () => {
    const employees = getRuntimeEmployees().filter((e) => e.status === "active");
    if (employees.length < 2) throw new Error("need at least 2 active employees");

    const emp1 = employees[0];
    const emp2 = employees[1];

    await upsertCrossTeamWakeBinding({
      receivingOrgId: DEMO_ORG.id,
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
      targetOrgId: emp1.orgId,
      targetEmployeeId: emp1.id,
    });

    const firstResult = await getCrossTeamWakeBinding({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });
    expect(firstResult).not.toBeNull();

    await upsertCrossTeamWakeBinding({
      receivingOrgId: "org_other",
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
      targetOrgId: emp2.orgId,
      targetEmployeeId: emp2.id,
    });

    const ambiguousResult = await getCrossTeamWakeBinding({
      receivingTeamId: RECEIVING_TEAM,
      mentionedSlackUserId: MENTIONED_USER,
    });
    expect(ambiguousResult).toBeNull();
  });
});
