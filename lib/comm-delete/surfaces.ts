/** comm.delete surface support matrix (fail-first stub). */
export type CommDeleteSurface = "slack" | "line" | "telegram";

export type CommDeleteSurfaceSupport =
  | { supported: true }
  | { supported: false; reason: string; messageJa: string; source: string };

export function commDeleteSurfaceSupport(_surface: CommDeleteSurface): CommDeleteSurfaceSupport {
  return { supported: false, reason: "stub", messageJa: "", source: "" };
}
