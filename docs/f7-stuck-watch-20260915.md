# F7 Stuck Watch — 不当停止の検知と再発火

**日付:** 2026-09-15  
**起案:** 安藤／依頼: 八坂  
**状態:** 実装GO（2026-09-15）  
**カタログID:** F7  
**関連:** F5 監査ラベル／承認ループ／P0 AI社員オペ（A1 v2・B1 mail.policy ほか）／Admin MCP  

---

## 0. 問題

AI社員オペでは「正当に止まるべきもの」と「本来止まらなくてよいもの」が混ざる。後者が詰まるとメンション未返信・承認後未fulfill・課金ゲート誤爆などが人間に見えず死ぬ。

Staffpassの本分は制御と監査なので、**不当停止を観測し、安全な範囲で再発火し、直せないものは運用口へ出す**のが制御面の仕事。

### 今日起きた実例（要件の種）

| 事象 | 正当？ | あるべき扱い |
|------|--------|--------------|
| `expired_trial_gated` で `comm.reply` 停止 | テナントとしては正当／運用orgでは運用故障 | `ops_fault` → 延長or課金＋未返信ウォッチ |
| `approved` なのに fulfill されない | 不当 | `ops_fault` → 自動 reinvoke |
| 社内chなのに `audience=unknown` → egress_denied | 設定／推論不足 | 台帳があれば補完再試行、なければ `config_drift` |
| `needs_approval` / 権限外 / denylist | 正当 | 再発火しない |

---

## 1. 方針ロック

1. **正当ゲートは再発火しない**（承認・権限外・ポリシー拒否）。  
2. **`ops_fault` のみ**自動リトライ（回数・間隔上限、同じ `jobId` で冪等）。  
3. 外向け送信・確定はリトライ後も **ゲート再評価**（承認の抜け道にしない）。  
4. ポリシー拒否を学習して緩めない。  
5. **MCP必須** — Admin MCP／Employee MCP で操作可能。ダッシュボードのみに閉じない。  
6. P0 AI社員オペと同じ監査・承認パターンに揃える。

---

## 2. faultClass（F5拡張）

```typescript
type FaultClass =
  | "expected_gate"
  | "ops_fault"
  | "config_drift";
```

| code / 条件 | faultClass |
|-------------|------------|
| `needs_approval` | expected_gate |
| 権限外・denylist・high_risk_consent_required | expected_gate |
| `expired_trial_gated` | ops_fault |
| approved + fulfill未完了 | ops_fault |
| 5xx / timeout | ops_fault |
| egress_denied + internal台帳済み + audience欠落 | ops_fault→1回補完、だめなら config_drift |
| missing_scope / unbound | config_drift |

監査: faultClass, code, jobId, tool, employeeId, retryCount, nextAction

---

## 3. ウォッチ P0

- W1 メンション未返信（デフォルト15分）
- W2 承認後未fulfill（デフォルト5分）→ 自動reinvoke max2・#53系と統合
- W3 ops_fault連続（K=2で停止）
- W4 config_driftは通知のみ

## 4. StuckWatchPolicy

orgs.stuck_watch_policy jsonb。enabled, mentionUnansweredMinutes, approvedUnfulfilledMinutes, maxAutoRetries=2, retryBackoffSeconds, autoRetryFaultClasses=["ops_fault"], notifyMouth, inferInternalAudienceFromLedger=true

## 5. MCP必須

Admin: stuckWatch.get|patch|list|inspect|retry|resolve|classify（summaryJa/nextStepJa）
Employee推奨: staffpass_stuck_list / staffpass_stuck_retry
invoke失敗に faultClass + stuckHint (retryable|fix|wait_approval)

## 6. AC F7-1〜F7-9（仕様書どおり）

## 7. カット順
faultClass → W2 → W1 → audience補完 → Admin MCP → employee任意
