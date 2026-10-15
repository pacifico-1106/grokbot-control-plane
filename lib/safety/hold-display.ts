/**
 * HoldPanel view-state. Pure (safe for the client bundle). Unreadable → error,
 * never the stop button (fail-closed display).
 */

export const HOLD_DISPLAY_UNREADABLE_JA =
  "停止状態を確認できません。安全のため停止ボタンは出していません。ページを再読み込みするか、運営に連絡してください。";

export type HoldDisplayStatus = {
  enabled: boolean;
  orgEnabled: boolean;
  state: "none" | "held" | "unknown";
  hold: { id: string } | null;
};

export type HoldDisplayMode = "loading" | "hidden" | "error" | "stop" | "held";

export function holdDisplayMode(
  status: HoldDisplayStatus | null,
  scope: "employee" | "org",
  loadFailed: boolean,
): HoldDisplayMode {
  if (loadFailed) return "error";
  if (!status) return "loading";
  if (!status.enabled || (scope === "org" && !status.orgEnabled)) return "hidden";
  if (status.state === "unknown") return "error";
  if (status.state === "held") return status.hold && status.hold.id ? "held" : "error";
  if (status.state === "none") return "stop";
  return "error";
}

export type HoldPanelHold = {
  id: string;
  kind: string;
  startedVia: string;
  startedAt: string;
  opsHold: boolean;
  releaseRequestedBy: string | null;
  releaseRequested: boolean;
};

export type HoldPanelStatus = {
  ok: boolean;
  enabled: boolean;
  orgEnabled: boolean;
  state: "none" | "held" | "unknown";
  me: string;
  hold: HoldPanelHold | null;
};

/** A cached / stale GET that says "none" must never overwrite a live held pointer. */
export function mergeHoldStatus(prev: HoldPanelStatus | null, next: HoldPanelStatus): HoldPanelStatus {
  if (prev?.state === "held" && prev.hold?.id && next.state === "none") return prev;
  return next;
}

export function buildHoldPanelStatus(input: {
  enabled: boolean;
  orgEnabled: boolean;
  memberId: string;
  read: { state: "none" } | { state: "unknown" } | {
    state: "held";
    hold: {
      id: string;
      kind: string;
      startedVia: string;
      startedAt: string;
      releaseRequestedBy: string | null;
      releaseApprovalId: string | null;
    };
  };
}): HoldPanelStatus {
  const hold = input.read.state === "held" ? {
    id: input.read.hold.id,
    kind: input.read.hold.kind,
    startedVia: input.read.hold.startedVia,
    startedAt: input.read.hold.startedAt,
    opsHold: input.read.hold.startedVia === "ops_console",
    releaseRequestedBy: input.read.hold.releaseRequestedBy,
    releaseRequested: Boolean(input.read.hold.releaseApprovalId),
  } : null;
  return {
    ok: true,
    enabled: input.enabled,
    orgEnabled: input.orgEnabled,
    state: input.read.state,
    me: `member:${input.memberId}`,
    hold,
  };
}
