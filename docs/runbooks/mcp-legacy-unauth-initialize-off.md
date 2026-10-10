# `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE=false` 検証・切替 runbook / Turning the legacy unauthenticated-initialize escape hatch off

作成 / Written: 2026-10-10 JST（森）。対象 / Scope: MCP OAuth スタック #205–#220（未マージ・draft）。
この文書は手順のみ。Vercel env（Preview / Production）の変更は 木村、本番の変更は別途 GO が必要。
Procedure only. Preview env changes are 木村's; production needs a separate GO.

## 0. 先に読む: いまの本番でフラグは効いていない / Read first: the flag is a no-op on today's production

- `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE` を読むコードは **OAuth スタック（#215 以降の `lib/feature-flags.ts`、
  #207 以降の `app/api/mcp/route.ts`）にしかなく、main にはない**（2026-10-10 時点の main `89b8769` で grep 0 件）。
- main（＝本番）の `/api/mcp` は OAuth を持たないため、未認証 `initialize` は常に 200、未認証 `tools/list` は
  `WWW-Authenticate` なしの 401。本番 env の `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE=true` は**何も変えていない**。
- したがって「Preview でフラグを false にする」検証は、**OAuth スタックをデプロイした Preview**
  （`MCP_OAUTH_ENABLED=1`）でしか意味がない。main の Preview で false にしても挙動は変わらない。
- OAuth スタック先頭 #220 (`cursor/mcp-oauth-hardening-2`, `641cdaa`) は main から **476 コミット遅れ**ており、
  #210（未認証 initialize 観測ログ）と #268（MCP 2026-07-28 D1）を含まない。Preview 前にスタックの rebase が必要（§2.0）。

The flag is only read by the unmerged OAuth stack. On main (production) unauthenticated `initialize` is always 200
and the production env value changes nothing. A meaningful Preview test needs a Preview deployment of the
(rebased) OAuth stack with `MCP_OAUTH_ENABLED=1`.

## 1. フラグの意味（OAuth スタック #220 のコード）/ What the flag does

| 条件 / Condition | 未認証の `initialize` / `ping` / `server/discover` / `notifications/*` | 未認証の `tools/list` / `tools/call` |
|---|---|---|
| `MCP_OAUTH_ENABLED` OFF（または DEMO） | 200 / 202（今と同じ） | 401、`WWW-Authenticate` なし |
| OAuth ON + legacy **false**（既定） | **401 + `WWW-Authenticate`** + JSON-RPC `-32001` `missing_credential` + `_meta["mcp/www_authenticate"]` | 401 + `WWW-Authenticate` |
| OAuth ON + legacy **true** | 200 / 202（エスケープハッチ） | 401 + `WWW-Authenticate` |

- 対象ルート: `/api/mcp`（POST）のみ。`/api/mcp/admin` は OAuth 対象外（`sp_at_` は 401）。GET `/api/mcp`
  （サーバーカード、秘密なし）は認証不要のまま。
- 資格情報ヘッダ（`Authorization` / `x-staffpass-credential`）が**ある**リクエストはフラグの影響を受けない。
  `gb_emp_` Bearer の既存クライアントは何も変わらない。
- `WWW-Authenticate`（RFC 6750 / RFC 9728）:
  `Bearer resource_metadata="<issuer>/.well-known/oauth-protected-resource/api/mcp", scope="staffpass.employee"`。
  トークン不正時は先頭に `error="invalid_token", error_description="<code>"`。
- メタデータ（すべて `MCP_OAUTH_ENABLED` OFF なら 404）:
  - `/.well-known/oauth-protected-resource/api/mcp` → `{resource: <issuer>/api/mcp, authorization_servers: [<issuer>], scopes_supported: ["staffpass.employee"], bearer_methods_supported: ["header"]}`
  - `/.well-known/oauth-protected-resource`（root）→ 同上、`resource: <issuer>`
  - `/.well-known/oauth-authorization-server` → `authorization_endpoint /oauth/authorize`、`token_endpoint /api/oauth/token`、
    `revocation_endpoint /api/oauth/revoke`、`code_challenge_methods_supported ["S256"]`、
    `token_endpoint_auth_methods_supported ["none"]`、`client_id_metadata_document_supported: true`、
    `registration_endpoint /api/oauth/register` は **`MCP_OAUTH_DCR_ENABLED` ON のときだけ**。

## 2. ローカル検証結果（2026-10-10 09:30–09:45 JST、森）/ Local verification

### 2.0 方法 / Method

- コード: #220 head `641cdaa` を detached worktree に展開。**ローカルのみ**（127.0.0.1）。Preview / 本番には一切接続していない。
- サーバー: Next の route handler（`/api/mcp`、PRM、AS メタデータ、authorize、consent、token、revoke、register）を
  そのまま Bun.serve で next.config の rewrite と同じパスに載せたハーネス。`app/api/mcp/oauth-e2e.test.ts` と同じ差し替え
  （in-memory OAuth ストア、DEMO 判定のみ false、ログイン済みテナント owner の固定セッション、`gb_emp_local…` を有効な社員証として扱う）。
  同意画面は React ページなので、「owner が『許可』を押す」部分だけを consent API への POST で代替。外向き通信は loopback 以外を遮断。
- env: `MCP_OAUTH_ENABLED=1`、`MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE` **未設定（= false）**、`MCP_OAUTH_ISSUER=http://127.0.0.1:<port>`、
  `MCP_OAUTH_ORG_ALLOWLIST=org_a`。DCR は ON（:8891）と OFF（:8892）の 2 通り、比較用に legacy true（:8893）。
- クライアント: 公式 **MCP TypeScript SDK 1.32.1**（`LATEST_PROTOCOL_VERSION = 2025-11-25`、Cursor のログと同じ版）の
  `Client` + `StreamableHTTPClientTransport` + `OAuthClientProvider`。CIMD URL を渡さない（Cursor は CIMD 未対応のため DCR に落ちる）、
  redirect は Cursor デスクトップ固定の `http://localhost:8787/callback`、`clientInfo` は `Cursor 1.0.0`。
- 既存テスト: `oauth-e2e`（9）/ `oauth-route`（11）/ `client-compat-route`（9）すべて pass（`node scripts/test-local.mjs`）。

### 2.1 curl（legacy false、DCR ON）

```text
$ curl -i -X POST /api/mcp -H 'user-agent: Cursor/1.0.0' \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","clientInfo":{"name":"Cursor","version":"1.0.0"},"capabilities":{}}}'
HTTP/1.1 401 Unauthorized
Access-Control-Expose-Headers: Mcp-Session-Id, WWW-Authenticate
Cache-Control: no-store
WWW-Authenticate: Bearer resource_metadata="http://127.0.0.1:8891/.well-known/oauth-protected-resource/api/mcp", scope="staffpass.employee"
{"jsonrpc":"2.0","id":0,"error":{"code":-32001,"message":"Authentication required (OAuth 2.1 or Authorization: Bearer gb_emp_…)",
 "data":{"code":"missing_credential","_meta":{"mcp/www_authenticate":["Bearer resource_metadata=\"…/api/mcp\", scope=\"staffpass.employee\""]}}}}

未認証 ping → 401、notifications/initialized → 401

$ curl -i /.well-known/oauth-protected-resource/api/mcp
HTTP/1.1 200 OK   Cache-Control: public, max-age=300   Access-Control-Allow-Origin: *
{"resource":"http://127.0.0.1:8891/api/mcp","authorization_servers":["http://127.0.0.1:8891"],"scopes_supported":["staffpass.employee"],"bearer_methods_supported":["header"],…}

$ curl /.well-known/oauth-protected-resource      → 200 {"resource":"http://127.0.0.1:8891",…}
$ curl /.well-known/oauth-authorization-server    → 200 {"issuer":"http://127.0.0.1:8891",…,"code_challenge_methods_supported":["S256"],
   "token_endpoint_auth_methods_supported":["none"],"client_id_metadata_document_supported":true,
   "authorization_response_iss_parameter_supported":true,"registration_endpoint":"http://127.0.0.1:8891/api/oauth/register"}
$ curl /.well-known/openid-configuration          → 404（RFC 8414 が先に成功するので問題なし）

POST /api/oauth/register {redirect_uris:["http://localhost:8787/callback"]}            → 201 {"client_id":"dcr_…","token_endpoint_auth_method":"none",…}
POST /api/oauth/register {redirect_uris:["https://www.cursor.com/agents/mcp/oauth/callback"]} → 400 invalid_redirect_uri
GET  /oauth/authorize?client_id=dcr_…&redirect_uri=http://localhost:8787/callback&code_challenge=…&code_challenge_method=S256&resource=…/api/mcp&scope=staffpass.employee offline_access&state=st_curl
     → 303 Location: /oauth/consent?rid=…   Set-Cookie: __Host-sp_oauth_rb_…; HttpOnly; Secure; SameSite=Lax
（owner が許可）→ 303 Location: http://localhost:8787/callback?code=…&state=st_curl&iss=http%3A%2F%2F127.0.0.1%3A8891
POST /api/oauth/token grant_type=authorization_code … code_verifier … resource
     → 200 {"access_token":"sp_at_…","token_type":"Bearer","expires_in":3600,"refresh_token":"sp_rt_…","scope":"staffpass.employee offline_access"}
POST /api/mcp initialize（Authorization: Bearer sp_at_…）→ 200
POST /api/mcp tools/list（sp_at_）→ 200（8 tools）
POST /api/mcp tools/list（Bearer sp_at_bogus）→ 401
     WWW-Authenticate: Bearer error="invalid_token", error_description="invalid_credential", resource_metadata="…/api/mcp", scope="staffpass.employee"
POST /api/mcp initialize（Bearer gb_emp_…）→ 200（OAuth を使わない既存経路は無影響）
```

監査（ハーネスが出力）: `oauth.consent_granted`（`clientId: dcr_…`、`redirectHost: localhost:8787`、`loopback: true`）、
`oauth.token_issued`（`clientHost: dcr`、ハッシュ prefix のみ。トークン値は出ない）。

注: #220 の initialize 応答は `protocolVersion: "2024-11-05"`（#205 の negotiation フラグ OFF のため）。main は #268 で
2025-11-25 をそのまま返す。rebase 後は main の挙動になる。

### 2.2 Cursor 相当クライアント（SDK）の自己回復 / Self-recovery

| ケース | 結果 |
|---|---|
| legacy **false** + DCR **ON** | **回復した**。`POST /api/mcp → 401 (WWW-Authenticate)` → PRM 200 → AS 200 → `POST /api/oauth/register → 201` → authorize 303 → consent 303（`iss` 付き）→ `POST /api/oauth/token → 200` → 再接続 `initialize 200` → `tools/list 200`（8 tools）→ `staffpass_profile`（`authMethod: "oauth"`、org 表示）。SDK は challenge の `scope="staffpass.employee"` と `resource=<issuer>/api/mcp`、`S256` を使った |
| legacy **false** + DCR **OFF**（既定） | **回復しない**。PRM 200 → AS 200 の後、SDK が `Incompatible auth server: does not support dynamic client registration` で停止（`registration_endpoint` なし、CIMD URL を持たないクライアント）。register は 404 |
| `gb_emp_` を設定ヘッダで送る（再接続 with token） | DCR / legacy に関係なく 200、tools 8 |
| 比較: legacy **true** + DCR ON | initialize 200 → `tools/list` の 401 + `WWW-Authenticate` を受けて SDK が OAuth を開始し、再接続後 tools 8（SDK は initialize 以外の 401 でも回復する） |

**結論 / Conclusion:** Cursor と同じ方式（DCR、CIMD なし、localhost:8787 コールバック、protocol 2025-11-25）の
公式 SDK クライアントは、legacy false の 401 + `WWW-Authenticate` から**自力で回復できる。ただし `MCP_OAUTH_DCR_ENABLED=1` が必須**。
Cursor は 2026-09-22 時点で CIMD 未対応（Cursor フォーラム公式回答）で、OAuth は DCR か `mcp.json` の静的 `auth.CLIENT_ID` のみ。
DCR OFF のままだと Cursor は OAuth で回復できず、社員証（`gb_emp_`）ヘッダの設定が唯一の回復手段になる。
Cursor 本体はクローズドソースなので、実クライアントでの確認は §3 の Preview で行う。

### 2.3 MCP 仕様（2025-11-25 Authorization）との適合 / Spec conformance

| 仕様の要求 | 我々の応答 | 判定 |
|---|---|---|
| RS は RFC 9728 PRM を実装し `authorization_servers` を含める（MUST） | PRM（path / root 両方）に `authorization_servers:[issuer]` | 適合 |
| 401 に `WWW-Authenticate` の `resource_metadata`、または well-known（MUST いずれか）。`scope` を含めるべき（SHOULD） | 両方提供。`scope="staffpass.employee"` あり | 適合 |
| クライアントは 401 の `WWW-Authenticate` を解析し、`resource_metadata` を優先、なければ path → root の well-known（MUST） | path / root とも 200 | 適合 |
| AS は RFC 8414 か OIDC Discovery の少なくとも一方（MUST） | RFC 8414 あり（OIDC は 404） | 適合 |
| PKCE: `code_challenge_methods_supported` が無いとクライアントは中止（MUST）、S256 | `["S256"]` | 適合 |
| RFC 8707 `resource` を authorize / token 両方で受け、audience を検証 | `resource` 必須・一致検証（E2E テスト済み） | 適合 |
| 不正・期限切れトークンは 401（MUST）| 401 + `error="invalid_token"` | 適合 |
| public client の refresh token はローテーション（MUST） | ローテーション + 再利用検知（E2E テスト済み） | 適合 |
| AS エンドポイントは HTTPS（MUST）、redirect は localhost か HTTPS（MUST） | 本番 issuer は https。redirect は許可リスト（https または loopback） | 適合（ローカル検証のみ http） |
| クライアント登録: CIMD SHOULD、DCR MAY | CIMD（ホスト許可リスト付き）+ DCR（フラグ） | 適合。ただし Cursor 互換には DCR が要る |
| 403 `insufficient_scope` によるステップアップ | スコープは 1 種のみで該当なし | 該当なし |

細部（非ブロッキング）: (a) challenge は `scope="staffpass.employee"` だが、token 応答は要求外の `offline_access` を含む scope を返した
（RFC 6749 §3.3 上、異なる scope を返すことは許される。refresh を出す設計どおり）。(b) Cursor のウェブ / Cloud Agents 用コールバック
`https://www.cursor.com/agents/mcp/oauth/callback` は既定の redirect 許可リストに無い。デスクトップ（loopback）だけで良ければ現状のまま、
Cursor Web も対象にするなら `MCP_OAUTH_REDIRECT_ALLOWLIST` に追加（既定リストを置き換えるので既定値も併記）。

## 3. Preview 手順（実施: 木村）/ Preview steps (木村)

### 3.0 前提 / Preconditions

1. OAuth スタックを main に rebase した Preview ブランチ（#220 系の先頭）。rebase は §0 の理由で必須（担当: 実装側）。
   main の Preview では検証にならない。
2. Preview DB に `supabase/migrations/*mcp_oauth*` を適用（承認後、rollout runbook どおり）。
3. Preview の env（**Preview スコープのみ**。Production には触らない）:
   - `MCP_OAUTH_ENABLED=1`
   - `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE` → **未設定、または `false`**
   - `MCP_OAUTH_DCR_ENABLED=1`（Cursor は CIMD 未対応のため必須。§2.2）
   - `MCP_OAUTH_ORG_ALLOWLIST=<TOKYO307 の org id>`、`MCP_OAUTH_STATE_SECRET`（32 文字以上・新規）、`IP_HASH_KEY`、
     `MCP_OAUTH_ISSUER=https://<preview のドメイン>`（Preview の URL が固定でない場合は branch alias を使う）
   - 観測用: `MCP_UNAUTH_INIT_LOG_ENABLED=true`（rebase 後なら #210 の `mcp.unauth_initialize` ログが出る）
4. 再デプロイ（env 変更は再デプロイしないと効かない）。

### 3.1 デプロイ直後のスモーク（curl）

```bash
P=https://<preview>
curl -si -X POST $P/api/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  | grep -iE '^HTTP|^www-authenticate'
# 期待: HTTP/2 401 と  www-authenticate: Bearer resource_metadata="https://<preview>/.well-known/oauth-protected-resource/api/mcp", scope="staffpass.employee"
curl -s $P/.well-known/oauth-protected-resource/api/mcp     # authorization_servers に https://<preview>
curl -s $P/.well-known/oauth-authorization-server | jq '{issuer,registration_endpoint,code_challenge_methods_supported}'
# 期待: issuer が PRM の authorization_servers[0] と完全一致、registration_endpoint あり、["S256"]
```

`initialize` が 200 なら legacy が true のまま（または OAuth OFF）なので、env と再デプロイを確認する。

### 3.2 接続するクライアント / Clients to connect

A. **Cursor デスクトップ（本命）**。`~/.cursor/mcp.json` に**ヘッダなし**で追加し、Cursor を再起動:

```json
{ "mcpServers": { "staffpass-preview": { "url": "https://<preview>/api/mcp" } } }
```

Settings → MCP（Customize）で `staffpass-preview` に「Needs login / Connect」が出る → クリック → ブラウザで Staffpass にログイン
（15 分以内のログイン）→ 同意画面（org 名・ログイン中メール・クライアント名・**redirect ホスト localhost:8787**）→ 社員を選び「許可」
→ Cursor に戻り、ツール一覧に `staffpass_*` が出る → チャットで `staffpass_profile` を呼び org=TOKYO307 を確認。
MCP ログ: Output パネル（Cmd+Shift+U）→ 「MCP Logs」。

B. **Cursor + 社員証（再接続 with token）**: 同じエントリに `"headers": {"Authorization": "Bearer ${env:STAFFPASS_GB_EMP}"}` を足して
再起動 → OAuth なしで接続できること（既存利用者の移行手段）。

C. 比較用（任意）: MCP Inspector（`npx @modelcontextprotocol/inspector`、Streamable HTTP、URL 同上、Quick OAuth Flow）。
Inspector は CIMD を使う場合があり、ホスト許可リストに無いと `invalid_client` になる（既存 runbook どおり）。

### 3.3 観測するもの / What to observe

- Vercel Logs（Preview）: `/api/mcp` の 401 → `/.well-known/oauth-protected-resource/api/mcp` 200 →
  `/.well-known/oauth-authorization-server` 200 → `POST /api/oauth/register` 201 → `/oauth/authorize` 303 →
  `/api/oauth/consent` 303 → `POST /api/oauth/token` 200 → `/api/mcp` 200（Bearer）の順に並ぶこと。
  `mcp.unauth_initialize`（clientName `Cursor`）は 401 の直前に 1 行出る（ログは応答を変えない）。
- 監査ログ: `oauth.consent_granted`（`clientId: dcr_…`、`redirectHost: localhost:8787`、`loopback: true`）、
  `oauth.token_issued`（`clientHost: dcr`）。トークン値・Cookie が含まれないこと。
- 社員詳細の「OAuth 接続」パネルに Cursor の接続が出ること。取り消し → Cursor の次の呼び出しが 401 `invalid_token` → Cursor が再ログインを促すこと。
- 1 時間後（access token 期限）: Cursor が `grant_type=refresh_token` で自動更新し、再ログインを求めないこと。

### 3.4 成功 / 失敗の基準 / Criteria

成功（すべて満たす）:
1. 未認証 `initialize` が 401 + 上記 `WWW-Authenticate`。
2. Cursor がユーザー操作「Connect」1 回 + ブラウザ同意だけで接続し、`tools/list` と `staffpass_profile` が通る。
3. Cursor 再起動後もログイン不要（トークン保存）。1 時間超でも refresh で継続。
4. 取り消し後に 401 → 再ログイン導線が出る。
5. B（gb_emp_ ヘッダ）が従来どおり動く。Claude / ChatGPT（既存 runbook 1b）も同じ Preview で接続できる。

失敗（どれか 1 つで不合格。原因を記録しロールバック）:
- Cursor が「Connect」を出さず、エラーのまま止まる（401 を OAuth の合図として扱わない）。
- `register` が 400 / 404（DCR OFF、または redirect 許可リスト不一致。Cursor Web からの場合は §2.3 (b)）。
- authorize で `invalid_client` / `invalid_request`、token で `invalid_grant`（PKCE / resource / redirect 不一致）。
- 接続後に頻繁な再ログイン（refresh 失敗。`oauth.refresh_reuse_detected` 等が出ていないか）。
記録するのは HTTP ステータスとパスだけ。トークン・Cookie・認可コードは記録しない。

### 3.5 ロールバック（Preview）/ Rollback

- 即時に legacy 挙動へ: Preview に `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE=true` → 再デプロイ（未認証 lifecycle が 200 に戻る）。
- OAuth ごと止める: `MCP_OAUTH_ENABLED` を外して再デプロイ（OAuth 経路は 404、`sp_at_` は 401、`gb_emp_` は無影響）。
- DCR だけ止める: `MCP_OAUTH_DCR_ENABLED` を外す（登録済み `dcr_` クライアントも `dcr_disabled` で拒否される）。

## 4. 本番切替 / Production cutover（OAuth スタックのマージと別 GO の後）

前提: OAuth スタックが rebase 済みで main にマージされ、§3 の Preview が成功していること。

1. 本番 DB にマイグレーション適用（承認後）。
2. 本番 env: `MCP_OAUTH_ENABLED=1`、`MCP_OAUTH_DCR_ENABLED=1`（Cursor 用）、`MCP_OAUTH_ORG_ALLOWLIST`（パイロット org）、
   `MCP_OAUTH_STATE_SECRET`、`IP_HASH_KEY`、`MCP_UNAUTH_INIT_LOG_ENABLED=true`（観測継続）。
   **最初は `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE=true` のまま**で OAuth を ON にし、24 時間 OAuth 経路が安定することを確認。
3. 事前告知: 未認証 initialize を出している Cursor 利用者（ログ上 417 件/週、IP 等は取っていないので個人は特定できない）向けに、
   「Cursor の MCP 設定で Connect を押して OAuth ログイン、または `Authorization: Bearer gb_emp_…` ヘッダを設定」を案内。
4. 切替: `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE` を削除（= false）→ 再デプロイ。平日昼（ログのピーク）を避け、監視できる時間帯に行う。
5. ロールバック: `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE=true` で再デプロイ（数分）。データ変更なし。

### 4.1 切替後の監視 / Monitoring（最初の 7 日）

| 指標（Vercel Logs / 監査） | 期待 | アクション基準 |
|---|---|---|
| `mcp.unauth_initialize`（Cursor）件数 | 切替直後は残るが、各クライアントは 401 → OAuth で減っていく | 3 日たっても日次件数が減らない → Cursor が回復していない。legacy true に戻して調査 |
| 未認証 401 の後に PRM / AS メタデータ取得が続くか | 続く | 401 の後に PRM が来ない＝クライアントが challenge を無視 |
| `POST /api/oauth/register` の 201 / 4xx / 429 | 201 が Cursor 利用者数程度 | 4xx 急増 → redirect 許可リスト。429 → レート制限値の見直し |
| `oauth.consent_granted` / `oauth.token_issued`（`clientHost: dcr`） | 増える | 0 のまま → 同意まで到達していない |
| refresh 失敗 / 再利用検知 | ほぼ 0 | 増加 → Cursor の並列 refresh。猶予 30 秒の妥当性を確認 |
| `gb_emp_` 経路の 401 率 | 不変 | 変化 → 切替と無関係な障害を疑う |

7 日間問題なければ legacy フラグとその分岐の削除 PR、`MCP_UNAUTH_INIT_LOG_ENABLED` の停止と #210 のコード削除を予定する。

## 付録 A: SDK クライアント（ローカル検証で使用、要点）/ Appendix: SDK client

```js
// @modelcontextprotocol/sdk 1.32.1. BASE は 127.0.0.1 のみ許可。
const provider = {
  redirectUrl: "http://localhost:8787/callback",            // Cursor デスクトップと同じ
  clientMetadata: { client_name: "Cursor-like (MCP TS SDK)", redirect_uris: ["http://localhost:8787/callback"],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
  // clientMetadataUrl なし → CIMD を使わず DCR（Cursor と同じ）
  state, clientInformation, saveClientInformation, tokens, saveTokens, saveCodeVerifier, codeVerifier,
  redirectToAuthorization(url) { /* ブラウザ代わり: authorize → consent → callback の code を取得 */ },
};
const client = new Client({ name: "Cursor", version: "1.0.0" }, { capabilities: {} });
try { await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), { authProvider: provider })); }
catch (e) { if (!(e instanceof UnauthorizedError)) throw e; }          // 401 → SDK が discovery/DCR/authorize を実行
await new StreamableHTTPClientTransport(url, { authProvider: provider }).finishAuth(code); // token
await new Client(...).connect(new StreamableHTTPClientTransport(url, { authProvider: provider })); // Bearer sp_at_ で再接続
```

参照 / References: MCP Authorization 2025-11-25（modelcontextprotocol.io/specification/2025-11-25/basic/authorization）、
Cursor Docs「Static OAuth for remote servers」（redirect `http://localhost:8787/callback` / `https://www.cursor.com/agents/mcp/oauth/callback`）、
Cursor Forum「MCP OAuth: CIMD Support Plans and Timelines」（2026-09-22 時点で CIMD 未対応、DCR と静的資格情報のみ）。
関連 runbook: `mcp-unauth-initialize-observation-20261003.md`（main）、`mcp-oauth-rollout-20261003.md` / `mcp-oauth-e2e-inspector-20261003.md`（OAuth スタック）。
