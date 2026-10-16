import { describe, expect, test } from "bun:test";
import { verifyInboundNoticeSource } from "@/lib/inbound-notice/accept";
import type { InboundNoticeSourceInput } from "@/lib/inbound-notice/types";

const BASE: InboundNoticeSourceInput = {
  orgId: "org_demo",
  employeeId: "emp_comm",
  employeeOrgId: "org_demo",
  employeeSlackTeamId: "T_DUMMY",
  teamId: "T_DUMMY",
  channelId: "C_DUMMY",
  channelRegistered: true,
  channelOrgId: "org_demo",
  botId: "B_DUMMY",
  appId: "A_DUMMY",
  allowedChannelIds: ["C_DUMMY"],
  allowedBotIds: ["B_DUMMY"],
  allowedAppIds: ["A_DUMMY"],
  expectedOrgId: "org_demo",
  expectedTeamId: "T_DUMMY",
  expectedEmployeeId: "emp_comm",
};

describe("verifyInboundNoticeSource (fail closed)", () => {
  test("accepts a registered channel + matching bot + same org/team/employee", () => {
    expect(verifyInboundNoticeSource(BASE)).toEqual({ ok: true });
  });

  test("accepts matching app id when bot id is unknown", () => {
    expect(verifyInboundNoticeSource({ ...BASE, botId: "", allowedBotIds: [] })).toEqual({ ok: true });
  });

  test("rejects unregistered channel even if env allowlists it", () => {
    const r = verifyInboundNoticeSource({ ...BASE, channelRegistered: false });
    expect(r).toEqual({ ok: false, reason: "unregistered_channel" });
  });

  test("rejects channel not in the allowlist", () => {
    const r = verifyInboundNoticeSource({ ...BASE, allowedChannelIds: ["C_OTHER"] });
    expect(r).toEqual({ ok: false, reason: "channel_not_allowlisted" });
  });

  test("rejects unknown bot/app", () => {
    const r = verifyInboundNoticeSource({
      ...BASE,
      botId: "B_EVIL",
      appId: "A_EVIL",
    });
    expect(r).toEqual({ ok: false, reason: "bot_mismatch" });
  });

  test("rejects empty allowlists (no implicit allow)", () => {
    const r = verifyInboundNoticeSource({
      ...BASE,
      allowedBotIds: [],
      allowedAppIds: [],
    });
    expect(r).toEqual({ ok: false, reason: "bot_mismatch" });
  });

  test("rejects team mismatch", () => {
    expect(verifyInboundNoticeSource({ ...BASE, teamId: "T_OTHER" })).toEqual({
      ok: false,
      reason: "team_mismatch",
    });
    expect(verifyInboundNoticeSource({ ...BASE, employeeSlackTeamId: "T_OTHER" })).toEqual({
      ok: false,
      reason: "team_mismatch",
    });
  });

  test("rejects org mismatch", () => {
    expect(verifyInboundNoticeSource({ ...BASE, employeeOrgId: "org_other" })).toEqual({
      ok: false,
      reason: "org_mismatch",
    });
    expect(verifyInboundNoticeSource({ ...BASE, channelOrgId: "org_other" })).toEqual({
      ok: false,
      reason: "org_mismatch",
    });
  });

  test("rejects missing employee", () => {
    expect(verifyInboundNoticeSource({ ...BASE, employeeId: "" })).toEqual({
      ok: false,
      reason: "employee_missing",
    });
    expect(verifyInboundNoticeSource({ ...BASE, expectedEmployeeId: "emp_other" })).toEqual({
      ok: false,
      reason: "employee_mismatch",
    });
  });
});
