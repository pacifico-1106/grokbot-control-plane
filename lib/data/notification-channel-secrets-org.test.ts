/**
 * getNotificationChannelSecretsById(orgId, channelId) — Supabase path (mocked).
 *
 * Defense in depth: org_notification_channel_secrets has no org_id column, so
 * the lookup must first prove that the channel belongs to `orgId`
 * (org_notification_channels.id + org_id) before reading the ciphertext.
 * Org mismatch / unknown channel / blank ids → {} (same as not found).
 *
 * After merging #241: the SAME single row read (select "id,provider,config")
 * also blocks a shared-approval-app inbox while SLACK_SHARED_APPROVAL_APP_ENABLED
 * is OFF ({} + delivery-failure alert). Tenant-app inboxes are unaffected.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
  org_notification_channels: [
    { id: "ch_a", org_id: "org_a", provider: "slack", enabled: true },
    { id: "ch_b", org_id: "org_b", provider: "slack", enabled: true },
    { id: "ch_orphan_secret_only", org_id: "org_c", provider: "line", enabled: true },
    { id: "ch_shared", org_id: "org_a", provider: "slack", enabled: true, config: { sharedApprovalApp: true, teamId: "T0SHARED01" } },
    { id: "ch_tenant", org_id: "org_a", provider: "slack", enabled: true, config: { channelId: "C0TENANT01" } },
  ],
  org_notification_channel_secrets: [
    { channel_id: "ch_a", credentials_ciphertext: JSON.stringify({ botToken: "xoxb-org-a-SECRET" }) },
    { channel_id: "ch_b", credentials_ciphertext: JSON.stringify({ botToken: "xoxb-org-b-SECRET" }) },
    { channel_id: "ch_shared", credentials_ciphertext: JSON.stringify({ botToken: "xoxb-shared-app-SECRET" }) },
    { channel_id: "ch_tenant", credentials_ciphertext: JSON.stringify({ botToken: "xoxb-tenant-app-SECRET", signingSecret: "tenant-sign" }) },
  ],
};
let reads: Array<{ table: string; columns: string; filters: Record<string, unknown> }> = [];
let failChannelsRead = false;
const alerts: Array<Record<string, unknown>> = [];

function fakeAdmin() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const selected = { columns: "" };
      const query = {
        select: (cols: string) => {
          selected.columns = cols;
          return query;
        },
        eq: (key: string, value: unknown) => {
          filters[key] = value;
          return query;
        },
        maybeSingle: async () => {
          reads.push({ table, columns: selected.columns, filters: { ...filters } });
          if (failChannelsRead && table === "org_notification_channels") {
            return { data: null, error: { message: "boom" } };
          }
          const rows = tables[table] ?? [];
          // Real PostgREST errors on an unknown column (e.g. org_id on the secrets table).
          const columns = new Set(rows.flatMap((row) => Object.keys(row)));
          for (const key of Object.keys(filters)) {
            if (!columns.has(key)) return { data: null, error: { message: `column ${table}.${key} does not exist` } };
          }
          const hit = rows.find((row) => Object.entries(filters).every(([k, v]) => row[k] === v)) ?? null;
          return { data: hit, error: null };
        },
      };
      return query;
    },
  };
}

mock.module("@/lib/mode", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  isStripeConfigured: () => false,
  isResendConfigured: () => false,
  runtimeModeLabel: () => "production",
}));
mock.module("@/lib/supabase", () => ({
  isDemoMode: () => false,
  isSupabaseConfigured: () => true,
  createSupabaseAdminClient: () => fakeAdmin(),
  createSupabaseBrowserClient: () => null,
  createSupabaseServerClient: () => null,
}));
mock.module("@/lib/notify/crypto", () => ({
  encryptNotificationSecrets: (value: Record<string, string>) => JSON.stringify(value),
  decryptNotificationSecrets: (value: string) => JSON.parse(value) as Record<string, string>,
}));

mock.module("@/lib/notify/delivery-failure-alert", () => ({
  alertApprovalDeliveryFailure: async (input: Record<string, unknown>) => {
    alerts.push(input);
    return { sent: false };
  },
}));

const { getNotificationChannelSecretsById, SHARED_APPROVAL_APP_SUSPENDED_REASON } = await import("./notification-channels");

const savedFlag = process.env.SLACK_SHARED_APPROVAL_APP_ENABLED;
beforeEach(() => {
  reads = [];
  failChannelsRead = false;
  alerts.length = 0;
  delete process.env.SLACK_SHARED_APPROVAL_APP_ENABLED;
});
afterAll(() => {
  if (savedFlag === undefined) delete process.env.SLACK_SHARED_APPROVAL_APP_ENABLED;
  else process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = savedFlag;
});

const channelReads = () => reads.filter((r) => r.table === "org_notification_channels");
const secretReads = () => reads.filter((r) => r.table === "org_notification_channel_secrets");

describe("getNotificationChannelSecretsById: org-scoped (Supabase path)", () => {
  test("org match returns the secrets", async () => {
    expect(await getNotificationChannelSecretsById("org_a", "ch_a")).toEqual({ botToken: "xoxb-org-a-SECRET" });
    expect(await getNotificationChannelSecretsById("org_b", "ch_b")).toEqual({ botToken: "xoxb-org-b-SECRET" });
  });

  test("org mismatch returns {} (same as not found) and never reads the other org's ciphertext", async () => {
    expect(await getNotificationChannelSecretsById("org_a", "ch_b")).toEqual({});
    expect(await getNotificationChannelSecretsById("org_b", "ch_a")).toEqual({});
    expect(reads.some((r) => r.table === "org_notification_channel_secrets")).toBe(false);
    expect(await getNotificationChannelSecretsById("org_a", "ch_does_not_exist")).toEqual({});
  });

  test("the ownership check filters org_notification_channels by BOTH id and org_id", async () => {
    await getNotificationChannelSecretsById("org_a", "ch_a");
    const ownership = reads.find((r) => r.table === "org_notification_channels");
    expect(ownership?.filters).toMatchObject({ id: "ch_a", org_id: "org_a" });
    const secretRead = reads.find((r) => r.table === "org_notification_channel_secrets");
    expect(secretRead?.filters).toEqual({ channel_id: "ch_a" });
    // Ownership is proven before the ciphertext is read.
    expect(reads.findIndex((r) => r.table === "org_notification_channels")).toBeLessThan(
      reads.findIndex((r) => r.table === "org_notification_channel_secrets")
    );
  });

  test("blank orgId / channelId fail closed without any query", async () => {
    for (const [orgId, channelId] of [["", "ch_a"], ["   ", "ch_a"], ["org_a", ""], ["org_a", "  "]]) {
      expect(await getNotificationChannelSecretsById(orgId, channelId)).toEqual({});
    }
    expect(reads).toEqual([]);
  });

  test("channel owned but no secret row → {}", async () => {
    expect(await getNotificationChannelSecretsById("org_c", "ch_orphan_secret_only")).toEqual({});
  });
});

describe("merged with #241: one row read decides org ownership AND the suspended shared app", () => {
  test("org mismatch → {} with exactly ONE query (select id,provider,config filtered by id + org_id); no ciphertext read", async () => {
    for (const flag of [undefined, "1"]) {
      reads = [];
      if (flag === undefined) delete process.env.SLACK_SHARED_APPROVAL_APP_ENABLED;
      else process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = flag;
      expect(await getNotificationChannelSecretsById("org_b", "ch_shared")).toEqual({});
      expect(await getNotificationChannelSecretsById("org_b", "ch_a")).toEqual({});
      expect(reads.length).toBe(2);
      for (const read of reads) {
        expect(read.table).toBe("org_notification_channels");
        expect(read.columns).toBe("id,provider,config");
        expect(read.filters).toMatchObject({ org_id: "org_b" });
      }
    }
    expect(alerts.length).toBe(0);
  });

  test("flag OFF + shared-app inbox → {} and the delivery-failure alert, with exactly ONE query", async () => {
    expect(await getNotificationChannelSecretsById("org_a", "ch_shared")).toEqual({});
    expect(reads.length).toBe(1);
    expect(channelReads()[0]).toMatchObject({ columns: "id,provider,config", filters: { id: "ch_shared", org_id: "org_a" } });
    expect(secretReads().length).toBe(0);
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toMatchObject({
      orgId: "org_a",
      channelId: "ch_shared",
      provider: "slack",
      kind: "delivery_failed",
      reason: SHARED_APPROVAL_APP_SUSPENDED_REASON,
    });
  });

  test("flag ON + shared-app inbox → its secret (no alert)", async () => {
    process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = "1";
    expect(await getNotificationChannelSecretsById("org_a", "ch_shared")).toEqual({ botToken: "xoxb-shared-app-SECRET" });
    expect(channelReads().length).toBe(1);
    expect(alerts.length).toBe(0);
  });

  test("tenant-app inbox keeps returning its secret with the flag OFF and ON (no alert)", async () => {
    for (const flag of [undefined, "1"]) {
      reads = [];
      if (flag === undefined) delete process.env.SLACK_SHARED_APPROVAL_APP_ENABLED;
      else process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = flag;
      expect(await getNotificationChannelSecretsById("org_a", "ch_tenant")).toEqual({
        botToken: "xoxb-tenant-app-SECRET",
        signingSecret: "tenant-sign",
      });
      expect(channelReads().length).toBe(1);
      expect(secretReads().length).toBe(1);
    }
    expect(alerts.length).toBe(0);
  });

  test("the channel row cannot be read → {} (fail closed), never falls through to the ciphertext", async () => {
    failChannelsRead = true;
    for (const flag of [undefined, "1"]) {
      if (flag === undefined) delete process.env.SLACK_SHARED_APPROVAL_APP_ENABLED;
      else process.env.SLACK_SHARED_APPROVAL_APP_ENABLED = flag;
      expect(await getNotificationChannelSecretsById("org_a", "ch_tenant")).toEqual({});
      expect(await getNotificationChannelSecretsById("org_a", "ch_shared")).toEqual({});
    }
    expect(secretReads().length).toBe(0);
  });
});
