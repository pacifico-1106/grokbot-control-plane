# config.change_request — AI社員の自己設定変更を承認制にする（2026-10-03）

Flag: `P1_CONFIG_CHANGE_REQUEST_ENABLED`（コード既定 OFF。`1` / `true` で ON）

## 1. 調査結果（承認なしで変更できる経路）

| 経路 | 現状 | 判定 |
| --- | --- | --- |
| Admin MCP（`gb_adm_`）`channels.classify` / `parties.upsert` / `policy.patch` / `replyPolicy.patch` / `mailPolicy.patch` / `schedulingPolicy.patch` / `ingressHandoff.patch` / `internalAudienceRule.patch` など | すでに全変更系が `queueAdminTool` → always_human の admin-class チケット。反映は承認後の `fulfill-admin.ts` のみ | 承認済み。ただし通知は org 既定 inbox、要約は差分なし（「チャネル分類を人が確認します（C123）」）、却下時の依頼者通知なし |
| AI 側 Instructions / プロンプト / ポリシー文 | Control plane に保存されていない。Grok Bot 側で AI が自分で書き換え可能 | **未承認で変更可能（Staffpass からは止められない）** |
| `voice`（`PATCH /api/employees/[id]/policy`） | ダッシュボード（人のセッション）専用 | 人の UI。対象外（非ゲート） |
| `opsDocLocation`（`/api/admin-mcp/ops-doc`） | 人のセッション専用 | 対象外 |
| チャネル台帳（ダッシュボード `/api/settings/directory`） | `directory_admin_mcp_required` でロック済み | 変更不可 |
| 自動書き込み `lib/gateway/audience.ts` | ext_shared 検出で shared_external に強制（安全側のみ） | 問題なし |
| 自動書き込み `lib/stuck-watch/audience-ledger.ts` | 人が承認した party 台帳が internal の時だけ internal | 問題なし |
| Gateway `calendar.allowlist.patch` | 事前承認必須 | 問題なし |
| 社員証（`gb_emp_`）MCP / Gateway | 設定を変えるツールなし | 問題なし |

結論: 実際に穴があるのは「AI が Grok 側で自分の Instructions/ポリシー文やチャネル扱いを書き換える」部分。
これを塞ぐため、Staffpass 側に**承認制の変更経路**を用意し、承認済みの内容だけを正本として配る。

## 2. 何をゲートしたか（flag ON 時）

1. **新ツール `staffpass_config_change_request`**（社員 MCP、flag ON の時だけ tools/list に出る）
   - `kind=instructions`（`mode=replace|append`、≤8000 文字）
   - `kind=channel_classification`（internal / shared_external / unknown、mixed）
   - `kind=channel_remove`
   - 呼ばれても**何も反映しない**。承認チケット（business class、tool=`config.change_request`、risk high）を作り、
     既存の承認インボックス経路で承認者へ通知する:
     責任者 Slack DM（`P0_INBOX_ROUTING_ENABLED` 時）→ 社員/組織の承認チャネル（Slack / Telegram / LINE）→ pilot Telegram。
   - 文面: `〇〇さんから次の変更依頼が来ています: <差分要約>。反映しますか？` + 対象 AI 社員 + 理由。
2. **承認者が解決できない → 受け付けない（fail-closed）**。`no_approver_resolvable`、監査 `config.change_refused`、チケットも作らない。
3. **承認 → 提案どおりだけ反映**（`executeApproval` の一回限りクレーム）。監査 `config.change_applied`。
   - Instructions: 承認済み Instructions（overlay）を更新。依頼時のベース hash と一致しない場合は `stale_base` で反映しない。
   - チャネル: 管理 MCP と同じ `applyChannelClassification` を使用（Connect/混在→internal は拒否）。削除は台帳から削除＋IM ルート削除。
   - 反映時にも flag を再確認（OFF なら `feature_disabled` で反映しない）。
4. **却下 / 差し戻し → 反映しない**。監査 `config.change_rejected`（applied:false）、依頼者向け丁寧文 `requesterNoticeJa` を
   status poll とコールバックに含める。AI は gateway の `comm.reply` で同じスレッドに伝える（audience gate を迂回しないため Staffpass から直接 Slack 投稿はしない）。
5. **ブロック継続**: 承認者・権限（scope/承認ポリシー/上限）・請求/プラン・認証情報などは `blocked_setting`（監査あり）。
6. **staffpass_whoami** が `approvedInstructions`（承認済みの正本）と `configChangeRuleJa` を返す。MCP `initialize` の instructions と雇用時スニペットにもルールを追記（flag ON の時だけ）。
7. 管理 MCP `channels.classify` のキュー要約に before→after 差分を表示（flag ON の時だけ）。従来どおり always_human。

**非ゲート（変更なし）**: 人の管理画面/ダッシュボード編集、管理 MCP の既存 always_human フロー、自動の安全側書き込み。

## 3. マイグレーション

**不要。** 承認済み Instructions は既存 `approval_requests`（tool=`config.change_request`、`metadata.configChangeApplied`）を台帳として読む。
監査 action は自由文字列（DB 制約なし）。

## 4. ロールアウト / ロールバック

- ロールアウト: Vercel production に `P1_CONFIG_CHANGE_REQUEST_ENABLED=1` を設定 → 再デプロイ。
  Slack DM を主経路にするには `P0_INBOX_ROUTING_ENABLED` が ON で、承認者の Slack 連携（identity binding）が active であること。
  AI 社員側は MCP の tools/list 再取得（`listChanged`）で新ツールを認識。既存社員の Instructions には雇用時スニペットのルール節を追記推奨。
- ロールバック: `P1_CONFIG_CHANGE_REQUEST_ENABLED` を外して再デプロイ。ツールは非表示、保留中チケットは承認されても反映されない（`feature_disabled`）。

## 5. 制約・既知の限界

- Grok 側の自己編集そのものは Staffpass から技術的に禁止できない。ツール説明・whoami ルール・スニペットで誘導し、承認済み内容を whoami で正本として配る。
- 同一社員の Instructions 変更が並行して承認された場合、後から承認された方は `stale_base` で反映されない（再依頼が必要）。
- 承認種別マップ上 `config.change_request` は「その他」扱い（approval-kind-routes を使う組織はそのルートに従う）。
- 設定変更はプラン能力ではないため、反映時のプラン再チェックは行わない（社員の active / 同一 org は確認）。
