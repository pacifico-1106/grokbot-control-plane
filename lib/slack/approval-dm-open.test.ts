/**
 * SLACK_APPROVAL_DM_AUTO_OPEN (PR-2): approval app delivery DM auto-open +
 * single 「設定しました」 notice. Demo mode, network mocked.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PUT } from "@/app/api/settings/notification-channels/route";
import { listNotificationChannels } from "@/lib/data";
import { DEMO_ORG, getRuntimeAudit } from "@/lib/demo-data";
import {
  APPROVAL_SETUP_NOTICE_TEXT,
  openApprovalDeliveryDm,
  pickApprovalDeliveryUser,
  sendApprovalSetupNotice,
} from "@/lib/slack/approval-dm-open";
import { slackApiArgs, slackRequestHeader } from "@/tests/helpers/slack-api-args";

const TEAM = "TAPPROVE1";
const TOKEN = "xoxb-approval-SECRET-777";
const SIGNING = "signing-SECRET-888";
const APPROVER = "UAPPROVER1";
const DM = "DAPPROVEDM1";

type Call = { method: string; body: Record<string, unknown>; auth: string; raw: string; contentType: string };
let calls: Call[] = [];
let savedFetch: typeof globalThis.fetch;
let savedFlag: string | undefined;
let user: Record<string, unknown>;
let failures: Record<string, string>;
let dmExtra: Record<string, unknown>;
let infoChannel: Record<string, unknown>;

function installFetch() {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const method = href.replace("https://slack.com/api/", "").split("?")[0];
    const body = slackApiArgs(method, init);
    const auth = slackRequestHeader(init, "authorization");
    calls.push({ method, body, auth, raw: init?.body == null ? "" : String(init.body), contentType: slackRequestHeader(init, "content-type") });
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (failures[method]) {
      const [error, needed] = failures[method].split("|");
      return json({ ok: false, error, ...(needed ? { needed } : {}) });
    }
    if (method === "auth.test") return json({ ok: true, team_id: TEAM, bot_id: "B1", user_id: "UBOT" });
    if (method === "users.info") return json({ ok: true, user });
    if (method === "conversations.open") return json({ ok: true, channel: { id: DM, is_im: true, ...dmExtra } });
    if (method === "conversations.info") return json({ ok: true, channel: { id: DM, is_im: true, ...infoChannel } });
    if (method === "chat.postMessage") return json({ ok: true, ts: "1791.0001", channel: body.channel });
    return json({ ok: false, error: "unknown_method" });
  }) as unknown as typeof fetch;
}

function put(body: Record<string, unknown>) {
  return PUT(new Request("http://localhost/api/settings/notification-channels", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function slackBody(extra: Record<string, unknown> = {}) {
  return {
    provider: "slack",
    enabled: true,
    isDefault: false,
    label: `承認用Slack-${Math.random().toString(36).slice(2, 7)}`,
    channelId: "",
    allowedUserIds: APPROVER,
    botToken: TOKEN,
    signingSecret: SIGNING,
    ...extra,
  };
}

function auditEvents(event: string) {
  return getRuntimeAudit().filter((a) => a.orgId === DEMO_ORG.id && a.metadata?.event === event);
}

beforeEach(() => {
  savedFlag = process.env.SLACK_APPROVAL_DM_AUTO_OPEN;
  process.env.SLACK_APPROVAL_DM_AUTO_OPEN = "1";
  savedFetch = globalThis.fetch;
  user = { id: APPROVER, team_id: TEAM, deleted: false, is_bot: false, is_restricted: false, is_ultra_restricted: false };
  failures = {};
  dmExtra = {};
  infoChannel = {};
  installFetch();
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env.SLACK_APPROVAL_DM_AUTO_OPEN;
  else process.env.SLACK_APPROVAL_DM_AUTO_OPEN = savedFlag;
  globalThis.fetch = savedFetch;
});

describe("pickApprovalDeliveryUser", () => {
  test("one allowed user → that user; several → explicit member required", () => {
    expect(pickApprovalDeliveryUser(["UAAA1"])).toEqual({ ok: true, userId: "UAAA1" });
    expect(pickApprovalDeliveryUser(["UAAA1", "UBBB2"])).toMatchObject({ ok: false, code: "delivery_user_required" });
    expect(pickApprovalDeliveryUser(["UAAA1", "UBBB2"], "UBBB2")).toEqual({ ok: true, userId: "UBBB2" });
    expect(pickApprovalDeliveryUser(["UAAA1"], "UEVIL9")).toMatchObject({ ok: false, code: "delivery_user_not_allowed" });
    expect(pickApprovalDeliveryUser([])).toMatchObject({ ok: false, code: "allowed_user_required" });
    expect(pickApprovalDeliveryUser(["not-an-id"])).toMatchObject({ ok: false, code: "invalid_slack_user_id" });
  });
});

describe("openApprovalDeliveryDm (fail-closed)", () => {
  test("happy path uses the bot token only in the header and returns the D…", async () => {
    const result = await openApprovalDeliveryDm({ botToken: TOKEN, allowedUserIds: [APPROVER] });
    expect(result).toEqual({ ok: true, channelId: DM, userId: APPROVER, teamId: TEAM });
    expect(calls.map((c) => c.method)).toEqual(["auth.test", "users.info", "conversations.open"]);
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  const rejects: Array<[string, Record<string, unknown>, string]> = [
    ["stranger", { is_stranger: true }, "approval_user_external"],
    ["other team", { team_id: "TOTHER" }, "approval_user_external"],
    ["grid other workspace", { enterprise_user: { teams: ["TOTHER"] } }, "approval_user_external"],
    ["no team", { team_id: "" }, "approval_user_undeterminable"],
    ["guest", { is_restricted: true }, "approval_user_guest"],
    ["bot", { is_bot: true }, "approval_user_inactive"],
    ["deleted", { deleted: true }, "approval_user_inactive"],
    ["id mismatch", { id: "USOMEONE" }, "approval_user_undeterminable"],
  ];
  for (const [label, extra, code] of rejects) {
    test(`${label} → ${code}, DM never opened`, async () => {
      user = { ...user, ...extra };
      const result = await openApprovalDeliveryDm({ botToken: TOKEN, allowedUserIds: [APPROVER] });
      expect(result).toMatchObject({ ok: false, code });
      expect(calls.map((c) => c.method)).not.toContain("conversations.open");
    });
  }

  test("missing users:read / im:write → names the missing scope", async () => {
    failures["users.info"] = "missing_scope|users:read";
    expect(await openApprovalDeliveryDm({ botToken: TOKEN, allowedUserIds: [APPROVER] })).toMatchObject({
      ok: false, code: "approval_app_missing_scope", missingScope: "users:read",
    });
    failures = { "conversations.open": "missing_scope" };
    expect(await openApprovalDeliveryDm({ botToken: TOKEN, allowedUserIds: [APPROVER] })).toMatchObject({
      ok: false, code: "approval_app_missing_scope", missingScope: "im:write",
    });
  });

  test("ext-shared DM → rejected", async () => {
    dmExtra = { is_ext_shared: true };
    expect(await openApprovalDeliveryDm({ botToken: TOKEN, allowedUserIds: [APPROVER] })).toMatchObject({ ok: false, code: "approval_user_external" });
  });

  test("non-xoxb / empty token → rejected without any Slack call", async () => {
    expect(await openApprovalDeliveryDm({ botToken: "xoxp-user-token", allowedUserIds: [APPROVER] })).toMatchObject({ ok: false, code: "bot_token_required" });
    expect(await openApprovalDeliveryDm({ botToken: "", allowedUserIds: [APPROVER] })).toMatchObject({ ok: false, code: "bot_token_required" });
    expect(calls.length).toBe(0);
  });

  test("hotfix: users.info / auth.test are form-encoded (user=U… in the body), token only in the header", async () => {
    const result = await openApprovalDeliveryDm({ botToken: TOKEN, allowedUserIds: [APPROVER] });
    expect(result).toMatchObject({ ok: true, userId: APPROVER });
    const info = calls.find((c) => c.method === "users.info")!;
    expect(info.contentType).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(info.raw).get("user")).toBe(APPROVER);
    expect(info.raw).toBe(`user=${APPROVER}`);
    const auth = calls.find((c) => c.method === "auth.test")!;
    expect(auth.contentType).toBe("application/x-www-form-urlencoded");
    for (const call of calls) {
      expect(call.raw).not.toContain(TOKEN);
      expect(call.raw).not.toContain("token");
      expect(call.auth).toBe(`Bearer ${TOKEN}`);
    }
  });

  test("hotfix: conversations.open / chat.postMessage stay JSON", async () => {
    await openApprovalDeliveryDm({ botToken: TOKEN, allowedUserIds: [APPROVER] });
    await sendApprovalSetupNotice(TOKEN, DM);
    const open = calls.find((c) => c.method === "conversations.open")!;
    expect(open.contentType).toBe("application/json; charset=utf-8");
    expect(JSON.parse(open.raw)).toEqual({ users: APPROVER, return_im: true });
    const post = calls.find((c) => c.method === "chat.postMessage")!;
    expect(post.contentType).toBe("application/json; charset=utf-8");
    expect(JSON.parse(post.raw)).toEqual({ channel: DM, text: APPROVAL_SETUP_NOTICE_TEXT });
    expect(open.raw + post.raw).not.toContain(TOKEN);
  });

  test("setup notice posts the fixed text once; failure is reported", async () => {
    expect(await sendApprovalSetupNotice(TOKEN, DM)).toMatchObject({ ok: true });
    expect(calls.filter((c) => c.method === "chat.postMessage").map((c) => c.body)).toEqual([{ channel: DM, text: APPROVAL_SETUP_NOTICE_TEXT }]);
    expect(APPROVAL_SETUP_NOTICE_TEXT).toContain("設定しました");
    failures["chat.postMessage"] = "channel_not_found";
    expect(await sendApprovalSetupNotice(TOKEN, DM)).toMatchObject({ ok: false, code: "setup_notice_failed" });
  });
});

describe("PUT /api/settings/notification-channels (org admin route)", () => {
  test("flag OFF: empty channel ID still rejected as before, no Slack call", async () => {
    delete process.env.SLACK_APPROVAL_DM_AUTO_OPEN;
    const res = await put(slackBody());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("destination_required");
    expect(calls.length).toBe(0);
  });

  test("flag OFF: manual D… save sends no notice (unchanged behavior)", async () => {
    delete process.env.SLACK_APPROVAL_DM_AUTO_OPEN;
    const res = await put(slackBody({ channelId: DM }));
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.method)).not.toContain("chat.postMessage");
  });

  test("flag ON: empty channel ID → DM opened, one notice, saved with destination + markers, audited, no secrets in response", async () => {
    const res = await put(slackBody());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.channel.config.channelId).toBe(DM);
    expect(body.channel.config.expectedTeamId).toBe(TEAM);
    expect(body.channel.config.autoOpened.userId).toBe(APPROVER);
    expect(typeof body.channel.config.setupNoticeAt).toBe("string");
    expect(body.autoOpened).toEqual({ userId: APPROVER, channelId: DM });
    expect(body.setupNotice.ok).toBe(true);
    expect(calls.filter((c) => c.method === "chat.postMessage").length).toBe(1);
    const text = JSON.stringify(body);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SIGNING);
    const sent = auditEvents("approval_dm.setup_notice_sent").at(0);
    expect(sent?.action).toBe("admin.notificationChannel");
    expect(sent?.metadata?.auditClass).toBe("admin");
    expect(JSON.stringify(getRuntimeAudit().slice(0, 5))).not.toContain(TOKEN);

    // Re-save with the same destination → no second notice; markers kept.
    calls = [];
    const again = await put({ ...slackBody({ channelId: DM, label: body.channel.label }), id: body.channel.id, botToken: "" });
    const againBody = await again.json();
    expect(again.status).toBe(200);
    expect(calls.map((c) => c.method)).not.toContain("chat.postMessage");
    expect(againBody.channel.config.setupNoticeAt).toBe(body.channel.config.setupNoticeAt);
  });

  test("flag ON: notice fails → nothing saved (fail-closed) + audited", async () => {
    const before = (await listNotificationChannels(DEMO_ORG.id)).length;
    failures["chat.postMessage"] = "not_in_channel";
    const res = await put(slackBody());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("setup_notice_failed");
    expect((await listNotificationChannels(DEMO_ORG.id)).length).toBe(before);
    expect(auditEvents("approval_dm.setup_notice_failed").length).toBeGreaterThan(0);
  });

  test("flag ON: stranger approver → 400, nothing saved, rejection audited", async () => {
    const before = (await listNotificationChannels(DEMO_ORG.id)).length;
    user = { ...user, is_stranger: true };
    const res = await put(slackBody());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("approval_user_external");
    expect((await listNotificationChannels(DEMO_ORG.id)).length).toBe(before);
    expect(auditEvents("approval_dm.auto_open_rejected").at(0)?.metadata?.code).toBe("approval_user_external");
  });

  test("flag ON: several allowed users without deliveryUserId → 400; with it → opens that user's DM", async () => {
    const res = await put(slackBody({ allowedUserIds: `${APPROVER},UOTHER22` }));
    expect((await res.json()).error).toBe("delivery_user_required");
    const ok = await put(slackBody({ allowedUserIds: `UOTHER22,${APPROVER}`, deliveryUserId: APPROVER }));
    expect(ok.status).toBe(200);
    expect(calls.filter((c) => c.method === "conversations.open").at(-1)?.body.users).toBe(APPROVER);
  });

  test("flag ON: the existing ext-shared guard still applies to the opened DM", async () => {
    infoChannel = { is_ext_shared: true };
    const res = await put(slackBody());
    expect(res.status).toBe(400);
    expect(calls.map((c) => c.method)).not.toContain("chat.postMessage");
  });

  test("flag ON: manual D… that changed → exactly one notice", async () => {
    const res = await put(slackBody({ channelId: "DMANUAL22" }));
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.method === "conversations.open").length).toBe(0);
    expect(calls.filter((c) => c.method === "chat.postMessage").length).toBe(1);
  });
});
