import { actorLabel } from "@/lib/employees/actor-label";
import type { AuditEvent } from "@/lib/types";
import { extractEmail, maskEmail, opaqueAuditId, sanitizeAuditDisplayText } from "./mask";
import type { AuditActorView, AuditMemberLookup, AuditPresentationLookups } from "./types";

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t || null;
}

function metaActorEmail(event: AuditEvent): string | null {
  const meta = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  return asString(event.actorEmail) ?? asString((meta as Record<string, unknown>).actorEmail);
}

export function parseActorChannel(raw: string): {
  channel: "slack" | "line" | "telegram" | "web" | "plain";
  rest: string;
} {
  const t = raw.trim();
  const m = t.match(/^(slack|line|telegram|web|email):(.+)$/i);
  if (!m) return { channel: "plain", rest: t };
  const channel = m[1].toLowerCase();
  if (channel === "email") return { channel: "web", rest: m[2] };
  return { channel: channel as "slack" | "line" | "telegram" | "web", rest: m[2] };
}

export function lookupMemberByActor(
  raw: string | null | undefined,
  membersByEmail?: ReadonlyMap<string, AuditMemberLookup>
): AuditMemberLookup | null {
  const email = extractEmail(raw);
  if (!email || !membersByEmail) return null;
  return membersByEmail.get(email) ?? membersByEmail.get(email.toLowerCase()) ?? null;
}

export function presentNamedPerson(
  raw: string | null | undefined,
  lookups: AuditPresentationLookups
): { name: string | null; emailMasked: string | null } {
  if (!raw) return { name: null, emailMasked: null };
  const parsed = parseActorChannel(raw);
  const member = lookupMemberByActor(raw, lookups.membersByEmail);
  if (member) {
    return {
      name: sanitizeAuditDisplayText(member.displayName).trim() || "不明",
      emailMasked: maskEmail(member.email),
    };
  }
  if (parsed.channel === "slack") {
    const slackId = parsed.rest.replace(/^U/i, "U");
    const named = lookups.slackDisplayNameByUserId?.get(parsed.rest) ?? lookups.slackDisplayNameByUserId?.get(slackId);
    const safeName = named && named !== parsed.rest && named !== slackId ? sanitizeAuditDisplayText(named).trim() : "";
    return { name: safeName || "Slack 承認者", emailMasked: null };
  }
  if (parsed.channel === "line") return { name: "LINE 承認者", emailMasked: null };
  if (parsed.channel === "telegram") return { name: "Telegram 承認者", emailMasked: null };
  const masked = maskEmail(raw);
  if (masked) return { name: "不明", emailMasked: masked };
  return { name: "不明", emailMasked: null };
}

export function resolveAuditActor(
  event: AuditEvent,
  lookups: AuditPresentationLookups = {}
): AuditActorView {
  const employeeId = event.employeeId ? String(event.employeeId).trim() : "";
  if (employeeId) {
    const emp = lookups.employeesById?.get(employeeId);
    const labeled = actorLabel(emp, employeeId);
    const mailbox = lookups.mailboxEmailByEmployeeId?.get(employeeId);
    return {
      kind: "ai",
      name: sanitizeAuditDisplayText(labeled.name) || "不明",
      emailMasked: mailbox ? maskEmail(mailbox) : null,
      employeeId: opaqueAuditId(employeeId),
    };
  }

  const stored = metaActorEmail(event);
  if (stored) {
    const person = presentNamedPerson(stored, lookups);
    return {
      kind: "human",
      name: person.name ? sanitizeAuditDisplayText(person.name) || "不明" : "不明",
      emailMasked: person.emailMasked,
      employeeId: null,
    };
  }

  return { kind: "system", name: "システム", emailMasked: null, employeeId: null };
}
