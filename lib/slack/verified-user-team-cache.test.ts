/**
 * users.info (Slack-verified speaker team) is called at most once per
 * (org, user) within one invoke, and a successful answer is cached for a short
 * TTL keyed by (orgId, slackUserId). Failures / unverifiable answers are never
 * cached across invokes and can never turn into internal. One org's cached
 * answer never serves another org.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { upsertConversationAdapter } from "@/lib/data/conversation-adapters";
import { setOrgInternalAudienceRule, clearDemoRule } from "@/lib/data/internal-audience-rule";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { parseConversationContext, resolveAudience } from "@/lib/gateway/audience";
import * as botToken from "@/lib/slack/bot-token";
import type { GatewayInvokeRequest } from "@/lib/types";

const ORG_A = DEMO_ORG.id;
const ORG_C = "org_team_cache_other";
const originalFetch = globalThis.fetch;
const realNow = Date.now;
let calls: Array<{ auth: string; user: string }> = [];
let answer: (auth: string) => Response = () => Response.json({ ok: false, error: "user_not_found" });

function reset() {
  (botToken as unknown as { resetSlackUserTeamCacheForTests?: () => void }).resetSlackUserTeamCacheForTests?.();
}

beforeEach(async () => {
  reset();
  calls = [];
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CONVERSATION_BOT_TOKEN;
  await upsertConversationAdapter({ orgId: ORG_A, surface: "slack", enabled: true, secrets: { botToken: "xoxb-cache-a" } });
  await upsertConversationAdapter({ orgId: ORG_C, surface: "slack", enabled: true, secrets: { botToken: "xoxb-cache-c" } });
  await setOrgInternalAudienceRule(ORG_A, { slackTeamIds: ["T0CACHEINT"], autoSlackTeamInternal: true }, "test");
  await setOrgInternalAudienceRule(ORG_C, { slackTeamIds: ["T0CACHEINT"], autoSlackTeamInternal: true }, "test");
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") || "";
    if (url.includes("users.info")) {
      calls.push({ auth, user: new URL(url).searchParams.get("user") || "" });
      return answer(auth);
    }
    if (url.includes("conversations.info")) return Response.json({ ok: true, channel: { is_ext_shared: false } });
    if (url.includes("chat.postMessage")) return Response.json({ ok: true, channel: "C", ts: "1.1" });
    return Response.json({ ok: false, error: "unexpected" });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  Date.now = realNow;
  clearDemoRule();
  reset();
  await upsertConversationAdapter({ orgId: ORG_A, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
  await upsertConversationAdapter({ orgId: ORG_C, surface: "slack", enabled: false, secrets: {} }).catch(() => undefined);
});

const ok = (team: string) => () => Response.json({ ok: true, user: { id: "U0CACHE", team_id: team } });

function ctx(orgId: string) {
  return parseConversationContext(
    { tool: "comm.reply", purpose: "comm.internal", conversation: { surface: "slack", slackUserId: "U0CACHE" } } as GatewayInvokeRequest,
    orgId
  )!;
}

function invoke(jobId: string) {
  return runGatewayInvoke({
    employeeId: "emp_comm",
    credentialId: "cred_comm",
    body: {
      tool: "comm.reply",
      purpose: "comm.internal",
      jobId,
      conversation: { surface: "slack", slackChannelId: "C0CACHECH", speakerId: "U0CACHE" },
      args: { slackChannelId: "C0CACHECH", text: "本文" },
    } as GatewayInvokeRequest,
  });
}

describe("one invoke → at most one users.info per (org, user)", () => {
  test("verified team: one call for the whole invoke", async () => {
    answer = ok("T0CACHEINT");
    await invoke(`job_cache_ok_${realNow().toString(36)}`);
    expect(calls.length).toBe(1);
  });

  test("unverifiable (error): still one call for the whole invoke, and the verdict is not internal", async () => {
    answer = () => Response.json({ ok: false, error: "missing_scope" });
    const r = await invoke(`job_cache_err_${realNow().toString(36)}`);
    expect(calls.length).toBe(1);
    expect((r.body.egress as { audience?: string } | undefined)?.audience).not.toBe("internal");
  });
});

describe("TTL cache keyed by (orgId, slackUserId)", () => {
  test("a verified answer is reused across calls within the TTL", async () => {
    answer = ok("T0CACHEINT");
    expect((await resolveAudience(ctx(ORG_A))).audience).toBe("internal");
    expect((await resolveAudience(ctx(ORG_A))).audience).toBe("internal");
    expect(calls.length).toBe(1);
  });

  test("never shared across orgs: org C asks Slack with its own token", async () => {
    answer = (auth) => (auth.endsWith("xoxb-cache-a") ? ok("T0CACHEINT")() : Response.json({ ok: false, error: "user_not_found" }));
    expect((await resolveAudience(ctx(ORG_A))).audience).toBe("internal");
    const c = await resolveAudience(ctx(ORG_C));
    expect(c.audience).not.toBe("internal");
    expect(calls.map((x) => x.auth)).toEqual(["Bearer xoxb-cache-a", "Bearer xoxb-cache-c"]);
  });

  test("expires after the TTL (60s)", async () => {
    answer = ok("T0CACHEINT");
    await resolveAudience(ctx(ORG_A));
    Date.now = () => realNow() + 61_000;
    answer = ok("T0OUTSIDER");
    expect((await resolveAudience(ctx(ORG_A))).audience).not.toBe("internal");
    expect(calls.length).toBe(2);
  });

  test("errors are not cached: a later call asks Slack again, and an error never yields internal", async () => {
    answer = () => Response.json({ ok: false, error: "ratelimited" });
    expect((await resolveAudience(ctx(ORG_A))).audience).not.toBe("internal");
    expect((await resolveAudience(ctx(ORG_A))).audience).not.toBe("internal");
    expect(calls.length).toBe(2);
    answer = ok("T0CACHEINT");
    expect((await resolveAudience(ctx(ORG_A))).audience).toBe("internal");
  });
});
