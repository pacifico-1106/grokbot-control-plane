# Staffpass リモート MCP

経営者向けの公開ページ: [https://staffpass.sealith.com/docs/mcp](https://staffpass.sealith.com/docs/mcp)（ダッシュボード「連携」と同じ手順）。

Staffpass を **Grok Bot Plugins / grok.com connectors / Cursor / Claude / xAI API** から使うための **公開 HTTPS Streamable HTTP MCP** です。

Sealith の「社員証 = Bearer・MCP が第一級」という世界観を踏まえつつ、中小企業向け制御面として **より厳格（fail-closed）** にしています。

| | |
|--|--|
| **Endpoint** | `https://staffpass.sealith.com/api/mcp` |
| **Server card** | `https://staffpass.sealith.com/.well-known/mcp/server-card.json` |
| **Transport** | Streamable HTTP JSON-RPC（`server/discover` / `initialize` / `tools/list` / `tools/call` / `ping`） |
| **Protocol** | MCP `2026-07-28`（リクエストごとの `_meta`）と従来版 `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05`（`initialize`）。詳細は下の「プロトコルバージョン」 |
| **Auth** | `Authorization: Bearer gb_emp_…`（または `x-staffpass-credential`） |

ローカル stdio は **Grok Bot 向けには使いません**（公開 HTTPS のみ）。

---

## アーキテクチャ（厳格さ）

```text
Client (Grok Bot / Cursor / Claude / xAI)
    │  Bearer gb_emp_…
    ▼
POST /api/mcp  (Streamable HTTP JSON-RPC)
    │  resolveEmployeeCredential (fingerprint → credentials / binding)
    ▼
staffpass_invoke ──► lib/gateway/invoke (同一 Gateway 強制パス)
    │
    ├─ unknown tool / missing purpose / unbound / needs_reauth → hard deny
    ├─ SoD force_human / action-limit / always_human confirm-send-order → needs_approval
    └─ audience × information-class egress（comm.send / slack.* エイリアス）
            宛先不明 = 社外。slack.post という名前では社内自己申告できない
```

**禁止:** MCP 専用の甘いバイパス。`staffpass_invoke` は Gateway と同じ `runGatewayInvoke` を呼びます。

**承認リターンパイプ:** `needs_approval` のとき、結果 JSON に必ず次を含めます（Instructions 散文だけに頼らない）。

- `approvalId`
- `statusToken`
- `pollUrl`（ホスト `staffpass.sealith.com`）
- `pollHint`（`continue_polling` / 後続は status ツール）
- `title` / `summary`（日本語サマリ）

承認後は `staffpass_get_approval_status` をポーリングします。

- `pollHint` が `fulfilled` なら、承認された操作は Staffpass が実行済みです（Slack 投稿は承認時に自動送信されます）。それで完了なので、再実行しないでください（二重送信になります）。
- `pollHint` が `reinvoke_with_approvalId` のときだけ、同じ `jobId` で `staffpass_invoke` に `approvalId` を付けて再実行します。`reinvokeReason` が返っているときは、そこに書かれた修正（管理ツールなど）を先に行ってから再実行します。`reinvokeReason` が無いまま `reinvoke_with_approvalId` になることもあります。そのときは同じ approvalId と同じ内容で、一度だけ再実行します。理由は `reinvokeCode` で返ることがあります（`pending_attachment` = 承認済み添付の未送信分、`not_executed_yet` = 承認済みだが未実行、`admin_result_required` = 管理 MCP で再実行）。
- `needs_approval` の応答に `approvalReasons[]` があれば、承認が必要な理由がすべて入っています（`topic_gate` / `egress` / `always_human` / `action_limit` など）。情報区分は AI の指定では下げられません（上げることはできます）。機密話題の一覧は `staffpass_sensitive_topics`（参照専用）で確認できます。

---

## 認証

社員証発行時に一度だけ表示される秘密値:

```http
Authorization: Bearer gb_emp_<…>
```

代替ヘッダ:

```http
x-staffpass-credential: gb_emp_<…>
```

サーバーは `fingerprintSecret`（SHA-256）で照合し、`credentials.secret_hash` / `employee_bindings.credential_fingerprint`（DEMO は in-memory binding）から `employeeId` + `orgId` + `generation` を解決します。

| 失敗 | code |
|------|------|
| 欠落 | `missing_credential` |
| 不明・失効・期限切れ | `invalid_credential` / `revoked` |
| 社員なし | `employee_not_found` |

---

## ツール一覧（狭い制御面のみ）

Commerce / handoff / JPYC の正本機能は Sealith から **移植しません**。任意の
`external_reference` 連携では、Staffpass承認とSealith注文を署名イベントで相関し、
Sealith由来の状態を読み取り投影としてだけ保持します。

| Tool | 用途 |
|------|------|
| `staffpass_whoami` | employeeId / displayName / orgId / binding / generation / scopes・purposes / **voice**（バッジ。社外は丁寧下限） |
| `staffpass_invoke` | Gateway と同ロジック。`tool` + `purpose` + `jobId` 必須。confirm/send/order は人間承認で停止。任意で `conversation`（surface + 宛先）。`comm.send` / `slack.post` は同一 audience resolver |
| `staffpass_get_approval_status` | `approvalId` + `statusToken` → GET `/api/approvals/status` と同じ |
| `staffpass_health` | runtimeMode / supabase・stripe・resend / 当該社員の binding |

### `allowed_tools`（クライアント側の絞り込み）

接続クライアントでは次の 4 つに制限してください。

```text
staffpass_whoami
staffpass_invoke
staffpass_get_approval_status
staffpass_health
```

ツール説明文にも「confirm/send/order は人間承認で停止する」と明記しています。

---

## プロトコルバージョン（MCP 2026-07-28 対応）

社員証 MCP（`/api/mcp`）と管理 MCP（`/api/mcp/admin`）は、MCP `2026-07-28` と従来版の両方に対応しています（仕様でいう dual-era サーバー）。

| クライアントの送り方 | サーバーの答え |
|---|---|
| `initialize` で `2024-11-05` / `2025-03-26` / `2025-06-18` / `2025-11-25` | 同じ版をそのまま返す |
| `initialize` で `2026-07-28` や未知の版 | `2025-11-25`（`initialize` を使う版の最新。`2026-07-28` には `initialize` がないため） |
| `initialize` で `protocolVersion` なし | `2024-11-05`（従来どおり） |
| リクエストの `_meta["io.modelcontextprotocol/protocolVersion"]` が `2026-07-28` | そのまま処理（結果に `resultType: "complete"` とサーバー情報。`tools/list` はキャッシュ目安 `ttlMs` / `cacheScope: "private"` つき） |
| `_meta` の版が未対応（例 `2027-01-01`） | HTTP 400 + `-32022`（Unsupported protocol version）。`data.supported` に対応版の一覧 |
| `server/discover` | 対応版の一覧（`supportedVersions`）、`initialize` と同じ `capabilities` と `instructions`、サーバー情報。認証不要 |

ヘッダの扱い（Streamable HTTP）:

- `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` が本文と食い違うと HTTP 400 + `-32020`（Header mismatch）。`Mcp-Name` の `=?base64?…?=` 形式は復号してから比べます。
- `MCP-Protocol-Version` がない従来クライアントは、これまでどおり処理します。
- `2026-07-28` のリクエストでヘッダが欠けている場合も、既定では処理します。`MCP_STRICT_REQUEST_HEADERS=true` にすると仕様どおり 400 で拒否します（既定 OFF）。
- `2026-07-28` のリクエストで未知のメソッドは HTTP 404 + `-32601`。従来版は HTTP 200 + `-32601` のまま。
- `_meta` は 16 KiB / 64 キーまで。知らないキーは読まずに無視し、応答には返しません。
- セッション（`Mcp-Session-Id`）は発行しません。

---

## curl 例（プレースホルダ）

秘密値は発行 UI の一度きりの表示を使い、ここに実値を貼らないでください。

### 1) initialize（従来版のクライアント）

`2026-07-28` のクライアントは `initialize` を使いません（下の「2026-07-28 の例」を参照）。

> 2026-10-05 時点: サーバーはどの `protocolVersion` を送っても `2024-11-05` で応答します（MCP `2026-07-28` の
> `server/discover` は未対応）。対応方針は `docs/mcp-events-approval-wake-20261005.md` §13 を参照してください。

```bash
curl -sS -X POST 'https://staffpass.sealith.com/api/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-11-25",
      "capabilities": {},
      "clientInfo": { "name": "curl", "version": "0.0.1" }
    }
  }'
```

### 2) tools/list

```bash
curl -sS -X POST 'https://staffpass.sealith.com/api/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer gb_emp_YOUR_SECRET_HERE' \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }'
```

### 3) tools/call — whoami

```bash
curl -sS -X POST 'https://staffpass.sealith.com/api/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer gb_emp_YOUR_SECRET_HERE' \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "staffpass_whoami",
      "arguments": {}
    }
  }'
```

### 4) tools/call — invoke（例: mail.send → needs_approval）

```bash
curl -sS -X POST 'https://staffpass.sealith.com/api/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer gb_emp_YOUR_SECRET_HERE' \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "staffpass_invoke",
      "arguments": {
        "tool": "mail.send",
        "purpose": "customer_followup",
        "jobId": "job_demo_001"
      }
    }
  }'
```

`needs_approval` のときは結果の `approvalId` / `statusToken` / `pollUrl` を保存し、承認まで止めます。

### 5) 承認ステータス poll

```bash
curl -sS -X POST 'https://staffpass.sealith.com/api/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer gb_emp_YOUR_SECRET_HERE' \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "tools/call",
    "params": {
      "name": "staffpass_get_approval_status",
      "arguments": {
        "approvalId": "APPROVAL_ID",
        "statusToken": "STATUS_TOKEN"
      }
    }
  }'
```

（同等の HTTP）`GET https://staffpass.sealith.com/api/approvals/status?id=…&token=…`

### 2026-07-28 の例（initialize なし。毎回ヘッダと `_meta` を付ける）

`server/discover`（任意。対応版と capabilities を先に知りたいとき。認証不要）:

```bash
curl -sS -X POST 'https://staffpass.sealith.com/api/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: server/discover' \
  -d '{
    "jsonrpc": "2.0",
    "id": "discover-1",
    "method": "server/discover",
    "params": {
      "_meta": {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { "name": "curl", "version": "0.0.1" },
        "io.modelcontextprotocol/clientCapabilities": {}
      }
    }
  }'
```

`tools/call` — whoami（`Mcp-Name` はツール名と同じ値）:

```http
POST /api/mcp HTTP/1.1
Host: staffpass.sealith.com
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer gb_emp_YOUR_SECRET_HERE
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: staffpass_whoami

{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "staffpass_whoami",
    "arguments": {},
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "curl", "version": "0.0.1" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

結果には `resultType: "complete"` と `_meta["io.modelcontextprotocol/serverInfo"]` が付きます。中身（`content` など）は従来版と同じです。

---

## Connect from Grok Bot（Plugins）

1. Grok Bot → **Settings → Plugins**
2. **Custom MCP URL** に `https://staffpass.sealith.com/api/mcp`
3. **Authorization** ヘッダに `Bearer gb_emp_…`（社員証の一度きり秘密）
4. `allowed_tools` があれば 4 つの `staffpass_*` に限定
5. ローカル stdio や `localhost` は不可（**公開 HTTPS のみ**）

発行画面の Instructions / Routine に「`needs_approval` 時は poll 必須」を残しつつ、**実際の承認 ID・URL はツール結果の構造化フィールドを正**とします。

---

## grok.com / connectors（Custom MCP）

1. [grok.com](https://grok.com) の **Connectors / Custom MCP**
2. URL: `https://staffpass.sealith.com/api/mcp`
3. Auth: Bearer `gb_emp_…`
4. Server card: `https://staffpass.sealith.com/.well-known/mcp/server-card.json` を参照可能

---

## Cursor / Claude Code（HTTP MCP スニペット）

Cursor（`mcp.json` 例）:

```json
{
  "mcpServers": {
    "staffpass": {
      "url": "https://staffpass.sealith.com/api/mcp",
      "headers": {
        "Authorization": "Bearer gb_emp_YOUR_SECRET_HERE"
      }
    }
  }
}
```

Claude Code / HTTP MCP も同様に **URL + Authorization ヘッダ** で接続します（stdio エントリは Staffpass 本番では使いません）。

xAI API の remote MCP も同じ URL / Bearer を指定してください。

---

## 経営者向け一言（JP SME）

- AI社員は **社員証（gb_emp_）** がないと動けません
- 送信・発注は **必ず人間の承認**（ダッシュボード or メール）
- 承認待ち中は Bot が勝手に完了しません（poll 必須）
- 使える MCP ツールは制御面の 4 つだけ（余計な決済・送金ツールは載せません）

---

## Follow-up（スコープ外）

- 公式マーケットプレイス向けプラグイン梱包
- Sealith commerce / handoff / JPYC の正本機能をStaffpass MCPへ移植
- Stripe 従量オーバーエイジの MCP 露出

会話の相手×情報区分（egress）の正本は [egress-policy.md](./egress-policy.md) です。Slack ツール名は境界ではありません。

実装の正本は Gateway（`lib/gateway/invoke.ts`）と社員証ガイド（[agent-credential-guide.md](./agent-credential-guide.md)）です。


---

## 管理 MCP（別口）

社員証 MCP（`/api/mcp`, `gb_emp_`）とは **別の口** です。混ぜないでください。

| | |
|--|--|
| **Endpoint** | `https://staffpass.sealith.com/api/mcp/admin` |
| **Auth** | `Authorization: Bearer gb_adm_…`（社員証 `gb_emp_` は fail-closed で拒否） |
| **Server name** | `staffpass-admin` |
| **Protocol** | 社員証 MCP と同じ（MCP `2026-07-28` + 従来版、`server/discover` 対応） |

ツール:

| Tool | 承認 | 用途 |
|------|------|------|
| `employees.issue` | always_human | AI社員証の発行 |
| `link` | always_human | 社員証とGrok Bot連携 |
| `policy.patch` | always_human | 権限更新 |
| `employees.postingIdentity.set` | always_human | Slack 投稿名義（`bot` / `user`）の切り替え。`user` は本人の Slack ユーザートークン（chat:write）を提案時と反映直前に確認。詳細は `docs/admin-mcp-posting-identity.md` |
| `parties.upsert` | always_human | 相手台帳登録 |
| `channels.classify` | always_human | チャネル分類 + 1:1 IM受口設定 |
| `roles.propose` | always_human | 職務案の提案 |
| `setup.slackStatus` | なし（read-only） | Slack設定診断（F1 口ルーティング状況含む） |
| `ingressHandoff.get` | なし（read-only） | D1 受信ハンドオフポリシー読み取り（本番稼働中、hasHighRiskAutomation / consent 状況を返却、AI社員ごとにemployeeId指定可） |
| `ingressHandoff.patch` | always_human | 受信ハンドオフポリシー更新（高リスク承諾必須：file+sealith=off+classified_external_sensitive、AI社員ごとにemployeeId指定可、clearOverrideで継承） |
| `schedulingPolicy.get` | なし（read-only） | A1 スケジューリングポリシー読み取り（本番稼働中） |
| `schedulingPolicy.patch` | always_human | スケジューリングポリシー更新（高リスク承諾必須） |
| `replyPolicy.get` | なし（read-only） | B2 返信ポリシー読み取り（本番稼働中、AI社員ごとにemployeeId指定可） |
| `replyPolicy.patch` | always_human | 返信ポリシー更新（営業時間外 allow_send は高リスク承諾必須） |

監査クラスは `admin.hire` / `admin.policy` / `admin.parties` など。`tool.invoke` / `mail.send` とは分けます。管理エージェントは自分の申請を承認できません。

### ツール更新後の再接続

管理 MCP に新しいツールがデプロイされた場合、MCP クライアント（Cursor、mcp-remote など）でツールリストが更新されないことがあります。

**対処法**: MCP コネクタを再起動/再接続してください。

- **Cursor**: MCP サーバー設定を一度削除して再追加、または Cursor を再起動
- **mcp-remote**: プロセスを再起動
- **grok.com connectors**: コネクタを削除して再追加

サーバーは `capabilities.tools.listChanged: true` を返すため、MCP 仕様に準拠したクライアントは `notifications/tools/list_changed` を受信してリストを更新できますが、Streamable HTTP では通知の push が制限されるため、再接続が確実です。
