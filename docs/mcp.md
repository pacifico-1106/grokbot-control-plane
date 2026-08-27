# Staffpass リモート MCP

経営者向けの公開ページ: [https://staffpass.sealith.com/docs/mcp](https://staffpass.sealith.com/docs/mcp)（ダッシュボード「連携」と同じ手順）。

Staffpass を **Grok Bot Plugins / grok.com connectors / Cursor / Claude / xAI API** から使うための **公開 HTTPS Streamable HTTP MCP** です。

Sealith の「社員証 = Bearer・MCP が第一級」という世界観を踏まえつつ、中小企業向け制御面として **より厳格（fail-closed）** にしています。

| | |
|--|--|
| **Endpoint** | `https://staffpass.sealith.com/api/mcp` |
| **Server card** | `https://staffpass.sealith.com/.well-known/mcp/server-card.json` |
| **Transport** | Streamable HTTP JSON-RPC（`initialize` / `tools/list` / `tools/call` / `ping`） |
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

承認後は `staffpass_get_approval_status` で `approved` を確認し、同じ `jobId` で `staffpass_invoke` に `approvalId` を付けて再実行します。

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
| `staffpass_whoami` | employeeId / displayName / orgId / binding / generation / scopes・purposes |
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

## curl 例（プレースホルダ）

秘密値は発行 UI の一度きりの表示を使い、ここに実値を貼らないでください。

### 1) initialize

```bash
curl -sS -X POST 'https://staffpass.sealith.com/api/mcp' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
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
