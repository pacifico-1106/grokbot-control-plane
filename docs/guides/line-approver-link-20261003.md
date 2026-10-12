# LINE 承認チャネルの改善（2026-10-03）

対象: `app/api/webhooks/line/[ref]/route.ts`、`app/api/settings/line-approver-link/route.ts`、`lib/line/*`、`lib/notify/line.ts`、`lib/employees/approval-inbox.ts`、`lib/approval-workflow/voter-binding.ts`

元資料: `/workspace/p0/line/line-approval-checklist-spacetree.md`（G1〜G9）

## フラグなしで常に有効になる変更（厳格化のみ）

| 変更 | 以前 | 以後 | フラグを付けない理由 |
|---|---|---|---|
| G3 未知の `<ref>` | 200 `{ok:true, ignored:true}` | **404** `{ok:false,error:"not_found"}`（本文は読まない） | 正しい URL への応答は変わらない。違う URL で LINE の「検証」が成功してしまうのを防ぐだけ。チャネルが存在するかどうか以外の情報は返さない |
| 署名不一致 | 401 | 401（変更なし。ref が見つかってから署名を検証する） | — |
| 押した人の `userId` が無い postback | `line:unknown` として処理しうる | 「LINE のユーザーを確認できない」と返信して拒否 | 本人が誰か分からない操作を通さない |
| 承認に `employeeId` があるのに社員を読めない | 承認者リスト未設定と同じ扱い（全員許可） | 拒否 | 読み込みに失敗したら閉じる（fail-closed） |
| userId の無い修正依頼テキスト | `line:unknown` で検索 | 無視 | 同上 |

## フラグ（すべて既定 OFF。OFF なら今の本番と同じ動き）

| フラグ | 内容 |
|---|---|
| `LINE_APPROVER_LINK_ENABLED` | G1/G4 連携コード。設定画面で本人用の 1 回限りのコード（`SP-XXXX-XXXX`、有効 15 分）を発行する。公式アカウントとの 1:1 トークでそのコードを送ると、`approval_workflow_voter_bindings` に確認済みの紐付け（組織 × チャネル × LINE userId → メンバー）を作る。確認できた LINE userId は設定画面に表示するだけで、許可 ID・承認者 ID には**自動で入れない** |
| `LINE_APPROVER_BINDING_MATCH` | G2。社員の `approverUserIds` に、生の LINE userId に加えて次の形でも書けるようにする。`line:<userId>`、または確認済みの紐付けを通したメンバー ID / Auth ユーザー ID（同じ組織の active なメンバーに限る） |
| `LINE_WORKFLOW_REVISION_REPLY` | G5。合議（ワークフロー）中の承認に LINE から修正依頼が来たら、黙って無視せず「LINE からの修正依頼は受け付けできない。承認・却下を選ぶか Staffpass で対応してほしい」と返信する |
| `LINE_RESOLVE_FOLLOWUP_REPLY` | G7。承認・却下のあとの「✅ 承認済み …」の追加通知を、有料の Push ではなく同じ Reply にまとめて送る。Reply が失敗したときは Push で送り直す |

## 本番での手順（実行は八坂さん・木村さんの判断）

1. migration `supabase/migrations/20261003180000_line_approver_link_codes.sql` を適用する。`LINE_APPROVER_LINK_ENABLED` を ON にする前に必須。
2. `VOTER_BINDING_SECRET` が本番で設定されていることを確認する（既存の紐付けでも必須。未設定ならコード発行 API は 503 を返す）。
3. Vercel env で必要なフラグを `true` にする。順番は `LINE_APPROVER_LINK_ENABLED`（承認者に連携してもらう）、次に `LINE_APPROVER_BINDING_MATCH`（承認者 ID をメンバー ID で書く場合）。`LINE_WORKFLOW_REVISION_REPLY` と `LINE_RESOLVE_FOLLOWUP_REPLY` はそれぞれ単独で ON にできる。
4. LINE Developers コンソール
   - Webhook URL は設定画面に出る `/api/webhooks/line/<ref>` を正確に入れる。間違った URL では「検証」が**失敗する**ようになった（404）。
   - 応答設定は「Webhook: ON」「応答メッセージ: OFF」を推奨（自動応答と連携コードへの返信が重ならないように）。
   - あいさつメッセージに「Staffpass の設定画面で発行した連携コードを、このトークに送ってください」と書いておくと案内しやすい。
5. 承認者（例: Space Tree の野木さん）の手順: Staffpass にログイン → 設定 → 承認を受け取る（LINE）→「連携コードを発行」→ LINE の 1:1 トークにコードを送る →「確認しました」と返信が来る → 設定画面の「確認済み LINE ユーザー ID」を、管理者が許可user ID または承認者 ID に貼る。

## やっていないこと（後続）

- **v2.1 チャネルアクセストークンの自動更新**: 今は設定画面に保存された long-lived token をそのまま使っている。自動更新には channel ID と secret による stateless token の発行（`/oauth2/v3/token`）、キャッシュ、失効時の再発行が必要になる。保存する秘密情報と外部への通信が増えるので、このPRには入れていない。当面は long-lived token（期限なし）を使う運用とする。
- **follow イベント**: 今も無視している。友だち追加だけでは本人かどうか証明できないので、自動では紐付けない（設計どおり）。
- G8（LINE を会話の窓口にする）は対象外。
