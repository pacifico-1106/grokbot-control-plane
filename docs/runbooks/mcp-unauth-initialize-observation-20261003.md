# MCP 未認証 initialize 観測（Q4）/ Unauthenticated initialize observation

**目的 / Purpose:** MCP OAuth（`MCP_OAUTH_ENABLED`）を ON にすると、`Authorization` なしの `initialize` は
`401 + WWW-Authenticate` になります。その前に「認証ヘッダなしで initialize を呼んでいるクライアント」が
いるかを確認します。 / Before OAuth goes ON (unauthenticated `initialize` → 401), find out which clients
call `/api/mcp` `initialize` with no credential header.

## フラグ / Flag

| Env | Default | 効果 / Effect |
|---|---|---|
| `MCP_UNAUTH_INIT_LOG_ENABLED` | OFF | ON の間、資格情報ヘッダ（`Authorization` / `x-staffpass-credential`）が**無い** `initialize` ごとに 1 行の JSON を `console.info` に出す |

レスポンスは一切変わりません（ON/OFF で byte 同一。テスト済み）。 / Responses are unchanged.

## ログ形式 / Log line

```json
{"event":"mcp.unauth_initialize","clientName":"claude-ai","clientVersion":"1.2.3","protocolVersion":"2025-06-18","userAgent":"Claude-User/1.0"}
```

- 記録する: `clientInfo.name` / `clientInfo.version` / `protocolVersion` / `User-Agent`（各 120 文字で切り詰め、制御文字除去）
- 記録しない: トークン・ヘッダ値・Cookie・IP（Vercel が既に持つリクエストログ以上の情報は追加しない）

## 手順 / Steps（実施は 八坂 / ops）

1. Vercel Production に `MCP_UNAUTH_INIT_LOG_ENABLED=true` を設定して再デプロイ。
2. 3〜7 日運用。Vercel Logs で `mcp.unauth_initialize` を検索し、`clientName` / `userAgent` 別に件数を数える。
3. 結果を OAuth ロールアウト判断に使う:
   - 0 件、または監視/クローラのみ → OAuth ON 時に `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE` は不要。
   - 実利用クライアントがいる → そのクライアントの設定に Bearer を追加してもらう。間に合わない場合のみ一時的に
     `MCP_OAUTH_LEGACY_UNAUTH_INITIALIZE=true`（initialize/ping/notifications だけ 200 を維持）。
4. 判断後にフラグを外し、このコードは OAuth GA 後に削除。

## 既知の未認証呼び出し / Known unauthenticated callers (code review, 2026-10-03)

- `docs/mcp.md` の curl `initialize` 例に `Authorization` ヘッダが無い（OAuth ON 後は 401。PR-8 で docs 更新）。
- Cursor / Claude Code / xAI remote MCP の文書化された設定は静的ヘッダ方式なので、initialize にも Bearer が付く想定。
- アプリ側には initialize の記録が無いため、本番での実数はこのフラグで初めて分かる。
