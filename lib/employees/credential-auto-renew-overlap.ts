/**
 * 社員証 auto-renew R3: issueCredentialOverlap + first-auth switchover + 24h cron.
 * Behind CREDENTIAL_AUTO_RENEW_ENABLED + org allowlist (default OFF).
 * Does not add gen1 HTTP (R8) or a boot script (R5). Never logs secret / claim_token.
 */
import { randomBytes } from "node:crypto";
import { mintOneTimeSecret } from "@/lib/bindings";
import { appendAuditEvent } from "@/lib/data/audit";
import {
  bumpCredentialGenerationKeepFingerprint,
  getBinding,
  moveBindingFingerprintIfCurrent,
} from "@/lib/data/bindings";
import {
  attachOverlappedNewCredential,
  claimCredentialRenewal,
  demoGetOverlapCredential,
  findClaimedOverlapByNewCredential,
  findOpenCredentialRenewalRow,
  insertOverlapCredentialRow,
  listExpiredOverlapRenewals,
  releaseCredentialRenewal,
  revokeExpiredOverlappedOldCredential,
  revokeInsertedOverlapCredential,
  revokeOverlappedOldCredential,
  getCredentialSecretHash,
} from "@/lib/data/credential-renewals";
import { credentialExpiresAtFromNow } from "@/lib/employees/credential-ttl";
import {
  CREDENTIAL_AUTO_RENEW_OVERLAP_WINDOW_MS,
  expireStaleCredentialRenewals,
  gateEmployeeForRenew,
  isCredentialAutoRenewEnabled,
  isCredentialAutoRenewOnForOrg,
} from "@/lib/employees/credential-auto-renew";

export type IssueCredentialOverlapResult =
  | {
      ok: true;
      newCredentialId: string;
      generation: number;
      expiresAt: string;
      overlapUntil: string;
      secret: { raw: string; prefix: string; fingerprint: string };
    }
  | { ok: false; code: string; message: string };

const fail = (code: string, message: string): IssueCredentialOverlapResult => ({
  ok: false,
  code,
  message,
});

function claimToken(): string {
  return randomBytes(24).toString("hex");
}

async function auditDenied(input: {
  orgId: string;
  employeeId?: string;
  code: string;
}): Promise<void> {
  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: input.employeeId ?? null,
    credentialId: null,
    action: "credential.renew_claim_denied",
    purpose: "admin.policy",
    summary: `社員証の更新の受け取りを拒否（${input.code}）`,
    metadata: { code: input.code, employeeId: input.employeeId ?? null },
  }).catch(() => undefined);
}

export async function issueCredentialOverlap(input: {
  orgId: string;
  employeeId: string;
  oldCredentialId: string;
}): Promise<IssueCredentialOverlapResult> {
  if (!isCredentialAutoRenewOnForOrg(input.orgId)) {
    return fail("feature_disabled", "社員証の自動更新は無効です（CREDENTIAL_AUTO_RENEW_ENABLED / 許可リスト）。");
  }
  const gated = await gateEmployeeForRenew({
    orgId: input.orgId,
    employeeId: input.employeeId,
    phase: "credential",
  });
  if (!gated.ok) {
    await auditDenied({ orgId: input.orgId, employeeId: input.employeeId, code: gated.code });
    return fail(gated.code, gated.message);
  }
  if (gated.oldCredentialId !== input.oldCredentialId) {
    await auditDenied({ orgId: input.orgId, employeeId: gated.employee.id, code: "not_claimable" });
    return fail("not_claimable", "受け取り窓が開いていません。");
  }
  await expireStaleCredentialRenewals({ orgId: input.orgId }).catch(() => 0);
  const open = await findOpenCredentialRenewalRow(input.orgId, gated.employee.id);
  if (!open) {
    await auditDenied({ orgId: input.orgId, employeeId: gated.employee.id, code: "not_claimable" });
    return fail("not_claimable", "受け取り窓が開いていません。");
  }
  if (open.state === "claimed") {
    await auditDenied({ orgId: input.orgId, employeeId: gated.employee.id, code: "already_claimed" });
    return fail("already_claimed", "この更新は既に受け取られています。");
  }
  if (open.state !== "claimable" || open.oldCredentialId !== input.oldCredentialId) {
    await auditDenied({ orgId: input.orgId, employeeId: gated.employee.id, code: "not_claimable" });
    return fail("not_claimable", "受け取り窓が開いていません。");
  }
  const untilMs = open.claimableUntil ? Date.parse(open.claimableUntil) : NaN;
  if (!Number.isFinite(untilMs) || untilMs < Date.now()) {
    await auditDenied({ orgId: input.orgId, employeeId: gated.employee.id, code: "window_expired" });
    return fail("window_expired", "受け取り期限を過ぎています。");
  }

  const token = claimToken();
  const at = new Date().toISOString();
  let claimed = false;
  try {
    claimed = await claimCredentialRenewal({
      id: open.id,
      orgId: input.orgId,
      employeeId: gated.employee.id,
      token,
      at,
    });
  } catch (e) {
    if (e instanceof Error && e.message === "invalid_claim_token") {
      await auditDenied({ orgId: input.orgId, employeeId: gated.employee.id, code: "not_claimable" });
      return fail("not_claimable", "受け取り窓が開いていません。");
    }
    await auditDenied({ orgId: input.orgId, employeeId: gated.employee.id, code: "already_claimed" });
    return fail("already_claimed", "この更新は既に受け取られています。");
  }
  if (!claimed) {
    const again = await findOpenCredentialRenewalRow(input.orgId, gated.employee.id);
    const code = again?.state === "claimed" ? "already_claimed" : "not_claimable";
    await auditDenied({ orgId: input.orgId, employeeId: gated.employee.id, code });
    return fail(code, code === "already_claimed" ? "この更新は既に受け取られています。" : "受け取り窓が開いていません。");
  }

  const binding = await getBinding(gated.employee.id);
  const oldSecretHash = binding?.credentialFingerprint || "";
  const secret = mintOneTimeSecret();
  const expiresAt = credentialExpiresAtFromNow();
  const overlapUntil = new Date(Date.now() + CREDENTIAL_AUTO_RENEW_OVERLAP_WINDOW_MS).toISOString();
  let newCredentialId: string | null = null;
  try {
    newCredentialId = await insertOverlapCredentialRow({
      orgId: input.orgId,
      employeeId: gated.employee.id,
      secretHash: secret.fingerprint,
      secretPrefix: secret.prefix,
      expiresAt,
      oldSecretHash,
      scopes: gated.employee.scopes,
      allowedPurposes: gated.employee.allowedPurposes,
      approvalPolicy: gated.employee.approvalPolicy,
      actionLimits: gated.employee.actionLimits,
      spend: gated.employee.spend,
      allowedAccounts: gated.employee.allowedAccounts,
    });
    if (!newCredentialId) throw new Error("overlap_insert_failed");
    const bumped = await bumpCredentialGenerationKeepFingerprint(gated.employee.id, input.orgId);
    const attached = await attachOverlappedNewCredential({
      id: open.id,
      orgId: input.orgId,
      token,
      newCredentialId,
      overlapUntil,
    });
    if (!attached) throw new Error("overlap_attach_failed");
    await appendAuditEvent({
      orgId: input.orgId,
      employeeId: gated.employee.id,
      credentialId: newCredentialId,
      action: "credential.renew_claimed",
      purpose: "admin.policy",
      summary: "社員証の更新を受け取り（重ね置き）",
      metadata: {
        generation: bumped.generation,
        newCredentialId,
        oldCredentialId: input.oldCredentialId,
        mode: open.mode,
        secretHashPrefix: secret.fingerprint.slice(0, 12),
        overlapUntil,
      },
    }).catch(() => undefined);
    return {
      ok: true,
      newCredentialId,
      generation: bumped.generation,
      expiresAt,
      overlapUntil,
      secret,
    };
  } catch {
    if (newCredentialId) {
      await revokeInsertedOverlapCredential({ orgId: input.orgId, credentialId: newCredentialId }).catch(() => undefined);
    }
    const released = await releaseCredentialRenewal({ id: open.id, orgId: input.orgId, token }).catch(() => false);
    void released;
    await auditDenied({ orgId: input.orgId, employeeId: gated.employee.id, code: "already_claimed" });
    return fail("already_claimed", "この更新は既に受け取られています。");
  }
}

/** New badge is valid while overlap is claimed and the binding fingerprint is still the old hash. */
export async function overlapNewCredentialAllowed(input: {
  orgId: string;
  newCredentialId: string;
  bindingFingerprint: string | null | undefined;
}): Promise<boolean> {
  if (!input.bindingFingerprint || !isCredentialAutoRenewOnForOrg(input.orgId)) return false;
  const overlap = await findClaimedOverlapByNewCredential(input.orgId, input.newCredentialId);
  if (!overlap || !overlap.newCredentialId || overlap.oldRevokedAt) return false;
  const oldHash =
    (await getCredentialSecretHash(overlap.oldCredentialId)) ||
    demoGetOverlapCredential(overlap.newCredentialId)?.oldSecretHash ||
    "";
  return Boolean(oldHash && oldHash === input.bindingFingerprint);
}

export async function completeCredentialOverlapOnFirstAuth(input: {
  orgId: string;
  employeeId: string;
  credentialId: string | null;
  fingerprint: string;
}): Promise<boolean> {
  if (!input.credentialId || !isCredentialAutoRenewOnForOrg(input.orgId)) return false;
  const overlap = await findClaimedOverlapByNewCredential(input.orgId, input.credentialId);
  if (!overlap || !overlap.newCredentialId || overlap.oldRevokedAt) return false;
  if (input.credentialId !== overlap.newCredentialId) return false;
  let revoked = false;
  try {
    revoked = await revokeOverlappedOldCredential({
      renewalId: overlap.id,
      orgId: input.orgId,
      oldCredentialId: overlap.oldCredentialId,
      newCredentialId: overlap.newCredentialId,
    });
  } catch {
    return false;
  }
  if (!revoked) return false;
  const oldHash =
    (await getCredentialSecretHash(overlap.oldCredentialId)) ||
    demoGetOverlapCredential(overlap.newCredentialId)?.oldSecretHash ||
    "";
  const newHash = (await getCredentialSecretHash(overlap.newCredentialId)) || input.fingerprint;
  if (oldHash && newHash) {
    await moveBindingFingerprintIfCurrent(input.employeeId, input.orgId, oldHash, newHash).catch(() => false);
  }
  await appendAuditEvent({
    orgId: input.orgId,
    employeeId: input.employeeId,
    credentialId: overlap.newCredentialId,
    action: "credential.renew_old_revoked",
    purpose: "admin.policy",
    summary: "更新前の社員証を失効（初回認証）",
    metadata: {
      reason: "first_auth",
      oldCredentialId: overlap.oldCredentialId,
      newCredentialId: overlap.newCredentialId,
      renewalId: overlap.id,
    },
  }).catch(() => undefined);
  return true;
}

export async function expireOverlappedOldCredentials(now?: Date): Promise<{
  orgs: number;
  revoked: number;
  failed: number;
}> {
  if (!isCredentialAutoRenewEnabled()) return { orgs: 0, revoked: 0, failed: 0 };
  const rows = await listExpiredOverlapRenewals(now);
  const seen = new Set<string>();
  let revoked = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.newCredentialId) continue;
    if (!isCredentialAutoRenewOnForOrg(row.orgId)) continue;
    seen.add(row.orgId);
    let ok = false;
    try {
      ok = await revokeExpiredOverlappedOldCredential({
        renewalId: row.id,
        orgId: row.orgId,
        oldCredentialId: row.oldCredentialId,
        newCredentialId: row.newCredentialId,
        at: now,
      });
    } catch {
      ok = false;
    }
    if (!ok) {
      failed += 1;
      await appendAuditEvent({
        orgId: row.orgId,
        employeeId: row.employeeId,
        credentialId: row.newCredentialId,
        action: "credential.renew_claim_denied",
        purpose: "admin.policy",
        summary: "重ね置き期限後の旧社員証失効に失敗",
        metadata: {
          code: "revoke_failed",
          reason: "overlap_timeout",
          oldCredentialId: row.oldCredentialId,
          newCredentialId: row.newCredentialId,
          renewalId: row.id,
        },
      }).catch(() => undefined);
      continue;
    }
    const oldHash =
      (await getCredentialSecretHash(row.oldCredentialId)) ||
      demoGetOverlapCredential(row.newCredentialId)?.oldSecretHash ||
      "";
    const newHash = (await getCredentialSecretHash(row.newCredentialId)) || "";
    if (oldHash && newHash) {
      await moveBindingFingerprintIfCurrent(row.employeeId, row.orgId, oldHash, newHash).catch(() => false);
    }
    await appendAuditEvent({
      orgId: row.orgId,
      employeeId: row.employeeId,
      credentialId: row.newCredentialId,
      action: "credential.renew_old_revoked",
      purpose: "admin.policy",
      summary: "更新前の社員証を失効（重ね置き期限）",
      metadata: {
        reason: "overlap_timeout",
        oldCredentialId: row.oldCredentialId,
        newCredentialId: row.newCredentialId,
        renewalId: row.id,
      },
    }).catch(() => undefined);
    revoked += 1;
  }
  return { orgs: seen.size, revoked, failed };
}
