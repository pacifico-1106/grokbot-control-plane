/**
 * PR-B admin MCP read tools: channels.list / parties.list.
 *
 * - Read-only, no approval ticket (same rule as the other *.list tools).
 * - Org comes only from the admin credential; any argument outside the schema
 *   (including orgId) is refused with unknown_argument.
 * - Whitelisted fields only (no internal ids, no secrets, no message content).
 * - Paginated with an opaque cursor; a store error is reported, never an
 *   empty list.
 */
import { pageOrgChannels, pageOrgParties } from "@/lib/data/directory";
import { CHANNEL_CLASSIFICATIONS, CHANNEL_LEDGER_SURFACES, PARTY_AUDIENCES, PARTY_KINDS } from "@/lib/channel-classify/core";
import type { ChannelClassification, ChannelLedgerSurface, OrgPartyKind } from "@/lib/types";

export const LEDGER_LIST_DEFAULT_LIMIT = 50;
export const LEDGER_LIST_MAX_LIMIT = 200;
const MAX_OFFSET = 100_000;

type ListError = { ok: false; code: string; field?: string; allowed?: string[]; message: string; messageJa: string };
export type LedgerListResult =
  | { ok: true; items: Array<Record<string, unknown>>; nextCursor: string | null; limit: number }
  | ListError;

function fail(code: string, messageJa: string, extra: Partial<ListError> = {}): ListError {
  return { ok: false, code, message: code, messageJa, ...extra };
}

export function encodeLedgerCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, o: offset }), "utf8").toString("base64url");
}

export function decodeLedgerCursor(cursor: unknown): number | null {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  if (typeof cursor !== "string" || cursor.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; o?: unknown };
    if (parsed.v !== 1 || typeof parsed.o !== "number" || !Number.isSafeInteger(parsed.o) || parsed.o < 0 || parsed.o > MAX_OFFSET) return null;
    return parsed.o;
  } catch {
    return null;
  }
}

function parseLimit(value: unknown): number | null {
  if (value === undefined || value === null) return LEDGER_LIST_DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > LEDGER_LIST_MAX_LIMIT) return null;
  return value;
}

function enumFilter<T extends string>(value: unknown, allowed: readonly T[]): { ok: true; value?: T } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true };
  if (typeof value === "string" && (allowed as readonly string[]).includes(value.trim())) return { ok: true, value: value.trim() as T };
  return { ok: false };
}

const CHANNEL_ARGS = ["surface", "classification", "limit", "cursor"];
const PARTY_ARGS = ["kind", "audience", "limit", "cursor"];

export async function handleChannelLedgerList(
  tool: "channels.list" | "parties.list",
  args: Record<string, unknown>,
  orgId: string
): Promise<LedgerListResult> {
  const allowedArgs = tool === "channels.list" ? CHANNEL_ARGS : PARTY_ARGS;
  const unknown = Object.keys(args).find((key) => !allowedArgs.includes(key));
  if (unknown) {
    return fail(
      "unknown_argument",
      unknown === "orgId" ? "orgId は指定できません（組織は認証情報から決まります）。" : `未知の引数です（許可: ${allowedArgs.join(", ")}）。`,
      { field: unknown.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40), allowed: allowedArgs }
    );
  }
  const limit = parseLimit(args.limit);
  if (limit === null) return fail("invalid_limit", `limit は 1〜${LEDGER_LIST_MAX_LIMIT} の整数です。`, { field: "limit" });
  const offset = decodeLedgerCursor(args.cursor);
  if (offset === null) return fail("invalid_cursor", "cursor が不正です。直前の応答の nextCursor をそのまま渡してください。", { field: "cursor" });

  try {
    if (tool === "channels.list") {
      const surface = enumFilter<ChannelLedgerSurface>(args.surface, CHANNEL_LEDGER_SURFACES);
      if (!surface.ok) return fail("invalid_surface", `surface は ${CHANNEL_LEDGER_SURFACES.join(", ")} のいずれかです。`, { field: "surface", allowed: [...CHANNEL_LEDGER_SURFACES] });
      const classification = enumFilter<ChannelClassification>(args.classification, CHANNEL_CLASSIFICATIONS);
      if (!classification.ok) return fail("invalid_classification", `classification は ${CHANNEL_CLASSIFICATIONS.join(", ")} のいずれかです。`, { field: "classification", allowed: [...CHANNEL_CLASSIFICATIONS] });
      const page = await pageOrgChannels(orgId, { offset, limit, surface: surface.value, classification: classification.value });
      return {
        ok: true,
        items: page.rows
          .filter((row) => row.orgId === orgId)
          .map((row) => ({
            surface: row.surface,
            externalId: row.externalId,
            classification: row.classification,
            mixed: Boolean(row.mixed),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })),
        nextCursor: page.hasMore ? encodeLedgerCursor(offset + limit) : null,
        limit,
      };
    }
    const kind = enumFilter<OrgPartyKind>(args.kind, PARTY_KINDS);
    if (!kind.ok) return fail("invalid_kind", `kind は ${PARTY_KINDS.join(", ")} のいずれかです。`, { field: "kind", allowed: [...PARTY_KINDS] });
    const audience = enumFilter<"internal" | "external">(args.audience, PARTY_AUDIENCES);
    if (!audience.ok) return fail("invalid_audience", `audience は ${PARTY_AUDIENCES.join(", ")} のいずれかです。`, { field: "audience", allowed: [...PARTY_AUDIENCES] });
    const page = await pageOrgParties(orgId, { offset, limit, kind: kind.value, audience: audience.value });
    return {
      ok: true,
      items: page.rows
        .filter((row) => row.orgId === orgId)
        .map((row) => ({
          kind: row.kind,
          identifier: row.identifier,
          audience: row.audience,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      nextCursor: page.hasMore ? encodeLedgerCursor(offset + limit) : null,
      limit,
    };
  } catch {
    return fail("store_unavailable", "台帳を読み取れませんでした。時間をおいて再実行してください。");
  }
}
