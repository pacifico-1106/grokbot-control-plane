/**
 * MCP endpoint handoff — shared, channel-independent module (unit tests).
 * @see /workspace/p0/mcp-endpoint-handoff-design-20261004.md (PR body)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeAudit, pushRuntimeAuditEvent } from "@/lib/demo-data";
import { isMcpEndpointHandoffEnabled } from "@/lib/feature-flags";
import type { AuditEvent } from "@/lib/types";
import {
  MCP_HANDOFF_SCHEMA,
  MCP_ACTIVITY_LOOKBEHIND_MS,
  buildMcpHandoff,
  evaluateMcpNotConnected,
  getMcpConnectionState,
  isMcpHandoffWakeAudit,
  recordMcpClientSeen,
  resetMcpClientSeenThrottleForTests,
  resolveMcpEndpointUrl,
  withMcpHandoff,
} from "@/lib/mcp/endpoint-handoff";

const FLAG = "MCP_ENDPOINT_HANDOFF_ENABLED";
let savedFlag: string | undefined;
let savedAppUrl: string | undefined;

beforeEach(() => {
  savedFlag = process.env[FLAG];
  savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  resetMcpClientSeenThrottleForTests();
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
});

const MIN = 60_000;

function audit(
  partial: Partial<AuditEvent> & { action: string; at: number }
): AuditEvent {
  return {
    id: `aud_${partial.action}_${partial.at}_${Math.random().toString(36).slice(2, 6)}`,
    orgId: partial.orgId ?? "org_x",
    employeeId: partial.employeeId ?? "emp_x",
    credentialId: partial.credentialId ?? null,
    action: partial.action,
    purpose: partial.purpose ?? null,
    summary: partial.summary ?? "",
    metadata: partial.metadata ?? {},
    createdAt: new Date(partial.at).toISOString(),
  } as AuditEvent;
}

function handoffWake(at: number, extra: Record<string, unknown> = {}): AuditEvent {
  return audit({
    action: "slack.mention_wake",
    at,
    metadata: { reason: "woke", channel: "C1", ts: "1.1", mcpHandoff: true, surface: "slack", ...extra },
  });
}

describe("flag", () => {
  test("MCP_ENDPOINT_HANDOFF_ENABLED defaults OFF", () => {
    delete process.env[FLAG];
    expect(isMcpEndpointHandoffEnabled()).toBe(false);
    process.env[FLAG] = "true";
    expect(isMcpEndpointHandoffEnabled()).toBe(true);
    process.env[FLAG] = "0";
    expect(isMcpEndpointHandoffEnabled()).toBe(false);
  });
});

describe("endpoint resolution (no hardcode)", () => {
  test("built from the app base URL config", () => {
    expect(resolveMcpEndpointUrl({ NEXT_PUBLIC_APP_URL: "https://tenant-a.example.test/" })).toBe(
      "https://tenant-a.example.test/api/mcp"
    );
    expect(resolveMcpEndpointUrl({ NEXT_PUBLIC_APP_URL: "http://localhost:4100" })).toBe(
      "http://localhost:4100/api/mcp"
    );
  });

  test("production never yields loopback (falls back to canonical https)", () => {
    expect(
      resolveMcpEndpointUrl({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "http://localhost:3000" })
    ).toBe("https://staffpass.sealith.com/api/mcp");
  });
});

describe("buildMcpHandoff", () => {
  test("machine-readable block with endpoint, steps and connectivity check", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://handoff.example.test";
    const block = buildMcpHandoff({ employeeId: "emp_a" });
    expect(block.schema).toBe(MCP_HANDOFF_SCHEMA);
    expect(block.schema).toBe("staffpass.mcp_handoff.v1");
    expect(block.employeeId).toBe("emp_a");
    expect(block.mcp.url).toBe("https://handoff.example.test/api/mcp");
    expect(block.mcp.transport).toBe("streamable_http");
    expect(block.mcp.serverCardUrl).toBe(
      "https://handoff.example.test/.well-known/mcp/server-card.json"
    );
    expect(block.mcp.auth.type).toBe("bearer");
    expect(block.mcp.auth.header).toBe("Authorization");
    expect(block.mcp.auth.included).toBe(false);
    expect(block.connectivityCheck.tool).toBe("staffpass_whoami");
    expect(block.connectivityCheck.fallbackTool).toBe("staffpass_health");
    expect(block.connectivityCheck.jsonRpc).toEqual({
      method: "tools/call",
      params: { name: "staffpass_whoami", arguments: {} },
    });
    expect(block.connectivityCheck.expect.employeeId).toBe("emp_a");
    expect(block.reply).toEqual({ mcpTool: "staffpass_invoke", gatewayTool: "comm.reply" });
    expect(block.setupSteps.map((s) => s.id)).toEqual([
      "register_mcp_server",
      "attach_badge",
      "verify",
    ]);
    expect(block.setupSteps[0].ja).toContain("https://handoff.example.test/api/mcp");
    expect(block.ifNotConnectedJa).toContain("staffpass_whoami");
    expect(block.wake).toBeUndefined();
  });

  test("wake context is carried when given", () => {
    const block = buildMcpHandoff({
      employeeId: "emp_a",
      wake: { surface: "line", kind: "approval_resolved", trigger: "approved" },
      connection: { status: "not_seen", lastSeenAt: null },
    });
    expect(block.wake).toEqual({ surface: "line", kind: "approval_resolved", trigger: "approved" });
    expect(block.connection).toEqual({ status: "not_seen", lastSeenAt: null });
  });

  test("never contains secrets (badge, tokens, signed URLs)", () => {
    const block = buildMcpHandoff({
      employeeId: "emp_a",
      wake: { surface: "slack", kind: "conversation", trigger: "mention" },
    });
    const json = JSON.stringify(block);
    expect(json).not.toMatch(/gb_emp_[A-Za-z0-9]{8,}/);
    expect(json).not.toMatch(/xox[abpr]-/);
    expect(json).not.toMatch(/token=/i);
    expect(json).not.toMatch(/statusToken/i);
    expect(json).not.toMatch(/[A-Za-z0-9]{32,}/);
  });
});

describe("withMcpHandoff", () => {
  test("flag OFF returns the exact same payload object (no behavior change)", async () => {
    delete process.env[FLAG];
    const payload = { channel: "C1", text: "hi" };
    const out = await withMcpHandoff(payload, {
      orgId: DEMO_ORG.id,
      employeeId: "emp_comm",
      surface: "slack",
      kind: "conversation",
      trigger: "mention",
    });
    expect(out).toBe(payload);
    expect("mcpHandoff" in out).toBe(false);
  });

  test("flag ON adds mcpHandoff with surface + connection status", async () => {
    process.env[FLAG] = "true";
    const payload = { channel: "C1", text: "hi" };
    const out = await withMcpHandoff(payload, {
      orgId: DEMO_ORG.id,
      employeeId: "emp_nobody_seen",
      surface: "telegram",
      kind: "approval_resolved",
      trigger: "rejected",
    });
    expect(out).not.toBe(payload);
    expect(out.channel).toBe("C1");
    expect(out.mcpHandoff?.wake?.surface).toBe("telegram");
    expect(out.mcpHandoff?.connection?.status).toBe("not_seen");
    expect("mcpHandoff" in payload).toBe(false);
  });
});

describe("recordMcpClientSeen + getMcpConnectionState", () => {
  test("flag OFF records nothing", async () => {
    delete process.env[FLAG];
    const before = getRuntimeAudit().length;
    await recordMcpClientSeen(
      { employeeId: "emp_seen_off", orgId: DEMO_ORG.id, credentialId: "cred_1", generation: 1 },
      "tools/list"
    );
    expect(getRuntimeAudit().length).toBe(before);
  });

  test("flag ON records once per throttle window, never the secret", async () => {
    process.env[FLAG] = "true";
    const cred = { employeeId: "emp_seen_on", orgId: DEMO_ORG.id, credentialId: "cred_2", generation: 3 };
    await recordMcpClientSeen(cred, "tools/list");
    await recordMcpClientSeen(cred, "tools/call", "staffpass_whoami");
    const rows = getRuntimeAudit().filter(
      (e) => e.action === "mcp.client_seen" && e.employeeId === "emp_seen_on"
    );
    expect(rows.length).toBe(1);
    expect(rows[0].credentialId).toBe("cred_2");
    expect(rows[0].metadata?.method).toBe("tools/list");
    expect(rows[0].metadata?.generation).toBe(3);
    const state = await getMcpConnectionState(DEMO_ORG.id, "emp_seen_on");
    expect(state.status).toBe("seen");
    expect(state.lastSeenAt).toBeTruthy();
  });

  test("not_connected_suspected after a notify with no later activity", async () => {
    process.env[FLAG] = "true";
    pushRuntimeAuditEvent({
      orgId: DEMO_ORG.id,
      employeeId: "emp_nc_state",
      credentialId: null,
      action: "mcp_handoff.not_connected_notify",
      purpose: "mcp_handoff",
      summary: "x",
      metadata: { itemId: "mcp_nc:emp_nc_state:w" },
    });
    const state = await getMcpConnectionState(DEMO_ORG.id, "emp_nc_state");
    expect(state.status).toBe("not_connected_suspected");
  });
});

describe("evaluateMcpNotConnected (fail-safe)", () => {
  const now = Date.parse("2026-10-04T05:00:00Z");
  const wakeAt = now - 20 * MIN;
  const old = audit({ action: "admin.hire", at: wakeAt - 60 * MIN });

  test("eligible: delivered handoff wake, no credential activity", () => {
    const wake = handoffWake(wakeAt);
    const r = evaluateMcpNotConnected({ wake, audits: [wake, old], now: new Date(now), complete: false });
    expect(r.eligible).toBe(true);
    expect(r.itemId).toBe(`mcp_nc:emp_x:${wake.id}`);
  });

  test("not a handoff wake (flag was OFF when sent) → skip", () => {
    const wake = handoffWake(wakeAt, { mcpHandoff: undefined });
    expect(isMcpHandoffWakeAudit(wake)).toBe(false);
    const r = evaluateMcpNotConnected({ wake, audits: [wake, old], now: new Date(now), complete: false });
    expect(r).toMatchObject({ eligible: false, reason: "not_handoff_wake" });
  });

  test("wake not delivered (wake_failed / missing url) → skip", () => {
    for (const reason of ["wake_failed", "wake_webhook_missing"]) {
      const wake = handoffWake(wakeAt, { reason });
      const r = evaluateMcpNotConnected({ wake, audits: [wake, old], now: new Date(now), complete: false });
      expect(r.eligible).toBe(false);
    }
  });

  test("too soon / too old → skip", () => {
    const soon = handoffWake(now - 3 * MIN);
    expect(
      evaluateMcpNotConnected({ wake: soon, audits: [soon, old], now: new Date(now), complete: false }).reason
    ).toBe("too_soon");
    const stale = handoffWake(now - 25 * 60 * MIN);
    expect(
      evaluateMcpNotConnected({ wake: stale, audits: [stale], now: new Date(now), complete: true }).reason
    ).toBe("too_old");
  });

  test("any credential activity after the wake → skip", () => {
    const wake = handoffWake(wakeAt);
    for (const act of [
      audit({ action: "mcp.client_seen", at: wakeAt + MIN, credentialId: "c" }),
      audit({ action: "tool.invoke", at: wakeAt + 2 * MIN }),
      audit({ action: "approval.requested", at: wakeAt + 2 * MIN, credentialId: "c" }),
    ]) {
      const r = evaluateMcpNotConnected({ wake, audits: [act, wake, old], now: new Date(now), complete: false });
      expect(r).toMatchObject({ eligible: false, reason: "activity_seen" });
    }
  });

  test("seen shortly BEFORE the wake (throttled window) still counts as connected", () => {
    const wake = handoffWake(wakeAt);
    const seen = audit({ action: "mcp.client_seen", at: wakeAt - (MCP_ACTIVITY_LOOKBEHIND_MS - MIN), credentialId: "c" });
    const r = evaluateMcpNotConnected({ wake, audits: [wake, seen, old], now: new Date(now), complete: false });
    expect(r).toMatchObject({ eligible: false, reason: "activity_seen" });
  });

  test("other employee's activity does not count (tenant/employee isolation)", () => {
    const wake = handoffWake(wakeAt);
    const other = audit({ action: "mcp.client_seen", at: wakeAt + MIN, employeeId: "emp_other", credentialId: "c" });
    const r = evaluateMcpNotConnected({ wake, audits: [other, wake, old], now: new Date(now), complete: false });
    expect(r.eligible).toBe(true);
  });

  test("insufficient history (audit window does not reach before the wake) → skip", () => {
    const wake = handoffWake(wakeAt);
    const r = evaluateMcpNotConnected({ wake, audits: [wake], now: new Date(now), complete: false });
    expect(r).toMatchObject({ eligible: false, reason: "insufficient_history" });
    const ok = evaluateMcpNotConnected({ wake, audits: [wake], now: new Date(now), complete: true });
    expect(ok.eligible).toBe(true);
  });

  test("cooldown: already notified for this employee within 24h → skip", () => {
    const wake = handoffWake(wakeAt);
    const prior = audit({
      action: "mcp_handoff.not_connected_notify",
      at: now - 5 * 60 * MIN,
      metadata: { itemId: "mcp_nc:emp_x:older" },
    });
    const r = evaluateMcpNotConnected({ wake, audits: [wake, prior, old], now: new Date(now), complete: false });
    expect(r).toMatchObject({ eligible: false, reason: "cooldown" });
  });
});
