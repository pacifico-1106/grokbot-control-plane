# スパムスイープ運用 Runbook（spam-sample-20261003 フォローアップ）

対象: 公開サインアップ（`POST /api/auth/signup`）経由のボット/スパムテナント。
2026-09-18〜09-26 に 「株式会社サンプル商事」名義の 11 テナントが作成され、2026-10-03 に手動で停止済み（Auth ban + membership disabled）。

## 全体像

| 層 | 内容 | フラグ（既定） |
|---|---|---|
| L1（hotfix PR #203） | Turnstile fail-closed / honeypot / AIC- 紹介コード形式 / 既定社名の削除 / メールの HTML エスケープ | なし（常時有効） |
| L2 | `signup_attempts` ログ、DB レート制限、使い捨て/Gmail 正規化 | `SIGNUP_ATTEMPT_LOG_ENABLED` / `SIGNUP_RATE_LIMIT_ENABLED` / `SIGNUP_DOMAIN_CHECK_ENABLED`（OFF） |
| L3 | `spam.scan`（読み取り専用）、`accounts.suspend/unsuspend/delete`（always_human） | `SPAM_ADMIN_TOOLS_ENABLED`（OFF） |
| L4 | 日次 `/api/cron/spam-sweep`（09:00 JST）: スキャン → レポート保存 → 停止の **承認チケットを提案するだけ** | `SPAM_SWEEP_ENABLED`（OFF） |

**cron は単独で停止・解除・削除を一切しません。** 実行は必ず承認チケット → 指定承認者の承認 → fulfill の経路です。

## 必要な環境変数

| 変数 | 用途 |
|---|---|
| `PLATFORM_OPS_ORG_ID` | 運用 org（TOKYO307 を想定）。spam ツール呼び出し元・提案チケットの置き場。未設定ならツールも提案も fail-closed |
| `SPAM_ACCOUNTS_APPROVER_USER_IDS` | 承認できる Supabase Auth user id（カンマ区切り）。**八坂のみ**を設定。未設定なら fulfill は `approver_not_configured` で何もしない |
| `SPAM_PROTECTED_ORG_IDS` | 対象外にする org id（カンマ区切り）。運用 org は自動で保護 |
| `SUPER_ADMIN_USER_IDS` | ここに含まれるユーザーが所属する org は対象外 |
| `CRON_SECRET` | 既存 cron と同じ Bearer |

## マイグレーション（手動適用・順序厳守）

1. `supabase/migrations/20261003000000_signup_attempts.sql`
2. `supabase/migrations/20261003000100_spam_sweep.sql`

どちらも冪等（`if not exists` / `create or replace`）。RLS 有効・anon/authenticated から revoke 済み。関数は service_role のみ実行可。

適用後、2026-10-03 の手動停止 11 件を台帳に記録する（7 日ルールの起点にするため）: `/workspace/staffpass-sql/spam-sweep-20261003/30_backfill_step1_ledger.sql`（本番 org id を含むためリポジトリには入れない）。

## 有効化の順番（推奨）

1. マイグレーション適用 → backfill
2. `SIGNUP_ATTEMPT_LOG_ENABLED=true`（記録のみ。数日観察）
3. `SIGNUP_RATE_LIMIT_ENABLED=true`、`SIGNUP_DOMAIN_CHECK_ENABLED=true`
4. `PLATFORM_OPS_ORG_ID` / `SPAM_ACCOUNTS_APPROVER_USER_IDS` を設定 → `SPAM_ADMIN_TOOLS_ENABLED=true`
5. `spam.scan` を手動で数回実行し誤検知がないことを確認 → `SPAM_SWEEP_ENABLED=true`

無効化は各フラグを OFF にするだけ（再デプロイ不要な環境変数運用の場合は Vercel の env 更新 + 再デプロイ）。

## スコア（lib/spam/score.ts）

| シグナル | 点 |
|---|---|
| 既定社名（株式会社サンプル商事 / 新しい組織） | +40 |
| 紹介コードあり かつ `AIC-` 形式でない | +40（12文字以上の大文字のみなら +10） |
| Gmail ドットトリック / 不正なドット | +10 |
| 使い捨てドメイン | +30 |
| 作成後一度も再ログインなし（24h 経過） | +5 |
| AI社員0・Stripe なし・メンバー1以下 | +5 |
| 同名 org が ±24h に 3 件以上 | +10 |
| 同一 IP ハッシュから 7 日で 3 件以上 | +15 |
| Stripe 顧客/サブスクあり | −100 |
| AI社員あり | −50 |

70 以上 = 候補、40〜69 = 監視。保護 org は常に 0。

## 手動オペレーション（Admin MCP）

1. `spam.scan { days: 30 }` — 読み取り専用。メールは `ab***c@domain` 形式でマスク。
2. `accounts.suspend { orgIds, reason }` — 既定は dryRun。`plan.orgs[].blockers` を確認。1件でもブロックがあれば実行不可（全か無か）。
3. `accounts.suspend { orgIds, reason, dryRun: false, previewHash }` — always_human チケット作成（この時点では何も変わらない）。
4. 八坂がダッシュボード（運用 org）で承認 → fulfill 時に再チェック:
   - フラグ ON、承認者が `SPAM_ACCOUNTS_APPROVER_USER_IDS` の Auth ユーザー（運用 org の active メンバー、Auth メール確認済みかつ一致、BAN されていない）
   - Slack / Telegram / LINE からの承認は**一致しない**（fail-closed）
   - 再計算した plan の previewHash が承認時と一致（状態が変わっていたら `plan_changed_since_approval` で中止）
5. 実行順: suspend = Auth ban（876000h）→ membership disabled。unsuspend = unban → active。delete = org 削除（cascade）→ Auth ユーザー削除。
6. 台帳 `spam_account_actions` と `audit_events`（対象 org + 運用 org）に記録。

### 削除（不可逆）の条件

- 台帳の最新アクションが `suspend` で、**7 日以上経過**
- その後 `unsuspend` されていない
- 全ユーザーが BAN 中、全メンバーシップが disabled
- Stripe なし / AI社員なし / 他 org 所属なし / 保護 org でない

承認ステップ後に org 削除が FK（`approval_*` / `decision_*` 系の非 cascade 参照）で失敗した場合はエラーで停止し、台帳には書かれない。手で原因を確認する。

## 解除（誤検知時）

`accounts.unsuspend` を同じ手順で（dryRun → previewHash → 八坂承認）。緊急時の手動ロールバック SQL/スクリプト: `/workspace/staffpass-sql/spam-sample-20261003/19_stage1_rollback*.{sql,sh}`。

## プランレール

spam ツールは `orgs.create` と同様に運用専用で、`PLAN_ADMIN_SCOPES` には含めていない。`PLAN_RAILS_ENABLED` が ON で運用 org にプランが付いている場合は拒否されるため、運用 org は planKey なしで運用する。

## 既知の制約 / 要確認

- 承認者の特定は `approval.resolvedBy`（解決したメンバーのプロフィールメール）→ 運用 org メンバー → Auth ユーザーで行う。プロフィールメールは編集可能なので Auth 側の確認済みメール一致を必須にしている。将来的には承認 API で resolver の user id を approval に保存するのが望ましい。
- `signup_attempts` の保持期間: cron が `purge_signup_attempts(90)` を呼ぶ（`SIGNUP_ATTEMPT_LOG_ENABLED` ON 時のみ）。
