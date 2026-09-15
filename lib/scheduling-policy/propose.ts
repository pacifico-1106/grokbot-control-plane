/**
 * A1 scheduling.policy integration for calendar.propose path.
 * Wire scheduling policy application into the propose flow.
 * Flow: freebusy/read → apply scheduling.policy → outward propose shows final candidates only.
 */
import {
  applySchedulingPolicy,
  applySchedulingPolicySync,
  getDefaultVideoTool,
  getOnlineCalendarTarget,
  isVideoToolAllowed,
  resolveCalendarConfirmAutomation,
  type ApplySchedulingPolicyOptions,
  type FreebusySlot,
} from "./apply";
import {
  filterSlotsByUnionBusy,
  resolveCalendarSources,
  type BusyInterval,
} from "./freebusy";
import { getEffectiveSchedulingPolicy } from "@/lib/data/scheduling-policy";
import type { ConfirmAutomationLevel, OrgSchedulingPolicy } from "@/lib/types";

export interface ProposeContext {
  orgId: string;
  employeeId?: string;
  jobId?: string;
  policyId?: string;
}

export interface ProposeInput {
  slots: FreebusySlot[];
  context: ProposeContext;
  requestedVideoTool?: string;
  /** A1 v2: busy intervals per calendar id for union_busy merge. */
  busyByCalendar?: Record<string, BusyInterval[]>;
}

export interface ProposeResult {
  finalCandidates: FreebusySlot[];
  policyApplied: boolean;
  policyId: string | null;
  policyName: string | null;
  effectiveConfirmAutomation: ConfirmAutomationLevel;
  droppedCount: number;
  keptCount: number;
  failClosed: boolean;
  failClosedReason?: string;
  onlineSettings?: {
    calendarTarget: string | null;
    defaultVideoTool: string | null;
    requestedVideoToolAllowed: boolean;
    requestedVideoToolReason?: string;
  };
  auditMetadata: Record<string, unknown>;
}

/**
 * Apply scheduling policy to calendar.propose flow.
 * If policy is set for org (or employee override), apply filtering.
 * If no policy, pass through all slots with always_human confirm.
 */
export async function applySchedulingPolicyToPropose(
  input: ProposeInput
): Promise<ProposeResult> {
  const { slots, context, requestedVideoTool } = input;

  const effective = await getEffectiveSchedulingPolicy(
    context.orgId,
    context.employeeId
  );

  if (effective.source === "default") {
    return {
      finalCandidates: slots,
      policyApplied: false,
      policyId: null,
      policyName: null,
      effectiveConfirmAutomation: "always_human",
      droppedCount: 0,
      keptCount: slots.length,
      failClosed: false,
      auditMetadata: {
        schedulingPolicy: {
          source: "default",
          policyApplied: false,
        },
        jobId: context.jobId,
      },
    };
  }

  const policy = effective.policy;
  const calendarSources = resolveCalendarSources(policy.rules);

  if (calendarSources && calendarSources.ids.length === 0) {
    return {
      finalCandidates: [],
      policyApplied: true,
      policyId: policy.policyId,
      policyName: policy.policyName,
      effectiveConfirmAutomation: resolveCalendarConfirmAutomation(policy),
      droppedCount: slots.length,
      keptCount: 0,
      failClosed: true,
      failClosedReason: "empty_calendar_sources",
      auditMetadata: {
        schedulingPolicy: {
          source: effective.source,
          policyId: policy.policyId,
          policyName: policy.policyName,
          keptCount: 0,
          droppedCount: slots.length,
          effectiveConfirmAutomation: resolveCalendarConfirmAutomation(policy),
          failClosed: true,
          failClosedReason: "empty_calendar_sources",
        },
        jobId: context.jobId,
      },
    };
  }

  let workingSlots = slots;
  let unionBusyDropped = 0;
  let calendarSourcesUsed: string[] | undefined;

  if (calendarSources && input.busyByCalendar) {
    const unionResult = filterSlotsByUnionBusy(
      workingSlots,
      calendarSources,
      input.busyByCalendar
    );
    workingSlots = unionResult.kept;
    unionBusyDropped = unionResult.dropped.length;
    calendarSourcesUsed = unionResult.calendarSourcesUsed;
  }

  const options: ApplySchedulingPolicyOptions = {
    orgId: context.orgId,
    employeeId: context.employeeId,
    jobId: context.jobId,
    calendarSourcesUsed,
  };

  const result = await applySchedulingPolicy(policy, workingSlots, options);
  const totalDropped = result.droppedCount + unionBusyDropped;

  let onlineSettings: ProposeResult["onlineSettings"] | undefined;
  if (requestedVideoTool) {
    const videoCheck = isVideoToolAllowed(policy, requestedVideoTool);
    onlineSettings = {
      calendarTarget: getOnlineCalendarTarget(policy),
      defaultVideoTool: getDefaultVideoTool(policy),
      requestedVideoToolAllowed: videoCheck.allowed,
      requestedVideoToolReason: videoCheck.reason,
    };
  } else {
    onlineSettings = {
      calendarTarget: getOnlineCalendarTarget(policy),
      defaultVideoTool: getDefaultVideoTool(policy),
      requestedVideoToolAllowed: true,
    };
  }

  return {
    finalCandidates: result.finalCandidates,
    policyApplied: true,
    policyId: policy.policyId,
    policyName: policy.policyName,
    effectiveConfirmAutomation: result.effectiveConfirmAutomation,
    droppedCount: totalDropped,
    keptCount: result.keptCount,
    failClosed: result.failClosed,
    failClosedReason: result.failClosedReason,
    onlineSettings,
    auditMetadata: {
      schedulingPolicy: {
        source: effective.source,
        policyId: policy.policyId,
        policyName: policy.policyName,
        keptCount: result.keptCount,
        droppedCount: totalDropped,
        effectiveConfirmAutomation: result.effectiveConfirmAutomation,
        failClosed: result.failClosed,
        failClosedReason: result.failClosedReason,
        auditLabels: result.auditLabels,
      },
      jobId: context.jobId,
    },
  };
}

/**
 * Synchronous version for tests or when no audit logging needed.
 */
export function applySchedulingPolicyToProposeSync(
  policy: OrgSchedulingPolicy | null,
  slots: FreebusySlot[],
  requestedVideoTool?: string,
  busyByCalendar?: Record<string, BusyInterval[]>
): Omit<ProposeResult, "auditMetadata"> & { auditMetadata?: Record<string, unknown> } {
  if (!policy) {
    return {
      finalCandidates: slots,
      policyApplied: false,
      policyId: null,
      policyName: null,
      effectiveConfirmAutomation: "always_human",
      droppedCount: 0,
      keptCount: slots.length,
      failClosed: false,
    };
  }

  const calendarSources = resolveCalendarSources(policy.rules);
  if (calendarSources && calendarSources.ids.length === 0) {
    return {
      finalCandidates: [],
      policyApplied: true,
      policyId: policy.policyId,
      policyName: policy.policyName,
      effectiveConfirmAutomation: resolveCalendarConfirmAutomation(policy),
      droppedCount: slots.length,
      keptCount: 0,
      failClosed: true,
      failClosedReason: "empty_calendar_sources",
    };
  }

  let workingSlots = slots;
  let unionBusyDropped = 0;
  let calendarSourcesUsed: string[] | undefined;

  if (calendarSources && busyByCalendar) {
    const unionResult = filterSlotsByUnionBusy(workingSlots, calendarSources, busyByCalendar);
    workingSlots = unionResult.kept;
    unionBusyDropped = unionResult.dropped.length;
    calendarSourcesUsed = unionResult.calendarSourcesUsed;
  }

  const result = applySchedulingPolicySync(policy, workingSlots, new Date(), {
    calendarSourcesUsed,
  });
  const totalDropped = result.droppedCount + unionBusyDropped;

  let onlineSettings: ProposeResult["onlineSettings"] | undefined;
  if (requestedVideoTool) {
    const videoCheck = isVideoToolAllowed(policy, requestedVideoTool);
    onlineSettings = {
      calendarTarget: getOnlineCalendarTarget(policy),
      defaultVideoTool: getDefaultVideoTool(policy),
      requestedVideoToolAllowed: videoCheck.allowed,
      requestedVideoToolReason: videoCheck.reason,
    };
  }

  return {
    finalCandidates: result.finalCandidates,
    policyApplied: true,
    policyId: policy.policyId,
    policyName: policy.policyName,
    effectiveConfirmAutomation: result.effectiveConfirmAutomation,
    droppedCount: totalDropped,
    keptCount: result.keptCount,
    failClosed: result.failClosed,
    failClosedReason: result.failClosedReason,
    onlineSettings,
  };
}

/**
 * Validate that online meeting settings are compliant with policy.
 * Fail-closed: if policy specifies online targets and request doesn't match, reject.
 */
export async function validateOnlineSettings(
  context: ProposeContext,
  calendarTarget?: string,
  videoTool?: string
): Promise<{
  ok: boolean;
  reason?: string;
  suggestedCalendarTarget?: string;
  suggestedVideoTool?: string;
}> {
  const effective = await getEffectiveSchedulingPolicy(
    context.orgId,
    context.employeeId
  );

  if (effective.source === "default") {
    return { ok: true };
  }

  const policy = effective.policy;
  const policyCalendarTarget = getOnlineCalendarTarget(policy);
  const policyDefaultVideoTool = getDefaultVideoTool(policy);

  if (policyCalendarTarget && calendarTarget && calendarTarget !== policyCalendarTarget) {
    return {
      ok: false,
      reason: `online_calendar_target mismatch: policy requires "${policyCalendarTarget}", got "${calendarTarget}"`,
      suggestedCalendarTarget: policyCalendarTarget,
    };
  }

  if (videoTool) {
    const videoCheck = isVideoToolAllowed(policy, videoTool);
    if (!videoCheck.allowed) {
      return {
        ok: false,
        reason: videoCheck.reason,
        suggestedVideoTool: policyDefaultVideoTool || undefined,
      };
    }
  }

  return {
    ok: true,
    suggestedCalendarTarget: policyCalendarTarget || undefined,
    suggestedVideoTool: policyDefaultVideoTool || undefined,
  };
}
