import type { InboundNoticeFieldKey, InboundNoticeFields } from "@/lib/inbound-notice/types";

export const FIELD_CAPS: Record<InboundNoticeFieldKey, number> = {
  receivedAt: 64,
  phone: 32,
  company: 200,
  personName: 100,
  category: 100,
  callbackNeeded: 32,
  emergency: 16,
  salesCall: 16,
  summary: 2000,
};

/** Canonical order. 要約 is last and greedy (remainder). */
export const FIELD_LABELS: ReadonlyArray<{ key: InboundNoticeFieldKey; label: string }> = [
  { key: "receivedAt", label: "受電日時" },
  { key: "phone", label: "電話番号" },
  { key: "company", label: "相手先会社" },
  { key: "personName", label: "相手先氏名" },
  { key: "category", label: "カテゴリ" },
  { key: "callbackNeeded", label: "折り返し要否" },
  { key: "emergency", label: "緊急" },
  { key: "salesCall", label: "営業電話" },
  { key: "summary", label: "要約" },
];

const EMPTY: InboundNoticeFields = {
  receivedAt: null,
  phone: null,
  company: null,
  personName: null,
  category: null,
  callbackNeeded: null,
  emergency: null,
  salesCall: null,
  summary: null,
};

function cap(value: string, n: number): string {
  return value.length <= n ? value : value.slice(0, n);
}

function labelRe(label: string): RegExp {
  return new RegExp(`^${label}[:：\\s]+(.*)$`);
}

function startsWithLabel(line: string): { key: InboundNoticeFieldKey; rest: string } | null {
  const trimmed = line.trim();
  for (const { key, label } of FIELD_LABELS) {
    const m = labelRe(label).exec(trimmed);
    if (m) return { key, rest: (m[1] ?? "").trim() };
  }
  return null;
}

function labeledLineCount(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    if (startsWithLabel(line)) n += 1;
  }
  return n;
}

/**
 * Collapsed notices use ` / ` between fields (dates keep `2026/01/02`).
 * Multiline notices keep ` / ` inside a value so injected labels cannot
 * become new field boundaries.
 */
function expandCollapsed(raw: string): string {
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (labeledLineCount(text) >= 2) return text;
  const labels = FIELD_LABELS.map((f) => f.label).join("|");
  return text.replace(new RegExp(`\\s*/\\s*(${labels})(?=[:：\\s]|$)`, "g"), "\n$1");
}

export function parseInboundNoticeFields(raw: unknown): InboundNoticeFields {
  if (typeof raw !== "string" || !raw.trim()) return { ...EMPTY };
  const text = expandCollapsed(raw);
  const lines = text.split("\n");
  const out: InboundNoticeFields = { ...EMPTY };
  let current: InboundNoticeFieldKey | null = null;
  let greedySummary = false;
  const buf: string[] = [];

  const flush = () => {
    if (!current) return;
    const joined = buf.join("\n").trim();
    out[current] = joined ? cap(joined, FIELD_CAPS[current]) : null;
    buf.length = 0;
  };

  for (const line of lines) {
    if (greedySummary) {
      buf.push(line.trim());
      continue;
    }
    const hit = startsWithLabel(line);
    if (hit) {
      flush();
      current = hit.key;
      buf.push(hit.rest);
      if (hit.key === "summary") greedySummary = true;
      continue;
    }
    if (current) buf.push(line.trim());
  }
  flush();
  return out;
}

const YES = new Set(["はい", "yes", "true"]);
const NO = new Set(["いいえ", "no", "false", "不要"]);

export function isYes(value: string | null): boolean {
  if (!value) return false;
  return YES.has(value.trim().toLowerCase());
}

export function isNo(value: string | null): boolean {
  if (!value) return false;
  return NO.has(value.trim().toLowerCase());
}
