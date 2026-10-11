/**
 * MCP OAuth 2.1 persistence (design §8).
 * - Supabase store (service role) in production; in-memory store in DEMO / tests.
 * - Only SHA-256 hashes of tokens / codes are ever stored.
 * - One-time artifacts (auth request, code) and refresh rotation are consumed
 *   with conditional UPDATE … WHERE consumed_at IS NULL RETURNING (atomic per row).
 */
import { randomUUID } from "node:crypto";
import { isDemoMode } from "@/lib/mode";
import { createSupabaseAdminClient } from "@/lib/supabase";

export type OAuthRegistrationType = "cimd" | "dcr" | "static";

export type OAuthClientRecord = {
  clientId: string;
  registrationType: OAuthRegistrationType;
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  metadata: Record<string, unknown>;
  metadataFetchedAt: string | null;
  metadataExpiresAt: string | null;
  status: "active" | "blocked";
  createdIpHash: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

export type OAuthAuthRequestRecord = {
  id: string;
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: string;
  scope: string[];
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
};

export type OAuthGrantRecord = {
  id: string;
  orgId: string;
  employeeId: string;
  clientId: string;
  credentialIdAtGrant: string | null;
  grantedByMemberId: string | null;
  grantedByEmail: string;
  resource: string;
  scope: string[];
  status: "active" | "revoked";
  expiresAt: string;
  revokedAt: string | null;
  revokedByEmail: string | null;
  revokeReason: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

export type OAuthCodeRecord = {
  codeHash: string;
  grantId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  expiresAt: string;
  consumedAt: string | null;
};

export type OAuthAccessTokenRecord = {
  tokenHash: string;
  grantId: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type OAuthRefreshTokenRecord = {
  tokenHash: string;
  grantId: string;
  parentHash: string | null;
  expiresAt: string;
  rotatedAt: string | null;
  revokedAt: string | null;
};

export type ConsumeResult<T> =
  | { ok: true; record: T }
  | { ok: false; reason: "not_found" | "expired" | "already_consumed"; record?: T };

export interface OAuthStore {
  /**
   * Insert or update a client. `preserveStatus` (CIMD metadata refresh): on
   * conflict the existing `status` is kept, so a block applied concurrently is
   * never reverted; `rec.status` is used only for a fresh insert.
   */
  upsertClient(
    rec: Omit<OAuthClientRecord, "createdAt" | "lastUsedAt"> & { createdAt?: string },
    opts?: { preserveStatus?: boolean }
  ): Promise<OAuthClientRecord>;
  getClient(clientId: string): Promise<OAuthClientRecord | null>;
  touchClient(clientId: string, at: string): Promise<void>;
  countDcrClientsSince(sinceIso: string, ipHash?: string | null): Promise<number>;
  /** DCR clients unused since `unusedBeforeIso` that have NO grant (any status). */
  deleteStaleDcrClients(unusedBeforeIso: string): Promise<number>;

  createAuthRequest(rec: Omit<OAuthAuthRequestRecord, "consumedAt" | "createdAt">): Promise<OAuthAuthRequestRecord>;
  getAuthRequest(id: string): Promise<OAuthAuthRequestRecord | null>;
  consumeAuthRequest(id: string, nowIso: string): Promise<ConsumeResult<OAuthAuthRequestRecord>>;

  createGrant(rec: Omit<OAuthGrantRecord, "id" | "status" | "revokedAt" | "revokedByEmail" | "revokeReason" | "lastUsedAt" | "createdAt">): Promise<OAuthGrantRecord>;
  getGrant(id: string): Promise<OAuthGrantRecord | null>;
  listGrantsForEmployee(orgId: string, employeeId: string): Promise<OAuthGrantRecord[]>;
  revokeGrant(id: string, by: string, reason: string, nowIso: string): Promise<OAuthGrantRecord | null>;
  revokeGrantsForEmployee(orgId: string, employeeId: string, by: string, reason: string, nowIso: string): Promise<OAuthGrantRecord[]>;
  touchGrant(id: string, at: string): Promise<void>;

  createCode(rec: Omit<OAuthCodeRecord, "consumedAt">): Promise<void>;
  /** Non-consuming read (token endpoint validates client/redirect/PKCE before consuming). */
  getCode(codeHash: string): Promise<OAuthCodeRecord | null>;
  consumeCode(codeHash: string, nowIso: string): Promise<ConsumeResult<OAuthCodeRecord>>;

  createAccessToken(rec: Omit<OAuthAccessTokenRecord, "revokedAt">): Promise<void>;
  getAccessToken(tokenHash: string): Promise<OAuthAccessTokenRecord | null>;
  revokeAccessToken(tokenHash: string, nowIso: string): Promise<boolean>;

  createRefreshToken(rec: Omit<OAuthRefreshTokenRecord, "rotatedAt" | "revokedAt">): Promise<void>;
  getRefreshToken(tokenHash: string): Promise<OAuthRefreshTokenRecord | null>;
  /** Mark rotated iff not yet rotated/revoked and unexpired. */
  rotateRefreshToken(tokenHash: string, nowIso: string): Promise<ConsumeResult<OAuthRefreshTokenRecord>>;
  revokeRefreshToken(tokenHash: string, nowIso: string): Promise<boolean>;

  /** Revoke every access + refresh token of a grant. */
  revokeTokensForGrant(grantId: string, nowIso: string): Promise<void>;

  /** Fixed-window counter; returns the count after this hit. */
  rateLimitHit(bucketKey: string, windowStartIso: string): Promise<number>;

  purgeExpired(nowIso: string): Promise<{ requests: number; codes: number; accessTokens: number; refreshTokens: number }>;
}

const isPast = (iso: string, nowIso: string) => Date.parse(iso) <= Date.parse(nowIso);

/* ------------------------------------------------------------------ memory */

export function createMemoryOAuthStore(): OAuthStore {
  const clients = new Map<string, OAuthClientRecord>();
  const requests = new Map<string, OAuthAuthRequestRecord>();
  const grants = new Map<string, OAuthGrantRecord>();
  const codes = new Map<string, OAuthCodeRecord>();
  const access = new Map<string, OAuthAccessTokenRecord>();
  const refresh = new Map<string, OAuthRefreshTokenRecord>();
  const buckets = new Map<string, number>();
  const clone = <T>(v: T): T => structuredClone(v);

  return {
    async upsertClient(rec, opts) {
      const prev = clients.get(rec.clientId);
      const next: OAuthClientRecord = {
        ...rec,
        status: opts?.preserveStatus && prev ? prev.status : rec.status,
        createdAt: prev?.createdAt ?? rec.createdAt ?? new Date().toISOString(),
        lastUsedAt: prev?.lastUsedAt ?? null,
      };
      clients.set(rec.clientId, next);
      return clone(next);
    },
    async getClient(id) {
      const c = clients.get(id);
      return c ? clone(c) : null;
    },
    async touchClient(id, at) {
      const c = clients.get(id);
      if (c) c.lastUsedAt = at;
    },
    async countDcrClientsSince(since, ipHash) {
      return [...clients.values()].filter(
        (c) => c.registrationType === "dcr" && c.createdAt >= since && (ipHash == null || c.createdIpHash === ipHash)
      ).length;
    },
    async deleteStaleDcrClients(before) {
      let n = 0;
      const withGrant = new Set([...grants.values()].map((g) => g.clientId));
      for (const [k, c] of clients) {
        if (c.registrationType === "dcr" && (c.lastUsedAt ?? c.createdAt) < before && !withGrant.has(k)) {
          clients.delete(k);
          n++;
        }
      }
      return n;
    },

    async createAuthRequest(rec) {
      const r: OAuthAuthRequestRecord = { ...rec, consumedAt: null, createdAt: new Date().toISOString() };
      requests.set(r.id, r);
      return clone(r);
    },
    async getAuthRequest(id) {
      const r = requests.get(id);
      return r ? clone(r) : null;
    },
    async consumeAuthRequest(id, now) {
      const r = requests.get(id);
      if (!r) return { ok: false, reason: "not_found" };
      if (r.consumedAt) return { ok: false, reason: "already_consumed", record: clone(r) };
      if (isPast(r.expiresAt, now)) return { ok: false, reason: "expired", record: clone(r) };
      r.consumedAt = now;
      return { ok: true, record: clone(r) };
    },

    async createGrant(rec) {
      const g: OAuthGrantRecord = {
        ...rec,
        id: randomUUID(),
        status: "active",
        revokedAt: null,
        revokedByEmail: null,
        revokeReason: null,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
      };
      grants.set(g.id, g);
      return clone(g);
    },
    async getGrant(id) {
      const g = grants.get(id);
      return g ? clone(g) : null;
    },
    async listGrantsForEmployee(orgId, employeeId) {
      return [...grants.values()]
        .filter((g) => g.orgId === orgId && g.employeeId === employeeId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map(clone);
    },
    async revokeGrant(id, by, reason, now) {
      const g = grants.get(id);
      if (!g) return null;
      if (g.status === "active") {
        Object.assign(g, { status: "revoked", revokedAt: now, revokedByEmail: by, revokeReason: reason });
      }
      return clone(g);
    },
    async revokeGrantsForEmployee(orgId, employeeId, by, reason, now) {
      const out: OAuthGrantRecord[] = [];
      for (const g of grants.values()) {
        if (g.orgId === orgId && g.employeeId === employeeId && g.status === "active") {
          Object.assign(g, { status: "revoked", revokedAt: now, revokedByEmail: by, revokeReason: reason });
          out.push(clone(g));
        }
      }
      return out;
    },
    async touchGrant(id, at) {
      const g = grants.get(id);
      if (g) g.lastUsedAt = at;
    },

    async createCode(rec) {
      codes.set(rec.codeHash, { ...rec, consumedAt: null });
    },
    async getCode(hash) {
      const c = codes.get(hash);
      return c ? clone(c) : null;
    },
    async consumeCode(hash, now) {
      const c = codes.get(hash);
      if (!c) return { ok: false, reason: "not_found" };
      if (c.consumedAt) return { ok: false, reason: "already_consumed", record: clone(c) };
      if (isPast(c.expiresAt, now)) return { ok: false, reason: "expired", record: clone(c) };
      c.consumedAt = now;
      return { ok: true, record: clone(c) };
    },

    async createAccessToken(rec) {
      access.set(rec.tokenHash, { ...rec, revokedAt: null });
    },
    async getAccessToken(hash) {
      const t = access.get(hash);
      return t ? clone(t) : null;
    },
    async revokeAccessToken(hash, now) {
      const t = access.get(hash);
      if (!t || t.revokedAt) return false;
      t.revokedAt = now;
      return true;
    },

    async createRefreshToken(rec) {
      refresh.set(rec.tokenHash, { ...rec, rotatedAt: null, revokedAt: null });
    },
    async getRefreshToken(hash) {
      const t = refresh.get(hash);
      return t ? clone(t) : null;
    },
    async rotateRefreshToken(hash, now) {
      const t = refresh.get(hash);
      if (!t) return { ok: false, reason: "not_found" };
      if (t.rotatedAt || t.revokedAt) return { ok: false, reason: "already_consumed", record: clone(t) };
      if (isPast(t.expiresAt, now)) return { ok: false, reason: "expired", record: clone(t) };
      t.rotatedAt = now;
      return { ok: true, record: clone(t) };
    },
    async revokeRefreshToken(hash, now) {
      const t = refresh.get(hash);
      if (!t || t.revokedAt) return false;
      t.revokedAt = now;
      return true;
    },

    async revokeTokensForGrant(grantId, now) {
      for (const t of access.values()) if (t.grantId === grantId && !t.revokedAt) t.revokedAt = now;
      for (const t of refresh.values()) if (t.grantId === grantId && !t.revokedAt) t.revokedAt = now;
    },

    async rateLimitHit(key, windowStart) {
      const k = `${key}@${windowStart}`;
      const n = (buckets.get(k) ?? 0) + 1;
      buckets.set(k, n);
      return n;
    },

    async purgeExpired(now) {
      const res = { requests: 0, codes: 0, accessTokens: 0, refreshTokens: 0 };
      for (const [k, r] of requests) if (isPast(r.expiresAt, now)) (requests.delete(k), res.requests++);
      for (const [k, c] of codes) if (isPast(c.expiresAt, now)) (codes.delete(k), res.codes++);
      for (const [k, t] of access) if (isPast(t.expiresAt, now)) (access.delete(k), res.accessTokens++);
      for (const [k, t] of refresh) if (isPast(t.expiresAt, now)) (refresh.delete(k), res.refreshTokens++);
      return res;
    },
  };
}

/* ---------------------------------------------------------------- supabase */

type Row = Record<string, unknown>;
const s = (v: unknown) => (v == null ? null : String(v));

function mapClient(r: Row): OAuthClientRecord {
  return {
    clientId: String(r.client_id),
    registrationType: r.registration_type as OAuthRegistrationType,
    clientName: String(r.client_name ?? ""),
    clientUri: s(r.client_uri),
    logoUri: s(r.logo_uri),
    redirectUris: (r.redirect_uris as string[]) ?? [],
    tokenEndpointAuthMethod: "none",
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    metadataFetchedAt: s(r.metadata_fetched_at),
    metadataExpiresAt: s(r.metadata_expires_at),
    status: (r.status as "active" | "blocked") ?? "active",
    createdIpHash: s(r.created_ip_hash),
    lastUsedAt: s(r.last_used_at),
    createdAt: String(r.created_at),
  };
}
function mapRequest(r: Row): OAuthAuthRequestRecord {
  return {
    id: String(r.id),
    clientId: String(r.client_id),
    redirectUri: String(r.redirect_uri),
    state: s(r.state),
    codeChallenge: String(r.code_challenge),
    resource: String(r.resource),
    scope: (r.scope as string[]) ?? [],
    expiresAt: String(r.expires_at),
    consumedAt: s(r.consumed_at),
    createdAt: String(r.created_at),
  };
}
function mapGrant(r: Row): OAuthGrantRecord {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    employeeId: String(r.employee_id),
    clientId: String(r.client_id),
    credentialIdAtGrant: s(r.credential_id_at_grant),
    grantedByMemberId: s(r.granted_by_member_id),
    grantedByEmail: String(r.granted_by_email ?? ""),
    resource: String(r.resource),
    scope: (r.scope as string[]) ?? [],
    status: r.status as "active" | "revoked",
    expiresAt: String(r.expires_at),
    revokedAt: s(r.revoked_at),
    revokedByEmail: s(r.revoked_by_email),
    revokeReason: s(r.revoke_reason),
    lastUsedAt: s(r.last_used_at),
    createdAt: String(r.created_at),
  };
}
function mapCode(r: Row): OAuthCodeRecord {
  return {
    codeHash: String(r.code_hash),
    grantId: String(r.grant_id),
    clientId: String(r.client_id),
    redirectUri: String(r.redirect_uri),
    codeChallenge: String(r.code_challenge),
    resource: String(r.resource),
    expiresAt: String(r.expires_at),
    consumedAt: s(r.consumed_at),
  };
}
function mapAccess(r: Row): OAuthAccessTokenRecord {
  return { tokenHash: String(r.token_hash), grantId: String(r.grant_id), expiresAt: String(r.expires_at), revokedAt: s(r.revoked_at) };
}
function mapRefresh(r: Row): OAuthRefreshTokenRecord {
  return {
    tokenHash: String(r.token_hash),
    grantId: String(r.grant_id),
    parentHash: s(r.parent_hash),
    expiresAt: String(r.expires_at),
    rotatedAt: s(r.rotated_at),
    revokedAt: s(r.revoked_at),
  };
}

function fail(op: string, error: { message?: string } | null): never {
  // Never include row data (could contain hashes) — op name + db message only.
  throw new Error(`oauth_store_${op}_failed${error?.message ? `: ${error.message}` : ""}`);
}

export function createSupabaseOAuthStore(): OAuthStore {
  const db = () => {
    const c = createSupabaseAdminClient();
    if (!c) throw new Error("oauth_store_unavailable");
    return c;
  };

  type ExpiringTable =
    | "oauth_authorization_requests"
    | "oauth_authorization_codes"
    | "oauth_access_tokens"
    | "oauth_refresh_tokens";
  /**
   * Literal .from() targets only: lib/security/tenant-config-write-paths.test.ts
   * forbids non-literal table names so no write can hide behind a variable.
   */
  const fromExpiring = (table: ExpiringTable) => {
    switch (table) {
      case "oauth_authorization_requests":
        return db().from("oauth_authorization_requests");
      case "oauth_authorization_codes":
        return db().from("oauth_authorization_codes");
      case "oauth_access_tokens":
        return db().from("oauth_access_tokens");
      case "oauth_refresh_tokens":
        return db().from("oauth_refresh_tokens");
    }
  };

  async function consume<T>(
    table: Exclude<ExpiringTable, "oauth_access_tokens">,
    keyCol: string,
    key: string,
    setCol: string,
    nowIso: string,
    map: (r: Row) => T,
    extraNullCols: string[] = []
  ): Promise<ConsumeResult<T>> {
    let q = fromExpiring(table)
      .update({ [setCol]: nowIso })
      .eq(keyCol, key)
      .is(setCol, null)
      .gt("expires_at", nowIso);
    for (const c of extraNullCols) q = q.is(c, null);
    const { data, error } = await q.select("*").maybeSingle();
    if (error) fail(`consume_${table}`, error);
    if (data) return { ok: true, record: map(data as Row) };
    const { data: existing } = await fromExpiring(table).select("*").eq(keyCol, key).maybeSingle();
    if (!existing) return { ok: false, reason: "not_found" };
    const rec = existing as Row;
    if (rec[setCol] || extraNullCols.some((c) => rec[c])) return { ok: false, reason: "already_consumed", record: map(rec) };
    return { ok: false, reason: "expired", record: map(rec) };
  }

  return {
    async upsertClient(rec, opts) {
      if (opts?.preserveStatus) {
        // Insert-if-absent, then metadata-only update that never touches `status`
        // (a concurrent admin block must win over a CIMD refresh).
        const meta = {
          registration_type: rec.registrationType,
          client_name: rec.clientName,
          client_uri: rec.clientUri,
          logo_uri: rec.logoUri,
          redirect_uris: rec.redirectUris,
          token_endpoint_auth_method: "none",
          metadata: rec.metadata,
          metadata_fetched_at: rec.metadataFetchedAt,
          metadata_expires_at: rec.metadataExpiresAt,
        };
        const ins = await db()
          .from("oauth_clients")
          .upsert({ client_id: rec.clientId, ...meta, status: rec.status, created_ip_hash: rec.createdIpHash }, { onConflict: "client_id", ignoreDuplicates: true });
        if (ins.error) fail("upsert_client_insert", ins.error);
        const { data, error } = await db().from("oauth_clients").update(meta).eq("client_id", rec.clientId).select("*").single();
        if (error || !data) fail("upsert_client_refresh", error);
        return mapClient(data as Row);
      }
      const { data, error } = await db()
        .from("oauth_clients")
        .upsert(
          {
            client_id: rec.clientId,
            registration_type: rec.registrationType,
            client_name: rec.clientName,
            client_uri: rec.clientUri,
            logo_uri: rec.logoUri,
            redirect_uris: rec.redirectUris,
            token_endpoint_auth_method: "none",
            metadata: rec.metadata,
            metadata_fetched_at: rec.metadataFetchedAt,
            metadata_expires_at: rec.metadataExpiresAt,
            status: rec.status,
            created_ip_hash: rec.createdIpHash,
          },
          { onConflict: "client_id" }
        )
        .select("*")
        .single();
      if (error || !data) fail("upsert_client", error);
      return mapClient(data as Row);
    },
    async getClient(id) {
      const { data } = await db().from("oauth_clients").select("*").eq("client_id", id).maybeSingle();
      return data ? mapClient(data as Row) : null;
    },
    async touchClient(id, at) {
      await db().from("oauth_clients").update({ last_used_at: at }).eq("client_id", id);
    },
    async countDcrClientsSince(since, ipHash) {
      let q = db().from("oauth_clients").select("client_id", { count: "exact", head: true }).eq("registration_type", "dcr").gte("created_at", since);
      if (ipHash != null) q = q.eq("created_ip_hash", ipHash);
      const { count, error } = await q;
      if (error) fail("count_dcr", error);
      return count ?? 0;
    },
    async deleteStaleDcrClients(before) {
      // Candidates (bounded batch), minus every client that has ANY grant:
      // oauth_grants.client_id cascades, so a consented client (active or
      // revoked grant = audit trail) is never deleted here.
      const { data: cands, error: e1 } = await db()
        .from("oauth_clients")
        .select("client_id")
        .eq("registration_type", "dcr")
        .or(`last_used_at.lt.${before},and(last_used_at.is.null,created_at.lt.${before})`)
        .limit(1000);
      if (e1) fail("stale_dcr_candidates", e1);
      const ids = (cands ?? []).map((r) => String((r as Row).client_id));
      if (ids.length === 0) return 0;
      const { data: used, error: e2 } = await db().from("oauth_grants").select("client_id").in("client_id", ids);
      if (e2) fail("stale_dcr_grants", e2);
      const keep = new Set((used ?? []).map((r) => String((r as Row).client_id)));
      const doomed = ids.filter((id) => !keep.has(id));
      if (doomed.length === 0) return 0;
      const { data, error } = await db()
        .from("oauth_clients")
        .delete()
        .eq("registration_type", "dcr")
        .in("client_id", doomed)
        .or(`last_used_at.lt.${before},and(last_used_at.is.null,created_at.lt.${before})`)
        .select("client_id");
      if (error) fail("delete_stale_dcr", error);
      return (data ?? []).length;
    },

    async createAuthRequest(rec) {
      const { data, error } = await db()
        .from("oauth_authorization_requests")
        .insert({
          id: rec.id,
          client_id: rec.clientId,
          redirect_uri: rec.redirectUri,
          state: rec.state,
          code_challenge: rec.codeChallenge,
          resource: rec.resource,
          scope: rec.scope,
          expires_at: rec.expiresAt,
        })
        .select("*")
        .single();
      if (error || !data) fail("create_request", error);
      return mapRequest(data as Row);
    },
    async getAuthRequest(id) {
      const { data } = await db().from("oauth_authorization_requests").select("*").eq("id", id).maybeSingle();
      return data ? mapRequest(data as Row) : null;
    },
    consumeAuthRequest: (id, now) => consume("oauth_authorization_requests", "id", id, "consumed_at", now, mapRequest),

    async createGrant(rec) {
      const { data, error } = await db()
        .from("oauth_grants")
        .insert({
          org_id: rec.orgId,
          employee_id: rec.employeeId,
          client_id: rec.clientId,
          credential_id_at_grant: rec.credentialIdAtGrant,
          granted_by_member_id: rec.grantedByMemberId,
          granted_by_email: rec.grantedByEmail,
          resource: rec.resource,
          scope: rec.scope,
          expires_at: rec.expiresAt,
        })
        .select("*")
        .single();
      if (error || !data) fail("create_grant", error);
      return mapGrant(data as Row);
    },
    async getGrant(id) {
      const { data } = await db().from("oauth_grants").select("*").eq("id", id).maybeSingle();
      return data ? mapGrant(data as Row) : null;
    },
    async listGrantsForEmployee(orgId, employeeId) {
      const { data, error } = await db()
        .from("oauth_grants")
        .select("*")
        .eq("org_id", orgId)
        .eq("employee_id", employeeId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) fail("list_grants", error);
      return (data ?? []).map((r) => mapGrant(r as Row));
    },
    async revokeGrant(id, by, reason, now) {
      await db()
        .from("oauth_grants")
        .update({ status: "revoked", revoked_at: now, revoked_by_email: by, revoke_reason: reason })
        .eq("id", id)
        .eq("status", "active");
      const { data } = await db().from("oauth_grants").select("*").eq("id", id).maybeSingle();
      return data ? mapGrant(data as Row) : null;
    },
    async revokeGrantsForEmployee(orgId, employeeId, by, reason, now) {
      const { data, error } = await db()
        .from("oauth_grants")
        .update({ status: "revoked", revoked_at: now, revoked_by_email: by, revoke_reason: reason })
        .eq("org_id", orgId)
        .eq("employee_id", employeeId)
        .eq("status", "active")
        .select("*");
      if (error) fail("revoke_employee_grants", error);
      return (data ?? []).map((r) => mapGrant(r as Row));
    },
    async touchGrant(id, at) {
      await db().from("oauth_grants").update({ last_used_at: at }).eq("id", id);
    },

    async createCode(rec) {
      const { error } = await db().from("oauth_authorization_codes").insert({
        code_hash: rec.codeHash,
        grant_id: rec.grantId,
        client_id: rec.clientId,
        redirect_uri: rec.redirectUri,
        code_challenge: rec.codeChallenge,
        resource: rec.resource,
        expires_at: rec.expiresAt,
      });
      if (error) fail("create_code", error);
    },
    async getCode(hash) {
      const { data } = await db().from("oauth_authorization_codes").select("*").eq("code_hash", hash).maybeSingle();
      return data ? mapCode(data as Row) : null;
    },
    consumeCode: (hash, now) => consume("oauth_authorization_codes", "code_hash", hash, "consumed_at", now, mapCode),

    async createAccessToken(rec) {
      const { error } = await db().from("oauth_access_tokens").insert({ token_hash: rec.tokenHash, grant_id: rec.grantId, expires_at: rec.expiresAt });
      if (error) fail("create_access", error);
    },
    async getAccessToken(hash) {
      const { data } = await db().from("oauth_access_tokens").select("*").eq("token_hash", hash).maybeSingle();
      return data ? mapAccess(data as Row) : null;
    },
    async revokeAccessToken(hash, now) {
      const { data } = await db().from("oauth_access_tokens").update({ revoked_at: now }).eq("token_hash", hash).is("revoked_at", null).select("token_hash");
      return (data ?? []).length > 0;
    },

    async createRefreshToken(rec) {
      const { error } = await db().from("oauth_refresh_tokens").insert({
        token_hash: rec.tokenHash,
        grant_id: rec.grantId,
        parent_hash: rec.parentHash,
        expires_at: rec.expiresAt,
      });
      if (error) fail("create_refresh", error);
    },
    async getRefreshToken(hash) {
      const { data } = await db().from("oauth_refresh_tokens").select("*").eq("token_hash", hash).maybeSingle();
      return data ? mapRefresh(data as Row) : null;
    },
    rotateRefreshToken: (hash, now) =>
      consume("oauth_refresh_tokens", "token_hash", hash, "rotated_at", now, mapRefresh, ["revoked_at"]),
    async revokeRefreshToken(hash, now) {
      const { data } = await db().from("oauth_refresh_tokens").update({ revoked_at: now }).eq("token_hash", hash).is("revoked_at", null).select("token_hash");
      return (data ?? []).length > 0;
    },

    async revokeTokensForGrant(grantId, now) {
      await db().from("oauth_access_tokens").update({ revoked_at: now }).eq("grant_id", grantId).is("revoked_at", null);
      await db().from("oauth_refresh_tokens").update({ revoked_at: now }).eq("grant_id", grantId).is("revoked_at", null);
    },

    async rateLimitHit(key, windowStart) {
      const { data, error } = await db().rpc("oauth_rate_limit_hit", { p_key: key, p_window_start: windowStart });
      if (error) fail("rate_limit", error);
      return Number(data ?? 0);
    },

    async purgeExpired(now) {
      const del = async (table: ExpiringTable) => {
        const { data, error } = await fromExpiring(table).delete().lt("expires_at", now).select("expires_at");
        if (error) fail(`purge_${table}`, error);
        return (data ?? []).length;
      };
      // Old rate-limit windows (>1 day) too.
      await db().from("oauth_rate_limits").delete().lt("window_start", new Date(Date.parse(now) - 86_400_000).toISOString());
      return {
        requests: await del("oauth_authorization_requests"),
        codes: await del("oauth_authorization_codes"),
        accessTokens: await del("oauth_access_tokens"),
        refreshTokens: await del("oauth_refresh_tokens"),
      };
    },
  };
}

/* ---------------------------------------------------------------- selector */

let override: OAuthStore | null = null;
let memorySingleton: OAuthStore | null = null;

/** DEMO → process-local memory store; production → Supabase service role. */
export function getOAuthStore(): OAuthStore {
  if (override) return override;
  if (isDemoMode()) {
    memorySingleton ??= createMemoryOAuthStore();
    return memorySingleton;
  }
  return createSupabaseOAuthStore();
}

/** Tests only. */
export function __setOAuthStoreForTests(store: OAuthStore | null): void {
  override = store;
}
