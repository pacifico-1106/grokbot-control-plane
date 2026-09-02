import { describe, expect, test } from "bun:test";
import { actorLabel } from "./actor-label";

describe("actorLabel", () => {
  test("prefers displayName and keeps the employeeId", () => {
    expect(actorLabel({ displayName: "安藤" }, "emp_sales_1")).toEqual({
      name: "安藤",
      employeeId: "emp_sales_1",
    });
  });

  test("falls back to employeeId when the employee is missing", () => {
    expect(actorLabel(undefined, "emp_sales_1")).toEqual({
      name: "emp_sales_1",
      employeeId: "emp_sales_1",
    });
    expect(actorLabel(null, "emp_sales_1")).toEqual({
      name: "emp_sales_1",
      employeeId: "emp_sales_1",
    });
  });

  test("never returns a blank actor when both are missing", () => {
    expect(actorLabel(undefined, undefined)).toEqual({
      name: "不明",
      employeeId: "",
    });
    expect(actorLabel(undefined, "   ")).toEqual({
      name: "不明",
      employeeId: "",
    });
    expect(actorLabel({ displayName: "  " }, null)).toEqual({
      name: "不明",
      employeeId: "",
    });
  });

  test("trims whitespace-only displayName and uses employeeId", () => {
    expect(actorLabel({ displayName: "  " }, "emp_1")).toEqual({
      name: "emp_1",
      employeeId: "emp_1",
    });
  });
});
