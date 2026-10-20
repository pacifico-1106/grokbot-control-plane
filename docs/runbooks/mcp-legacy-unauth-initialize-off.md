# `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE=false` 検証・切替 runbook / Turning the legacy unauthenticated-initialize escape hatch off

作成 / Written: 2026-10-10 JST（森）。対象 / Scope: MCP OAuth スタック #205–#220（未マージ・draft）。
**更新 / Updated: 2026-10-10 10:50 JST** — 木村さんの判断で OAuth は main 上に作り直した新スタック **#314–#320** に移行（§0.1）。
#205 は close、旧 #206–#220 のブランチは変更なし。**フラグの既定が逆になった**ので §1・§3・§4 を読み替え済み。
**更新 / Updated: 2026-10-10 12:10 JST** — #314–#320 は main にマージ済み（`855de50`）。§0 の本番 env を訂正（10/10 の試行前、本番に `MCP_OAUTH_*` は 1 つもなかった）。
Preview の env はブランチ限定、Preview は本番 DB を共有しているのでマイグレーションは別 DB にだけ当てる（§3.0）。
`MCP_OAUTH_REDIRECT_ALLOWLIST` は既定リストを置き換える（Cursor の 3 コールバックを全部入れる。§2.3 (b)）。関連 PR: #322（CIMD SSRF）、#323（#318 の指摘）、#325（Cursor デスクトップ `cursor://`）、#326（#315 の search_path）。
この文書は手順のみ。Vercel env（Preview / Production）の変更は 木村、本番の変更は別途 GO が必要。
Procedure only. Preview env changes are 木村's; production needs a separate GO.

## 0. 先に読む: いまの本番でフラグは効いていない / Read first: the flag is a no-op on today's production

- **10/10 の試行前の本番には `MCP_OAUTH_*` の env が 1 つも設定されていなかった**（`MCP_OAUTH_ENABLED` も
  `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE` もなし）。以前の版で「本番 env に `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE=true` がある」と書いたのは誤り。
- 当時の main には `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE` を読むコードもなかった（2026-10-10 朝の main `89b8769` で grep 0 件。旧スタック #207 / #215 以降にしかなかった）。
  未認証 `initialize` は常に 200、未認証 `tools/list` は `WWW-Authenticate` なしの 401。
- 新スタック #314–#320 は main にマージ済み（`855de50`）。フラグはすべて既定 OFF なので、env を何も設定しなければ挙動はマージ前と同じ（`flags-unset-baseline` テスト）。
- 2026-10-10 に 木村さんが本番で OAuth + DCR を **TOKYO307 だけ** ON にした（試行。`MCP_OAUTH_ORG_ALLOWLIST` で 1 org に限定）。
  legacy フラグは未設定のままなので、未認証 `initialize` は 200 のまま。
- 「legacy を `false` にする」検証は、`MCP_OAUTH_ENABLED=1` の環境でしか意味がない（OAuth OFF では false にしても何も変わらない）。
- 旧スタック先頭 #220 (`cursor/mcp-oauth-hardening-2`, `641cdaa`) は main から 476 コミット遅れていたため作り直した（§0.1）。

Before the 10/10 trial, production had no `MCP_OAUTH_*` env at all (an earlier version of this runbook wrongly said
`MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE=true` was set). The re-landed stack is merged (`855de50`) with every flag OFF by default;
on 10/10 木村 turned OAuth + DCR on in production for TOKYO307 only. The legacy flag is still unset there, so unauthenticated
`initialize` stays 200. Testing `false` is only meaningful with `MCP_OAUTH_ENABLED=1`.

### 0.1 新スタック（re-land、2026-10-10）/ The re-landed stack

| 順 | PR | ブランチ（すべて `-20261010`） | 内容 |
|---|---|---|---|
| 1 | #314 | `feat/mcp-oauth-reland-1-discovery-20261010`（base `main`） | discovery（PRM + AS）、フラグ、全フラグ未設定のピンテスト |
| 2 | #315 | `feat/mcp-oauth-reland-2-store-20261010` | migration `20261010200000_mcp_oauth.sql` + rollback、ストア |
| 3 | #316 | `feat/mcp-oauth-reland-3-authorize-consent-20261010` | authorize + consent + PKCE S256 |
| 4 | #317 | `feat/mcp-oauth-reland-4-token-revocation-20261010` | token + revoke + grant 管理 |
| 5 | #318 | `feat/mcp-oauth-reland-5-dcr-20261010` | DCR + レート制限 |
| 6 | #319 | `feat/mcp-oauth-reland-6-mcp-route-20261010` | `/api/mcp` の 401 + `WWW-Authenticate` + legacy フラグ（#210 / #268 と統合） |
| 7 | #320 | `feat/mcp-oauth-reland-7-cursor-web-callback-20261010` | Cursor web コールバックを完全一致で許可 |

- 新スタックは main（`7e30b56`）の上に作り、#314–#320 とも main にマージ済み（`855de50`）。Preview は main（と未マージの修正 PR）から切った検証用ブランチをデプロイする（§3.0）。
- **`MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE` の既定が変わった（木村さん指定）**: 未設定・空・不明な値 = **今日と同じ（未認証 initialize 200）**。
  `false` / `0` / `off` / `disabled` / `no` を**明示したときだけ** 401 + challenge。（旧スタック #220 は逆で、未設定でも 401 だった。）
- 新スタックのマイグレーションは `20261010200000_mcp_oauth.sql`（旧 `20261003100000` は使わない）。

The OAuth stack was re-landed on main as #314–#320 (table above). The legacy flag's default flipped: unset now
means today's behaviour (unauth initialize 200), and only an explicit `false` gives 401. The stack is merged; deploy a dedicated Preview branch (§3.0).

## 1. フラグの意味（新スタック #319 のコード）/ What the flag does

| 条件 / Condition | 未認証の `initialize` / `ping` / `server/discover` / `notifications/*` | 未認証の `tools/list` / `tools/call` |
|---|---|---|
| `MCP_OAUTH_ENABLED` OFF（または DEMO） | 200 / 202（今と同じ） | 401、`WWW-Authenticate` なし |
| OAuth ON + legacy **未設定**（既定）または `true` | 200 / 202（今と同じ） | 401 + `WWW-Authenticate` |
| OAuth ON + legacy **`false` を明示** | **401 + `WWW-Authenticate`** + JSON-RPC `-32001` `missing_credential` + `_meta["mcp/www_authenticate"]` | 401 + `WWW-Authenticate` |

（旧 #220 では未設定でも 401 だった。§2.1–2.2 は #220 で legacy を設定せずに取った結果で、新スタックの「`false` 明示」に相当する。新スタックでの再実行は §2.4。）

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
- env: `MCP_OAUTH_ENABLED=1`、`MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE` は設定せず（#220 のコードではこれで 401。新スタックの「`false` 明示」と同じ挙動）、`MCP_OAUTH_ISSUER=http://127.0.0.1:<port>`、
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
`https://www.cursor.com/agents/mcp/oauth/callback` は #220 の既定 redirect 許可リストに無かった。**新スタック #320 で既定リストに完全一致で追加済み**
（ワイルドカード・前方一致なし。www なし / 末尾 `/` / `http://` / クエリ / パス追加は拒否）。(c) Cursor デスクトップは DCR で
`cursor://anysphere.cursor-mcp/oauth/callback`、`https://www.cursor.com/agents/mcp/oauth/callback`、`http://localhost:8787/callback` の 3 つを
まとめて送る。`cursor://` が拒否されて登録全体が 400 になっていたので、**#325** で `cursor://` を完全一致の 1 件だけ許可した（ほかのカスタムスキームは拒否のまま）。

**`MCP_OAUTH_REDIRECT_ALLOWLIST` を設定すると既定リストは丸ごと置き換わる**（追記ではない）。設定する場合は、使うクライアントの
コールバックを全部書くこと。Cursor 用には次の 3 つを必ず入れる（1 つでも欠けると Cursor デスクトップの DCR は 400）:

```text
cursor://anysphere.cursor-mcp/oauth/callback,https://www.cursor.com/agents/mcp/oauth/callback,http://localhost:{port}/callback
```

Claude / ChatGPT も使うなら、それぞれの既定値（`lib/mcp-oauth/config.ts` の `DEFAULT_REDIRECT_ALLOWLIST`）も併記する。迷ったら設定しない（既定リストを使う）。
`cursor://` は #325 のコードに固定された 1 件だけが有効で、ここに別のカスタムスキームを書いても通らない。

### 2.4 新スタックでの再実行（2026-10-10 10:40 JST ごろ、#320 head `e47f31a`）/ Re-run on the re-landed stack

同じハーネスと SDK クライアント、127.0.0.1 のみ。
- legacy **`false` 明示** + DCR ON（:8895）: `initialize` → 401、`Access-Control-Expose-Headers: WWW-Authenticate`、
  `WWW-Authenticate: Bearer resource_metadata="http://127.0.0.1:8895/.well-known/oauth-protected-resource/api/mcp", scope="staffpass.employee"`
  → PRM 200 → AS 200 → register 201 → authorize 303 → consent 303（`iss` 付き）→ token 200 → 再接続して tools 8、`staffpass_profile` OK。
- legacy **未設定** + DCR ON（:8896）: `initialize` 200（`protocolVersion: "2025-11-25"`、#268）→ `tools/list` 401 + challenge → 同じ流れで回復。
- register: `https://www.cursor.com/agents/mcp/oauth/callback` → 201。www なし / 末尾 `/` / `http://` / `?x=1` / `/extra` → 400。

## 3. Preview 手順（実施: 木村）/ Preview steps (木村)

### 3.0 前提 / Preconditions

1. main（スタックはマージ済み）から検証用ブランチを切り、試したい修正 PR（#322 / #323 / #325 / #326）を入れて Preview をデプロイする。
   例: `preview/mcp-oauth-cursor-20261010`。以下の env は**すべてこのブランチだけ**に効かせる。
2. **DB: Preview は本番と同じ DB を使っている。Preview 用にマイグレーションを本番 DB に当てないこと。**
   別の Supabase プロジェクト（検証用 DB）を用意し、マイグレーション（`20261010200000_mcp_oauth.sql`、#326 を入れるなら `20261010300000_mcp_oauth_rate_limit_search_path.sql`）は**その DB にだけ**当てる。
   rollback は `supabase/verification/` の同名 `_rollback.sql`。
   検証用ブランチの env で `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` をその検証用 DB に向ける（ブランチ限定）。
   これをしないと、Preview の OAuth の行（クライアント・grant・トークン・レート制限）が本番 DB に書かれる。
3. 検証用ブランチの env（**Vercel の Preview 環境で Git ブランチを指定**して設定。全 Preview 共通にはしない。Production には触らない。
   CLI なら `vercel env add <NAME> preview <branch>`）:
   - `MCP_OAUTH_ENABLED=1`
   - `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE=false` を**明示**（新スタックでは未設定 = 200 のままなので、未設定では検証にならない）
   - `MCP_OAUTH_DCR_ENABLED=1`（Cursor は CIMD 未対応のため必須。§2.2）
   - `MCP_OAUTH_ORG_ALLOWLIST=<TOKYO307 の org id>`、`MCP_OAUTH_STATE_SECRET`（32 文字以上・新規）、`IP_HASH_KEY`、
     `MCP_OAUTH_ISSUER=https://<preview のドメイン>`（Preview の URL が固定でない場合は branch alias を使う）
   - 観測用: `MCP_UNAUTH_INIT_LOG_ENABLED=true`（#210 の `mcp.unauth_initialize` ログ。新スタックは 401 を返す initialize でも出す）
   - `MCP_OAUTH_REDIRECT_ALLOWLIST` は**設定しない**（既定リストに Cursor の 3 つが入っている）。設定する場合は既定リストが置き換わるので、§2.3 の 3 つを全部入れる。
   - 上の Supabase 3 変数（検証用 DB）。
4. そのブランチを再デプロイ（env 変更は再デプロイしないと効かない）。

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

`initialize` が 200 なら legacy が未設定 / true のまま（または OAuth OFF）なので、`false` の明示と再デプロイを確認する。

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

（env はすべて検証用ブランチ限定のものを操作する。ほかの Preview と Production には影響しない。）
- 即時に legacy 挙動へ: そのブランチの `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE` を削除（または `true`）→ 再デプロイ（未認証 lifecycle が 200 に戻る）。
- OAuth ごと止める: `MCP_OAUTH_ENABLED` を外して再デプロイ（OAuth 経路は 404、`sp_at_` は 401、`gb_emp_` は無影響）。
- DCR だけ止める: `MCP_OAUTH_DCR_ENABLED` を外す（登録済み `dcr_` クライアントも `dcr_disabled` で拒否される）。

## 4. 本番切替 / Production cutover（OAuth スタックのマージと別 GO の後）

前提: 新スタック #314–#320 は main にマージ済み（`855de50`）。§3 の Preview が成功していること。#322 / #323 / #325 / #326 を本番 ON の前に入れる。
（10/10 時点: 木村さんが OAuth + DCR を TOKYO307 だけ ON にして試行中。legacy フラグは未設定 = 200。）

1. 本番 DB にマイグレーション適用（承認後。#326 の `20261010300000` も）。Preview の検証は別 DB で行ったので、本番 DB への適用はここが初回。
2. 本番 env: `MCP_OAUTH_ENABLED=1`、`MCP_OAUTH_DCR_ENABLED=1`（Cursor 用）、`MCP_OAUTH_ORG_ALLOWLIST`（パイロット org）、
   `MCP_OAUTH_STATE_SECRET`、`IP_HASH_KEY`、`MCP_UNAUTH_INIT_LOG_ENABLED=true`（観測継続）。
   **最初は `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE` を未設定（= 今日と同じ 200）のまま**で OAuth を ON にし、24 時間 OAuth 経路が安定することを確認。
   （10/10 の試行前、本番には `MCP_OAUTH_*` が 1 つもなかった。`MCP_OAUTH_REDIRECT_ALLOWLIST` は設定しない。設定するなら §2.3 の Cursor 3 つを全部入れる。）
3. 事前告知: 未認証 initialize を出している Cursor 利用者（ログ上 417 件/週、IP 等は取っていないので個人は特定できない）向けに、
   「Cursor の MCP 設定で Connect を押して OAuth ログイン、または `Authorization: Bearer gb_emp_…` ヘッダを設定」を案内。
4. 切替: `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE=false` を**明示設定**→ 再デプロイ（削除しても 401 にはならない）。平日昼（ログのピーク）を避け、監視できる時間帯に行う。
5. ロールバック: `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE` を削除（または `true`）して再デプロイ（数分）。データ変更なし。

### 4.1 切替後の監視 / Monitoring（最初の 7 日）

| 指標（Vercel Logs / 監査） | 期待 | アクション基準 |
|---|---|---|
| `mcp.unauth_initialize`（Cursor）件数 | 切替直後は残るが、各クライアントは 401 → OAuth で減っていく | 3 日たっても日次件数が減らない → Cursor が回復していない。legacy を削除（または true）に戻して調査 |
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
関連 runbook: `mcp-unauth-initialize-observation-20261003.md`（main）、`mcp-oauth-rollout-20261003.md` / `mcp-oauth-e2e-inspector-20261003.md`（新スタック #314–#320 に同梱）。
