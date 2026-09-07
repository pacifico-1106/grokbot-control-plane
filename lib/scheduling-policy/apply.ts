/**
 * A1 scheduling.policy apply engine.
 * Given freebusy-like slots + context → filter/score → final candidates.
 * Record which rules dropped/kept (audit labels F5). Fail-closed on conflict/unknown.
 */
import { appendAuditEvent } from "@/lib/data/audit";
import type {
  ConfirmAutomationLevel,
  OrgSchedulingPolicy,
  SchedulingAuditLabel,
  SchedulingRule,
  TimeWindow,
} from "@/lib/types";

/** Input slot from freebusy or calendar system. */
export interface FreebusySlot {
  id: string;
  start: string;
  end: string;
  isOnline?: boolean;
  locationHint?: string;
  estimatedCostJpy?: number;
  metadata?: Record<string, unknown>;
}

/** Scored candidate after policy application. */
export interface ScoredCandidate {
  slot: FreebusySlot;
  score: number;
  kept: boolean;
  appliedRules: string[];
  droppedByRules: string[];
  reasons: string[];
}

/** Apply engine result. */
export interface ApplySchedulingPolicyResult {
  finalCandidates: FreebusySlot[];
  allCandidates: ScoredCandidate[];
  auditLabels: SchedulingAuditLabel[];
  effectiveConfirmAutomation: ConfirmAutomationLevel;
  droppedCount: number;
  keptCount: number;
  failClosed: boolean;
  failClosedReason?: string;
}

export interface ApplySchedulingPolicyOptions {
  orgId: string;
  employeeId?: string;
  jobId?: string;
  now?: Date;
}

function parseDate(str: string): Date {
  return new Date(str);
}

function isTimeWithinWindow(
  slotStart: Date,
  slotEnd: Date,
  window: TimeWindow
): boolean {
  if (window.dayOfWeek && window.dayOfWeek.length > 0) {
    const slotDay = slotStart.getDay();
    if (!window.dayOfWeek.includes(slotDay)) {
      return false;
    }
  }

  if (window.startDate) {
    const startDate = parseDate(window.startDate);
    if (slotStart < startDate) {
      return false;
    }
  }

  if (window.endDate) {
    const endDate = parseDate(window.endDate);
    if (slotEnd > endDate) {
      return false;
    }
  }

  if (window.startTime && window.endTime) {
    const slotHour = slotStart.getHours();
    const slotMinute = slotStart.getMinutes();
    const slotTimeMinutes = slotHour * 60 + slotMinute;

    const [startH, startM] = window.startTime.split(":").map(Number);
    const [endH, endM] = window.endTime.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (slotTimeMinutes < startMinutes || slotTimeMinutes >= endMinutes) {
      return false;
    }
  }

  return true;
}

function isSlotInBlackout(
  slot: FreebusySlot,
  blackouts: TimeWindow[] | undefined
): { blocked: boolean; reason?: string } {
  if (!blackouts || blackouts.length === 0) {
    return { blocked: false };
  }

  const slotStart = parseDate(slot.start);
  const slotEnd = parseDate(slot.end);

  for (const window of blackouts) {
    if (isTimeWithinWindow(slotStart, slotEnd, window)) {
      return { blocked: true, reason: window.reason || "hard_blackout" };
    }
  }

  return { blocked: false };
}

function isSlotPreferred(
  slot: FreebusySlot,
  prefers: TimeWindow[] | undefined
): { preferred: boolean; reason?: string } {
  if (!prefers || prefers.length === 0) {
    return { preferred: false };
  }

  const slotStart = parseDate(slot.start);
  const slotEnd = parseDate(slot.end);

  for (const window of prefers) {
    if (isTimeWithinWindow(slotStart, slotEnd, window)) {
      return { preferred: true, reason: window.reason || "soft_prefer" };
    }
  }

  return { preferred: false };
}

function scoreSlotByRule(
  slot: FreebusySlot,
  rule: SchedulingRule
): {
  score: number;
  kept: boolean;
  reasons: string[];
} {
  let score = 100;
  const reasons: string[] = [];
  let kept = true;

  const blackoutResult = isSlotInBlackout(slot, rule.hardBlackout);
  if (blackoutResult.blocked) {
    kept = false;
    reasons.push(`hardBlackout: ${blackoutResult.reason}`);
    return { score: 0, kept, reasons };
  }

  const preferResult = isSlotPreferred(slot, rule.softPrefer);
  if (preferResult.preferred) {
    score += 20;
    reasons.push(`softPrefer: ${preferResult.reason}`);
  }

  if (rule.locationAffinity && slot.locationHint) {
    const isOnline = slot.isOnline || slot.locationHint.toLowerCase().includes("online");
    const isOffice =
      !isOnline &&
      (slot.locationHint.toLowerCase().includes("office") ||
        slot.locationHint.toLowerCase().includes("オフィス"));

    switch (rule.locationAffinity) {
      case "office_first":
        if (isOffice) score += 15;
        else if (isOnline) score -= 10;
        break;
      case "remote_first":
        if (isOnline) score += 15;
        else if (isOffice) score -= 10;
        break;
      case "hybrid":
        break;
      case "any":
        break;
    }
    reasons.push(`locationAffinity: ${rule.locationAffinity}`);
  }

  if (rule.costCapJpy !== undefined && slot.estimatedCostJpy !== undefined) {
    if (slot.estimatedCostJpy > rule.costCapJpy) {
      kept = false;
      reasons.push(`costCap exceeded: ${slot.estimatedCostJpy} > ${rule.costCapJpy}`);
      return { score: 0, kept, reasons };
    }
    const costRatio = slot.estimatedCostJpy / rule.costCapJpy;
    score -= Math.floor(costRatio * 10);
    reasons.push(`costWithinCap: ${slot.estimatedCostJpy} / ${rule.costCapJpy}`);
  }

  if (rule.onlinePack?.enabled && slot.isOnline) {
    if (rule.onlinePack.calendarTarget && slot.metadata?.calendar) {
      if (slot.metadata.calendar !== rule.onlinePack.calendarTarget) {
        kept = false;
        reasons.push(
          `onlineCalendarTarget mismatch: ${slot.metadata.calendar} != ${rule.onlinePack.calendarTarget}`
        );
        return { score: 0, kept, reasons };
      }
    }
    if (
      rule.onlinePack.videoToolAllowlist.length > 0 &&
      slot.metadata?.videoTool
    ) {
      const allowed = rule.onlinePack.videoToolAllowlist.map((e) =>
        e.tool.toLowerCase()
      );
      const slotTool = String(slot.metadata.videoTool).toLowerCase();
      if (!allowed.includes(slotTool)) {
        kept = false;
        reasons.push(
          `videoTool not in allowlist: ${slotTool} not in [${allowed.join(", ")}]`
        );
        return { score: 0, kept, reasons };
      }
    }
  }

  return { score, kept, reasons };
}

function resolveEffectiveConfirmAutomation(
  rules: SchedulingRule[]
): ConfirmAutomationLevel {
  let lowest: ConfirmAutomationLevel = "full_auto";
  const order: ConfirmAutomationLevel[] = [
    "always_human",
    "risk_based",
    "conditional",
    "full_auto",
  ];

  for (const rule of rules) {
    const current = order.indexOf(rule.confirmAutomation);
    const lowestIdx = order.indexOf(lowest);
    if (current < lowestIdx) {
      lowest = rule.confirmAutomation;
    }
  }

  return lowest;
}

/**
 * Apply scheduling policy to freebusy slots.
 * Fail-closed: on conflict or unknown, do not widen candidates.
 */
export function applySchedulingPolicySync(
  policy: OrgSchedulingPolicy,
  slots: FreebusySlot[],
  _now: Date = new Date()
): ApplySchedulingPolicyResult {
  if (policy.rules.length === 0) {
    return {
      finalCandidates: [],
      allCandidates: [],
      auditLabels: [],
      effectiveConfirmAutomation: "always_human",
      droppedCount: slots.length,
      keptCount: 0,
      failClosed: true,
      failClosedReason: "no_rules_defined",
    };
  }

  const allCandidates: ScoredCandidate[] = [];
  const auditLabels: SchedulingAuditLabel[] = [];

  for (const slot of slots) {
    let bestScore = -1;
    let kept = false;
    const appliedRules: string[] = [];
    const droppedByRules: string[] = [];
    const allReasons: string[] = [];

    for (const rule of policy.rules) {
      const result = scoreSlotByRule(slot, rule);
      appliedRules.push(rule.id);

      if (result.kept) {
        if (result.score > bestScore) {
          bestScore = result.score;
          kept = true;
        }
        allReasons.push(...result.reasons);
      } else {
        droppedByRules.push(rule.id);
        allReasons.push(...result.reasons);
      }
    }

    if (droppedByRules.length === policy.rules.length) {
      kept = false;
      bestScore = 0;
    }

    const candidate: ScoredCandidate = {
      slot,
      score: kept ? bestScore : 0,
      kept,
      appliedRules,
      droppedByRules,
      reasons: allReasons,
    };
    allCandidates.push(candidate);

    auditLabels.push({
      slotId: slot.id,
      kept,
      appliedRules,
      droppedByRules: droppedByRules.length > 0 ? droppedByRules : undefined,
      reason: allReasons.join("; ") || undefined,
    });
  }

  allCandidates.sort((a, b) => b.score - a.score);

  const finalCandidates = allCandidates.filter((c) => c.kept).map((c) => c.slot);

  const effectiveConfirmAutomation = resolveEffectiveConfirmAutomation(policy.rules);

  return {
    finalCandidates,
    allCandidates,
    auditLabels,
    effectiveConfirmAutomation,
    droppedCount: allCandidates.filter((c) => !c.kept).length,
    keptCount: finalCandidates.length,
    failClosed: false,
  };
}

/**
 * Async version with audit logging.
 */
export async function applySchedulingPolicy(
  policy: OrgSchedulingPolicy,
  slots: FreebusySlot[],
  options: ApplySchedulingPolicyOptions
): Promise<ApplySchedulingPolicyResult> {
  const now = options.now || new Date();
  const result = applySchedulingPolicySync(policy, slots, now);

  if (result.droppedCount > 0 || result.failClosed) {
    await appendAuditEvent({
      orgId: options.orgId,
      employeeId: options.employeeId ?? null,
      credentialId: null,
      action: "tool.invoke",
      purpose: "scheduling.policy_applied",
      summary: result.failClosed
        ? `日程ポリシー適用 fail-closed: ${result.failClosedReason}`
        : `日程ポリシー適用: ${result.keptCount}件採用 / ${result.droppedCount}件除外`,
      metadata: {
        jobId: options.jobId,
        policyId: policy.policyId,
        policyName: policy.policyName,
        slotsInput: slots.length,
        keptCount: result.keptCount,
        droppedCount: result.droppedCount,
        failClosed: result.failClosed,
        failClosedReason: result.failClosedReason,
        effectiveConfirmAutomation: result.effectiveConfirmAutomation,
        auditLabels: result.auditLabels,
      },
    }).catch(() => undefined);
  }

  return result;
}

/**
 * Build audit metadata for calendar.propose with scheduling policy context.
 */
export function buildSchedulingPolicyAuditMetadata(
  result: ApplySchedulingPolicyResult,
  options: ApplySchedulingPolicyOptions
): Record<string, unknown> {
  return {
    schedulingPolicy: {
      keptCount: result.keptCount,
      droppedCount: result.droppedCount,
      effectiveConfirmAutomation: result.effectiveConfirmAutomation,
      failClosed: result.failClosed,
      failClosedReason: result.failClosedReason,
    },
    jobId: options.jobId,
  };
}

/**
 * Check if online video tool is allowed by policy.
 * Fail-closed: if policy specifies allowlist and tool not in it, reject.
 */
export function isVideoToolAllowed(
  policy: OrgSchedulingPolicy,
  videoTool: string
): { allowed: boolean; reason?: string } {
  for (const rule of policy.rules) {
    if (rule.onlinePack?.enabled && rule.onlinePack.videoToolAllowlist.length > 0) {
      const allowed = rule.onlinePack.videoToolAllowlist.map((e) =>
        e.tool.toLowerCase()
      );
      if (!allowed.includes(videoTool.toLowerCase())) {
        return {
          allowed: false,
          reason: `videoTool "${videoTool}" not in allowlist: [${allowed.join(", ")}]`,
        };
      }
    }
  }
  return { allowed: true };
}

/**
 * Get default video tool from policy.
 */
export function getDefaultVideoTool(policy: OrgSchedulingPolicy): string | null {
  for (const rule of policy.rules) {
    if (rule.onlinePack?.enabled && rule.onlinePack.defaultVideoTool) {
      return rule.onlinePack.defaultVideoTool;
    }
  }
  return null;
}

/**
 * Get online calendar target from policy.
 */
export function getOnlineCalendarTarget(policy: OrgSchedulingPolicy): string | null {
  for (const rule of policy.rules) {
    if (rule.onlinePack?.enabled && rule.onlinePack.calendarTarget) {
      return rule.onlinePack.calendarTarget;
    }
  }
  return null;
}
