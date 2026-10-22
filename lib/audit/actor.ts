import { actorLabel } from "@/lib/employees/actor-label";
import { isAuditPageAdminWhoEnabledForOrg } from "@/lib/feature-flags";
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

const HOLD_TRAIL_ACTIONS = new Set([
  "employee.hold.started",
  "employee.hold.start_failed",
  "employee.hold.release_requested",
  "employee.hold.released",
  "employee.hold.release_refused",
  "employee.hold.self_approval_denied",
]);

function holdMeta(event: AuditEvent): Record<string, unknown> {
  return event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
    ? event.metadata
    : {};
}

function holdTrailActorKey(action: string, meta: Record<string, unknown>): string | null {
  const started = asString(meta.startedBy) ?? asString(meta.started_by);
  const released = asString(meta.releasedBy) ?? asString(meta.released_by);
  const requested = asString(meta.requestedBy) ?? asString(meta.requested_by);
  if (action === "employee.hold.released" || action === "employee.hold.release_refused") {
    return released ?? started;
  }
  if (action === "employee.hold.release_requested") return requested ?? started;
  if (action === "employee.hold.self_approval_denied") {
    return asString(meta.actor) ?? requested ?? started;
  }
  return started;
}

function classifyHoldActorKey(key: string): "human" | "system" | "unknown" {
  if (key === "system:anomaly") return "system";
  if (/^member:.+$/.test(key)) return "human";
  if (/^ops:[A-Za-z0-9._@+-]{1,128}$/.test(key)) return "human";
  return "unknown";
}

function unknownHoldActor(): AuditActorView {
  return { kind: "unknown", name: "不明", emailMasked: null, employeeId: null };
}

function humanHoldActor(
  event: AuditEvent,
  key: string,
  lookups: AuditPresentationLookups
): AuditActorView {
  // Column only — metadata.actorEmail is caller-supplied and must not win.
  const stored = asString(event.actorEmail);
  if (key.startsWith("ops:")) {
    const rest = key.slice(4);
    return {
      kind: "human",
      name: "運営",
      emailMasked: maskEmail(stored) ?? maskEmail(rest),
      employeeId: null,
    };
  }
  if (stored) {
    const person = presentNamedPerson(stored, lookups);
    return {
      kind: "human",
      name: person.name ? sanitizeAuditDisplayText(person.name) || "不明" : "不明",
      emailMasked: person.emailMasked,
      employeeId: null,
    };
  }
  if (key.startsWith("member:")) {
    const member = lookups.membersById?.get(key.slice("member:".length));
    if (member) {
      const person = presentNamedPerson(member.email, lookups);
      return {
        kind: "human",
        name: person.name ? sanitizeAuditDisplayText(person.name) || "不明" : "不明",
        emailMasked: person.emailMasked,
        employeeId: null,
      };
    }
  }
  return { kind: "human", name: "不明", emailMasked: null, employeeId: null };
}

function resolveHoldTrailActor(
  event: AuditEvent,
  lookups: AuditPresentationLookups
): AuditActorView {
  const key = holdTrailActorKey(event.action, holdMeta(event));
  if (!key) return unknownHoldActor();
  const kind = classifyHoldActorKey(key);
  if (kind === "unknown") return unknownHoldActor();
  if (kind === "system") return { kind: "system", name: "システム", emailMasked: null, employeeId: null };
  return humanHoldActor(event, key, lookups);
}

function systemActor(): AuditActorView {
  return { kind: "system", name: "システム", emailMasked: null, employeeId: null };
}

function humanFromEmail(event: AuditEvent, lookups: AuditPresentationLookups): AuditActorView {
  const stored = metaActorEmail(event);
  if (!stored) return { kind: "human", name: "不明", emailMasked: null, employeeId: null };
  const person = presentNamedPerson(stored, lookups);
  return {
    kind: "human",
    name: person.name ? sanitizeAuditDisplayText(person.name) || "不明" : "不明",
    emailMasked: person.emailMasked,
    employeeId: null,
  };
}

function resolveAdminPageActor(
  event: AuditEvent,
  lookups: AuditPresentationLookups
): AuditActorView | null {
  if (!isAuditPageAdminWhoEnabledForOrg(event.orgId)) return null;
  if (!event.action.startsWith("admin.")) return null;
  const meta = holdMeta(event);
  const actorKind = asString(meta.actorKind);
  if (actorKind === "system") return systemActor();
  if (metaActorEmail(event) || actorKind === "human") return humanFromEmail(event, lookups);
  return systemActor();
}

export function resolveAuditActor(
  event: AuditEvent,
  lookups: AuditPresentationLookups = {}
): AuditActorView {
  if (HOLD_TRAIL_ACTIONS.has(event.action)) {
    return resolveHoldTrailActor(event, lookups);
  }

  const adminWho = resolveAdminPageActor(event, lookups);
  if (adminWho) return adminWho;

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
