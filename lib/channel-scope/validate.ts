/**
 * P1 Channel Scope — Validation (CS1)
 *
 * Strict: malformed security policy is rejected, never coerced into a wider scope.
 * Shared by Admin MCP (channelScope.patch) and Web API (/api/channel-scope) in CS2.
 */
import type {
  ChannelScopeConnectConfig,
  ChannelScopeConnectEgress,
  ChannelScopeMode,
  ChannelScopePolicy,
  ChannelScopeSurface,
} from "./types";
import { CHANNEL_SCOPE_CONNECT_EGRESS, CHANNEL_SCOPE_MODES, CHANNEL_SCOPE_SURFACES } from "./types";

export const MAX_ALLOWED_EXTERNAL_TEAM_IDS = 100;
/** Slack workspace (T…) or Enterprise Grid org (E…) id. Same shape as IAR slackTeamIds (+E). */
export const SLACK_TEAM_ID_RE = /^[TE][A-Z0-9]{2,30}$/;
const UPDATED_BY_MAX = 200;

export type ChannelScopeValidationError = {
  field: string;
  code: string;
  message: string;
  messageJa: string;
};

export type ChannelScopeValidationResult =
  | { ok: true; policy: ChannelScopePolicy }
  | { ok: false; errors: ChannelScopeValidationError[] };

const POLICY_KEYS = new Set(["version", "mode", "includeSlackConnect", "surfaces", "connect", "updatedAt", "updatedBy"]);
const CONNECT_KEYS = new Set(["egress", "notifyApproverOnInvite", "allowedExternalTeamIds"]);
const PATCH_KEYS = new Set(["mode", "includeSlackConnect", "connect"]);

export function defaultConnectConfig(): ChannelScopeConnectConfig {
  return { egress: "needs_approval_until_confirmed", notifyApproverOnInvite: true, allowedExternalTeamIds: [] };
}

/** Safe default: registered_only, no Connect. Identical to pre-P1 behavior. */
export function defaultChannelScopePolicy(): ChannelScopePolicy {
  return {
    version: 1,
    mode: "registered_only",
    includeSlackConnect: false,
    surfaces: ["slack"],
    connect: defaultConnectConfig(),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function err(field: string, code: string, message: string, messageJa: string): ChannelScopeValidationError {
  return { field, code, message, messageJa };
}

function validateConnect(
  raw: unknown,
  errors: ChannelScopeValidationError[]
): ChannelScopeConnectConfig {
  const out = defaultConnectConfig();
  if (raw === undefined) return out;
  if (!isPlainObject(raw)) {
    errors.push(err("connect", "invalid_type", "connect must be an object", "connect はオブジェクトで指定してください"));
    return out;
  }
  for (const key of Object.keys(raw)) {
    if (!CONNECT_KEYS.has(key)) {
      errors.push(err(`connect.${key}`, "unknown_field", `unknown field connect.${key}`, `connect.${key} は未対応の項目です`));
    }
  }
  if (raw.egress !== undefined) {
    if (typeof raw.egress !== "string" || !CHANNEL_SCOPE_CONNECT_EGRESS.includes(raw.egress as ChannelScopeConnectEgress)) {
      errors.push(err("connect.egress", "invalid_value", "connect.egress must be needs_approval_until_confirmed or matrix", "connect.egress は needs_approval_until_confirmed か matrix です"));
    } else {
      out.egress = raw.egress as ChannelScopeConnectEgress;
    }
  }
  if (raw.notifyApproverOnInvite !== undefined) {
    if (typeof raw.notifyApproverOnInvite !== "boolean") {
      errors.push(err("connect.notifyApproverOnInvite", "invalid_type", "notifyApproverOnInvite must be boolean", "notifyApproverOnInvite は true/false で指定してください"));
    } else {
      out.notifyApproverOnInvite = raw.notifyApproverOnInvite;
    }
  }
  if (raw.allowedExternalTeamIds !== undefined) {
    const ids = raw.allowedExternalTeamIds;
    if (!Array.isArray(ids)) {
      errors.push(err("connect.allowedExternalTeamIds", "invalid_type", "allowedExternalTeamIds must be an array", "allowedExternalTeamIds は配列で指定してください"));
    } else if (ids.length > MAX_ALLOWED_EXTERNAL_TEAM_IDS) {
      errors.push(err("connect.allowedExternalTeamIds", "too_many", `at most ${MAX_ALLOWED_EXTERNAL_TEAM_IDS} team ids`, `allowedExternalTeamIds は最大 ${MAX_ALLOWED_EXTERNAL_TEAM_IDS} 件です`));
    } else {
      const normalized: string[] = [];
      ids.forEach((v, i) => {
        const id = typeof v === "string" ? v.trim().toUpperCase() : "";
        if (!SLACK_TEAM_ID_RE.test(id)) {
          errors.push(err(`connect.allowedExternalTeamIds[${i}]`, "invalid_team_id", "team id must look like T… or E…", "チームIDは T… または E… の形式です"));
        } else if (!normalized.includes(id)) {
          normalized.push(id);
        }
      });
      out.allowedExternalTeamIds = normalized;
    }
  }
  return out;
}

/**
 * Validate and normalize a full stored policy (org default or employee override).
 * Missing optional fields get safe defaults. Unknown fields are rejected.
 */
export function validateChannelScopePolicy(raw: unknown): ChannelScopeValidationResult {
  const errors: ChannelScopeValidationError[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [err("", "invalid_input", "policy must be an object", "ポリシーはオブジェクトで指定してください")] };
  }
  for (const key of Object.keys(raw)) {
    if (!POLICY_KEYS.has(key)) {
      errors.push(err(key, "unknown_field", `unknown field ${key}`, `${key} は未対応の項目です`));
    }
  }
  if (raw.version !== undefined && raw.version !== 1) {
    errors.push(err("version", "unsupported_version", "version must be 1", "version は 1 のみ対応しています"));
  }
  let mode: ChannelScopeMode = "registered_only";
  if (typeof raw.mode !== "string" || !CHANNEL_SCOPE_MODES.includes(raw.mode as ChannelScopeMode)) {
    errors.push(err("mode", "invalid_mode", "mode must be registered_only or all_joined", "mode は registered_only か all_joined です"));
  } else {
    mode = raw.mode as ChannelScopeMode;
  }
  let includeSlackConnect = false;
  if (raw.includeSlackConnect !== undefined) {
    if (typeof raw.includeSlackConnect !== "boolean") {
      errors.push(err("includeSlackConnect", "invalid_type", "includeSlackConnect must be boolean", "includeSlackConnect は true/false で指定してください"));
    } else {
      includeSlackConnect = raw.includeSlackConnect;
    }
  }
  if (includeSlackConnect && mode !== "all_joined") {
    errors.push(err("includeSlackConnect", "connect_requires_all_joined", "includeSlackConnect=true requires mode=all_joined", "includeSlackConnect=true は mode=all_joined のときだけ指定できます"));
  }
  let surfaces: ChannelScopeSurface[] = ["slack"];
  if (raw.surfaces !== undefined) {
    if (
      !Array.isArray(raw.surfaces) ||
      raw.surfaces.length === 0 ||
      raw.surfaces.some((s) => typeof s !== "string" || !CHANNEL_SCOPE_SURFACES.includes(s as ChannelScopeSurface))
    ) {
      errors.push(err("surfaces", "invalid_surfaces", "surfaces must be a non-empty subset of [slack]", "surfaces は [\"slack\"] のみ対応しています"));
    } else {
      surfaces = [...new Set(raw.surfaces as ChannelScopeSurface[])];
    }
  }
  const connect = validateConnect(raw.connect, errors);
  const policy: ChannelScopePolicy = { version: 1, mode, includeSlackConnect, surfaces, connect };
  if (raw.updatedAt !== undefined) {
    if (typeof raw.updatedAt !== "string" || Number.isNaN(Date.parse(raw.updatedAt))) {
      errors.push(err("updatedAt", "invalid_type", "updatedAt must be an ISO timestamp", "updatedAt は ISO 形式の日時です"));
    } else {
      policy.updatedAt = raw.updatedAt;
    }
  }
  if (raw.updatedBy !== undefined) {
    if (typeof raw.updatedBy !== "string" || raw.updatedBy.length > UPDATED_BY_MAX) {
      errors.push(err("updatedBy", "invalid_type", "updatedBy must be a short string", "updatedBy は短い文字列です"));
    } else {
      policy.updatedBy = raw.updatedBy;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, policy };
}

/**
 * Build the next policy from a patch ({ mode, includeSlackConnect?, connect? }) on top of the
 * current stored policy (or the safe default). connect fields merge field-by-field.
 * The result is fully re-validated.
 */
export function applyChannelScopePatch(
  current: ChannelScopePolicy | null,
  patch: unknown
): ChannelScopeValidationResult {
  if (!isPlainObject(patch)) {
    return { ok: false, errors: [err("", "invalid_input", "patch must be an object", "変更内容はオブジェクトで指定してください")] };
  }
  const unknown = Object.keys(patch).filter((k) => !PATCH_KEYS.has(k));
  if (unknown.length) {
    return { ok: false, errors: unknown.map((k) => err(k, "unknown_field", `unknown field ${k}`, `${k} は未対応の項目です`)) };
  }
  const base = current ?? defaultChannelScopePolicy();
  const connectPatch = patch.connect;
  if (connectPatch !== undefined && !isPlainObject(connectPatch)) {
    return { ok: false, errors: [err("connect", "invalid_type", "connect must be an object", "connect はオブジェクトで指定してください")] };
  }
  const next: Record<string, unknown> = {
    version: 1,
    mode: patch.mode,
    // Omitted includeSlackConnect resets to false (never silently inherit a wider value).
    includeSlackConnect: patch.includeSlackConnect === undefined ? false : patch.includeSlackConnect,
    surfaces: base.surfaces,
    connect: { ...base.connect, ...(connectPatch ?? {}) },
  };
  return validateChannelScopePolicy(next);
}
