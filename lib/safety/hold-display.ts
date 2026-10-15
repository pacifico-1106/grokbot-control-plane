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
  return "stop";
}
