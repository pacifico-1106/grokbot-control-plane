# AI社員パック 導入セットアップ プレイブック

**更新:** 2026-09-18  
**正本:** AI社員パック商用ファネル + 運用分担  
**関連:** [`tenant-slack-kickoff-rail.md`](./tenant-slack-kickoff-rail.md) · [`p0-ai-employee-ops-backlog-20260915.md`](./p0-ai-employee-ops-backlog-20260915.md) · [`staffpass-slack-bot-install.md`](./staffpass-slack-bot-install.md)

---

## 1. プラン構成（プロダクトロック）

### 月額プラン（税抜・1名あたり）

| プランID | 表示名 | 月額 | 対象 |
|---------|--------|------|------|
| `intern` | インターン | ¥50,000 | 定型・一般業務（日報、議事録、定型返信） |
| `proper` | プロパー | ¥150,000 | 営業・事務リード（顧客対応、見積作成、スケジュール調整） |
| `executive` | エグゼクティブ | ¥300,000 | 経営補佐・高度運用（経営分析、判断支援、複合タスク） |
| `custom` | カスタマイズ | 個別見積 | 特殊要件・大規模導入 |

**年払い**: 月額の10%オフ

### 初期費用（セットアップ・研修費）

| プラン | 初期費用（税抜） |
|--------|-----------------|
| インターン / プロパー | ¥150,000 |
| エグゼクティブ | ¥300,000 |
| カスタマイズ | 個別見積 |

### パックに含まれるもの

- **社員証（Staffpass）**: 権限・承認フロー・監査記録
- **手足（Cursor / Grok Bot）**: AI実行環境
- **承認チャネル**: メール / LINE / Slack

**実費（顧客負担）**:
- Google Workspace アカウント費用（AI社員用メール席）
- Slack ワークスペース席（Bot / 社員席）

---

## 2. ファネル分岐（相談 vs 即決）

### パス A: 相談ファネル（`/lp/ai-employee/consult`）

```
LP「相談する」→ フォーム送信 → 安藤へ通知メール → ヒアリング → 見積/契約 → 支払い → セットアップ
```

- **対象**: 要件不明確、カスタマイズ希望、大規模導入
- **初回接点**: 安藤が1営業日以内にメールで連絡
- **契約**: ヒアリング後に見積書 → 契約締結 → 初期費用支払い

### パス B: 即決ファネル（`/lp/ai-employee/checkout`）

```
LP「初期費用を払って申し込む」→ Stripe Checkout（初期費用）→ 支払い完了 → 安藤へ通知 → セットアップ開始
```

- **対象**: プラン確定済み、すぐに始めたい
- **支払い**: Stripe Checkout（クレジットカード / 銀行振込）
- **開始**: 支払い確認後、安藤から翌営業日以内にセットアップガイドをメール

**注意**: Stripe Checkout は初期費用（一時金）のみ。月額サブスクは別途契約で開始。

---

## 3. セットアップチェックリスト（支払い完了後）

### 分担: 安藤 vs スタッフ（人間）

| # | ステップ | 安藤 | スタッフ | 備考 |
|---|----------|:----:|:--------:|------|
| 1 | Staffpass 組織作成 | ✓ | | `orgs` 行作成 |
| 2 | 契約情報を Staffpass に記録 | ✓ | | プラン・請求期間・Stripe session id |
| 3 | Google Workspace 管理者同意 + 席付与 | | ✓ | AI社員用メールアドレス発行 |
| 4 | **Slack WS Bot Install** | | ✓ | **Authorize より先に実施**（順序重要） |
| 5 | Bot Token スコープ確認（`files:write` 含む） | | ✓ | 不足時は再インストール |
| 6 | Bot Token を Staffpass に登録 | ✓* | ✓ | ダッシュボード or Admin MCP |
| 7 | AI社員証発行（`employees.issue`） | ✓ | | hire は `always_human` |
| 8 | Gmail / Calendar OAuth 連携 | | ✓ | 社員側でブラウザ操作 |
| 9 | **Slack Employee Authorize**（必要時） | | ✓ | Path B / `posting_as: user` 用 |
| 10 | チャネル分類 + IM route 設定 | ✓ | | `channels.classify` + `employeeId` |
| 11 | role / policy 初期提案 | ✓ | | プラン上限に収める |
| 12 | 承認チャネル設定（メール / LINE / Slack） | ✓ | ✓ | 社長・管理者の通知先 |
| 13 | テスト投稿（Slack / メール） | | ✓ | 本番相当の確認 |
| 14 | 日程調整テスト（カレンダー連携） | | ✓ | scheduling.policy 動作確認 |
| 15 | 接続性チェック | ✓ | | `setup.slackStatus` 等 |
| 16 | 運用開始の連絡 | ✓ | | 完了メール送信 |

**凡例**: ✓ = 主担当、✓* = 管理MCPで実施可（人間承認必要）

### 順序重要: WS Bot Install → Employee Authorize

**正しい順序**:
1. Slack ワークスペース管理者が **Bot Install**（`/api/slack/bot-install/start`）
2. Bot Token (`xoxb-`) を Staffpass に登録
3. 必要に応じて社員が **Authorize**（`/api/slack/oauth/start`）で User Token (`xoxp-`) 取得

**よくある間違い**:
- Bot Install せずに Authorize だけ行う → Bot Token がないため `posting_as: bot` が機能しない
- Install と Authorize を混同 → チェックリストで明示的に分ける

詳細: [`staffpass-slack-bot-install.md`](./staffpass-slack-bot-install.md)

---

## 4. 既知の摩擦点（Miraishachu / Space Tree 事例）

### 4-1. Install と Authorize の混同

**症状**: 「Slack 連携したのに Bot が動かない」
**原因**: Employee Authorize（User Token）だけ行い、Bot Install を忘れている
**対処**:
1. `setup.slackStatus` で `botTokenPresent` を確認
2. `false` なら「WS にインストール」を案内
3. Bot Install → Bot Token 登録 → 再テスト

### 4-2. files:write スコープ不足

**症状**: ファイル添付が失敗する、`missing_scope` エラー
**原因**: Bot Token に `files:write` がない（旧インストール）
**対処**:
1. Slack API → OAuth & Permissions → Bot Token Scopes に `files:write` 追加
2. **Reinstall to Workspace** を実行（スコープ追加だけでは反映されない）
3. 新しい `xoxb-` を Staffpass に再登録

### 4-3. チャネル分類の IM route 未設定

**症状**: DM でメンションなしでも AI社員が起きるはずが起きない
**原因**: `channels.classify` で `employeeId` を指定していない
**対処**:
1. `channels.classify` を `employeeId` 付きで実行
2. 管理MCP で確認: `setup.slackStatus` → `imRoutesCount`

### 4-4. 接続先ワークスペースの誤り（Connect ≠ ホーム WS）

**症状**: Connect チャネルでメンションしても反応しない
**原因**: Bot を相手方 WS にインストールしようとしている（不可）
**対処**:
1. Bot は **自社ホスト WS** にのみインストール
2. Connect チャネルでは **個人メンション**（`@username`）で wake
3. `posting_as: user` で社員名義返信

### 4-5. Path B の User Token Scopes 不足

**症状**: 人↔人 DM でファイル添付できない
**原因**: User Token に `files:write` がない
**対処**:
1. Slack API → User Token Scopes に `im:history`, `files:write` 追加
2. 社員が Slack 再 OAuth（ダッシュボード → 社員証 → Slack 連携）
3. 新しい `xoxp-` で Path B ファイルアップロード可能に

---

## 5. ハンドオフテンプレート（安藤 → スタッフ）

```
【AI社員パック セットアップ依頼】

■ 会社情報
会社名: ○○株式会社
担当者: 山田 太郎
メール: yamada@example.com
電話: 03-XXXX-XXXX

■ 契約情報
プラン: インターン / プロパー / エグゼクティブ / カスタマイズ
請求期間: 月払い / 年払い
AI社員数: ○名
Stripe Session ID: cs_live_XXXX（即決の場合）
Staffpass Org ID: org_XXXX

■ 完了済みステップ
[x] Staffpass 組織作成
[x] 契約情報記録
[ ] Google Workspace 席付与
[ ] Slack WS Bot Install
...

■ スタッフ対応依頼
1. Google Workspace で AI社員用メール (ai-employee@example.com) を発行
2. Slack WS に Staffpass Bot をインストール
3. Bot Token を確認して Staffpass に登録

■ 備考・特記事項
- 既存の Google Workspace を利用
- Slack Connect で外部チャネルあり（Path B 設定必要）
```

---

## 6. 環境構築完了の定義（Definition of Done）

### 最小完了条件

- [ ] Staffpass に組織 (`orgs`) が存在する
- [ ] 契約プラン・請求情報が Staffpass に記録されている
- [ ] AI社員証が発行されている（`employees` 行、`active` ステータス）
- [ ] 手足（Grok Bot / Cursor）がリンクされている（`binding` 有効）
- [ ] 承認チャネルが設定され、テスト承認が成功している

### Slack 連携完了条件（Slack 利用時）

- [ ] Bot Token (`xoxb-`) が Staffpass に登録されている
- [ ] `setup.slackStatus.botTokenPresent` = `true`
- [ ] `setup.slackStatus.botHasFilesWrite` = `true`（ファイル添付を使う場合）
- [ ] `setup.slackStatus.adapterEnabled` = `true`
- [ ] テスト投稿が Bot 名義で成功している

### Gmail / Calendar 連携完了条件（メール利用時）

- [ ] AI社員用 Gmail アカウントが OAuth 連携されている
- [ ] テストメール送信（下書き → 承認 → 送信）が成功している
- [ ] カレンダー連携がある場合、テスト日程調整が成功している

### 完了連絡

上記チェックが全て完了したら、安藤から顧客へ「環境構築完了」メールを送信:

```
件名: 【Staffpass】AI社員 環境構築が完了しました

○○株式会社
山田様

お待たせしました。AI社員の環境構築が完了しました。

■ ダッシュボードURL
https://staffpass.sealith.com/app

■ 発行されたAI社員
- 社員名: 秘書アシスタント
- 社員ID: emp_XXXX

■ 次のステップ
1. ダッシュボードにログイン
2. 「社員一覧」からAI社員を確認
3. テストタスクを依頼して動作確認

ご不明点があればお気軽にご連絡ください。

安藤
tando@tokyo307inc.com
```

---

## 7. Stripe 環境変数（Kimura 設定用）

AI社員パック初期費用の Stripe Price ID:

| 環境変数 | 用途 | Price 設定 |
|----------|------|------------|
| `STRIPE_PRICE_ID_AI_EMP_SETUP_INTERN` | インターン 初期費用 | one-time ¥150,000 |
| `STRIPE_PRICE_ID_AI_EMP_SETUP_PROPER` | プロパー 初期費用 | one-time ¥150,000 |
| `STRIPE_PRICE_ID_AI_EMP_SETUP_EXECUTIVE` | エグゼクティブ 初期費用 | one-time ¥300,000 |

**Stripe Dashboard 作業**:
1. Product 作成: `AI社員パック 初期費用（インターン）`
2. Price 作成: one-time ¥150,000 JPY → `STRIPE_PRICE_ID_AI_EMP_SETUP_INTERN`
3. Product 作成: `AI社員パック 初期費用（プロパー）`
4. Price 作成: one-time ¥150,000 JPY → `STRIPE_PRICE_ID_AI_EMP_SETUP_PROPER`
5. Product 作成: `AI社員パック 初期費用（エグゼクティブ）`
6. Price 作成: one-time ¥300,000 JPY → `STRIPE_PRICE_ID_AI_EMP_SETUP_EXECUTIVE`

**Checkout metadata**:
- `plan`: `intern` | `proper` | `executive`
- `setupYen`: `150000` | `300000`
- `source`: `lp-ai-employee`

**Webhook TODO**:
- `checkout.session.completed` で支払い完了時に安藤へ通知メール
- 将来: 自動で Staffpass org 作成 → 現時点は手動

---

## 8. 契約台帳

| システム | 役割 | 記録内容 |
|----------|------|----------|
| **Staffpass** | 契約台帳（正本） | 組織・社員・プラン・請求期間・連絡先 |
| **Stripe** | 支払い事実のみ | Customer ID・Session ID・支払い状況 |

**Staffpass orgs テーブル追加フィールド案（将来）**:
- `ai_emp_pack_plan`: `intern` | `proper` | `executive` | `custom`
- `ai_emp_pack_billing_period`: `monthly` | `annual`
- `ai_emp_pack_started_at`: ISO timestamp
- `ai_emp_pack_headcount`: number

---

## 9. Out of Scope（次の PR / 将来）

- [ ] 月額サブスク自動開始（Checkout → subscription 自動作成）
- [ ] Webhook で自動 org 作成
- [ ] Staffpass hire 完全自動化
- [ ] LINE 公式アカウント連携（承認チャネル拡張）
- [ ] カスタムプランの自動見積

---

## 変更履歴

| 日付 | 決定 | 内容 |
|------|------|------|
| 2026-09-18 | Kimura | AI社員パック商用ファネル v1 作成 |
