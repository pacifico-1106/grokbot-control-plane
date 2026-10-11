# Grok Bot ↔ AI社員バインディング — ライフライン仕様

**対象:** Staffpass / AI社員 制御面 × Grok Bot  
**原則:** バインディングは永続。セッションや Cookie ではない。

## 4 ルール（MUST）

1. **`employeeId` は生涯不変**  
   AI社員の識別子は発行後ずっと同じ。削除・再雇い以外で ID を付け替えない。

2. **トークン手渡しは初回デリバリのみ**  
   秘密値（`gb_emp_…`）は発行／再発行時に一度だけ UI に出す。永続化は fingerprint（ハッシュ）と generation。生秘密は保存しない。

3. **再発行は `credentialGeneration++` のみ**  
   社員証を再発行しても `employeeId`・agent 紐付けは消えない・リセットしない。generation だけが増える。

4. **破綻は可視化、黙って消さない**  
   ヘルス失敗 → `status=needs_reauth`（UI: **要再連携**）。agent id や binding 行をサイレント削除しない。Managed では `lastSuccessAt` を監視する。

## Fail-closed

ゲートウェイ / tool invoke（`POST /api/gateway/invoke`）は次で拒否（401/403 + `code`）:

- unbound / not_found
- revoked
- needs_reauth
- degraded

## 主要 API

| Method | Path | 内容 |
|--------|------|------|
| GET | `/api/employees/[id]/binding` | バインディング JSON（読み取り専用。行が無ければ unlinked を返し、作成しない） |
| POST | `/api/employees/[id]/link` | agent / workspace 紐付け（組織オーナー / 管理者のみ。メンバーは 403 admin_required） |
| POST | `/api/employees/[id]/rotate` | 秘密再発行・generation++ |
| GET | `/api/employees/[id]/health` | 現在のヘルス状態（読み取り専用。何も書き込まない・`?forceFail` は無視。組織メンバーが閲覧可） |
| POST | `/api/employees/[id]/health` | ヘルス（バインディングを書き込むため組織オーナー / 管理者のみ）。`?forceFail=1` はデモモードでのみ有効（本番では無視） |
| POST | `/api/gateway/invoke` | fail-closed 実行スタブ |

## データ

- ランタイム: `lib/bindings.ts`（DEMO インメモリ）
- 永続スキーマ: `supabase/schema.sql` → `employee_bindings`

## 決済委任との関係

発注（`commerce:order`）はバインディングが executable でも、続けて **予算ゲート**（`lib/spend-gate.ts`）を通る。  
limits 未設定は fail-closed で `needs_approval`。詳細は `docs/spend-delegation.md` と `docs/enforcement-auto-vs-manual.md`。

**実際の発注・送信は Gateway 経由のみ。Botに直結ツールを載せない。**

## Managed 生命線デモ（言い方）

デモ／導入で必ず口に出す3点:

1. **employeeId は生涯同じ** — 社員証を再発行しても ID は付け替えない（generation だけ増える）
2. **切れても黙って消さない** — ヘルス失敗は UI で **要再連携（needs_reauth）**。binding 行をサイレント削除しない
3. **手は Gateway の外に出さない** — Bot に直結の送信・発注ツールを載せない。Staffpass が拒否すれば動かない

共有PCの弱点は先に認め、境界を社員証（allowedAccounts 含む）に移したうえで監視する。

更新: 2026-08-23
