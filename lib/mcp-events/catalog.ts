/**
 * MCP Events catalog (events/list). Payloads are ids + status only: no title,
 * summary, revision note, approver identity, status token or metadata. The AI
 * reads details with its own badge through staffpass_get_approval_status.
 * Descriptions are schema documentation, not instructions; receipt of an event
 * is not authorization to act (every action still goes through the Gateway).
 */
export const MCP_EVENT_NAMES = ["approval.decided", "approval.expired"] as const;
export type McpEventName = (typeof MCP_EVENT_NAMES)[number];

export const DECIDED_STATUSES = ["approved", "rejected", "revision_requested"] as const;
export const RISKS = ["low", "medium", "high"] as const;
const ID_PATTERN = "^[A-Za-z0-9_.:/-]{1,128}$";
const ID_RE = new RegExp(ID_PATTERN);

export type EventArguments = {
  approvalId?: string;
  jobId?: string;
  risk?: Array<(typeof RISKS)[number]>;
  status?: Array<(typeof DECIDED_STATUSES)[number]>;
};

const idProp = (description: string) => ({ type: "string", pattern: ID_PATTERN, description });
const riskProp = {
  type: "array",
  items: { type: "string", enum: [...RISKS] },
  uniqueItems: true,
  minItems: 1,
  description: "Only approvals with these risk levels. Omit for all (subscriptions that include high are granted a shorter lifetime).",
};
const common = {
  approvalId: { type: "string", description: "Approval id." },
  employeeId: { type: "string", description: "The AI employee (badge holder) the approval belongs to." },
  jobId: { type: ["string", "null"], description: "Correlation jobId given at invoke time, if any." },
  tool: { type: ["string", "null"], description: "Gateway tool id of the approval (e.g. mail.send)." },
  risk: { type: "string", enum: [...RISKS] },
};

export function isMcpEventName(name: unknown): name is McpEventName {
  return typeof name === "string" && (MCP_EVENT_NAMES as readonly string[]).includes(name);
}

export function listEventDefinitions() {
  return [
    {
      name: "approval.decided",
      title: "Approval decided",
      description:
        "A human decided one of this AI employee's approval requests (approved, rejected or revision requested) on any approval channel. " +
        "Carries ids and status only; read the details with staffpass_get_approval_status. When fulfillment is server_completed, Staffpass already performed the approved action.",
      delivery: ["webhook"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          approvalId: idProp("Only this approval (must belong to the subscribing badge)."),
          jobId: idProp("Only approvals created with this jobId."),
          risk: riskProp,
          status: { type: "array", items: { type: "string", enum: [...DECIDED_STATUSES] }, uniqueItems: true, minItems: 1 },
        },
      },
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        required: ["approvalId", "employeeId", "status", "decidedAt", "fulfillment"],
        properties: {
          ...common,
          status: { type: "string", enum: [...DECIDED_STATUSES] },
          decidedAt: { type: ["string", "null"], format: "date-time" },
          fulfillment: {
            type: "string",
            enum: ["server_completed", "server_failed", "not_attempted", "not_applicable"],
            description: "Outcome of Staffpass's own server-side send for approved requests at decision time.",
          },
        },
      },
    },
    {
      name: "approval.expired",
      title: "Approval expired",
      description:
        "One of this AI employee's approval requests was closed without a decision (approval lifetime elapsed or decision deadline passed). " +
        "Carries ids and status only; nothing was sent.",
      delivery: ["webhook"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          approvalId: idProp("Only this approval (must belong to the subscribing badge)."),
          jobId: idProp("Only approvals created with this jobId."),
          risk: riskProp,
        },
      },
      payloadSchema: {
        type: "object",
        additionalProperties: false,
        required: ["approvalId", "employeeId", "status", "reason", "expiredAt"],
        properties: {
          ...common,
          status: { type: "string", enum: ["expired", "rejected"], description: "Approval status after closing (deadline auto-reject reports rejected)." },
          reason: { type: "string", enum: ["ttl_elapsed", "deadline_exceeded", "closed_at_fulfil"] },
          expiredAt: { type: "string", format: "date-time" },
        },
      },
    },
  ];
}

function uniqueEnumArray<T extends string>(v: unknown, allowed: readonly T[]): T[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > allowed.length) return null;
  const out = new Set<T>();
  for (const item of v) {
    if (typeof item !== "string" || !(allowed as readonly string[]).includes(item)) return null;
    out.add(item as T);
  }
  return [...out].sort();
}

/** Strict validation + normalisation (sorted, de-duplicated) so equal filters give equal subscription ids. */
export function validateEventArguments(
  name: McpEventName,
  raw: unknown
): { ok: true; args: EventArguments } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, args: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "arguments must be an object" };
  const rec = raw as Record<string, unknown>;
  const allowed = name === "approval.decided" ? ["approvalId", "jobId", "risk", "status"] : ["approvalId", "jobId", "risk"];
  for (const key of Object.keys(rec)) {
    if (!allowed.includes(key)) return { ok: false, message: `unknown argument: ${key.slice(0, 40)}` };
  }
  const args: EventArguments = {};
  for (const key of ["approvalId", "jobId"] as const) {
    if (rec[key] === undefined) continue;
    if (typeof rec[key] !== "string" || !ID_RE.test(rec[key] as string)) return { ok: false, message: `${key} is invalid` };
    args[key] = rec[key] as string;
  }
  if (rec.risk !== undefined) {
    const risk = uniqueEnumArray(rec.risk, RISKS);
    if (!risk) return { ok: false, message: "risk is invalid" };
    args.risk = risk;
  }
  if (rec.status !== undefined) {
    const status = uniqueEnumArray(rec.status, DECIDED_STATUSES);
    if (!status) return { ok: false, message: "status is invalid" };
    args.status = status;
  }
  return { ok: true, args };
}

export function matchesArguments(
  args: EventArguments,
  data: { approvalId: string; jobId: string | null; risk: string; status: string },
  name: McpEventName
): boolean {
  if (args.approvalId && args.approvalId !== data.approvalId) return false;
  if (args.jobId && args.jobId !== data.jobId) return false;
  if (args.risk && !(args.risk as string[]).includes(data.risk)) return false;
  if (name === "approval.decided" && args.status && !(args.status as string[]).includes(data.status)) return false;
  return true;
}
