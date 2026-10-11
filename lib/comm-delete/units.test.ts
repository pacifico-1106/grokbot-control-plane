/**
 * comm.delete — unit contract (flag, target parsing, surface support, post
 * records, tool registry / risk / presets / plans / MCP exposure).
 * No network, demo mode, dummy ids.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as commDeleteConfig from "@/lib/comm-delete/config";
import { commDeleteMaxAgeHours, isCommDeleteEnabled } from "@/lib/comm-delete/config";
import { isRetryableApprovalFailure } from "@/lib/approvals/execution";
import { commDeleteSurfaceSupport } from "@/lib/comm-delete/surfaces";
import { parseCommDeleteTarget } from "@/lib/comm-delete/target";
import { buildSlackPostRecord } from "@/lib/comm-delete/post-record";
import { inferRiskForTool } from "@/lib/approvals/summary";
import {
  isAudienceGatedTool,
  isOutboundSendTool,
  resolveGatewayTool,
  toolRequiresHumanApproval,
} from "@/lib/gateway/tools";
import { JP_SME_STRICT_APPROVAL_PRESETS, normalizeToolApprovalDefaults } from "@/lib/employees/approval-presets";
import { PLAN_GATEWAY_SCOPES } from "@/lib/billing/plan-scopes";
import { STAFFPASS_MCP_TOOLS } from "@/lib/mcp/tools";

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of ["COMM_DELETE_ENABLED", "COMM_DELETE_MAX_AGE_HOURS"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("COMM_DELETE_ENABLED (default OFF)", () => {
  test("unset / false → OFF", () => {
    delete process.env.COMM_DELETE_ENABLED;
    expect(isCommDeleteEnabled()).toBe(false);
    process.env.COMM_DELETE_ENABLED = "false";
    expect(isCommDeleteEnabled()).toBe(false);
  });
  test("true / 1 → ON", () => {
    process.env.COMM_DELETE_ENABLED = "true";
    expect(isCommDeleteEnabled()).toBe(true);
    process.env.COMM_DELETE_ENABLED = "1";
    expect(isCommDeleteEnabled()).toBe(true);
  });
  test("max age: default 72h, clamped to 1..720", () => {
    delete process.env.COMM_DELETE_MAX_AGE_HOURS;
    expect(commDeleteMaxAgeHours()).toBe(72);
    process.env.COMM_DELETE_MAX_AGE_HOURS = "0";
    expect(commDeleteMaxAgeHours()).toBe(1);
    process.env.COMM_DELETE_MAX_AGE_HOURS = "100000";
    expect(commDeleteMaxAgeHours()).toBe(720);
    process.env.COMM_DELETE_MAX_AGE_HOURS = "abc";
    expect(commDeleteMaxAgeHours()).toBe(72);
  });
});

describe("too_old support", () => {
  test("record lookback is a fixed 720h (30 days), never shorter than the max window", () => {
    const lookback = (commDeleteConfig as Record<string, unknown>).COMM_DELETE_RECORD_LOOKBACK_HOURS;
    expect(lookback).toBe(720);
    process.env.COMM_DELETE_MAX_AGE_HOURS = "100000";
    expect(commDeleteMaxAgeHours()).toBeLessThanOrEqual(720);
  });
  test("an approved delete refused as too_old precedes any provider call (claim may run again)", () => {
    expect(isRetryableApprovalFailure("comm.delete", "too_old")).toBe(true);
    expect(isRetryableApprovalFailure("mail.send", "too_old")).toBe(false);
  });
});

describe("parseCommDeleteTarget", () => {
  test("Slack: channel + ts (ts is the message id)", () => {
    const r = parseCommDeleteTarget({ surface: "slack", channel: "C0123ABCD", ts: "1787911800.000100" });
    expect(r).toEqual({ ok: true, target: { surface: "slack", channel: "C0123ABCD", messageId: "1787911800.000100" } });
  });
  test("Slack: messageId alias and DM / private channel ids; surface defaults to slack", () => {
    expect(parseCommDeleteTarget({ channel: "D0C1UE4A14N", messageId: "1787911800.000100" }).ok).toBe(true);
    expect(parseCommDeleteTarget({ channelId: "G0ABCDEF1", ts: "1787911800.000100" }).ok).toBe(true);
  });
  test("Slack: malformed channel / ts / missing → invalid_delete_target", () => {
    for (const args of [
      {},
      { channel: "C0123ABCD" },
      { ts: "1787911800.000100" },
      { channel: "U0123ABCD", ts: "1787911800.000100" },
      { channel: "C0123ABCD", ts: "yesterday" },
      { channel: "C0123ABCD; DROP", ts: "1787911800.000100" },
      { channel: "C".padEnd(40, "A"), ts: "1787911800.000100" },
      { surface: "fax", channel: "C0123ABCD", ts: "1787911800.000100" },
    ]) {
      const r = parseCommDeleteTarget(args as Record<string, unknown>);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_delete_target");
    }
  });
  test("LINE / Telegram: chat + message id are accepted (support is decided separately)", () => {
    expect(parseCommDeleteTarget({ surface: "line", channel: "Uabc123", messageId: "325708" }).ok).toBe(true);
    expect(parseCommDeleteTarget({ surface: "telegram", channel: "-100123456", messageId: "42" }).ok).toBe(true);
  });
});

describe("surface support matrix", () => {
  test("Slack supported", () => {
    expect(commDeleteSurfaceSupport("slack")).toEqual({ supported: true });
  });
  test("LINE: not_supported — the Messaging API cannot unsend a sent message", () => {
    const s = commDeleteSurfaceSupport("line");
    expect(s.supported).toBe(false);
    if (!s.supported) {
      expect(s.reason).toBe("provider_has_no_delete_api");
      expect(s.messageJa).toContain("LINE");
      expect(s.source).toContain("developers.line.biz");
    }
  });
  test("Telegram: not_supported — no gateway posting path yet (deleteMessage 48h rule noted)", () => {
    const s = commDeleteSurfaceSupport("telegram");
    expect(s.supported).toBe(false);
    if (!s.supported) {
      expect(s.reason).toBe("no_gateway_post_path");
      expect(s.messageJa).toContain("48");
      expect(s.source).toContain("core.telegram.org");
    }
  });
});

describe("post records (ids only, records which token posted)", () => {
  test("Slack delivery with postedVia → record", () => {
    expect(buildSlackPostRecord({ ok: true, delivery: "slack", channel: "C0123ABCD", ts: "1787911800.000100", postedVia: "user" }))
      .toEqual({ v: 1, surface: "slack", channel: "C0123ABCD", messageId: "1787911800.000100", postedVia: "user" });
  });
  test("stub / failed / missing ids / missing postedVia → no record", () => {
    expect(buildSlackPostRecord({ ok: true, delivery: "stub" })).toBeNull();
    expect(buildSlackPostRecord({ ok: false, error: "x" })).toBeNull();
    expect(buildSlackPostRecord({ ok: true, delivery: "slack", channel: "C0123ABCD", postedVia: "bot" })).toBeNull();
    expect(buildSlackPostRecord({ ok: true, delivery: "slack", channel: "C0123ABCD", ts: "1787911800.000100" })).toBeNull();
    expect(buildSlackPostRecord(undefined)).toBeNull();
  });
});

describe("tool registry / approval policy fit", () => {
  test("comm.delete is a registered gateway tool (mutate, mayAuto, not forced)", () => {
    const r = resolveGatewayTool("comm.delete");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.def.kind).toBe("mutate");
    expect(r.def.mayAuto).toBe(true);
    expect(r.def.forceNeedsApproval).toBe(false);
    expect(isAudienceGatedTool(r.def)).toBe(false);
    expect(isOutboundSendTool(r.def)).toBe(false);
    expect(resolveGatewayTool("comm:delete").ok).toBe(true);
  });
  test("risk is low", () => {
    expect(inferRiskForTool("comm.delete")).toBe("low");
  });
  test("risk_based default: no per-tool hint → no forced human approval; explicit always_human forces it", () => {
    const r = resolveGatewayTool("comm.delete");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(toolRequiresHumanApproval(r.def)).toBe(false);
    expect(toolRequiresHumanApproval(r.def, { "comm.delete": "always_human" })).toBe(true);
  });
  test("preset row: comm.delete risk_based", () => {
    const row = JP_SME_STRICT_APPROVAL_PRESETS.find((item) => item.tool === "comm.delete");
    expect(row?.defaultMode).toBe("risk_based");
  });
  test("normalize keeps deny / always_human for comm.delete (stricter-only), drops auto", () => {
    expect(normalizeToolApprovalDefaults({ "comm.delete": "deny" })["comm.delete"]).toBe("deny");
    expect(normalizeToolApprovalDefaults({ "comm.delete": "always_human" })["comm.delete"]).toBe("always_human");
    expect(normalizeToolApprovalDefaults({ "comm.delete": "auto" })["comm.delete"]).toBeUndefined();
  });
  test("available on every plan that can post (intern / proper / executive)", () => {
    for (const plan of ["intern", "proper", "executive"] as const) {
      expect((PLAN_GATEWAY_SCOPES[plan] as readonly string[]).includes("comm.delete")).toBe(true);
    }
  });
  test("exposed through the MCP staffpass_invoke tool like comm.reply / comm.send", () => {
    const invokeTool = STAFFPASS_MCP_TOOLS.find((item) => item.name === "staffpass_invoke");
    expect(invokeTool?.description).toContain("comm.delete");
  });
});
