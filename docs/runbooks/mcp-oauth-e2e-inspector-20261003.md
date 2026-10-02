# MCP OAuth E2E 計画 & MCP Inspector 手順 / E2E plan & MCP Inspector runbook (2026-10-03)

対象 PR: #205–#208, #214–#218, PR-10。すべて draft・フラグ既定 OFF。**本番 env の変更・マイグレーション実行は別途承認が必要**（この文書は手順のみ）。
Scope: the MCP OAuth stack. All flags default OFF. Changing prod env or running migrations needs separate approval; this doc is procedure only.

## 0. 自動テスト（CI / ローカル）/ Automated

| 層 / Layer | ファイル / File | 内容 / Covers |
|---|---|---|
| E2E（ルートハンドラ連結）| `app/api/mcp/oauth-e2e.test.ts` | authorize → consent → token → `/api/mcp`（tools/list, staffpass_profile）、modern 2026-07-28、refresh ローテーション + 再利用検知（30 秒猶予後に grant 失効）、code 再利用、revoke、PKCE/redirect/resource 不一致、cross-site consent、他 org 社員、admin MCP 拒否、フラグ OFF で全 404、資格情報ライフサイクル |
| 単体 | `lib/mcp-oauth/__tests__/*` | CIMD/SSRF、redirect policy、authorize、consent、token、resource server |
| ルート | `app/api/mcp/*.test.ts`, `app/api/employees/[id]/oauth-grants/route.test.ts` | 401 challenge、client compat、modern era、grant 管理 |

`node scripts/test-local.mjs`（ネットワーク遮断 preload）。期待: 既知の 2 件以外は全 pass。

## 1. プレビュー環境での確認（承認後のみ）/ Preview verification (only after approval)

前提 / Preconditions（すべてプレビュー / preview only）:
1. マイグレーション `supabase/migrations/*mcp_oauth*` をプレビュー DB に適用（承認後）。
2. env（プレビューのみ）: `MCP_OAUTH_ENABLED=1`, `MCP_OAUTH_ORG_ALLOWLIST=92f3617c-33fc-4dac-b9b4-d4f42e8522ac`（TOKYO307、要 SQL 確認: rollout runbook 参照）, `MCP_OAUTH_STATE_SECRET`（32+ 文字、新規生成）, `IP_HASH_KEY`（16+ 文字）, 必要なら `MCP_OAUTH_ISSUER=<preview origin>`。
3. 任意: `MCP_PROTOCOL_NEGOTIATION_ENABLED=1`, `MCP_PROTOCOL_MODERN_ENABLED=1`（PR-9 確認時）。

### 1a. MCP Inspector（ローカル PC から）

```bash
npx @modelcontextprotocol/inspector
# UI: Transport = Streamable HTTP, URL = https://<preview>/api/mcp
# "Open Auth Settings" → "Quick OAuth Flow"
```

確認項目 / Checks:
- [ ] 未認証 `initialize` → 401 + `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/api/mcp", scope="staffpass.employee"`
- [ ] PRM → AS メタデータ取得（`issuer` 一致、`code_challenge_methods_supported: ["S256"]`、`client_id_metadata_document_supported: true`）
- [ ] Inspector の client_id（CIMD URL）がホスト許可リストにない場合は authorize で `invalid_client`（期待どおり）。許可する場合は `MCP_OAUTH_CIMD_ALLOWED_HOSTS` にプレビュー限定で追加（設定すると既定リストを置き換えるため `chatgpt.com,claude.ai,claude.com,anthropic.com` も併記）
- [ ] ログイン（15 分以内）→ 同意画面に org 名・ログイン中メール・クライアントホスト・ログアウトリンク（Q6）
- [ ] 社員を選び「許可」→ Inspector に戻り token 取得（`sp_at_` / `sp_rt_`）
- [ ] `tools/list` に `securitySchemes`、`staffpass_profile` あり。`staffpass_profile` 実行で org=TOKYO307
- [ ] 社員詳細「OAuth 接続」パネルに接続が表示 → 取り消し → Inspector の次の呼び出しが 401 `invalid_token`
- [ ] 監査ログ: `oauth.consent_granted` / `oauth.token_issued` / `oauth.grant_revoked`（トークン値が含まれないこと）

### 1b. Claude Team / ChatGPT Business（Q9、八坂さんアカウント）

- Claude: Settings → Connectors → Add custom connector → `https://<preview>/api/mcp` → Connect → 同意 → `staffpass_profile` を呼ぶ
- ChatGPT: Settings → Connectors（Developer mode）→ Create → URL 同上、Authentication = OAuth → 同意 → `staffpass_profile`
- [ ] 両クライアントで接続・ツール一覧・profile・取り消し後の再認証要求を確認
- [ ] 失敗時は `/api/mcp` の 401 と PRM/AS の HTTP ステータスのみ記録（トークンや Cookie は記録しない）

### 1c. ネガティブ（プレビュー、手動）
- [ ] 許可リスト外 org のオーナーで同意 → 403
- [ ] member ロール / `hire_issue_credentials` なし admin → 403
- [ ] 16 分以上前のログイン → 再ログイン要求
- [ ] `/api/mcp/admin` に `sp_at_` → 401
- [ ] `MCP_OAUTH_ENABLED` を外して再デプロイ → `/oauth/*`・`/api/oauth/*` 404、`sp_at_` 401、`gb_emp_` は従来どおり

## 2. ロールバック / Rollback
`MCP_OAUTH_ENABLED` を外す（即時、全 OAuth 経路 404 / `sp_at_` 無効）。データは残るため、必要なら grant 管理パネルで取り消し、または purge cron に任せる。`gb_emp_` 経路は影響なし。
Unset `MCP_OAUTH_ENABLED` (instant). `gb_emp_` is unaffected.
