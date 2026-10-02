/**
 * Consent screen data + decision processing (design §6, PR-5).
 *
 * Who may consent: a REAL signed-in member (no owner fallback) of the org,
 * role owner/admin AND capability hire_issue_credentials, signed in within
 * the last 15 min, MFA (aal2) when MCP_OAUTH_CONSENT_REQUIRE_MFA is ON, org
 * on MCP_OAUTH_ORG_ALLOWLIST, and the employee must belong to the session org.
 *
 * Secrets (code, CSRF token, rid) never go to logs / audit / error text.
 */
import { getOAuthStore, type OAuthStore } from "@/lib/data/oauth";
import { isMcpOAuthConsentMfaRequired } from "@/lib/feature-flags";
import {
  AUTH_CODE_TTL_SEC,
  CONSENT_MAX_LOGIN_AGE_SEC,
  GRANT_MAX_TTL_SEC,
  cimdAllowedHosts,
  isOrgAllowedForOAuth,
  oauthStateSecret,
} from "@/lib/mcp-oauth/config";
import { ridBindingCookieName, verifyRidBinding } from "@/lib/mcp-oauth/browser-binding";
import { mintConsentCsrf, verifyConsentCsrf } from "@/lib/mcp-oauth/csrf";
import type { CurrentCredential } from "@/lib/mcp-oauth/employee-state";
import { buildClientRedirect } from "@/lib/mcp-oauth/http";
import type { RateDecision } from "@/lib/mcp-oauth/rate-limit";
import { OAUTH_RATE_LIMITS } from "@/lib/mcp-oauth/rate-limit";
import { isLoopbackRedirect, isRedirectAllowedForClient, redirectHost } from "@/lib/mcp-oauth/redirect-policy";
import { hashPrefix, mintAuthCode } from "@/lib/mcp-oauth/tokens";
import { CREDENTIAL_ADMIN_ROLES } from "@/lib/auth/require-credential-admin";
import { hasCapability } from "@/lib/team/rbac";
import type { AuditEvent, Employee, OrgMember } from "@/lib/types";

export type ConsentSession = {
  userId: string | null;
  email: string | null;
  orgId: string | null;
  member: OrgMember | null;
  lastSignInAt?: string | null;
};

export type ConsentNotifyInput = {
  orgId: string;
  actorEmail: string;
  employeeId: string;
  employeeName: string;
  clientName: string;
  clientHost: string;
};

export type ConsentDeps = {
  store: OAuthStore;
  getSession: () => Promise<ConsentSession>;
  getEmployeeById: (id: string) => Promise<Employee | null>;
  listEmployees: (orgId: string) => Promise<Employee[]>;
  getBinding: (employeeId: string) => Promise<{ status: string } | undefined | null>;
  getCurrentCredential: (employeeId: string) => Promise<CurrentCredential>;
  getOrgName: (orgId: string) => Promise<string | null>;
  /** Supabase assurance level; only consulted when the MFA flag is ON. */
  getAal: () => Promise<string | null>;
  audit: (e: Omit<AuditEvent, "id" | "createdAt"> & { actorEmail?: string }) => Promise<void>;
  notify: (input: ConsentNotifyInput) => Promise<void>;
  rateLimit: (bucket: string, limit: number, windowSec: number) => Promise<RateDecision>;
  stateSecret: () => string | null;
  /** Request cookie lookup (rid browser binding, hardening 2). */
  getCookie: (name: string) => Promise<string | null>;
  now: () => Date;
};

export type ConsentPage = { type: "page"; status: number; error: string; messageJa: string; reason?: "not_started_here" };
export type ConsentRedirect = { type: "redirect"; location: string };

export type ConsentEmployeeOption = {
  id: string;
  displayName: string;
  roleLabel: string;
  scopes: string[];
  allowedPurposes: string[];
  credentialExpiresAt: string | null;
};

export type ConsentView = {
  rid: string;
  csrf: string;
  email: string;
  orgId: string;
  orgName: string;
  client: {
    name: string;
    host: string;
    redirectHost: string;
    verifiedHost: boolean;
    registrationType: string;
    loopback: boolean;
  };
  employees: ConsentEmployeeOption[];
  /** Always shown, for every client (hardening 2). */
  startedYourselfWarningJa: string;
  /** Prominent "what you are approving": client/redirect host + eligible AI employee names (hardening 2b). */
  approvalSummaryJa: string;
  /** null → may consent; otherwise the reason (shown, buttons disabled except deny). */
  blockedReason: null | "role" | "org_not_allowed" | "login_too_old" | "mfa_required" | "no_employees";
};

export type ConsentViewOutcome =
  | { type: "login_required" }
  | ConsentPage
  | { type: "view"; view: ConsentView };

function page(status: number, error: string, messageJa: string): ConsentPage {
  return { type: "page", status, error, messageJa };
}

export const STARTED_YOURSELF_WARNING_JA =
  "⚠ この接続を自分で開始した場合（このブラウザで AI クライアントから始めた操作）だけ許可してください。誰かからこのリンクが送られてきた場合は、許可しないでください（「拒否」を押してください）。";

export const NOT_STARTED_HERE_MESSAGE_JA =
  "この接続リクエストは、このブラウザで開始されたものではありません。誰かからリンクが送られてきた場合は、何もせずに閉じてください。自分で接続したい場合は、AI クライアントからこのブラウザでやり直してください。";

function approvalSummary(clientHost: string, redirectHostName: string, employees: ConsentEmployeeOption[]): string {
  const where = redirectHostName && redirectHostName !== clientHost ? `${clientHost}（送信先 ${redirectHostName}）` : clientHost || redirectHostName;
  const names = employees.slice(0, 5).map((e) => `「${e.displayName}」`).join("");
  const more = employees.length > 5 ? ` ほか ${employees.length - 5} 名` : "";
  return employees.length
    ? `許可すると、${where} の AI クライアントが、選んだ AI 社員（候補: ${names}${more}）として動けるようになります。`
    : `許可すると、${where} の AI クライアントが AI 社員として動けるようになります。`;
}
export const LOOPBACK_WARNING_JA = "この接続はあなたの PC 上のアプリに渡されます。";

const NOT_BOUND_PAGE = (): ConsentPage => ({ ...page(403, "access_denied", NOT_STARTED_HERE_MESSAGE_JA), reason: "not_started_here" });

async function browserBound(deps: ConsentDeps, secret: string, rid: string): Promise<boolean> {
  if (!rid || rid.length > 128) return false;
  return verifyRidBinding(secret, rid, await deps.getCookie(ridBindingCookieName(rid)));
}

function clientHostOf(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return "";
  }
}

function isCredentialAdmin(member: OrgMember | null): boolean {
  return Boolean(member && CREDENTIAL_ADMIN_ROLES.includes(member.role) && hasCapability(member, "hire_issue_credentials"));
}

function loginFresh(lastSignInAt: string | null | undefined, now: Date): boolean {
  const t = lastSignInAt ? Date.parse(lastSignInAt) : NaN;
  if (!Number.isFinite(t)) return false;
  const age = now.getTime() - t;
  return age >= -60_000 && age <= CONSENT_MAX_LOGIN_AGE_SEC * 1000;
}

/** A real session: Supabase user + active membership + org. No owner fallback. */
function realSession(s: ConsentSession): s is ConsentSession & { userId: string; orgId: string; member: OrgMember } {
  return Boolean(s.userId && s.orgId && s.member && s.member.orgId === s.orgId);
}

async function usableAuthRequest(deps: ConsentDeps, rid: string) {
  if (!rid || rid.length > 128) return { ok: false as const, out: page(400, "invalid_request", "認可リクエストが見つかりません。AI クライアントからやり直してください。") };
  const req = await deps.store.getAuthRequest(rid);
  if (!req) return { ok: false as const, out: page(400, "invalid_request", "認可リクエストが見つかりません。AI クライアントからやり直してください。") };
  if (req.consumedAt) return { ok: false as const, out: page(400, "invalid_request", "この認可リクエストは使用済みです。AI クライアントからやり直してください。") };
  if (Date.parse(req.expiresAt) <= deps.now().getTime()) {
    return { ok: false as const, out: page(400, "invalid_request", "認可リクエストの有効期限（10 分）が切れました。AI クライアントからやり直してください。") };
  }
  const client = await deps.store.getClient(req.clientId);
  if (!client || client.status !== "active" || !isRedirectAllowedForClient(req.redirectUri, client.redirectUris)) {
    return { ok: false as const, out: page(400, "invalid_client", "この AI クライアントは現在利用できません。") };
  }
  return { ok: true as const, req, client };
}

async function eligibleEmployees(deps: ConsentDeps, orgId: string): Promise<ConsentEmployeeOption[]> {
  const all = await deps.listEmployees(orgId);
  const out: ConsentEmployeeOption[] = [];
  for (const e of all) {
    if (e.orgId !== orgId || e.status !== "active") continue;
    const b = await deps.getBinding(e.id);
    if (b?.status === "revoked") continue;
    const cred = await deps.getCurrentCredential(e.id);
    if (!cred) continue;
    if (cred.expiresAt && Date.parse(cred.expiresAt) <= deps.now().getTime()) continue;
    out.push({
      id: e.id,
      displayName: e.displayName,
      roleLabel: e.roleLabel,
      scopes: (e.scopes ?? []).map(String),
      allowedPurposes: e.allowedPurposes ?? [],
      credentialExpiresAt: cred.expiresAt,
    });
  }
  return out;
}

export async function loadConsentView(rid: string, deps: ConsentDeps): Promise<ConsentViewOutcome> {
  const session = await deps.getSession();
  if (!session.userId) return { type: "login_required" };
  if (!realSession(session)) return page(403, "access_denied", "組織のメンバーとしてログインしていません。");
  const secret = deps.stateSecret();
  if (!secret) return page(503, "temporarily_unavailable", "サーバー設定が未完了のため、いまは接続できません。");

  const r = await usableAuthRequest(deps, rid);
  if (!r.ok) return r.out;
  if (!(await browserBound(deps, secret, rid))) return NOT_BOUND_PAGE();
  const now = deps.now();

  const employees = await eligibleEmployees(deps, session.orgId);
  let blockedReason: ConsentView["blockedReason"] = null;
  if (!isCredentialAdmin(session.member)) blockedReason = "role";
  else if (!isOrgAllowedForOAuth(session.orgId)) blockedReason = "org_not_allowed";
  else if (!loginFresh(session.lastSignInAt, now)) blockedReason = "login_too_old";
  else if (isMcpOAuthConsentMfaRequired() && (await deps.getAal()) !== "aal2") blockedReason = "mfa_required";
  else if (employees.length === 0) blockedReason = "no_employees";

  const host = clientHostOf(r.client.clientId);
  return {
    type: "view",
    view: {
      rid,
      csrf: mintConsentCsrf(secret, rid, session.userId, now),
      email: session.email || session.member.email,
      orgId: session.orgId,
      orgName: (await deps.getOrgName(session.orgId)) || "（名称未設定の組織）",
      client: {
        name: r.client.clientName || host || "AI クライアント",
        host,
        redirectHost: redirectHost(r.req.redirectUri),
        verifiedHost: r.client.registrationType === "cimd" && cimdAllowedHosts().includes(host),
        registrationType: r.client.registrationType,
        loopback: isLoopbackRedirect(r.req.redirectUri),
      },
      employees,
      startedYourselfWarningJa: STARTED_YOURSELF_WARNING_JA,
      approvalSummaryJa: approvalSummary(host, redirectHost(r.req.redirectUri), employees),
      blockedReason,
    },
  };
}

export type ConsentDecisionInput = {
  rid: string;
  csrf: string;
  decision: string;
  employeeId: string;
  confirmed: boolean;
};

export async function processConsentDecision(
  input: ConsentDecisionInput,
  deps: ConsentDeps
): Promise<ConsentPage | ConsentRedirect> {
  const session = await deps.getSession();
  if (!realSession(session)) return page(401, "login_required", "ログインし直してから、AI クライアントで接続をやり直してください。");

  const rl = await deps.rateLimit(`consent:${session.userId}`, OAUTH_RATE_LIMITS.consentPerUserPerMin, 60);
  if (!rl.allowed) return page(429, "slow_down", "操作が多すぎます。1 分ほど待ってからやり直してください。");

  const secret = deps.stateSecret();
  if (!secret) return page(503, "temporarily_unavailable", "サーバー設定が未完了のため、いまは接続できません。");
  const now = deps.now();
  if (!verifyConsentCsrf(secret, input.csrf, input.rid, session.userId, now)) {
    return page(403, "access_denied", "画面の有効期限が切れたか、不正な送信です。AI クライアントからやり直してください。");
  }

  const r = await usableAuthRequest(deps, input.rid);
  if (!r.ok) return r.out;
  if (!(await browserBound(deps, secret, input.rid))) return NOT_BOUND_PAGE();
  const { req, client } = r;
  const clientHost = clientHostOf(client.clientId);
  const actorEmail = session.email || session.member.email;

  if (input.decision !== "allow") {
    const consumed = await deps.store.consumeAuthRequest(req.id, now.toISOString());
    if (!consumed.ok) return page(400, "invalid_request", "この認可リクエストは使用済みです。");
    await deps.audit({
      orgId: session.orgId,
      employeeId: null,
      credentialId: null,
      actorEmail,
      action: "oauth.consent_denied",
      purpose: null,
      summary: `${clientHost || "AI クライアント"} への接続を拒否`,
      metadata: { clientHost, clientId: client.clientId, actorMemberId: session.member.id },
    });
    return { type: "redirect", location: buildClientRedirect(req.redirectUri, { error: "access_denied", state: req.state }) };
  }

  if (!isCredentialAdmin(session.member)) {
    return page(403, "access_denied", "AI 社員の接続を許可できるのは、社員証の発行権限を持つオーナーまたは管理者だけです。");
  }
  if (!loginFresh(session.lastSignInAt, now)) {
    return page(401, "login_required", "安全のため、15 分以内にログインし直してから許可してください。");
  }
  if (isMcpOAuthConsentMfaRequired() && (await deps.getAal()) !== "aal2") {
    return page(403, "mfa_required", "二要素認証を済ませてから許可してください。");
  }
  if (!input.confirmed) return page(400, "invalid_request", "確認のチェックを入れてから許可してください。");
  if (!isOrgAllowedForOAuth(session.orgId)) {
    return page(403, "access_denied", "この組織では AI クライアント接続（OAuth）はまだ有効になっていません。");
  }

  const employee = input.employeeId ? await deps.getEmployeeById(input.employeeId) : null;
  // IDOR: the employee must belong to the SESSION org (never trust the form).
  if (!employee || employee.orgId !== session.orgId) {
    return page(403, "access_denied", "選んだ AI 社員はこの組織に所属していません。");
  }
  if (employee.status !== "active") return page(400, "invalid_request", "この AI 社員は現在稼働していません。");
  const binding = await deps.getBinding(employee.id);
  if (binding?.status === "revoked") return page(403, "access_denied", "この AI 社員の社員証は失効しています。");
  const cred = await deps.getCurrentCredential(employee.id);
  if (!cred || (cred.expiresAt && Date.parse(cred.expiresAt) <= now.getTime())) {
    return page(400, "invalid_request", "この AI 社員には有効な社員証がありません。先に社員証を発行してください。");
  }

  // One-time rid (atomic).
  const consumed = await deps.store.consumeAuthRequest(req.id, now.toISOString());
  if (!consumed.ok) return page(400, "invalid_request", "この認可リクエストは使用済みです。");

  const cap = now.getTime() + GRANT_MAX_TTL_SEC * 1000;
  const credCap = cred.expiresAt ? Date.parse(cred.expiresAt) : Infinity;
  const grant = await deps.store.createGrant({
    orgId: session.orgId,
    employeeId: employee.id,
    clientId: client.clientId,
    credentialIdAtGrant: cred.credentialId,
    grantedByMemberId: session.member.id,
    grantedByEmail: actorEmail,
    resource: req.resource,
    scope: req.scope,
    expiresAt: new Date(Math.min(cap, credCap)).toISOString(),
  });

  const code = mintAuthCode();
  await deps.store.createCode({
    codeHash: code.hash,
    grantId: grant.id,
    clientId: client.clientId,
    redirectUri: req.redirectUri,
    codeChallenge: req.codeChallenge,
    resource: req.resource,
    expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_SEC * 1000).toISOString(),
  });

  await deps.audit({
    orgId: session.orgId,
    employeeId: employee.id,
    credentialId: cred.credentialId,
    actorEmail,
    action: "oauth.consent_granted",
    purpose: null,
    summary: `${employee.displayName} を ${clientHost || "AI クライアント"} に接続`,
    metadata: {
      clientHost,
      clientId: client.clientId,
      grantId: grant.id,
      redirectHost: redirectHost(req.redirectUri),
      loopback: isLoopbackRedirect(req.redirectUri),
      codeHashPrefix: hashPrefix(code.hash),
      grantExpiresAt: grant.expiresAt,
      actorMemberId: session.member.id,
    },
  });
  try {
    await deps.notify({
      orgId: session.orgId,
      actorEmail,
      employeeId: employee.id,
      employeeName: employee.displayName,
      clientName: client.clientName || clientHost,
      clientHost,
    });
  } catch {
    // notification is best-effort; audit row is the record
  }

  return { type: "redirect", location: buildClientRedirect(req.redirectUri, { code: code.raw, state: req.state }) };
}

let depsOverride: ConsentDeps | null = null;
/** Test hook (route tests inject fakes). */
export function __setConsentDepsForTests(d: ConsentDeps | null) {
  depsOverride = d;
}

/** Production wiring (lazy imports keep tests free of Supabase / next/headers). */
export async function defaultConsentDeps(): Promise<ConsentDeps> {
  if (depsOverride) return depsOverride;
  const [{ getSessionContext }, data, { getCurrentEmployeeCredential }, { rateLimit }, { appendAuditEvent }, notify, orgs] =
    await Promise.all([
      import("@/lib/auth/session"),
      import("@/lib/data"),
      import("@/lib/mcp-oauth/employee-state"),
      import("@/lib/mcp-oauth/rate-limit"),
      import("@/lib/data/audit"),
      import("@/lib/mcp-oauth/notify"),
      import("@/lib/mcp-oauth/org-info"),
    ]);
  return {
    store: getOAuthStore(),
    getSession: getSessionContext,
    getEmployeeById: data.getEmployeeById,
    listEmployees: (orgId) => data.listEmployees(orgId),
    getBinding: (id) => data.getBinding(id),
    getCurrentCredential: getCurrentEmployeeCredential,
    getOrgName: orgs.getOrgName,
    getAal: orgs.getSessionAal,
    audit: appendAuditEvent,
    notify: notify.notifyOAuthConnected,
    rateLimit: (b, l, w) => rateLimit(b, l, w),
    stateSecret: oauthStateSecret,
    getCookie: async (name) => {
      const { cookies } = await import("next/headers");
      return (await cookies()).get(name)?.value ?? null;
    },
    now: () => new Date(),
  };
}
