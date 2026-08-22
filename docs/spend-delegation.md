# 決済委任（予算・承認）— 雇うフロー補足

**対象:** Staffpass / AI社員 制御面 × Grok Bot  
**関連:** `docs/enforcement-auto-vs-manual.md` · `docs/binding-lifeline.md`

## 何を社長が決めるか

雇うフロー Step 3「予算・承認（補足）」:

| 項目 | 意味 | 既定 |
|------|------|------|
| 承認モード | `always_human` / `risk_based`（少額は自動） | 発注検知時は **always_human を推奨**（固定ではない） |
| `spend.maxPerOrderJpy` | 1件あたり上限。**0 = 発注禁止** | 3000 |
| `spend.maxPerDayJpy` / `maxPerMonthJpy` | 任意の日次・月次天井 | 未設定 |
| `merchantAllowTip` | 買ってよいもののヒント（例: eSIMのみ） | 空 |
| `firstOrderRequiresHuman` | 初回発注は必ず人間 | **ON** |

`commerce:order` がスコープに無い場合は Step 3 で「将来の決済委任」を折りたたみ表示（スキップ可）。

## Fail-closed

- 発注スコープあり + **limits 欠落** → `needs_approval`（自動許可しない）
- `always_human` → 常に `needs_approval`
- 初回 + `firstOrderRequiresHuman` → `needs_approval`
- `maxPerOrderJpy === 0` → `deny`（発注禁止）
- 上限超過 → `needs_approval`

実装: `lib/spend-gate.ts` → `evaluateSpend`  
呼出: `POST /api/gateway/invoke`（`commerce.order` / `commerce:order`）

## 運用一文

**実際の発注・送信は Gateway 経由のみ。Botに直結ツールを載せない。**

更新: 2026-08-23
