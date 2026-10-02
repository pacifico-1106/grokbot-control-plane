# MCP OAuth 2.1 ロールアウト手順 / Rollout runbook (2026-10-03)

> 状態: コードは PR #205〜（スタック）で **すべてフラグ OFF**。マイグレーションは**ファイルのみ**（未実行）。
> このドキュメントは PR ごとに追記されます。 / All code ships flag-OFF; migrations are files only.

## Q5: パイロット組織 / Pilot org allowlist

本番ドメイン（`https://staffpass.sealith.com`）で、組織の許可リストを使って TOKYO307 だけで始めます。

| Env | ロールアウト時に設定する値 |
|---|---|
| `MCP_OAUTH_ORG_ALLOWLIST` | `92f3617c-33fc-4dac-b9b4-d4f42e8522ac`（TOKYO307 / トーキョーサンマルサンマルナナ株式会社） |

- 値の出典: リポジトリ内の既存運用ドキュメント（`docs/admin-orgs-patch-20260915.md` §8、`docs/runbooks/approval-enforcement-rollout-2026-09-28.md`）。エージェントには本番 DB の読み取り手段が無いため、**設定前に** 次の SQL で確認してください（読み取りのみ）:

  ```sql
  select id, name, created_at from orgs where id = '92f3617c-33fc-4dac-b9b4-d4f42e8522ac';
  ```
- 空にすると**全組織**が対象になります（パイロット中は必ず値を入れる）。
- 許可リストは同意（consent）と、毎リクエストのトークン検証（RS）の両方で判定されます。外せば既存 grant も即座に使えなくなります。

## フラグと環境変数 / Flags & env

| Env | 既定 | 用途 |
|---|---|---|
| `MCP_OAUTH_ENABLED` | OFF | OAuth 全体（.well-known、authorize、consent、token、revoke、`sp_at_` 受け入れ、401 の WWW-Authenticate）。DEMO では常に無効 |
| `MCP_OAUTH_DCR_ENABLED` | OFF | `/api/oauth/register`（DCR）。Q7: 通常は CIMD のみ |
| `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE` | OFF | Q4 の逃げ道: OAuth ON でも `initialize`/`ping`/`notifications/*` だけ未認証で 200 |
| `MCP_OAUTH_CONSENT_REQUIRE_MFA` | OFF | Q2 のフック: ON で同意に aal2（二要素）を要求 |
| `MCP_OAUTH_STATE_SECRET` | — | 同意 CSRF の HMAC 鍵（32 バイト以上。未設定なら同意は 503 で fail-closed） |
| `IP_HASH_KEY` | — | レート制限キー（未設定なら authorize / register は 503） |
| `MCP_OAUTH_ISSUER` | `https://staffpass.sealith.com` | issuer（末尾スラッシュなし） |
| `MCP_UNAUTH_INIT_LOG_ENABLED` | OFF | #210: 未認証 initialize の観測ログ（OAuth ON 前に数日） |

## 同意（consent）の条件 / Who can consent (PR-5)

- 実セッション（Supabase ユーザー + その組織の active メンバー）。**owner へのフォールバックは使わない**。
- role が owner / admin、かつ capability `hire_issue_credentials`（Q1）。
- 最後のログインから 15 分以内（`auth.users.last_sign_in_at`）。過ぎていれば画面の「再ログインする」から。
- 組織が `MCP_OAUTH_ORG_ALLOWLIST` に含まれる。
- 選んだ AI 社員がセッションの組織に属し、active、binding が失効しておらず、有効な社員証がある。
- grant の期限は 90 日、かつ社員証の期限を超えない。code は 60 秒・1 回限り。
- 許可後、組織の owner / admin にメール通知（取り消しリンク付き）。監査: `oauth.consent_granted` / `oauth.consent_denied`。
- OAuth ON の間、ログイン POST は別オリジンからの `Origin` を 403 にします（ログイン CSRF 対策）。

## 実機確認 / Verification accounts (Q9)

八坂さんが ChatGPT Business（Premium シート）と Claude Team のアカウントを用意。PR-6（token）・PR-8（クライアント互換）マージ後、ステージングまたはパイロット組織で確認します。

## ロールアウト順（案）

1. #210 を先にマージし `MCP_UNAUTH_INIT_LOG_ENABLED=true` で 3〜7 日観測（Q4）。
2. マイグレーション `20261003100000_mcp_oauth.sql` を 八坂さんが実行（`/workspace/staffpass-sql/mcp-oauth-20261003/`）。
3. `MCP_OAUTH_STATE_SECRET`、`IP_HASH_KEY`、`MCP_OAUTH_ORG_ALLOWLIST=92f3617c-33fc-4dac-b9b4-d4f42e8522ac` を設定。
4. `MCP_OAUTH_ENABLED=true`。問題があれば即 OFF（挙動は今と完全に同じに戻る）。

## Token / revoke（PR-6）

- `POST /api/oauth/token`: `application/x-www-form-urlencoded` のみ・パラメータ重複は拒否・公開クライアントのみ（`client_secret` は 401）・PKCE S256。
  - code は 60 秒・1 回限り。**再利用を検知したら grant ごと取り消し**（`oauth.code_reuse_detected`、owner/admin に通知）。
  - refresh は毎回ローテーション。回転済みトークンの再利用は 30 秒以内なら `invalid_grant` のみ（通信リトライ対策）、30 秒を超えたら**盗用とみなし grant ごと取り消し**（`oauth.refresh_reuse_detected`、通知）。
  - access 1 時間・refresh 30 日。どちらも grant の期限（≤90 日・≤社員証の期限）を超えない。
  - 監査 `oauth.token_issued` は code 交換時の 1 回だけ（refresh ごとには書かない）。ハッシュ先頭 12 文字のみ。
  - client と IP あたり 60 回/分。応答は `Cache-Control: no-store`。
- `POST /api/oauth/revoke`（RFC 7009）: 常に 200。refresh を取り消すと grant ごと取り消し（`oauth.grant_revoked`）、access はそのトークンだけ。
- cron `/api/cron/oauth-purge`（毎日 03:00 JST、`CRON_SECRET` 必須）: 期限切れの認可リクエスト・code・トークンを削除。フラグ OFF の間は何もしません。

## 接続の管理（PR-7）

- 社員詳細画面「接続中の AI クライアント（OAuth）」: 一覧と個別の取り消し（`hire_issue_credentials` が必要、同じ組織の社員のみ）。API: `GET /api/employees/[id]/oauth-grants`、`DELETE /api/employees/[id]/oauth-grants/[grantId]`。
- 契約終了（terminate）: その社員の OAuth 接続をすべて取り消し（監査 `oauth.grant_revoked` reason=terminate）。RS も停止中の社員を毎回拒否するので二重に止まります。
- 社員証の再発行（Q3）: **既定では OAuth 接続を切りません**。「OAuth 接続（AI クライアント）もすべて取り消す」にチェックしたときだけ取り消します（reason=rotate）。
- ゲートウェイの監査: OAuth 経由の invoke は全監査行の metadata に `authMethod: "oauth"`、`oauthGrantId`、`oauthClientHost` が付きます（社員証 `gb_emp_` 経由は従来どおり）。
- いずれもフラグ OFF の間は何もしません（UI も非表示）。

## クライアント互換（PR-8）/ Client compat

- OAuth ON 時のみ: `tools/list` に `securitySchemes`（oauth2 / `staffpass.employee`）、`staffpass_profile`（読み取り専用）、認証エラー本文に `_meta["mcp/www_authenticate"]`、initialize instructions を OAuth 前提の文言に差し替え、`GET /api/mcp` の `auth.oauth`。OFF 時はバイト同一（テストで固定）。
- Only when ON: securitySchemes, `staffpass_profile`, body-level challenge `_meta`, OAuth-aware instructions, server-card `auth.oauth`. OFF = byte-identical (tests pin this).
- フラグ非依存の堅牢化: `tools/call` の 500 は内部エラー文言を返さず `tool_call_failed` 固定（ログはツール名と例外名のみ）。
- Flag-independent hardening: tools/call 500 no longer echoes `e.message`.
- 実機確認（Q9, 八坂さんの ChatGPT Business / Claude Team）: 接続後に `staffpass_profile` を呼び、org 名が TOKYO307、表示名が対象社員であることを確認。

## 堅牢化（PR-10）/ Hardening

- クライアント単位の緊急停止 / per-client kill switch: `update oauth_clients set status='blocked' where client_id='<url>';`（承認後に実行）。PR-10 から resource server も client status を確認するため、発行済みアクセストークンも即時無効（従来は最大 1 時間有効だった。audit run-1 候補 `rs-blocked-client-token-still-valid`）。
- E2E テスト `app/api/mcp/oauth-e2e.test.ts`、手順書 `docs/runbooks/mcp-oauth-e2e-inspector-20261003.md`。
- 監査 run-1（`~/security-audit-skill/grokbot-control-plane/run-1`）は独立検証エージェントが使えず incomplete。未検証リード: X-Forwarded-For 先頭ホップでのレート制限キー（エッジの XFF 上書き挙動を要確認）。
