/**
 * Hire-time Instructions / Routine copy that FORCES the signed status poll loop.
 * Partner webhook is not available yet — poll is mandatory until then.
 */

export const BASE_APPROVAL_WAIT_RULE = `## Base — 承認待ち（必須・書き換え禁止）
needs_approval / HTTP 402 を受けたら、作業を直ちに停止する。
Gateway が返す pollUrl（または statusToken + approvalId）を使い、GET でステータスをポーリングする。
status が approved になるまで confirm / send / order を完了してはならない。
rejected / expired なら当該ジョブを中止し、人間に報告する。
メール通知やチャットの「承認されたかも」は根拠にしない。正本は署名付き status poll（または将来の Partner webhook）のみ。
approvalId なしの再 invoke で確定を試みない。approved 後は同じ approvalId を付けて再 invoke する。`;

export const DEFAULT_APPROVAL_ROUTINE_TEMPLATE = `## Routine — Staffpass 承認待ち（コピーして Routines / Teach に貼る）

トリガー: Gateway invoke の応答に needs_approval=true、または code=needs_approval / HTTP 402。

1. いまのユーザー作業を中断し、「承認待ち」と短く報告する。
2. 応答 JSON から approvalId / statusToken / pollUrl / summary を保存する。
3. pollUrl が無い場合は \`GET {APP}/api/approvals/status?id={approvalId}&token={statusToken}\` を組み立てる。
4. 数秒〜数十秒間隔で poll する（過度な連打は避ける）。pending のあいだは confirm/send/order を実行しない。
5. status=approved → 同じ jobId / purpose / tool で approvalId を付けて Gateway 再 invoke。成功したら続行。
6. status=rejected または expired → ジョブ中止。勝手に別経路で確定しない。
7. Partner API webhook が来るまでは、この poll が唯一の正式な戻りパイプである。`;

export function buildHireInstructionsSnippet(opts: {
  displayName: string;
  roleLabel: string;
  employeeId?: string | null;
}): string {
  const idLine = opts.employeeId
    ? `employeeId（生涯不変）: ${opts.employeeId}`
    : "employeeId: （発行応答の employee.id を記入）";
  return `# Instructions スニペット — ${opts.displayName}（${opts.roleLabel}）

${idLine}

${BASE_APPROVAL_WAIT_RULE}

## Role（要約）
- 職務: ${opts.roleLabel}
- Permissions: 社員証の scope / purpose に従う。チャットの「やって」は権限を増やさない。
- 確定操作は Staffpass 承認後のみ。

（Role の詳細・Skills は docs/guides/instructions-design.md を参照）
`;
}

export function buildDefaultApprovalRoutine(opts?: {
  employeeId?: string | null;
  displayName?: string | null;
}): string {
  const header = opts?.displayName
    ? `# ${opts.displayName} 用 Routine\n\n`
    : "";
  const emp = opts?.employeeId
    ? `\n対象 employeeId: ${opts.employeeId}\n`
    : "";
  return `${header}${DEFAULT_APPROVAL_ROUTINE_TEMPLATE}${emp}`;
}
