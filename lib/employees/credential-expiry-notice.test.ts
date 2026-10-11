/**
 * CREDENTIAL_EXPIRY_NOTICE_ENABLED (default OFF): pre-expiry notice for 社員証
 * (7 days before and the day before) to the tenant's approval inbox, through
 * the common inbox send (Slack / LINE / Telegram). Dedup per credential ×
 * threshold, per-org caps, ID-only text + dashboard link, tenant isolation.
 * Background: every TOKYO307 credential expired 9/23–9/30 without warning.
 * Injected deps; no network, no DB.
 */
import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_EXPIRY_NOTICE_MAX_PER_ORG_PER_DAY,
  CREDENTIAL_EXPIRY_NOTICE_MAX_PER_ORG_PER_RUN,
  credentialExpiryNoticeText,
  noticeThresholdFor,
  runCredentialExpiryNotices,
  type ExpiringCredentialRow,
  type NoticeDeps,
} from "./credential-expiry-notice";

const DAY = 86_400_000;
const NOW = new Date("2026-10-12T00:00:00.000Z");
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const ORIGIN = "https://staffpass.example";

type Channel = { id: string; orgId: string; provider: "slack" | "line" | "telegram" };
function harness(rows: ExpiringCredentialRow[], opts: { channels?: Record<string, Channel | null>; sendOk?: boolean | ((c: Channel) => boolean); claimError?: boolean } = {}) {
  const claims = new Map<string, { orgId: string; at: number }>();
  const sent: Array<{ channel: Channel; text: string }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const released: string[] = [];
  let clock = NOW.getTime();
  const deps: NoticeDeps = {
    now: () => new Date(clock),
    origin: () => ORIGIN,
    listExpiring: async (now, horizonMs) =>
      rows.filter((r) => Date.parse(r.expiresAt) > now.getTime() && Date.parse(r.expiresAt) <= now.getTime() + horizonMs),
    claim: async (row, threshold) => {
      if (opts.claimError) return "error";
      const key = `${row.credentialId}:${threshold}`;
      if (claims.has(key)) return "duplicate";
      claims.set(key, { orgId: row.orgId, at: clock });
      return "claimed";
    },
    release: async (row, threshold) => {
      const key = `${row.credentialId}:${threshold}`;
      claims.delete(key);
      released.push(key);
    },
    countRecent: async (orgId, since) => [...claims.values()].filter((c) => c.orgId === orgId && c.at >= since.getTime()).length,
    resolveInbox: async (orgId) => (opts.channels && orgId in opts.channels ? opts.channels[orgId] : { id: `ch_${orgId}`, orgId, provider: "slack" }),
    send: async (channel, text) => {
      const ok = typeof opts.sendOk === "function" ? opts.sendOk(channel as Channel) : opts.sendOk ?? true;
      if (ok) sent.push({ channel: channel as Channel, text });
      return { ok };
    },
    audit: async (e) => {
      audits.push(e as Record<string, unknown>);
    },
  };
  return { deps, claims, sent, audits, released, advance: (ms: number) => (clock += ms) };
}
const row = (n: number, expiresInMs: number, over: Partial<ExpiringCredentialRow> = {}): ExpiringCredentialRow => ({
  credentialId: `cred_${n}`,
  orgId: "org_a",
  employeeId: `emp_${n}`,
  employeeOrgId: "org_a",
  employeeStatus: "active",
  expiresAt: iso(expiresInMs),
  ...over,
});

describe("noticeThresholdFor", () => {
  test("7d window, 1d window, outside, expired", () => {
    expect(noticeThresholdFor(iso(7 * DAY), NOW)).toBe("7d");
    expect(noticeThresholdFor(iso(DAY + 1), NOW)).toBe("7d");
    expect(noticeThresholdFor(iso(DAY), NOW)).toBe("1d");
    expect(noticeThresholdFor(iso(60_000), NOW)).toBe("1d");
    expect(noticeThresholdFor(iso(7 * DAY + 1), NOW)).toBeNull();
    expect(noticeThresholdFor(iso(0), NOW)).toBeNull();
    expect(noticeThresholdFor(iso(-DAY), NOW)).toBeNull();
    expect(noticeThresholdFor("garbage", NOW)).toBeNull();
  });
});

describe("runCredentialExpiryNotices", () => {
  test("one message per org to the approval inbox; IDs + dashboard link only", async () => {
    const h = harness([row(1, 6 * DAY), row(2, 12 * 3_600_000)]);
    const r = await runCredentialExpiryNotices(h.deps);
    expect(r).toMatchObject({ orgs: 1, notified: 2, sent: 1 });
    expect(h.sent).toHaveLength(1);
    const text = h.sent[0].text;
    expect(text).toContain("emp_1");
    expect(text).toContain("cred_1");
    expect(text).toContain("cred_2");
    expect(text).toContain(`${ORIGIN}/app/employees/emp_1`);
    expect(text).toContain(`${ORIGIN}/app/employees/emp_2`);
    expect(text).toContain("あと 6 日");
    expect(text).toContain("明日まで");
    expect(text).not.toMatch(/gb_emp_|secret|token/i);
    expect(h.claims.has("cred_1:7d")).toBe(true);
    expect(h.claims.has("cred_2:1d")).toBe(true);
  });

  test("dedup per credential × threshold: a second run sends nothing; the 1d notice still comes later", async () => {
    const h = harness([row(1, 6 * DAY)]);
    await runCredentialExpiryNotices(h.deps);
    expect(h.sent).toHaveLength(1);
    expect(await runCredentialExpiryNotices(h.deps)).toMatchObject({ notified: 0, sent: 0 });
    expect(h.sent).toHaveLength(1);
    h.advance(5 * DAY + 3_600_000); // now 23h before expiry
    await runCredentialExpiryNotices(h.deps);
    expect(h.sent).toHaveLength(2);
    expect(h.claims.has("cred_1:1d")).toBe(true);
    await runCredentialExpiryNotices(h.deps);
    expect(h.sent).toHaveLength(2);
  });

  test("first seen inside the 1d window → only the 1d notice", async () => {
    const h = harness([row(1, 3_600_000)]);
    await runCredentialExpiryNotices(h.deps);
    expect([...h.claims.keys()]).toEqual(["cred_1:1d"]);
  });

  test(`per-org cap per run (${CREDENTIAL_EXPIRY_NOTICE_MAX_PER_ORG_PER_RUN}): the rest is counted and sent on the next run`, async () => {
    expect(CREDENTIAL_EXPIRY_NOTICE_MAX_PER_ORG_PER_RUN).toBe(10);
    const rows = Array.from({ length: 13 }, (_, i) => row(i + 1, 3 * DAY + i * 60_000));
    const h = harness(rows);
    const r1 = await runCredentialExpiryNotices(h.deps);
    expect(r1).toMatchObject({ notified: 10, deferred: 3 });
    expect(h.claims.size).toBe(10);
    expect(h.sent[0].text).toContain("他 3 件");
    const r2 = await runCredentialExpiryNotices(h.deps);
    expect(r2).toMatchObject({ notified: 3, deferred: 0 });
    expect(h.claims.size).toBe(13);
  });

  test(`per-org cap per 24h (${CREDENTIAL_EXPIRY_NOTICE_MAX_PER_ORG_PER_DAY}) across runs`, async () => {
    expect(CREDENTIAL_EXPIRY_NOTICE_MAX_PER_ORG_PER_DAY).toBe(20);
    const rows = Array.from({ length: 25 }, (_, i) => row(i + 1, 3 * DAY + i * 60_000));
    const h = harness(rows);
    await runCredentialExpiryNotices(h.deps);
    await runCredentialExpiryNotices(h.deps);
    const r3 = await runCredentialExpiryNotices(h.deps);
    expect(h.claims.size).toBe(20);
    expect(r3).toMatchObject({ notified: 0, deferred: 5, cappedOrgs: 1 });
    h.advance(DAY + 1);
    await runCredentialExpiryNotices(h.deps);
    expect(h.claims.size).toBe(25);
  });

  test("tenant isolation: each org's inbox gets only its own ids; a mismatched employee org or a foreign inbox is refused", async () => {
    const h = harness(
      [
        row(1, 2 * DAY, { orgId: "org_a", employeeOrgId: "org_a" }),
        row(2, 2 * DAY, { orgId: "org_b", employeeOrgId: "org_b" }),
        row(3, 2 * DAY, { orgId: "org_a", employeeOrgId: "org_b" }), // credential / employee org mismatch
        row(4, 2 * DAY, { orgId: "org_c", employeeOrgId: "org_c" }),
      ],
      { channels: { org_c: { id: "ch_b", orgId: "org_b", provider: "slack" } } } // resolver returns another org's inbox
    );
    const r = await runCredentialExpiryNotices(h.deps);
    const byOrg = Object.fromEntries(h.sent.map((s) => [s.channel.orgId, s.text]));
    expect(Object.keys(byOrg).sort()).toEqual(["org_a", "org_b"]);
    expect(byOrg.org_a).toContain("cred_1");
    expect(byOrg.org_a).not.toContain("cred_2");
    expect(byOrg.org_a).not.toContain("cred_3");
    expect(byOrg.org_b).toContain("cred_2");
    expect(byOrg.org_b).not.toContain("cred_1");
    expect(byOrg.org_b).not.toContain("cred_4");
    expect(h.claims.has("cred_3:7d")).toBe(false);
    expect(h.claims.has("cred_4:7d")).toBe(false);
    expect(r).toMatchObject({ skippedMismatch: 1, noInbox: 1 });
  });

  test("suspended / draft employees are skipped", async () => {
    const h = harness([row(1, 2 * DAY, { employeeStatus: "suspended" }), row(2, 2 * DAY, { employeeStatus: "draft" })]);
    const r = await runCredentialExpiryNotices(h.deps);
    expect(h.sent).toHaveLength(0);
    expect(h.claims.size).toBe(0);
    expect(r.notified).toBe(0);
  });

  test("no inbox → nothing claimed (sent once an inbox exists)", async () => {
    const h = harness([row(1, 2 * DAY)], { channels: { org_a: null } });
    const r = await runCredentialExpiryNotices(h.deps);
    expect(r).toMatchObject({ noInbox: 1, notified: 0 });
    expect(h.claims.size).toBe(0);
  });

  test("send failure → claims released (retried next run) and a failure audit with ids only", async () => {
    const h = harness([row(1, 2 * DAY), row(2, 2 * DAY)], { sendOk: false });
    const r = await runCredentialExpiryNotices(h.deps);
    expect(r).toMatchObject({ sent: 0, failed: 1, notified: 0 });
    expect(h.claims.size).toBe(0);
    expect(h.released.sort()).toEqual(["cred_1:7d", "cred_2:7d"]);
    const a = h.audits.find((x) => x.action === "credential.expiry_notice");
    expect(a).toBeDefined();
    expect((a!.metadata as Record<string, unknown>).ok).toBe(false);
    expect(JSON.stringify(a)).not.toMatch(/https?:\/\//);
  });

  test("claim error → skipped, never sent without a claim", async () => {
    const h = harness([row(1, 2 * DAY)], { claimError: true });
    await runCredentialExpiryNotices(h.deps);
    expect(h.sent).toHaveLength(0);
  });

  test("success audit per org: ids + thresholds + counts, no link, no text", async () => {
    const h = harness([row(1, 6 * DAY)]);
    await runCredentialExpiryNotices(h.deps);
    const a = h.audits.find((x) => x.action === "credential.expiry_notice")!;
    expect(a.orgId).toBe("org_a");
    expect(a.metadata).toMatchObject({ ok: true, provider: "slack", channelId: "ch_org_a", items: [{ credentialId: "cred_1", employeeId: "emp_1", threshold: "7d" }] });
    expect(JSON.stringify(a)).not.toMatch(/https?:\/\//);
  });
});

describe("credentialExpiryNoticeText", () => {
  test("IDs, JST expiry, link per employee; never display names", () => {
    const text = credentialExpiryNoticeText(
      [{ credentialId: "cred_9", employeeId: "emp_9", expiresAt: "2026-10-19T03:00:00.000Z", threshold: "7d", daysLeft: 7 }],
      { origin: ORIGIN, deferred: 0 }
    );
    expect(text).toContain("2026/10/19 12:00 JST");
    expect(text).toContain(`${ORIGIN}/app/employees/emp_9`);
    expect(text).toContain("emp_9");
  });
});
