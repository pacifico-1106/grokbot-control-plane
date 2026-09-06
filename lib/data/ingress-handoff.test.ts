import { afterEach, describe, expect, test } from "bun:test";
import {
  getOrgIngressHandoffPolicy,
  setOrgIngressHandoffPolicy,
  getEmployeeIngressHandoffPolicy,
  setEmployeeIngressHandoffPolicy,
  getEffectiveIngressHandoffPolicy,
  resetDemoIngressHandoffPolicy,
} from "./ingress-handoff";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import type { OrgIngressHandoffPolicy } from "@/lib/types";

const ORG_ID = DEMO_ORG.id;

function makePolicy(body: "full" | "prefix" | "none", sealith: "off" | "suggest" | "required"): OrgIngressHandoffPolicy {
  return {
    version: 1,
    rules: [
      {
        id: `ihr_${Date.now()}`,
        applyTo: "all",
        body,
        ...(body === "prefix" ? { bodyPrefixChars: 100 } : {}),
        attachment: "meta",
        sealith,
        audit: { jobId: true, sealithTransferId: false },
      },
    ],
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };
}

describe("ingress handoff policy storage", () => {
  afterEach(() => {
    resetDemoIngressHandoffPolicy();
  });

  test("getOrgIngressHandoffPolicy returns default when no policy set", async () => {
    const policy = await getOrgIngressHandoffPolicy(ORG_ID);
    expect(policy.version).toBe(1);
    expect(policy.rules.length).toBe(1);
    expect(policy.rules[0].body).toBe("full");
    expect(policy.rules[0].attachment).toBe("meta");
    expect(policy.rules[0].sealith).toBe("off");
  });

  test("setOrgIngressHandoffPolicy persists and retrieves policy", async () => {
    const testPolicy = makePolicy("prefix", "suggest");
    await setOrgIngressHandoffPolicy(ORG_ID, testPolicy);
    
    const retrieved = await getOrgIngressHandoffPolicy(ORG_ID);
    expect(retrieved.rules[0].body).toBe("prefix");
    expect(retrieved.rules[0].sealith).toBe("suggest");
  });

  test("getEmployeeIngressHandoffPolicy returns null when no override", async () => {
    const employees = getRuntimeEmployees();
    const employeeId = employees[0]?.id;
    expect(employeeId).toBeTruthy();

    const override = await getEmployeeIngressHandoffPolicy(employeeId);
    expect(override).toBeNull();
  });

  test("setEmployeeIngressHandoffPolicy persists employee override", async () => {
    const employees = getRuntimeEmployees();
    const employeeId = employees[0]?.id;
    expect(employeeId).toBeTruthy();

    const testPolicy = makePolicy("none", "required");
    await setEmployeeIngressHandoffPolicy(employeeId, ORG_ID, testPolicy);
    
    const override = await getEmployeeIngressHandoffPolicy(employeeId);
    expect(override).not.toBeNull();
    expect(override?.rules[0].body).toBe("none");
    expect(override?.rules[0].sealith).toBe("required");
  });

  test("setEmployeeIngressHandoffPolicy with null clears override", async () => {
    const employees = getRuntimeEmployees();
    const employeeId = employees[0]?.id;
    expect(employeeId).toBeTruthy();

    const testPolicy = makePolicy("none", "required");
    await setEmployeeIngressHandoffPolicy(employeeId, ORG_ID, testPolicy);
    
    let override = await getEmployeeIngressHandoffPolicy(employeeId);
    expect(override).not.toBeNull();

    await setEmployeeIngressHandoffPolicy(employeeId, ORG_ID, null);
    override = await getEmployeeIngressHandoffPolicy(employeeId);
    expect(override).toBeNull();
  });
});

describe("effective ingress handoff policy fallback", () => {
  afterEach(() => {
    resetDemoIngressHandoffPolicy();
  });

  test("fallback to default when no org or employee policy", async () => {
    const employees = getRuntimeEmployees();
    const employeeId = employees[0]?.id;

    const effective = await getEffectiveIngressHandoffPolicy(ORG_ID, employeeId);
    
    expect(effective.source).toBe("default");
    expect(effective.employeeOverride).toBeNull();
    expect(effective.orgPolicy).toBeNull();
    expect(effective.policy.rules[0].body).toBe("full");
  });

  test("fallback to org policy when no employee override", async () => {
    const employees = getRuntimeEmployees();
    const employeeId = employees[0]?.id;

    const orgPolicy = makePolicy("prefix", "suggest");
    await setOrgIngressHandoffPolicy(ORG_ID, orgPolicy);

    const effective = await getEffectiveIngressHandoffPolicy(ORG_ID, employeeId);
    
    expect(effective.source).toBe("org");
    expect(effective.employeeOverride).toBeNull();
    expect(effective.orgPolicy).not.toBeNull();
    expect(effective.policy.rules[0].body).toBe("prefix");
    expect(effective.policy.rules[0].sealith).toBe("suggest");
  });

  test("employee override takes precedence over org policy", async () => {
    const employees = getRuntimeEmployees();
    const employeeId = employees[0]?.id;
    expect(employeeId).toBeTruthy();

    const orgPolicy = makePolicy("prefix", "suggest");
    await setOrgIngressHandoffPolicy(ORG_ID, orgPolicy);

    const employeePolicy = makePolicy("none", "required");
    await setEmployeeIngressHandoffPolicy(employeeId, ORG_ID, employeePolicy);

    const effective = await getEffectiveIngressHandoffPolicy(ORG_ID, employeeId);
    
    expect(effective.source).toBe("employee");
    expect(effective.employeeOverride).not.toBeNull();
    expect(effective.orgPolicy).not.toBeNull();
    expect(effective.policy.rules[0].body).toBe("none");
    expect(effective.policy.rules[0].sealith).toBe("required");
  });

  test("different employees can have different policies", async () => {
    const employees = getRuntimeEmployees();
    const employee1Id = employees[0]?.id;
    const employee2Id = employees[1]?.id;
    expect(employee1Id).toBeTruthy();
    expect(employee2Id).toBeTruthy();

    const orgPolicy = makePolicy("full", "off");
    await setOrgIngressHandoffPolicy(ORG_ID, orgPolicy);

    const employee1Policy = makePolicy("none", "required");
    await setEmployeeIngressHandoffPolicy(employee1Id, ORG_ID, employee1Policy);

    const effective1 = await getEffectiveIngressHandoffPolicy(ORG_ID, employee1Id);
    expect(effective1.source).toBe("employee");
    expect(effective1.policy.rules[0].body).toBe("none");

    const effective2 = await getEffectiveIngressHandoffPolicy(ORG_ID, employee2Id);
    expect(effective2.source).toBe("org");
    expect(effective2.policy.rules[0].body).toBe("full");
  });

  test("clearing employee override falls back to org policy", async () => {
    const employees = getRuntimeEmployees();
    const employeeId = employees[0]?.id;
    expect(employeeId).toBeTruthy();

    const orgPolicy = makePolicy("prefix", "suggest");
    await setOrgIngressHandoffPolicy(ORG_ID, orgPolicy);

    const employeePolicy = makePolicy("none", "required");
    await setEmployeeIngressHandoffPolicy(employeeId, ORG_ID, employeePolicy);

    let effective = await getEffectiveIngressHandoffPolicy(ORG_ID, employeeId);
    expect(effective.source).toBe("employee");
    expect(effective.policy.rules[0].body).toBe("none");

    await setEmployeeIngressHandoffPolicy(employeeId, ORG_ID, null);
    effective = await getEffectiveIngressHandoffPolicy(ORG_ID, employeeId);
    expect(effective.source).toBe("org");
    expect(effective.policy.rules[0].body).toBe("prefix");
  });

  test("without employeeId, returns org policy", async () => {
    const orgPolicy = makePolicy("prefix", "suggest");
    await setOrgIngressHandoffPolicy(ORG_ID, orgPolicy);

    const effective = await getEffectiveIngressHandoffPolicy(ORG_ID, null);
    
    expect(effective.source).toBe("org");
    expect(effective.employeeOverride).toBeNull();
    expect(effective.policy.rules[0].body).toBe("prefix");
  });

  test("layers always contain both employee and org policy info", async () => {
    const employees = getRuntimeEmployees();
    const employeeId = employees[0]?.id;
    expect(employeeId).toBeTruthy();

    const orgPolicy = makePolicy("prefix", "suggest");
    await setOrgIngressHandoffPolicy(ORG_ID, orgPolicy);

    const employeePolicy = makePolicy("none", "required");
    await setEmployeeIngressHandoffPolicy(employeeId, ORG_ID, employeePolicy);

    const effective = await getEffectiveIngressHandoffPolicy(ORG_ID, employeeId);
    
    expect(effective.employeeOverride?.rules[0].body).toBe("none");
    expect(effective.orgPolicy?.rules[0].body).toBe("prefix");
  });
});
