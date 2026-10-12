/**
 * Per-employee comm accounts (design §2-3 C5, §2-4, §5). One LINE official
 * account per AI employee (決定 3). Flag COMM_ACCOUNTS_ENABLED (default OFF).
 *
 * Security:
 * - The org is decided only by the server: webhook ref → account row → org.
 *   Nothing in an inbound event (destination etc.) selects the org.
 * - The webhook ref is 32 random bytes (base64url), separate from any secret.
 * - An external account id (LINE bot userId) is unique across all orgs, so
 *   another tenant cannot register the same official account.
 * - Secrets: write-only. Only their NAMES are ever returned. The value is
 *   AES-256-GCM ciphertext bound to (account id, org id) — lib/comm/secret-crypto.
 *   Only readCommAccountSecretsForServer decrypts, for the sending adapter.
 *   Not reachable from Admin MCP / AI (no tool calls these functions; see
 *   lib/comm/accounts-callers.test.ts).
 * - A new account is "pending" and ignored by ingress until its secrets are set.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { isCommAccountsEnabled } from "@/lib/comm/flags";
import { decryptCommSecrets, encryptCommSecrets } from "@/lib/comm/secret-crypto";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

export type CommSurface = "line";
export type CommAccountStatus = "pending" | "active" | "disabled";
export type CommAccount = {
  id: string;
  orgId: string;
  employeeId: string;
  surface: CommSurface;
  externalAccountId: string;
  webhookRef: string;
  status: CommAccountStatus;
  displayName: string | null;
};
export type CommAccountView = Omit<CommAccount, "webhookRef"> & {
  webhookPath: string;
  secretNames: string[];
  secretsVerifiedAt: string | null;
};
export type LineSecrets = { channelAccessToken: string; channelSecret: string };

const SURFACES = new Set<CommSurface>(["line"]);
const EXTERNAL_ID_RE: Record<CommSurface, RegExp> = { line: /^U[0-9a-f]{32}$/ };
const SECRET_SPEC: Record<CommSurface, Record<string, RegExp>> = {
  line: {
    channelAccessToken: /^[A-Za-z0-9+/=._-]{100,512}$/,
    channelSecret: /^[0-9a-f]{32}$/,
  },
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function newWebhookRef(): string {
  return randomBytes(32).toString("base64url");
}

export function commWebhookPath(account: Pick<CommAccount, "surface" | "webhookRef">): string {
  return `/api/webhooks/${account.surface}/c/${account.webhookRef}`;
}

type SecretRow = { ciphertext: string; secretNames: string[]; verifiedAt: string | null };

interface Backend {
  insert(a: CommAccount, createdBy: string | null): Promise<"ok" | "employee_has_account" | "external_account_taken" | "error">;
  get(orgId: string, id: string): Promise<CommAccount | null>;
  byRef(ref: string): Promise<CommAccount | null>;
  list(orgId: string): Promise<Array<CommAccount & { secret: SecretRow | null }>>;
  putSecret(a: CommAccount, row: SecretRow, memberId: string | null): Promise<boolean>;
  getSecret(a: CommAccount): Promise<SecretRow | null>;
  setStatus(a: CommAccount, status: CommAccountStatus): Promise<boolean>;
  recordEvent(a: CommAccount, key: string): Promise<"new" | "duplicate" | "error">;
}

// ---------- demo (in-memory) ----------
const demo = { accounts: new Map<string, CommAccount>(), secrets: new Map<string, SecretRow>(), events: new Set<string>() };
export function resetDemoCommAccounts() {
  demo.accounts.clear();
  demo.secrets.clear();
  demo.events.clear();
}
const demoBackend: Backend = {
  async insert(a) {
    for (const x of demo.accounts.values()) {
      if (x.orgId === a.orgId && x.employeeId === a.employeeId && x.surface === a.surface) return "employee_has_account";
      if (x.surface === a.surface && x.externalAccountId === a.externalAccountId) return "external_account_taken";
    }
    demo.accounts.set(a.id, { ...a });
    return "ok";
  },
  async get(orgId, id) {
    const a = demo.accounts.get(id);
    return a && a.orgId === orgId ? { ...a } : null;
  },
  async byRef(ref) {
    for (const a of demo.accounts.values()) if (a.webhookRef === ref) return { ...a };
    return null;
  },
  async list(orgId) {
    return [...demo.accounts.values()].filter((a) => a.orgId === orgId).map((a) => ({ ...a, secret: demo.secrets.get(a.id) ?? null }));
  },
  async putSecret(a, row) {
    demo.secrets.set(a.id, { ...row });
    return true;
  },
  async getSecret(a) {
    return demo.secrets.get(a.id) ?? null;
  },
  async setStatus(a, status) {
    const x = demo.accounts.get(a.id);
    if (!x || x.orgId !== a.orgId) return false;
    x.status = status;
    return true;
  },
  async recordEvent(a, key) {
    const k = `${a.id}|${key}`;
    if (demo.events.has(k)) return "duplicate";
    demo.events.add(k);
    return "new";
  },
};

// ---------- supabase ----------
type Row = {
  id: string;
  org_id: string;
  employee_id: string;
  surface: CommSurface;
  external_account_id: string;
  webhook_ref: string;
  status: CommAccountStatus;
  display_name: string | null;
};
const COLS = "id, org_id, employee_id, surface, external_account_id, webhook_ref, status, display_name";
const fromRow = (r: Row): CommAccount => ({
  id: r.id,
  orgId: r.org_id,
  employeeId: r.employee_id,
  surface: r.surface,
  externalAccountId: r.external_account_id,
  webhookRef: r.webhook_ref,
  status: r.status,
  displayName: r.display_name,
});

function supabaseBackend(): Backend | null {
  const db = createSupabaseAdminClient();
  if (!db) return null;
  return {
    async insert(a, createdBy) {
      const { error } = await db.from("employee_comm_accounts").insert({
        id: a.id,
        org_id: a.orgId,
        employee_id: a.employeeId,
        surface: a.surface,
        external_account_id: a.externalAccountId,
        webhook_ref: a.webhookRef,
        status: a.status,
        display_name: a.displayName,
        created_by_member_id: createdBy && UUID_RE.test(createdBy) ? createdBy : null,
      });
      if (!error) return "ok";
      const msg = `${error.message || ""} ${(error as { details?: string }).details || ""}`;
      if (error.code === "23505" && msg.includes("employee_comm_accounts_employee_key")) return "employee_has_account";
      if (error.code === "23505" && msg.includes("employee_comm_accounts_external_key")) return "external_account_taken";
      return "error";
    },
    async get(orgId, id) {
      const { data, error } = await db.from("employee_comm_accounts").select(COLS).eq("org_id", orgId).eq("id", id).maybeSingle();
      if (error) throw new Error("comm_account_read_failed");
      return data ? fromRow(data as Row) : null;
    },
    async byRef(ref) {
      const { data, error } = await db.from("employee_comm_accounts").select(COLS).eq("webhook_ref", ref).maybeSingle();
      if (error) throw new Error("comm_account_read_failed");
      return data ? fromRow(data as Row) : null;
    },
    async list(orgId) {
      const { data, error } = await db
        .from("employee_comm_accounts")
        .select(`${COLS}, employee_comm_account_secrets(secret_names, verified_at)`)
        .eq("org_id", orgId)
        .order("created_at", { ascending: true });
      if (error) throw new Error("comm_account_read_failed");
      return (data as unknown as Array<Row & { employee_comm_account_secrets: { secret_names: string[]; verified_at: string | null } | null }>).map((r) => ({
        ...fromRow(r),
        secret: r.employee_comm_account_secrets
          ? { ciphertext: "", secretNames: r.employee_comm_account_secrets.secret_names, verifiedAt: r.employee_comm_account_secrets.verified_at }
          : null,
      }));
    },
    async putSecret(a, row, memberId) {
      const { error } = await db.from("employee_comm_account_secrets").upsert(
        {
          account_id: a.id,
          org_id: a.orgId,
          ciphertext: row.ciphertext,
          secret_names: row.secretNames,
          verified_at: row.verifiedAt,
          updated_by_member_id: memberId && UUID_RE.test(memberId) ? memberId : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "account_id" }
      );
      return !error;
    },
    async getSecret(a) {
      const { data, error } = await db
        .from("employee_comm_account_secrets")
        .select("ciphertext, secret_names, verified_at")
        .eq("account_id", a.id)
        .eq("org_id", a.orgId)
        .maybeSingle();
      if (error) throw new Error("comm_secret_read_failed");
      return data ? { ciphertext: data.ciphertext as string, secretNames: data.secret_names as string[], verifiedAt: (data.verified_at as string | null) ?? null } : null;
    },
    async setStatus(a, status) {
      const { data, error } = await db
        .from("employee_comm_accounts")
        .update({ status, disabled_at: status === "disabled" ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
        .eq("org_id", a.orgId)
        .eq("id", a.id)
        .select("id");
      return !error && Array.isArray(data) && data.length === 1;
    },
    async recordEvent(a, key) {
      const { error } = await db.from("comm_inbound_events").insert({ account_id: a.id, org_id: a.orgId, event_key: key });
      if (!error) return "new";
      return error.code === "23505" ? "duplicate" : "error";
    },
  };
}

function backend(): Backend | null {
  return isDemoMode() ? demoBackend : supabaseBackend();
}

export async function createCommAccount(input: {
  orgId: string;
  employeeId: string;
  surface: CommSurface;
  externalAccountId: string;
  displayName?: string | null;
  createdByMemberId: string | null;
}): Promise<{ ok: true; account: CommAccount } | { ok: false; reason: string }> {
  if (!isCommAccountsEnabled()) return { ok: false, reason: "disabled" };
  if (!SURFACES.has(input.surface)) return { ok: false, reason: "invalid_surface" };
  const ext = String(input.externalAccountId || "").trim();
  if (!EXTERNAL_ID_RE[input.surface].test(ext)) return { ok: false, reason: "invalid_external_account_id" };
  const name = input.displayName == null ? null : String(input.displayName).trim().slice(0, 200) || null;
  const b = backend();
  if (!b) return { ok: false, reason: "storage_unavailable" };
  const account: CommAccount = {
    id: randomUUID(),
    orgId: input.orgId,
    employeeId: input.employeeId,
    surface: input.surface,
    externalAccountId: ext,
    webhookRef: newWebhookRef(),
    status: "pending",
    displayName: name,
  };
  const r = await b.insert(account, input.createdByMemberId);
  if (r !== "ok") return { ok: false, reason: r === "error" ? "storage_error" : r };
  return { ok: true, account };
}

function validateSecrets(surface: CommSurface, secrets: Record<string, unknown>): LineSecrets | null {
  const spec = SECRET_SPEC[surface];
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) return null;
  const keys = Object.keys(secrets);
  if (keys.length !== Object.keys(spec).length) return null;
  const out: Record<string, string> = {};
  for (const [name, re] of Object.entries(spec)) {
    const v = secrets[name];
    if (typeof v !== "string" || !re.test(v)) return null;
    out[name] = v;
  }
  return out as LineSecrets;
}

export async function setCommAccountSecrets(input: {
  orgId: string;
  accountId: string;
  secrets: LineSecrets;
  memberId: string | null;
  verifiedAt?: string | null;
}): Promise<{ ok: true; secretNames: string[] } | { ok: false; reason: string }> {
  if (!isCommAccountsEnabled()) return { ok: false, reason: "disabled" };
  const b = backend();
  if (!b) return { ok: false, reason: "storage_unavailable" };
  const account = await b.get(input.orgId, input.accountId).catch(() => null);
  if (!account || account.status === "disabled") return { ok: false, reason: "not_found" };
  const valid = validateSecrets(account.surface, input.secrets as unknown as Record<string, unknown>);
  if (!valid) return { ok: false, reason: "invalid_secrets" };
  let ciphertext: string;
  try {
    ciphertext = encryptCommSecrets({ accountId: account.id, orgId: account.orgId }, valid);
  } catch {
    return { ok: false, reason: "encryption_unavailable" };
  }
  const secretNames = Object.keys(SECRET_SPEC[account.surface]).sort();
  if (!(await b.putSecret(account, { ciphertext, secretNames, verifiedAt: input.verifiedAt ?? null }, input.memberId))) {
    return { ok: false, reason: "storage_error" };
  }
  if (account.status === "pending" && !(await b.setStatus(account, "active"))) return { ok: false, reason: "storage_error" };
  return { ok: true, secretNames };
}

/** Server-only: decrypted secrets for the sending / verifying adapter. Never return these to a client or AI. */
export async function readCommAccountSecretsForServer(
  orgId: string,
  accountId: string
): Promise<{ ok: true; secrets: LineSecrets } | { ok: false; reason: string }> {
  if (!isCommAccountsEnabled()) return { ok: false, reason: "disabled" };
  const b = backend();
  if (!b) return { ok: false, reason: "storage_unavailable" };
  const account = await b.get(orgId, accountId).catch(() => null);
  if (!account) return { ok: false, reason: "not_found" };
  const row = await b.getSecret(account).catch(() => undefined);
  if (row === undefined) return { ok: false, reason: "storage_error" };
  if (!row) return { ok: false, reason: "no_secrets" };
  try {
    const secrets = decryptCommSecrets({ accountId: account.id, orgId: account.orgId }, row.ciphertext);
    const valid = validateSecrets(account.surface, secrets);
    return valid ? { ok: true, secrets: valid } : { ok: false, reason: "secret_invalid" };
  } catch {
    return { ok: false, reason: "secret_invalid" };
  }
}

/** Ingress: webhook ref → ACTIVE account. Flag OFF, unknown, pending, disabled → null (route answers 404). */
export async function getActiveCommAccountByWebhookRef(ref: string): Promise<CommAccount | null> {
  if (!isCommAccountsEnabled()) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(ref || ""))) return null;
  const b = backend();
  if (!b) return null;
  const a = await b.byRef(ref);
  return a && a.status === "active" ? a : null;
}

export async function listCommAccounts(orgId: string): Promise<CommAccountView[]> {
  if (!isCommAccountsEnabled()) return [];
  const b = backend();
  if (!b) return [];
  const rows = await b.list(orgId);
  return rows.map(({ secret, webhookRef, ...a }) => ({
    ...a,
    webhookPath: commWebhookPath({ surface: a.surface, webhookRef }),
    secretNames: secret?.secretNames ?? [],
    secretsVerifiedAt: secret?.verifiedAt ?? null,
  }));
}

export async function disableCommAccount(orgId: string, accountId: string): Promise<{ ok: boolean }> {
  if (!isCommAccountsEnabled()) return { ok: false };
  const b = backend();
  if (!b) return { ok: false };
  const a = await b.get(orgId, accountId).catch(() => null);
  if (!a) return { ok: false };
  return { ok: await b.setStatus(a, "disabled") };
}

/** Replay / redelivery guard (H7, H10): one row per (account, webhookEventId). No body is stored. */
export async function recordInboundEvent(account: CommAccount, eventKey: string): Promise<"new" | "duplicate" | "invalid" | "error"> {
  if (!EVENT_KEY_RE.test(String(eventKey || ""))) return "invalid";
  const b = backend();
  if (!b) return "error";
  return b.recordEvent(account, eventKey).catch(() => "error" as const);
}

/**
 * Pre-send re-check (lib/comm/pre-send): the account as stored now, by id within the org.
 * No secrets. null = gone or comm accounts OFF; throws when it cannot be read (the caller
 * refuses — fail closed).
 */
export async function getCommAccountForSend(orgId: string, accountId: string): Promise<CommAccount | null> {
  if (!isCommAccountsEnabled()) return null;
  const b = backend();
  if (!b) throw new Error("comm_accounts_unavailable");
  const a = await b.get(orgId, accountId);
  if (!a) return null;
  const { webhookRef: _ref, ...rest } = a;
  void _ref;
  return { ...rest, webhookRef: "" };
}

/** Tests only: the demo inbound-event ledger (keys only). */
export function __demoInboundEventsForTests(): string[] {
  return [...demo.events];
}
