/**
 * getNotificationChannelSecretsById(orgId, channelId) — Supabase path (mocked).
 *
 * Defense in depth: org_notification_channel_secrets has no org_id column, so
 * the lookup must first prove that the channel belongs to `orgId`
 * (org_notification_channels.id + org_id) before reading the ciphertext.
 * Org mismatch / unknown channel / blank ids → {} (same as not found).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
  org_notification_channels: [
    { id: "ch_a", org_id: "org_a", provider: "slack", enabled: true },
    { id: "ch_b", org_id: "org_b", provider: "slack", enabled: true },
    { id: "ch_orphan_secret_only", org_id: "org_c", provider: "line", enabled: true },
  ],
  org_notification_channel_secrets: [
    { channel_id: "ch_a", credentials_ciphertext: JSON.stringify({ botToken: "xoxb-org-a-SECRET" }) },
    { channel_id: "ch_b", credentials_ciphertext: JSON.stringify({ botToken: "xoxb-org-b-SECRET" }) },
  ],
};
let reads: Array<{ table: string; filters: Record<string, unknown> }> = [];

function fakeAdmin() {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          filters[key] = value;
          return query;
        },
        maybeSingle: async () => {
          reads.push({ table, filters: { ...filters } });
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

const { getNotificationChannelSecretsById } = await import("./notification-channels");

beforeEach(() => {
  reads = [];
});

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
