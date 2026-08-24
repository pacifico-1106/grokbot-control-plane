/**
 * DEMO in-memory store for durable Grok Bot ↔ AI-employee bindings.
 * Production: mirror fields live in supabase employee_bindings (see schema.sql).
 * Product rule: employeeId is stable forever; rotate bumps generation only.
 */

import { createHash, randomBytes } from "node:crypto";
import type {
  BindingStatus,
  EmployeeBinding,
  ExecutableAllow,
  ExecutableDeny,
} from "./types";

const DEMO_LABEL = "DEMO" as const;

/** Process-local binding rows keyed by employeeId. */
const runtimeBindings = new Map<string, EmployeeBinding>();

export function fingerprintSecret(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function mintOneTimeSecret(): {
  raw: string;
  fingerprint: string;
  prefix: string;
} {
  const raw = `gb_emp_${randomBytes(8).toString("hex")}_${randomBytes(16).toString("hex")}`;
  return {
    raw,
    fingerprint: fingerprintSecret(raw),
    prefix: raw.slice(0, 14),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function touch(row: EmployeeBinding, patch: Partial<EmployeeBinding>): EmployeeBinding {
  const next: EmployeeBinding = {
    ...row,
    ...patch,
    updatedAt: nowIso(),
  };
  runtimeBindings.set(next.employeeId, next);
  return next;
}

/** Read binding; undefined if never ensured. */
export function getBinding(employeeId: string): EmployeeBinding | undefined {
  return runtimeBindings.get(employeeId);
}

/** Lookup by SHA-256 fingerprint of gb_emp_ secret (DEMO store). */
export function findBindingByCredentialFingerprint(
  fingerprint: string
): EmployeeBinding | undefined {
  if (!fingerprint) return undefined;
  for (const b of runtimeBindings.values()) {
    if (b.credentialFingerprint && b.credentialFingerprint === fingerprint) {
      return b;
    }
  }
  return undefined;
}

/** List all bindings for an org (DEMO store). */
export function listBindingsForOrg(orgId: string): EmployeeBinding[] {
  return [...runtimeBindings.values()].filter((b) => b.orgId === orgId);
}

/** Count bindings in needs_reauth (ops alert). */
export function countNeedsReauth(orgId?: string): number {
  let n = 0;
  for (const b of runtimeBindings.values()) {
    if (orgId && b.orgId !== orgId) continue;
    if (b.status === "needs_reauth") n += 1;
  }
  return n;
}

/**
 * Ensure a binding row exists for employeeId.
 * Never invents a new employeeId — caller must pass the stable id.
 */
export function ensureBindingRow(
  employeeId: string,
  orgId: string
): EmployeeBinding {
  const existing = runtimeBindings.get(employeeId);
  if (existing) return existing;
  const created: EmployeeBinding = {
    employeeId,
    orgId,
    grokBotAgentId: null,
    grokBotWorkspaceId: null,
    credentialGeneration: 0,
    credentialFingerprint: null,
    status: "unlinked",
    lastSuccessAt: null,
    lastError: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  runtimeBindings.set(employeeId, created);
  return created;
}

/** Attach Grok Bot agent (and optional workspace). Keeps employeeId + generation. */
export function linkAgent(
  employeeId: string,
  opts: {
    orgId: string;
    grokBotAgentId: string;
    grokBotWorkspaceId?: string | null;
  }
): EmployeeBinding {
  const row = ensureBindingRow(employeeId, opts.orgId);
  if (row.status === "revoked") {
    throw Object.assign(new Error("binding_revoked"), { code: "revoked" as const });
  }
  const agentId = opts.grokBotAgentId.trim();
  if (!agentId) {
    throw Object.assign(new Error("agent_id_required"), { code: "invalid" as const });
  }
  return touch(row, {
    grokBotAgentId: agentId,
    grokBotWorkspaceId:
      opts.grokBotWorkspaceId === undefined
        ? row.grokBotWorkspaceId
        : opts.grokBotWorkspaceId || null,
    status: "linked",
    lastError: null,
  });
}

/**
 * Rotate credential: generation++, new fingerprint.
 * Never resets employeeId or clears agent link silently.
 */
export function rotateCredential(
  employeeId: string,
  orgId: string,
  fingerprint: string
): { binding: EmployeeBinding; generation: number } {
  const row = ensureBindingRow(employeeId, orgId);
  if (row.status === "revoked") {
    throw Object.assign(new Error("binding_revoked"), { code: "revoked" as const });
  }
  const generation = row.credentialGeneration + 1;
  const nextStatus: BindingStatus = row.grokBotAgentId ? "linked" : "unlinked";
  const binding = touch(row, {
    credentialGeneration: generation,
    credentialFingerprint: fingerprint,
    status: nextStatus,
    lastError: null,
  });
  return { binding, generation };
}

export function recordHealthSuccess(employeeId: string): EmployeeBinding | undefined {
  const row = runtimeBindings.get(employeeId);
  if (!row) return undefined;
  if (row.status === "revoked") {
    return touch(row, { lastError: "revoked" });
  }
  return touch(row, {
    status: row.grokBotAgentId ? "linked" : "unlinked",
    lastSuccessAt: nowIso(),
    lastError: null,
  });
}

export function recordHealthFailure(
  employeeId: string,
  error: string
): EmployeeBinding | undefined {
  const row = runtimeBindings.get(employeeId);
  if (!row) return undefined;
  if (row.status === "revoked") {
    return touch(row, { lastError: error || "revoked" });
  }
  // Broken credentials → needs_reauth (UI: 要再連携). Never silent reset / unlink.
  return touch(row, {
    status: "needs_reauth",
    lastError: error || "health_failed",
  });
}

export function revokeBinding(employeeId: string): EmployeeBinding | undefined {
  const row = runtimeBindings.get(employeeId);
  if (!row) return undefined;
  return touch(row, {
    status: "revoked",
    lastError: "revoked",
  });
}

/**
 * Fail-closed gate for gateway / tool invoke.
 * Denies unbound, revoked, needs_reauth, degraded.
 */
export function assertExecutable(
  employeeId: string
): ExecutableAllow | ExecutableDeny {
  const binding = runtimeBindings.get(employeeId);
  if (!binding) {
    return {
      ok: false,
      code: "not_found",
      message: "binding not found; refuse invoke (fail-closed)",
    };
  }
  if (binding.status === "revoked") {
    return {
      ok: false,
      code: "revoked",
      message: "binding revoked; refuse invoke (fail-closed)",
    };
  }
  if (binding.status === "unlinked" || !binding.grokBotAgentId) {
    return {
      ok: false,
      code: "unbound",
      message: "employee not linked to Grok Bot agent; refuse invoke (fail-closed)",
    };
  }
  if (binding.status === "needs_reauth") {
    return {
      ok: false,
      code: "needs_reauth",
      message: "credentials need reauth (要再連携); refuse invoke (fail-closed)",
    };
  }
  if (binding.status === "degraded") {
    return {
      ok: false,
      code: "degraded",
      message: "binding degraded; refuse invoke (fail-closed)",
    };
  }
  if (binding.status !== "linked") {
    return {
      ok: false,
      code: "health_failed",
      message: "binding not executable; refuse invoke (fail-closed)",
    };
  }
  return { ok: true, binding };
}

/** Seed DEMO bindings for known demo employees (idempotent). */
export function seedDemoBindings(
  employees: Array<{ id: string; orgId: string }>,
  opts?: { linkSales?: boolean }
): void {
  for (const e of employees) {
    ensureBindingRow(e.id, e.orgId);
  }
  if (opts?.linkSales === false) return;

  const sales = runtimeBindings.get("emp_sales");
  if (sales && sales.status === "unlinked" && !sales.grokBotAgentId) {
    touch(sales, {
      grokBotAgentId: "gba_demo_sales",
      grokBotWorkspaceId: "gbw_demo",
      credentialGeneration: 1,
      credentialFingerprint: fingerprintSecret("demo-seed-sales-v1"),
      status: "linked",
      lastSuccessAt: new Date(Date.now() - 3600000).toISOString(),
      lastError: null,
    });
  }
  const ops = runtimeBindings.get("emp_ops");
  if (ops && ops.status === "unlinked" && !ops.grokBotAgentId) {
    // Ops starts needs_reauth so Managed UI can show 要再連携 alert.
    touch(ops, {
      grokBotAgentId: "gba_demo_ops",
      grokBotWorkspaceId: "gbw_demo",
      credentialGeneration: 2,
      credentialFingerprint: fingerprintSecret("demo-seed-ops-v2"),
      status: "needs_reauth",
      lastSuccessAt: new Date(Date.now() - 86400000 * 2).toISOString(),
      lastError: "credential_rejected",
    });
  }
}

export function bindingPublicView(b: EmployeeBinding) {
  return {
    ...b,
    demo: DEMO_LABEL,
    managedNote:
      "切断・credential 破綻は黙って消さない。status=needs_reauth で 要再連携 を出す。",
  };
}
