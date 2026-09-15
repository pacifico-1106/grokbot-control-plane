# Staffpass 承認ワークフロー（合議・定足数・最終Go）

**日付:** 2026-09-16  
**起案:** 安藤／依頼: 八坂  
**状態:** 実装GO  
**動機:** みらい社中など「上司3人の合議 → 定足数 → 最終Go担当」が必要。現状の承認inboxは allowedUsers の **OR（1人で完了）** のみ。  
**カタログ候補ID:** F8（横断メタ）または既存承認ループの拡張 `approval.workflow`

---

## 0. 問題

社団・委員会型の組織では、対外送信や経費・企画の一次判断を **複数人の合議** で行い、さらに **別人が最終Go** することがある。スペースツリー（上司1名・Slack DM）では足りない。

---

## 1. 方針ロック

1. **正当ゲートは緩めない。** 定足数未達・最終Go未了の外向け送信／確定は fail-closed。  
2. **現行の1人承認（OR）はデフォルトのまま残す**（スペースツリー等）。workflow は org／employee／tool で opt-in。  
3. **合議と最終Goは役割を分ける**（同じ人が両レーンに出てもよいが、設定は分離）。  
4. **MCP必須:** Admin MCP でポリシーCRUD・状態照会・手動リマインド。Employee MCP は自分の pending 合議の参照程度。  
5. 監査に各票・定足数判定・最終Goを残す（誰が・いつ・どの票）。  
6. Slack／LINE／Telegram／Web の既存承認口に載せる（カードは「あなたの1票」＋進捗「2/3」）。

---

## 2. 概念

```typescript
type QuorumRule =
  | { type: "any" }                              // 現行互換: 1人で完了
  | { type: "count"; n: number }                 // N人以上の approve
  | { type: "ratio"; numerator: number; denominator: number } // 例 2/3
  | { type: "majority" };                        // floor(voters/2)+1

interface ApprovalLane {
  id: string;                                    // lane_consensus / lane_final
  nameJa: string;
  voterUserIds: string[];                        // Slack/Telegram/LINE user ids or staffpass member ids（実装で統一）
  quorum: QuorumRule;
  // reject が1つでも即 reject か、定足数だけ見るか
  onReject: "fail_closed" | "count_as_vote";     // P0推奨: fail_closed
}

interface ApprovalWorkflow {
  version: 1;
  policyId: string;
  /** どの Gateway 行為にこのWFを掛けるか */
  match: {
    tools?: string[];                            // mail.send, calendar.confirm, ...
    purposes?: string[];
    // 将来: amountJpyMin, audience external など
  };
  stages: ApprovalLane[];                        // 順次。前stageのquorum達成後に次へ
  /** stages 完了後にまだ外に出さない場合の最後の人（省略可＝最終stageで完了） */
  finalGoUserId?: string;
  notifyMouth: { surface: "slack" | "line" | "telegram" | "web" };
  updatedAt: string;
  updatedBy: string;
}
```

階層: `orgs.approval_workflow_policy` jsonb ＋ employee override（任意）。

### みらい社中向けプリセット例

**社員1体**（対外窓口＋対内一次窓口）

- 対外: Slack（内部・外部）、メール下書き／返信  
- 対内: 企画立案・経費申請の一次受付  

**承認WF**

1. `lane_consensus` … 上司3人、`quorum: { type: "ratio", numerator: 2, denominator: 3 }` または `majority`  
2. `finalGoUserId` … 別担当（または代表理事）。合議達成後もこの1票がないと `mail.send` / 高額確定などは通さない  

経費・企画の「一次窓口」は AIが下書き・整理し、合議レーンへ上げる。最終Goは対外送信・会計連携など高リスクだけでも可（match.tools で絞る）。

---

## 3. ランタイム

1. invoke が always_human／workflow 対象 → `needs_approval` で **workflowInstance** 作成  
2. stage0 の全 voter にカード配信（進捗 `承認 1/3`）  
3. 票が揃い quorum 達成 → 次 stage または finalGo へ  
4. `onReject: fail_closed` なら1 reject で instance 全体 reject  
5. 全 stage＋finalGo 完了後に従来どおり fulfill / auto_reinvoke  
6. 期限切れは既存 expired 扱い＋Stuck Watch 連携可  

### 既存との互換

- workflow 未設定 → 現行 `any`（1人承認）  
- allowedUserIds のみのチャネル → そのまま OR  

---

## 4. Admin MCP（必須）

| ツール | 承認 | 用途 |
|--------|------|------|
| `approvalWorkflow.get` | 不要 | 有効ポリシー＋summaryJa |
| `approvalWorkflow.patch` | always_human | stages / quorum / finalGo / match |
| `approvalWorkflow.inspect` | 不要 | instance の票・進捗 |
| `approvalWorkflow.remind` | always_human | 未投票者へリマインド |

Employee MCP（任意）: `staffpass_approval_ballot_status`（自分の票と進捗）。

invoke／get_approval_status レスポンス拡張:

```json
{
  "needs_approval": true,
  "workflow": {
    "instanceId": "...",
    "stageId": "lane_consensus",
    "progress": { "approved": 2, "rejected": 0, "pending": 1, "quorum": "2/3" },
    "finalGoPending": false
  }
}
```

---

## 5. 受け入れ条件（AC）

| # | AC |
|---|-----|
| W1 | workflow 未設定orgでは現行どおり1人承認で通る（回帰） |
| W2 | ratio 2/3 で voters=3 のとき approve 2 で stage 達成、1では未達 |
| W3 | majority で voters=3 のとき 2 で達成 |
| W4 | reject 1（fail_closed）で instance 全体が rejected、fulfill されない |
| W5 | finalGoUserId 設定時、合議達成後も最終票まで外向け send されない |
| W6 | 各票が監査に残る（actor, stage, vote, at） |
| W7 | Admin MCP だけで patch / inspect ができる |
| W8 | Slack（または設定口）に進捗付きカードが届く |

---

## 6. カット順

```
1) データ模型 + workflowInstance + 票テーブル／jsonb
2) エンジン（any / count / ratio / majority）+ fail_closed reject
3) finalGo 段
4) get_approval_status / カードUI進捗
5) Admin MCP get/patch/inspect
6) みらい社中プリセット文書＋試験org
並行) Stuck Watch と未投票リマインド
```

モデル: Cursor Models（Grok/Composer）既定。

---

## 7. みらい社中パイロットメモ（セットアップ）

- org: みらい社中（正式名称はヒアリングで確定）、trialDays=365  
- AI社員1: 表示名 `{名}（AIスタッフ）`  
  - 対外: Slack内外、mail draft/reply  
  - 対内: 企画・経費の一次窓口  
- 承認: 上司3人合議（2/3 or majority）＋最終Go担当1名  
- 承認口: ヒアリング次第（Slack DM推奨。Telegram非所持ならSlack）  
- クライアントはGrok Bot UIに入らない運用（スペースツリーと同じ派遣モデル）  

正式法人名・3上司・最終Go担当のIDはヒアリング後に埋める。

---

## 8. 非目標（P0外）

- 任意DAGのBPMエンジン  
- 委任・代理投票の高度ルーティング  
- 金額帯ごとの動的voter選出（P1: match に amount を足す予約のみ）  
