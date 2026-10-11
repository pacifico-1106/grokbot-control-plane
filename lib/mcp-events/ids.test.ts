/** Deterministic subscription ids and stable event ids (dedupe across retries). */
import { describe, expect, test } from "bun:test";
import { approvalEventId, canonicalJson, subscriptionId } from "@/lib/mcp-events/ids";

describe("canonical JSON", () => {
  test("key order does not matter; arrays keep order; no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
});

describe("subscription id = f(principal, url, name, arguments)", () => {
  const base = { principal: "emp:org_a:emp_1:g1", url: "https://hooks.example.com/a", name: "approval.decided", args: { risk: ["high"] } };
  test("deterministic and formatted sub_<32 hex>", () => {
    expect(subscriptionId(base)).toBe(subscriptionId({ ...base, args: { risk: ["high"] } }));
    expect(subscriptionId(base)).toMatch(/^sub_[0-9a-f]{32}$/);
  });
  test("any key component changes the id (tenants never collide)", () => {
    const id = subscriptionId(base);
    expect(subscriptionId({ ...base, principal: "emp:org_b:emp_1:g1" })).not.toBe(id);
    expect(subscriptionId({ ...base, principal: "emp:org_a:emp_1:g2" })).not.toBe(id);
    expect(subscriptionId({ ...base, url: "https://hooks.example.com/b" })).not.toBe(id);
    expect(subscriptionId({ ...base, name: "approval.expired" })).not.toBe(id);
    expect(subscriptionId({ ...base, args: {} })).not.toBe(id);
  });
  test("component boundaries are unambiguous", () => {
    expect(subscriptionId({ ...base, principal: "a|b", url: "https://c" }))
      .not.toBe(subscriptionId({ ...base, principal: "a", url: "b|https://c" }));
  });
});

describe("event id = f(org, approval, name, status) — same on every retry and re-emit", () => {
  test("stable, evt_<32 hex>, differs by org / approval / name / status", () => {
    const e = { orgId: "org_a", approvalId: "apr_1", name: "approval.decided", status: "approved" };
    expect(approvalEventId(e)).toBe(approvalEventId({ ...e }));
    expect(approvalEventId(e)).toMatch(/^evt_[0-9a-f]{32}$/);
    for (const change of [{ orgId: "org_b" }, { approvalId: "apr_2" }, { name: "approval.expired" }, { status: "rejected" }]) {
      expect(approvalEventId({ ...e, ...change })).not.toBe(approvalEventId(e));
    }
  });
});
