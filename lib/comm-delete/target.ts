/** comm.delete target parsing (fail-first stub). */
import type { CommDeleteSurface } from "./surfaces";

export type CommDeleteTarget = { surface: CommDeleteSurface; channel: string; messageId: string };

export type CommDeleteTargetParse =
  | { ok: true; target: CommDeleteTarget }
  | { ok: false; code: "invalid_delete_target"; field: string; messageJa: string };

export function parseCommDeleteTarget(_args: Record<string, unknown> | undefined | null): CommDeleteTargetParse {
  return { ok: false, code: "invalid_delete_target", field: "stub", messageJa: "" };
}
