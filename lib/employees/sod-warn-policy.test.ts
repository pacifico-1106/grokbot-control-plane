import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SOD_WARN_POLICY,
  isDefaultSodWarnPolicy,
  normalizeSodWarnPolicy,
} from "./sod-warn-policy";

describe("normalizeSodWarnPolicy", () => {
  test("missing / invalid uses the strict default", () => {
    expect(normalizeSodWarnPolicy(null).domains).toEqual(DEFAULT_SOD_WARN_POLICY.domains);
    expect(normalizeSodWarnPolicy(undefined).domains).toEqual(DEFAULT_SOD_WARN_POLICY.domains);
    expect(normalizeSodWarnPolicy("nope").domains).toEqual(DEFAULT_SOD_WARN_POLICY.domains);
    expect(isDefaultSodWarnPolicy(normalizeSodWarnPolicy({}))).toBe(true);
  });

  test("empty domains array is kept (no combo warnings)", () => {
    expect(normalizeSodWarnPolicy({ domains: [] }).domains).toEqual([]);
    expect(isDefaultSodWarnPolicy(normalizeSodWarnPolicy({ domains: [] }))).toBe(false);
  });

  test("unknown keys are dropped and order is canonical", () => {
    const policy = normalizeSodWarnPolicy({
      domains: ["commit", "money", "browser", "nope", "comm_external"],
    });
    expect(policy.domains).toEqual(["comm_external", "money", "commit"]);
  });
});
