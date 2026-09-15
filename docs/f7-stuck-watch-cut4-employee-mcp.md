# F7 Stuck Watch — Cut 4: Employee MCP

**日付:** 2026-09-15  
**カット:** employee任意（canon §5 Employee推奨 + §7 cut order）

## 実装

Employee MCP に badge スコープの stuck watch 操作を追加:

- `staffpass_stuck_list` — 呼び出し中社員バッジの W1/W2 項目のみ（cross-employee 除外）
- `staffpass_stuck_retry` — 自バッジ項目の ops_fault 再試行のみ; `expected_gate` 拒否; `config_drift` は修正ヒント

Admin `stuckWatch.list` / `stuckWatch.retry` の thin wrapper（`lib/stuck-watch/employee-handlers.ts`）。エンジンは `lib/stuck-watch/*` を再利用。

## 主要ファイル

- `lib/stuck-watch/employee-handlers.ts`
- `lib/mcp/tools.ts` — schema + dispatch
- `lib/mcp/public.ts` / `public/.well-known/mcp/server-card.json`
- `lib/stuck-watch/employee-stuck-watch.test.ts`
