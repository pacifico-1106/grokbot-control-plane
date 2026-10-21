/**
 * U-07 / LP-HRK: Web-only high-risk operations until passkeys.
 * LINE postback refuses these and tells the approver to use /app/approvals.
 * Unclassifiable tickets are refused (fail-closed).
 */
import { isAdminClassApproval } from "@/lib/admin-mcp/audit-class";
import { isLineWebOnlyHighRiskEnabled } from "@/lib/comm/flags";
import { isHoldReleaseTicket } from "@/lib/safety/hold-config";

export type LineWebOnlyHighRiskRef = {
  file: string;
  lines: string;
  note: string;
};

export type LineWebOnlyHighRiskCategory =
  | "停止解除"
  | "金銭"
  | "秘密（資格情報）"
  | "ポリシー変更"
  | "always_human";

export type LineWebOnlyHighRiskItem = {
  id: string;
  category: LineWebOnlyHighRiskCategory;
  tool: string;
  reason: string;
  lineCanApprove: false;
  webPath: string;
  refs: readonly LineWebOnlyHighRiskRef[];
};

const WEB = "/app/approvals";

export const LINE_WEB_ONLY_HIGH_RISK: readonly LineWebOnlyHighRiskItem[] = [
  {
    id: "HRK-HOLD-RELEASE",
    category: "停止解除",
    tool: "employee.hold.release",
    reason: "hold_release_web_only",
    lineCanApprove: false,
    webPath: `${WEB} （『解除を承認』） / POST /api/holds/release/approve`,
    refs: [
      { file: "lib/safety/hold-config.ts", lines: "35", note: "HOLD_RELEASE_SURFACES = [\"web\"]" },
      { file: "lib/safety/hold-config.ts", lines: "45", note: "HOLD_RELEASE_TOOL = \"employee.hold.release\"" },
      { file: "lib/approvals/workflow-integration.ts", lines: "75-80", note: "LINE / inbox workflow approve refused" },
    ],
  },
  {
    id: "HRK-MONEY",
    category: "金銭",
    tool: "commerce.order",
    reason: "line_web_only_money",
    lineCanApprove: false,
    webPath: WEB,
    refs: [{ file: "lib/comm/line-web-only-high-risk.ts", lines: "verdict", note: "commerce.* refused on LINE" }],
  },
  {
    id: "HRK-SECRET",
    category: "秘密（資格情報）",
    tool: "employees.credential.reissue",
    reason: "line_web_only_secret",
    lineCanApprove: false,
    webPath: WEB,
    refs: [{ file: "lib/comm/line-web-only-high-risk.ts", lines: "verdict", note: "credential / secret tools" }],
  },
  {
    id: "HRK-POLICY",
    category: "ポリシー変更",
    tool: "policy.patch",
    reason: "line_web_only_policy",
    lineCanApprove: false,
    webPath: WEB,
    refs: [{ file: "lib/comm/line-web-only-high-risk.ts", lines: "verdict", note: "policy / config-change tools" }],
  },
  {
    id: "HRK-ALWAYS-HUMAN",
    category: "always_human",
    tool: "*",
    reason: "line_web_only_always_human",
    lineCanApprove: false,
    webPath: WEB,
    refs: [{ file: "lib/comm/line-web-only-high-risk.ts", lines: "verdict", note: "metadata.approvalPolicy / toolHint always_human" }],
  },
] as const;

export const LINE_WEB_ONLY_HIGH_RISK_NOT_GATED = [] as const;

/** LINE postback may approve only these, and only with a classifiable policy. */
export const LINE_SURFACE_ALLOW_TOOLS = new Set([
  "comm.reply",
  "comm.send",
  "slack.post",
  "mail.send",
  "browser.use",
]);

const CLASSIFIABLE_POLICY = new Set(["risk_based", "auto", "needs_approval"]);
const MONEY_TOOLS = new Set(["commerce.order", "commerce.quote"]);
const SECRET_RE = /credential|secret/i;
const POLICY_RE = /policy|config_change|approvalWorkflow|approvalRoutes|ingressHandoff|mailPolicy|replyPolicy|schedulingPolicy|internalAudience/i;

export function approvalTicketPolicyMetadata(input: {
  tool?: string | null;
  purpose?: string | null;
  employeeApprovalPolicy?: string | null;
  toolHint?: string | null;
  metadata?: Record<string, unknown> | null;
}): {
  approvalPolicy: string | null;
  employeeAlwaysHuman: boolean;
  approvalClass: "admin" | "business";
  always_human: boolean;
} {
  const md = input.metadata ?? {};
  const employeeAlwaysHuman = input.employeeApprovalPolicy === "always_human" || md.employeeAlwaysHuman === true;
  const policyFromMeta = typeof md.approvalPolicy === "string" && md.approvalPolicy.trim() ? md.approvalPolicy.trim() : null;
  const approvalPolicy =
    employeeAlwaysHuman || input.toolHint === "always_human" || md.always_human === true
      ? "always_human"
      : policyFromMeta ||
        (input.employeeApprovalPolicy && input.employeeApprovalPolicy.trim()) ||
        (input.toolHint === "auto" || input.toolHint === "risk_based" ? input.toolHint : null);
  const alwaysHuman = approvalPolicy === "always_human" || md.always_human === true;
  const { approvalClass: _ignoredClass, ...safeMd } = md;
  void _ignoredClass;
  const approvalClass = isAdminClassApproval({ tool: input.tool, purpose: input.purpose, metadata: safeMd })
    ? "admin"
    : "business";
  return { approvalPolicy, employeeAlwaysHuman, approvalClass, always_human: alwaysHuman };
}

/** L4: the 4 policy keys are written only when the high-risk flag is ON. */
export function approvalTicketPolicyStamp(
  orgId: string | null | undefined,
  input: Parameters<typeof approvalTicketPolicyMetadata>[0]
): {
  approvalPolicy?: string | null;
  employeeAlwaysHuman?: boolean;
  approvalClass?: "admin" | "business";
  always_human?: boolean;
} {
  if (!isLineWebOnlyHighRiskEnabled(orgId)) return {};
  return approvalTicketPolicyMetadata(input);
}

export type LineWebOnlyHighRiskVerdict = {
  refuse: boolean;
  reason: string;
  category: LineWebOnlyHighRiskCategory | "unknown" | "";
};

export function lineWebOnlyHighRiskVerdict(approval: {
  tool?: string | null;
  metadata?: Record<string, unknown> | null;
} | null | undefined): LineWebOnlyHighRiskVerdict {
  if (!approval) return { refuse: true, reason: "line_web_only_unclassified", category: "unknown" };
  if (isHoldReleaseTicket(approval)) {
    return { refuse: true, reason: "hold_release_web_only", category: "停止解除" };
  }
  const md = approval.metadata ?? {};
  const tool = String(md.adminTool ?? approval.tool ?? "").trim();
  if (
    md.always_human === true ||
    md.approvalPolicy === "always_human" ||
    md.toolHint === "always_human" ||
    md.employeeAlwaysHuman === true
  ) {
    return { refuse: true, reason: "line_web_only_always_human", category: "always_human" };
  }
  if (md.approvalClass === "admin" || md.auditClass === "admin") {
    return { refuse: true, reason: "line_web_only_admin", category: "ポリシー変更" };
  }
  if (!tool) return { refuse: true, reason: "line_web_only_unclassified", category: "unknown" };
  if (MONEY_TOOLS.has(tool) || tool.startsWith("commerce.")) {
    return { refuse: true, reason: "line_web_only_money", category: "金銭" };
  }
  if (SECRET_RE.test(tool)) {
    return { refuse: true, reason: "line_web_only_secret", category: "秘密（資格情報）" };
  }
  if (POLICY_RE.test(tool) || tool.includes("policy")) {
    return { refuse: true, reason: "line_web_only_policy", category: "ポリシー変更" };
  }
  if (!LINE_SURFACE_ALLOW_TOOLS.has(tool)) {
    return { refuse: true, reason: "line_web_only_default_deny", category: "unknown" };
  }
  const policy = typeof md.approvalPolicy === "string" ? md.approvalPolicy : "";
  if (!CLASSIFIABLE_POLICY.has(policy)) {
    return { refuse: true, reason: "line_web_only_unclassified", category: "unknown" };
  }
  return { refuse: false, reason: "", category: "" };
}

export function isLineSurfaceApproval(input: {
  resolvedBy?: string | null;
  externalVoter?: { provider?: string } | null;
}): boolean {
  if ((input.externalVoter?.provider || "").toLowerCase() === "line") return true;
  return String(input.resolvedBy || "").startsWith("line:");
}
