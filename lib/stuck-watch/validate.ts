import type { FaultClass, OrgStuckWatchPolicy } from "@/lib/types";

function nowIso(): string {
  return new Date().toISOString();
}

const DEFAULT_AUTO_RETRY: FaultClass[] = ["ops_fault"];

export function defaultStuckWatchPolicy(): OrgStuckWatchPolicy {
  return {
    version: 1,
    enabled: true,
    mentionUnansweredMinutes: 15,
    approvedUnfulfilledMinutes: 5,
    maxAutoRetries: 2,
    retryBackoffSeconds: 60,
    autoRetryFaultClasses: [...DEFAULT_AUTO_RETRY],
    notifyMouth: null,
    inferInternalAudienceFromLedger: true,
    updatedAt: nowIso(),
    updatedBy: "system",
  };
}

function parseFaultClasses(raw: unknown): FaultClass[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [...DEFAULT_AUTO_RETRY];
  }
  const allowed = new Set<FaultClass>([
    "expected_gate",
    "ops_fault",
    "config_drift",
  ]);
  const parsed = raw
    .map((value) => String(value).trim())
    .filter((value): value is FaultClass => allowed.has(value as FaultClass));
  return parsed.length > 0 ? parsed : [...DEFAULT_AUTO_RETRY];
}

function clampMinutes(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), 24 * 60);
}

function clampRetries(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), 10);
}

function clampBackoff(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), 3600);
}

export function normalizeStuckWatchPolicy(
  raw: unknown
): OrgStuckWatchPolicy {
  const defaults = defaultStuckWatchPolicy();
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  const obj = raw as Record<string, unknown>;
  const notifyMouth =
    typeof obj.notifyMouth === "string" && obj.notifyMouth.trim()
      ? obj.notifyMouth.trim()
      : obj.notifyMouth === null
        ? null
        : defaults.notifyMouth ?? null;

  return {
    version: 1,
    enabled: obj.enabled === false ? false : true,
    mentionUnansweredMinutes: clampMinutes(
      obj.mentionUnansweredMinutes,
      defaults.mentionUnansweredMinutes
    ),
    approvedUnfulfilledMinutes: clampMinutes(
      obj.approvedUnfulfilledMinutes,
      defaults.approvedUnfulfilledMinutes
    ),
    maxAutoRetries: clampRetries(obj.maxAutoRetries, defaults.maxAutoRetries),
    retryBackoffSeconds: clampBackoff(
      obj.retryBackoffSeconds,
      defaults.retryBackoffSeconds
    ),
    autoRetryFaultClasses: parseFaultClasses(obj.autoRetryFaultClasses),
    notifyMouth,
    inferInternalAudienceFromLedger:
      obj.inferInternalAudienceFromLedger === false ? false : true,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : nowIso(),
    updatedBy: typeof obj.updatedBy === "string" ? obj.updatedBy : "system",
  };
}
