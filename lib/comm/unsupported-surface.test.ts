/**
 * C / H1 (design §6): unsupported-surface delivery is fail-closed.
 * LP-SND-01 / LP-SND-07. Flag DELIVERY_UNSUPPORTED_SURFACE_ENABLED default OFF.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_ORG } from "@/lib/demo-data";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { upsertOrgChannel } from "@/lib/data/directory";
import type { GatewayInvokeRequest } from "@/lib/types";

async function uns() {
  return import("@/lib/comm/unsupported-surface");
}

const DM = "D0UNSUP01";
const TEXT = "未対応窓口の本文は送ってはいけない";
const originalFetch = globalThis.fetch;
type Call = { url: string };
let calls: Call[] = [];

function recordProviders() {
  calls = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ url });
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String(init?.body || "{}"));
    } catch {
      /* form */
    }
    if (url.includes("chat.postMessage")) {
      return Response.json({ ok: true, channel: body.channel, ts: "1791200000.000001" });
    }
    if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
    if (url.includes("api.line.me")) return Response.json({});
    return Response.json({ ok: false, error: "unexpected_fetch" });
  }) as typeof fetch;
}
const slackPosts = () => calls.filter((c) => c.url.includes("chat.postMessage"));
const linePosts = () => calls.filter((c) => c.url.includes("api.line.me"));

const FLAGS = [
  "DELIVERY_UNSUPPORTED_SURFACE_ENABLED",
  "DELIVERY_UNSUPPORTED_SURFACE_ORG_IDS",
  "COMM_ACCOUNTS_ENABLED",
  "LINE_CONVERSATION_ENABLED",
] as const;
const saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeAll(async () => {
  await upsertOrgChannel({
    orgId: DEMO_ORG.id,
    surface: "slack",
    externalId: DM,
    classification: "internal",
    mixed: false,
    skipInspect: true,
  });
  await upsertConversationAdapter({
    orgId: DEMO_ORG.id,
    surface: "slack",
    enabled: true,
    secrets: { botToken: "xoxb-unsup-test" },
  });
});

const jid = (p: string) => `job_unsup_${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
function req(
  tool: string,
  conversation: Record<string, unknown>,
  extraArgs: Record<string, unknown> = {}
): GatewayInvokeRequest {
  return {
    tool,
    purpose: "comm.internal",
    jobId: jid(tool),
    conversation: { orgId: DEMO_ORG.id, ...conversation },
    args: { text: TEXT, ...extraArgs },
  } as unknown as GatewayInvokeRequest;
}
const invoke = (b: GatewayInvokeRequest) => runGatewayInvoke({ employeeId: "emp_comm", credentialId: "cred_comm", body: b });

function expectNotSent(body: Record<string, unknown>) {
  expect(body.ok).toBe(false);
  expect(body.sent).toBe(false);
  expect(body.accepted).not.toBe(true);
  expect(JSON.stringify(body.result ?? null)).not.toContain('"accepted":true');
  expect(String(body.message)).toContain("送信していません");
  expect(JSON.stringify(body)).not.toContain(TEXT);
}

describe("DELIVERY_UNSUPPORTED_SURFACE_ENABLED default OFF", () => {
  test("unset → OFF; explicit ON; org allowlist", async () => {
    const { isDeliveryUnsupportedSurfaceEnabled } = await uns();
    delete process.env.DELIVERY_UNSUPPORTED_SURFACE_ENABLED;
    delete process.env.DELIVERY_UNSUPPORTED_SURFACE_ORG_IDS;
    expect(isDeliveryUnsupportedSurfaceEnabled()).toBe(false);
    expect(isDeliveryUnsupportedSurfaceEnabled("aaaaaaaa-0000-4000-8000-000000000307")).toBe(false);
    process.env.DELIVERY_UNSUPPORTED_SURFACE_ENABLED = "true";
    expect(isDeliveryUnsupportedSurfaceEnabled()).toBe(true);
    process.env.DELIVERY_UNSUPPORTED_SURFACE_ORG_IDS = "aaaaaaaa-0000-4000-8000-000000000307";
    expect(isDeliveryUnsupportedSurfaceEnabled("aaaaaaaa-0000-4000-8000-000000000307")).toBe(true);
    expect(isDeliveryUnsupportedSurfaceEnabled("bbbbbbbb-0000-4000-8000-000000000001")).toBe(false);
  });
});

describe("H1 verdict: declared non-Slack surface is unsupported (no adapter)", () => {
  test("slack is allowed; mail / phone / line / telegram / line_works are refused", async () => {
    const { unsupportedSurfaceDeliveryVerdict } = await uns();
    expect(unsupportedSurfaceDeliveryVerdict({ surface: "slack" }).refuse).toBe(false);
    expect(unsupportedSurfaceDeliveryVerdict({ surface: "mail" }).refuse).toBe(true);
    expect(unsupportedSurfaceDeliveryVerdict({ surface: "phone" }).refuse).toBe(true);
    expect(unsupportedSurfaceDeliveryVerdict({ surface: "line" }).refuse).toBe(true);
    expect(unsupportedSurfaceDeliveryVerdict({ surface: "telegram" }).refuse).toBe(true);
    expect(unsupportedSurfaceDeliveryVerdict({ surface: "line_works" }).refuse).toBe(true);
    expect(unsupportedSurfaceDeliveryVerdict({ surface: "web" }).refuse).toBe(true);
  });

  test("LINE conversation adapter (token path) is the only non-Slack exception", async () => {
    const { unsupportedSurfaceDeliveryVerdict } = await uns();
    expect(unsupportedSurfaceDeliveryVerdict({ surface: "line", lineConversation: true }).refuse).toBe(false);
    expect(unsupportedSurfaceDeliveryVerdict({ surface: "mail", lineConversation: true }).refuse).toBe(true);
  });

  test("declaredConversationSurface reads conversation.surface, not Slack dest fields", async () => {
    const { declaredConversationSurface } = await uns();
    expect(
      declaredConversationSurface({
        conversation: { surface: "mail" },
        args: { channel: DM },
      })
    ).toBe("mail");
    expect(declaredConversationSurface({ conversation: { surface: "slack" } })).toBe("slack");
    expect(declaredConversationSurface({ args: { channel: DM } })).toBeNull();
  });
});

describe("LP-SND-01: LINE without conversation path is not sent", () => {
  test("flag OFF: comm.reply surface=line → 409 delivery_unsupported_surface, no provider call", async () => {
    delete process.env.DELIVERY_UNSUPPORTED_SURFACE_ENABLED;
    recordProviders();
    const res = await invoke(req("comm.reply", { surface: "line", lineId: "Uaaaabbbbccccddddeeeeffff00001111" }));
    expect(res.httpStatus).toBe(409);
    expect(res.body.code).toBe("delivery_unsupported_surface");
    expectNotSent(res.body as Record<string, unknown>);
    expect(slackPosts()).toHaveLength(0);
    expect(linePosts()).toHaveLength(0);
  });
});

describe("flag ON: do not send an unsupported surface to Slack (fail-closed)", () => {
  test("mail + Slack channel args → 409, no chat.postMessage", async () => {
    process.env.DELIVERY_UNSUPPORTED_SURFACE_ENABLED = "true";
    recordProviders();
    const res = await invoke(req("comm.reply", { surface: "mail", email: "yamada@example.com" }, { channel: DM }));
    expect(res.httpStatus).toBe(409);
    expect(res.body.code).toBe("delivery_unsupported_surface");
    expectNotSent(res.body as Record<string, unknown>);
    expect(slackPosts()).toHaveLength(0);
  });

  test("phone / line + Slack dest fields still refuse (never another surface)", async () => {
    process.env.DELIVERY_UNSUPPORTED_SURFACE_ENABLED = "true";
    recordProviders();
    for (const conv of [
      { surface: "phone", phone: "+819000000000" },
      { surface: "line", lineId: "Uaaaabbbbccccddddeeeeffff00001111" },
    ]) {
      const res = await invoke(req("comm.send", conv, { slackChannelId: DM }));
      expect({ conv, code: res.body.code, sent: res.body.sent, posts: slackPosts().length }).toEqual({
        conv,
        code: "delivery_unsupported_surface",
        sent: false,
        posts: 0,
      });
    }
  });

  test("lock-in: Slack DM still posts when the declared surface is slack", async () => {
    process.env.DELIVERY_UNSUPPORTED_SURFACE_ENABLED = "true";
    recordProviders();
    const res = await invoke(req("comm.reply", { surface: "slack", slackChannelId: DM, speakerId: "U_YAMADA" }));
    expect(res.httpStatus).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(slackPosts()).toHaveLength(1);
  });
});

describe("C extract: invoke reads the common verdict when the flag is ON", () => {
  test("source-lock", () => {
    const invokeSrc = readFileSync(join(process.cwd(), "lib/gateway/invoke.ts"), "utf8");
    expect(invokeSrc).toContain("unsupportedSurfaceDeliveryVerdict");
    expect(invokeSrc).toContain("isDeliveryUnsupportedSurfaceEnabled");
    expect(invokeSrc).toContain("declaredConversationSurface");
  });
});
