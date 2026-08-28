import { describe, expect, test } from "bun:test";
import {
  EMPLOYEE_IDENTITY_MAX_LEN,
  normalizeEmployeeIdentityField,
} from "./identity";

describe("normalizeEmployeeIdentityField", () => {
  test("trims surrounding whitespace", () => {
    expect(normalizeEmployeeIdentityField("  安藤  ")).toBe("安藤");
    expect(normalizeEmployeeIdentityField("\t営業\n")).toBe("営業");
  });

  test("empty after trim is invalid (empty string)", () => {
    expect(normalizeEmployeeIdentityField("")).toBe("");
    expect(normalizeEmployeeIdentityField("   ")).toBe("");
    expect(normalizeEmployeeIdentityField(null)).toBe("");
    expect(normalizeEmployeeIdentityField(undefined)).toBe("");
  });

  test("caps length at 80 characters", () => {
    const exact = "あ".repeat(EMPLOYEE_IDENTITY_MAX_LEN);
    const over = exact + "い";
    expect(normalizeEmployeeIdentityField(exact)).toBe(exact);
    expect(normalizeEmployeeIdentityField(over)).toBe(exact);
    expect(normalizeEmployeeIdentityField(over).length).toBe(80);
  });
});
