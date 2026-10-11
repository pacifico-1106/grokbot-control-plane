/**
 * SLACK_IM_NO_ROUTE_AUDIT: user-token DM で im_no_route になったとき、
 * authorizations の user が linked 社員に一意対応する場合だけ、その社員の org に
 * slack.im_wake_skipped を残す。本文は絶対に残さない。フラグ OFF は現状と同じ。
 *
 * すべて demo モード（ダミー値・ネットワークなし）で動く。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bindEmployeeSlackIdentity,
  revokeEmployeeSlackIdentity,
  setDemoSlackIdentityStatusForTests,
} from "@/lib/data/slack-identities";
import { updateWakeWebhook } from "@/lib/data";
import { upsertOrgChannel } from "@/lib/data/directory";
import {
  deleteSlackImEmployeeRoute,
  syncSlackImEmployeeRoute,
} from "@/lib/data/slack-im-routes";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { processSlackMentionEnvelope } from "@/lib/slack/mention-ingress";
import {
  resetImNoRouteAuditThrottleForTests,
  setImNoRouteAuditWriterForTests,
} from "@/lib/slack/im-no-route-audit";
import { isSlackImNoRouteAuditEnabled } from "@/lib/feature-flags";
import type { AuditEvent, Employee } from "@/lib/types";

const FLAG = "SLACK_IM_NO_ROUTE_AUDIT";
const BOUND_USER = "U_NOROUTE_EMP";
const SPEAKER = "U_NOROUTE_HUMAN";
const TEAM = "T_NOROUTE";
const OTHER_TEAM = "T_NOROUTE_EVIL";
const DM = "DNOROUTEAUDIT1";
const DM2 = "DNOROUTEAUDIT2";
const SECRET_BODY = "本文ひみつ-ZX9-請求書の金額は12345円";
const OTHER_ORG = "org_noroute_other_tenant";
const OTHER_EMP = "emp_noroute_other_tenant";

let savedFlag: string | undefined;
let savedFetch: typeof globalThis.fetch;
let seq = 0;

function wakeFetchCalls(): { count: () => number } {
  let count = 0;
  globalThis.fetch = (async () => {
    count += 1;
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  return { count: () => count };
}

function newEventId(tag: string): string {
  seq += 1;
  return `Ev_noroute_${tag}_${Date.now()}_${seq}`;
}

function userTokenDm(input: {
  eventId: string;
  channel?: string;
  authUser?: string;
  authTeam?: string;
  envelopeTeam?: string;
  isBot?: boolean;
  noAuthorizations?: boolean;
}) {
  return {
    type: "event_callback",
    team_id: input.envelopeTeam ?? TEAM,
    event_id: input.eventId,
    ...(input.noAuthorizations
      ? {}
      : {
          authorizations: [
            {
              is_bot: input.isBot ?? false,
              user_id: input.authUser ?? BOUND_USER,
              team_id: input.authTeam ?? TEAM,
            },
          ],
        }),
    event: {
      type: "message",
      channel_type: "im",
      user: SPEAKER,
      text: SECRET_BODY,
      blocks: [{ type: "rich_text", elements: [{ type: "text", text: SECRET_BODY }] }],
      ts: "1791000000.000100",
      channel: input.channel ?? DM,
    },
  };
}

function employee(id: string): Employee {
  const emp = getRuntimeEmployees().find((item) => item.id === id);
  if (!emp) throw new Error(`missing ${id}`);
  return emp;
}

async function bind(emp: Employee, opts?: { team?: string }) {
  const previous = emp.allowedAccounts;
  emp.allowedAccounts = [{ service: "slack", accountId: BOUND_USER }];
  await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
  await bindEmployeeSlackIdentity({
    employeeId: emp.id,
    orgId: emp.orgId,
    slackUserId: BOUND_USER,
    slackTeamId: opts?.team ?? TEAM,
    displayName: "ルート検証",
    userToken: "xoxp-dummy-not-a-real-token",
  });
  return async () => {
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
    emp.allowedAccounts = previous;
  };
}

function addOtherTenantEmployee(): () => void {
  const base = employee("emp_comm");
  const clone: Employee = {
    ...base,
    id: OTHER_EMP,
    orgId: OTHER_ORG,
    allowedAccounts: [],
  };
  getRuntimeEmployees().push(clone);
  return () => {
    const list = getRuntimeEmployees();
    const idx = list.findIndex((item) => item.id === OTHER_EMP);
    if (idx >= 0) list.splice(idx, 1);
  };
}

function newSkipAudits(before: number): AuditEvent[] {
  const all = getRuntimeAudit();
  return all
    .slice(0, all.length - before)
    .filter((event) => event.action === "slack.im_wake_skipped");
}

beforeEach(async () => {
  savedFlag = process.env[FLAG];
  savedFetch = globalThis.fetch;
  process.env[FLAG] = "1";
  resetImNoRouteAuditThrottleForTests();
  setImNoRouteAuditWriterForTests(null);
  await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: DM });
  await deleteSlackImEmployeeRoute({ orgId: DEMO_ORG.id, slackChannelId: DM2 });
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  globalThis.fetch = savedFetch;
  resetImNoRouteAuditThrottleForTests();
  setImNoRouteAuditWriterForTests(null);
});

describe("feature flag", () => {
  test("SLACK_IM_NO_ROUTE_AUDIT defaults OFF and parses like other flags", () => {
    delete process.env[FLAG];
    expect(isSlackImNoRouteAuditEnabled()).toBe(false);
    process.env[FLAG] = "";
    expect(isSlackImNoRouteAuditEnabled()).toBe(false);
    process.env[FLAG] = "0";
    expect(isSlackImNoRouteAuditEnabled()).toBe(false);
    for (const on of ["1", "true", "on", "enabled", "TRUE"]) {
      process.env[FLAG] = on;
      expect(isSlackImNoRouteAuditEnabled()).toBe(true);
    }
  });
});

describe("im_no_route audit (SLACK_IM_NO_ROUTE_AUDIT)", () => {
  test("一意対応: linked 社員の org に slack.im_wake_skipped を1件残す（推奨アクション付き）", async () => {
    const emp = employee("emp_comm");
    const restore = await bind(emp);
    const wake = wakeFetchCalls();
    const before = getRuntimeAudit().length;
    try {
      const eventId = newEventId("unique");
      const outcome = await processSlackMentionEnvelope(userTokenDm({ eventId }));
      expect(outcome).toEqual({
        handled: true,
        woke: 0,
        skipReason: "im_no_route_or_self",
        userToken: true,
        isDirectMessage: true,
      });
      expect(wake.count()).toBe(0);

      const audits = newSkipAudits(before);
      expect(audits.length).toBe(1);
      const audit = audits[0];
      expect(audit.orgId).toBe(emp.orgId);
      expect(audit.employeeId).toBe(emp.id);
      expect(audit.credentialId).toBeNull();
      expect(audit.purpose).toBe("slack.internal_im");
      expect(audit.summary).toContain("im_no_route");
      expect(audit.summary).toContain("channels.classify");
      const meta = audit.metadata as Record<string, unknown>;
      expect(meta.reason).toBe("im_no_route");
      expect(meta.channel).toBe(DM);
      expect(meta.teamId).toBe(TEAM);
      expect(meta.eventType).toBe("message");
      expect(meta.eventId).toBe(eventId);
      expect(meta.userToken).toBe(true);
      expect(meta.crossTeam).toBe(false);
      expect(meta.channelClassification).toBe("unregistered");
      expect(meta.recommendedAction).toEqual({
        tool: "channels.classify",
        args: {
          surface: "slack",
          externalId: DM,
          classification: "internal",
          mixed: false,
          employeeId: emp.id,
          slackTeamId: TEAM,
        },
      });
      expect(String(meta.hintJa)).toContain("channels.classify");
    } finally {
      await restore();
    }
  });

  test("本文（text / blocks）・発言者IDはどこにも入らない", async () => {
    const emp = employee("emp_comm");
    const restore = await bind(emp);
    wakeFetchCalls();
    const before = getRuntimeAudit().length;
    try {
      await processSlackMentionEnvelope(userTokenDm({ eventId: newEventId("nobody") }));
      const audits = newSkipAudits(before);
      expect(audits.length).toBe(1);
      const serialized = JSON.stringify(audits[0]);
      expect(serialized).not.toContain(SECRET_BODY);
      expect(serialized).not.toContain("本文ひみつ");
      expect(serialized).not.toContain("12345");
      expect(serialized).not.toContain(SPEAKER);
      expect(serialized).not.toContain("xoxp-");
      const meta = audits[0].metadata as Record<string, unknown>;
      expect(Object.keys(meta)).not.toContain("text");
      expect(Object.keys(meta)).not.toContain("blocks");
      expect(Object.keys(meta)).not.toContain("ts");
    } finally {
      await restore();
    }
  });

  test("0件: authorizations の user に linked 社員がいなければ org に書かない", async () => {
    wakeFetchCalls();
    const before = getRuntimeAudit().length;
    const outcome = await processSlackMentionEnvelope(
      userTokenDm({ eventId: newEventId("zero"), authUser: "U_NOBODY_LINKED" })
    );
    expect(outcome.skipReason).toBe("im_no_route_or_self");
    expect(newSkipAudits(before)).toEqual([]);
  });

  test("0件（team 不一致）: 同じ user_id でも別 team の authorization では書かない", async () => {
    const emp = employee("emp_comm");
    const restore = await bind(emp);
    wakeFetchCalls();
    const before = getRuntimeAudit().length;
    try {
      await processSlackMentionEnvelope(
        userTokenDm({ eventId: newEventId("teammismatch"), authTeam: OTHER_TEAM, envelopeTeam: OTHER_TEAM })
      );
      expect(newSkipAudits(before)).toEqual([]);
    } finally {
      await restore();
    }
  });

  test("複数件: 同じ Slack user が複数 org の社員に linked なら、どの org にも書かない", async () => {
    const removeOther = addOtherTenantEmployee();
    const restoreA = await bind(employee("emp_comm"));
    const restoreB = await bind(employee(OTHER_EMP));
    wakeFetchCalls();
    const before = getRuntimeAudit().length;
    try {
      const outcome = await processSlackMentionEnvelope(
        userTokenDm({ eventId: newEventId("multi") })
      );
      expect(outcome.skipReason).toBe("im_no_route_or_self");
      expect(outcome.woke).toBe(0);
      expect(newSkipAudits(before)).toEqual([]);
    } finally {
      await restoreB();
      await restoreA();
      removeOther();
    }
  });

  test("一意対応が別 org の社員なら、その org にだけ書く（demo org には書かない）", async () => {
    const removeOther = addOtherTenantEmployee();
    const restore = await bind(employee(OTHER_EMP));
    wakeFetchCalls();
    const before = getRuntimeAudit().length;
    try {
      await processSlackMentionEnvelope(userTokenDm({ eventId: newEventId("otherorg") }));
      const audits = newSkipAudits(before);
      expect(audits.length).toBe(1);
      expect(audits[0].orgId).toBe(OTHER_ORG);
      expect(audits[0].employeeId).toBe(OTHER_EMP);
      expect(audits.some((a) => a.orgId === DEMO_ORG.id)).toBe(false);
    } finally {
      await restore();
      removeOther();
    }
  });

  test("unlinked（needs_reauth）: linked でない社員には書かない", async () => {
    const emp = employee("emp_comm");
    const restore = await bind(emp);
    setDemoSlackIdentityStatusForTests(emp.id, "needs_reauth");
    wakeFetchCalls();
    const before = getRuntimeAudit().length;
    try {
      await processSlackMentionEnvelope(userTokenDm({ eventId: newEventId("reauth") }));
      expect(newSkipAudits(before)).toEqual([]);
    } finally {
      await restore();
    }
  });

  test("unlinked（revoked / 連携解除済み）: 書かない", async () => {
    const emp = employee("emp_comm");
    const restore = await bind(emp);
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: emp.orgId });
    wakeFetchCalls();
    const before = getRuntimeAudit().length;
    try {
      await processSlackMentionEnvelope(userTokenDm({ eventId: newEventId("revoked") }));
      expect(newSkipAudits(before)).toEqual([]);
    } finally {
      await restore();
    }
  });

  test("フラグ OFF: 一意対応でも何も書かず、outcome は ON と同一", async () => {
    const emp = employee("emp_comm");
    const restore = await bind(emp);
    wakeFetchCalls();
    try {
      process.env[FLAG] = "0";
      const beforeOff = getRuntimeAudit().length;
      const off = await processSlackMentionEnvelope(userTokenDm({ eventId: newEventId("off") }));
      expect(getRuntimeAudit().length).toBe(beforeOff);
      expect(newSkipAudits(beforeOff)).toEqual([]);

      delete process.env[FLAG];
      const beforeUnset = getRuntimeAudit().length;
      const unset = await processSlackMentionEnvelope(userTokenDm({ eventId: newEventId("unset") }));
      expect(getRuntimeAudit().length).toBe(beforeUnset);

      process.env[FLAG] = "1";
      const on = await processSlackMentionEnvelope(userTokenDm({ eventId: newEventId("on") }));
      expect(off).toEqual(on);
      expect(unset).toEqual(on);
    } finally {
      await restore();
    }
  });

  test("bot token の DM（Path A）は対象外: 書かない", async () => {
    const emp = employee("emp_comm");
    const restore = await bind(emp);
    wakeFetchCalls();
    const before = getRuntimeAudit().length;
    try {
      await processSlackMentionEnvelope(
        userTokenDm({ eventId: newEventId("bot"), isBot: true, authUser: BOUND_USER })
      );
      await processSlackMentionEnvelope(
        userTokenDm({ eventId: newEventId("noauth"), noAuthorizations: true })
      );
      expect(newSkipAudits(before)).toEqual([]);
    } finally {
      await restore();
    }
  });

  test("ルートがあり起動できる DM では im_no_route を書かない", async () => {
    const emp = employee("emp_comm");
    const restore = await bind(emp);
    await updateWakeWebhook(emp.id, { orgId: emp.orgId, url: "https://example.test/wake/noroute", secret: "dummy" });
    await upsertOrgChannel({
      orgId: emp.orgId,
      surface: "slack",
      externalId: DM,
      classification: "internal",
      skipInspect: true,
    });
    await syncSlackImEmployeeRoute({
      orgId: emp.orgId,
      surface: "slack",
      slackChannelId: DM,
      slackTeamId: TEAM,
      classification: "internal",
      mixed: false,
      employeeId: emp.id,
    });
    const wake = wakeFetchCalls();
    const before = getRuntimeAudit().length;
    try {
      const outcome = await processSlackMentionEnvelope(userTokenDm({ eventId: newEventId("routed") }));
      expect(outcome.woke).toBe(1);
      expect(wake.count()).toBe(1);
      expect(newSkipAudits(before)).toEqual([]);
    } finally {
      await deleteSlackImEmployeeRoute({ orgId: emp.orgId, slackChannelId: DM });
      await upsertOrgChannel({
        orgId: emp.orgId,
        surface: "slack",
        externalId: DM,
        classification: "unknown",
        skipInspect: true,
      });
      await updateWakeWebhook(emp.id, { orgId: emp.orgId, url: null, secret: "" });
      await restore();
    }
  });

  test("分類済みだがルートがない DM は現在の分類を添える", async () => {
    const emp = employee("emp_comm");
    const restore = await bind(emp);
    await upsertOrgChannel({
      orgId: emp.orgId,
      surface: "slack",
      externalId: DM2,
      classification: "unknown",
      skipInspect: true,
    });
    wakeFetchCalls();
    const before = getRuntimeAudit().length;
    try {
      await processSlackMentionEnvelope(userTokenDm({ eventId: newEventId("classified"), channel: DM2 }));
      const audits = newSkipAudits(before);
      expect(audits.length).toBe(1);
      expect((audits[0].metadata as Record<string, unknown>).channelClassification).toBe("unknown");
    } finally {
      await restore();
    }
  });

  test("Slack Connect（team 跨ぎ）DM では internal 分類を推奨しない", async () => {
    const emp = employee("emp_comm");
    const restore = await bind(emp);
    wakeFetchCalls();
    const before = getRuntimeAudit().length;
    try {
      await processSlackMentionEnvelope(
        userTokenDm({ eventId: newEventId("connect"), authTeam: TEAM, envelopeTeam: OTHER_TEAM })
      );
      const audits = newSkipAudits(before);
      expect(audits.length).toBe(1);
      const meta = audits[0].metadata as Record<string, unknown>;
      expect(meta.crossTeam).toBe(true);
      expect(meta.recommendedAction).toBeNull();
      expect(String(meta.hintJa)).toContain("Slack Connect");
    } finally {
      await restore();
    }
  });

  test("重複抑制: 同じ org×DM は一定時間1件だけ。次の記録に抑制件数を載せる。別 DM は別枠", async () => {
    const emp = employee("emp_comm");
    const restore = await bind(emp);
    wakeFetchCalls();
    const before = getRuntimeAudit().length;
    try {
      for (let i = 0; i < 5; i += 1) {
        await processSlackMentionEnvelope(userTokenDm({ eventId: newEventId(`burst${i}`) }));
      }
      await processSlackMentionEnvelope(userTokenDm({ eventId: newEventId("dm2"), channel: DM2 }));
      const audits = newSkipAudits(before);
      expect(audits.filter((a) => (a.metadata as Record<string, unknown>).channel === DM).length).toBe(1);
      expect(audits.filter((a) => (a.metadata as Record<string, unknown>).channel === DM2).length).toBe(1);
      const first = audits.find((a) => (a.metadata as Record<string, unknown>).channel === DM);
      expect((first?.metadata as Record<string, unknown>).suppressedSinceLast).toBe(0);
    } finally {
      await restore();
    }
  });

  test("重複抑制の窓が過ぎたら次の1件を書き、抑制件数を載せる", async () => {
    const { recordImNoRouteAudit } = await import("@/lib/slack/im-no-route-audit");
    const emp = employee("emp_comm");
    const restore = await bind(emp);
    const before = getRuntimeAudit().length;
    const base = {
      authorizations: [{ is_bot: false, user_id: BOUND_USER, team_id: TEAM }],
      envelopeTeamId: TEAM,
      channel: DM,
      channelType: "im",
      eventType: "message",
    };
    try {
      const t0 = 1_000_000;
      expect((await recordImNoRouteAudit({ ...base, eventId: "e1", now: t0 })).status).toBe("written");
      expect((await recordImNoRouteAudit({ ...base, eventId: "e2", now: t0 + 1_000 })).status).toBe("suppressed");
      expect((await recordImNoRouteAudit({ ...base, eventId: "e3", now: t0 + 2_000 })).status).toBe("suppressed");
      const later = await recordImNoRouteAudit({ ...base, eventId: "e4", now: t0 + 11 * 60_000 });
      expect(later.status).toBe("written");
      const audits = newSkipAudits(before);
      expect(audits.length).toBe(2);
      // newest first
      expect((audits[0].metadata as Record<string, unknown>).eventId).toBe("e4");
      expect((audits[0].metadata as Record<string, unknown>).suppressedSinceLast).toBe(2);
    } finally {
      await restore();
    }
  });

  test("audit 書き込みが失敗しても DM 処理本体は壊れない（例外を投げず同じ outcome）", async () => {
    const emp = employee("emp_comm");
    const restore = await bind(emp);
    wakeFetchCalls();
    try {
      let attempts = 0;
      setImNoRouteAuditWriterForTests(async () => {
        attempts += 1;
        throw new Error("audit_insert_failed_dummy");
      });
      const failed = await processSlackMentionEnvelope(userTokenDm({ eventId: newEventId("fail") }));
      expect(attempts).toBe(1);
      setImNoRouteAuditWriterForTests(null);
      resetImNoRouteAuditThrottleForTests();
      const ok = await processSlackMentionEnvelope(userTokenDm({ eventId: newEventId("ok") }));
      expect(failed).toEqual(ok);
      expect(failed.handled).toBe(true);
    } finally {
      await restore();
    }
  });

  test("recordImNoRouteAudit は writer の例外を握りつぶして status=error を返す", async () => {
    const { recordImNoRouteAudit } = await import("@/lib/slack/im-no-route-audit");
    const emp = employee("emp_comm");
    const restore = await bind(emp);
    try {
      setImNoRouteAuditWriterForTests(async () => {
        throw new Error("audit_insert_failed_dummy");
      });
      const result = await recordImNoRouteAudit({
        authorizations: [{ is_bot: false, user_id: BOUND_USER, team_id: TEAM }],
        envelopeTeamId: TEAM,
        channel: DM,
        channelType: "im",
        eventType: "message",
        eventId: "e_fail",
      });
      expect(result.status).toBe("error");
    } finally {
      await restore();
    }
  });

  test("recordImNoRouteAudit: フラグ OFF なら何も参照せず flag_off", async () => {
    const { recordImNoRouteAudit } = await import("@/lib/slack/im-no-route-audit");
    process.env[FLAG] = "0";
    let attempts = 0;
    setImNoRouteAuditWriterForTests(async () => {
      attempts += 1;
    });
    const result = await recordImNoRouteAudit({
      authorizations: [{ is_bot: false, user_id: BOUND_USER, team_id: TEAM }],
      envelopeTeamId: TEAM,
      channel: DM,
      channelType: "im",
      eventType: "message",
      eventId: "e_off",
    });
    expect(result.status).toBe("flag_off");
    expect(attempts).toBe(0);
  });
});
