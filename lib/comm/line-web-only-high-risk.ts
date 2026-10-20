/**
 * U-07 / LP-HRK-01/02: Web-only high-risk operations extracted from current code.
 * Do not invent tools that are not gated here. Design §7 decision 9 lists
 * 金銭・秘密（資格情報）・ポリシー変更・停止解除; only 停止解除 is actually
 * LINE-blocked today. The others still take LINE postback unless a later PR
 * adds a dedicated gate.
 */
export type LineWebOnlyHighRiskRef = {
  file: string;
  lines: string;
  note: string;
};

export type LineWebOnlyHighRiskItem = {
  id: string;
  category: "停止解除" | "金銭" | "秘密（資格情報）" | "ポリシー変更";
  tool: string;
  reason: string;
  lineCanApprove: false;
  webPath: string;
  refs: readonly LineWebOnlyHighRiskRef[];
};

export const LINE_WEB_ONLY_HIGH_RISK: readonly LineWebOnlyHighRiskItem[] = [
  {
    id: "HRK-HOLD-RELEASE",
    category: "停止解除",
    tool: "employee.hold.release",
    reason: "hold_release_web_only",
    lineCanApprove: false,
    webPath: "/app/approvals （『解除を承認』） / POST /api/holds/release/approve",
    refs: [
      { file: "lib/safety/hold-config.ts", lines: "35", note: "HOLD_RELEASE_SURFACES = [\"web\"]" },
      { file: "lib/safety/hold-config.ts", lines: "45", note: "HOLD_RELEASE_TOOL = \"employee.hold.release\"" },
      { file: "lib/safety/hold-config.ts", lines: "62-66", note: "isHoldReleaseTicket reads adminTool ?? tool" },
      { file: "lib/safety/hold-release-auth.ts", lines: "69", note: "non-web surface → 403 hold_release_web_only" },
      { file: "lib/data/approvals.ts", lines: "486", note: "demo resolveApproval: approved + hold-release → hold_release_web_only" },
      { file: "lib/data/approvals.ts", lines: "521", note: "prod resolveApproval: same refuse" },
      { file: "lib/approvals/workflow-integration.ts", lines: "77-79", note: "LINE / inbox workflow approve refused" },
      { file: "lib/approvals/hold-release-web.ts", lines: "12-13", note: "Web-only Japanese copy" },
    ],
  },
] as const;

export const LINE_WEB_ONLY_HIGH_RISK_NOT_GATED = [
  {
    category: "金銭" as const,
    note: "spend / 金銭の承認は always_human だが、現行コードに LINE 拒否の専用ゲートは無い",
  },
  {
    category: "秘密（資格情報）" as const,
    note: "社員証・秘密の値は画面入力（H5）だが、承認ボタン自体の Web 専用ゲートは無い",
  },
  {
    category: "ポリシー変更" as const,
    note: "config-change / policy は always_human。LINE postback を止める専用判定は無い",
  },
] as const;
