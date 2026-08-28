import { describe, expect, test } from "bun:test";
import { parsePurposes } from "./purposes";

describe("parsePurposes", () => {
  test("splits, trims, drops empty, keeps order", () => {
    expect(parsePurposes("ops.admin, sales.outreach, calendar.propose")).toEqual([
      "ops.admin",
      "sales.outreach",
      "calendar.propose",
    ]);
    expect(parsePurposes("  ops.admin  ,  , calendar.propose , comm.internal ")).toEqual([
      "ops.admin",
      "calendar.propose",
      "comm.internal",
    ]);
    expect(parsePurposes("b, a, c")).toEqual(["b", "a", "c"]);
  });

  test("accepts Japanese comma and newlines", () => {
    expect(parsePurposes("ops.admin、calendar.propose、comm.internal")).toEqual([
      "ops.admin",
      "calendar.propose",
      "comm.internal",
    ]);
    expect(parsePurposes("ops.admin\ncalendar.propose\n\ncomm.internal")).toEqual([
      "ops.admin",
      "calendar.propose",
      "comm.internal",
    ]);
  });

  test("splits on whitespace and slash", () => {
    expect(parsePurposes("ops.admin calendar.propose comm.internal")).toEqual([
      "ops.admin",
      "calendar.propose",
      "comm.internal",
    ]);
    expect(parsePurposes("ops.admin / calendar.propose / comm.internal")).toEqual([
      "ops.admin",
      "calendar.propose",
      "comm.internal",
    ]);
    expect(parsePurposes("ops.admin/calendar.propose")).toEqual([
      "ops.admin",
      "calendar.propose",
    ]);
  });

  test("drops scope tokens that contain a colon", () => {
    expect(parsePurposes("ops.admin, mail:send, calendar.propose")).toEqual([
      "ops.admin",
      "calendar.propose",
    ]);
    expect(parsePurposes("browser:use commerce:order comm.internal")).toEqual([
      "comm.internal",
    ]);
  });

  test("dedupes while keeping first-seen order", () => {
    expect(parsePurposes("ops.admin, calendar.propose, ops.admin")).toEqual([
      "ops.admin",
      "calendar.propose",
    ]);
  });

  test("empty or whitespace-only input is empty list", () => {
    expect(parsePurposes("")).toEqual([]);
    expect(parsePurposes("   ")).toEqual([]);
    expect(parsePurposes(",、\n")).toEqual([]);
    expect(parsePurposes("/  ,")).toEqual([]);
  });
});
