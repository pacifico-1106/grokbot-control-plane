# F7 Stuck Watch — Cut 3: audience ledger 補完

**日付:** 2026-09-15  
**カット:** audience補完（canon §2 egress_denied row + §7 cut order）

## 実装

`egress_denied` + `inferInternalAudienceFromLedger=true` + org に台帳あり + audience 欠落/unknown のとき:

1. **1 回自動補完** (`ops_fault` / `retryable`): `parties` / `internal_audience_rule` / `org_channels` から宛先を補完し、ゲート再評価で invoke を再実行
2. **補完失敗** → `config_drift` に再分類、W4 (`stuck_watch.w4_notify`) で notifyMouth 通知、ループしない

## 主要ファイル

- `lib/stuck-watch/audience-ledger.ts` — 補完・W4・台帳検出
- `lib/gateway/invoke.ts` — egress_denied 直後の自動補完フック
- `lib/stuck-watch/admin-handlers.ts` — `stuckWatch.retry` の egress_denied パス
- `lib/stuck-watch/audience-ledger.test.ts` — 単体・統合テスト

## 監査

- `stuck_watch.audience_ledger_retry` — 補完再試行
- `stuck_watch.w4_notify` — config_drift 通知

## 未着手

- Employee MCP (`staffpass_stuck_*`) — 次カット
