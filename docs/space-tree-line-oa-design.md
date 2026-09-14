# Space Tree パイロット — LINE OA 承認・会話窓口 設計（正本）

**対象:** Space Tree（スペースツリー）テナント / デモ組織  
**ステータス:** 設計ロック（P0 実証オペ向け）  
**更新:** 2026-09-14  
**読者:** 導入伴走・運用・エンジニア

---

## 決定サマリ

| 項目 | 決定 |
|------|------|
| **North star** | 上長承認を Telegram から **LINE Messaging API（公式アカウント / OA）** へ移行。会話窓口も OA 近似（個人 LINE 代理はしない） |
| **社内 Slack（Ando Path B）** | TOKYO307 / Ando 社内オペ・PDF / `comm.reply` Path B は **維持**。Space Tree 対外・対上長は LINE OA |
| **資格情報の分離** | 承認用 LINE（`org_notification_channels`）と 会話用 LINE（`org_conversation_adapters` surface=`line`）は **別カード・別 secret**。Slack の「承認 vs 会話投稿」と同型 |
| **表示名** | OA 名は AI 窓口を明示（例: `Staffpass｜スペースツリー` / `安藤（AI窓口）`）。人間個人 LINE の **無告知なりすまし禁止** |
| **P0 スコープ** | **承認のみ**（実装ほぼ既存）。コード変更は原則ゼロ |
| **P1 / P2** | OA 会話スタブ → 本実装。**別 GO**。本パイロット P0 には含めない |

**実装 GO は設計ロック後**（P0 は既存実装のテナント設定・オペ実証）。

---

## 背景（コード上すでに真）

Staffpass には LINE 承認インフラが **すでに存在** する。本設計は新規発明ではなく、Space Tree テナントへの **切替方針とフェーズ分割** を固定する。

| レイヤ | 現状 |
|--------|------|
| 承認インボックス | `org_notification_channels` に `telegram` / `line` / `slack` |
| LINE 通知 | `lib/notify/line.ts` — Flex 承認カード、postback 承認/却下/修正依頼、署名検証、`allowedUserIds`、`destinationId`（user / group / room） |
| Webhook | `/api/webhooks/line/<ref>` — 承認解決（callback token は DB 上 `telegramRef`、名称は歴史的） |
| 設定 UI | 「承認を受け取る」→「**承認用LINE**」— destinationId / channelAccessToken / channelSecret / allowedUserIds。secret は AES-GCM 暗号化、再表示なし |
| テナント手順 | [telegram-approval.md](./guides/telegram-approval.md) LINE 節 |
| 会話アダプタ | DB surface に `line` あり。**ダッシュボード/API は Slack のみ**（`surface !== "slack"` → unsupported）。LINE 会話窓口は **予約 / 未出荷** |
| Slack Path B | ユーザートークン / 個人名義 — **LINE 相当なし**（Messaging API は OA プッシュのみ） |

---

## ロール分担（推奨）

```
┌─────────────────────────────────────────────────────────────┐
│ TOKYO307 / Ando 社内オペ                                     │
│   Slack Path B — Staffpass wake, PDF, comm.reply 内部        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Space Tree パイロット                                        │
│   LINE OA — 上長承認（P0）                                   │
│   LINE OA — 顧客/現場 会話窓口（P1/P2、別 GO）               │
└─────────────────────────────────────────────────────────────┘
```

- **混在禁止:** 承認用 LINE チャネル secret を会話アダプタに流用しない（Slack と同じ分離原則）。
- **Telegram:** Space Tree テナントの承認経路からは **無効化または demote**（二重送信の混乱防止）。他テナントは影響なし。

---

## 表示名・プロフィール（推奨）

| 要素 | 方針 |
|------|------|
| OA 表示名 | `Staffpass｜スペースツリー` または `安藤（AI窓口）` 等、**AI 窓口であることを明示** |
| プロフィール bio | 1 行 — 「AI 社員が Staffpass 経由で動作」「上長承認あり」 |
| 将来 F6 identity-disclosure | パイロット段階は OA 名/bio での開示で足りる |

個人 LINE アカウントの自動操作（Path B 相当）が将来必須になった場合 → **非対応 / 要別設計**（LINE Login + Messaging user-link またはパートナー API）。**本パイロットの対象外。**

---

## 監査・egress・always_human

| テーマ | 方針 |
|--------|------|
| 承認通知 | **notification-channel クラス**（会話アダプタではない） |
| always_human | ポリシー上 always_human の承認は維持。LINE postback タップ = Telegram と同型の **人間操作面** |
| 自己承認拒否 | LINE webhook に **既存配線**（`isSelfApprovalDenied`）。維持 |
| 会話 egress（P1/P2） | `reply_policy` / `parties` / `channels.classify` パターンを再利用。LINE 外部相手は相手台帳。送信はポリシー解決まで **always_human** |
| Secret | 既存 notification / adapter 暗号（AES-GCM）。raw token を API/画面に返さない |

---

## フェーズ分割

### P0 — 承認のみ（実装ほぼ既存・実証オペ）✅ 本パイロット

**目的:** Space Tree 上長が LINE OA で Flex 承認三択を受け取り、postback で poll / ダッシュボードに反映されることを実証する。

| ステップ | 内容 |
|----------|------|
| 1 | Space Tree テナント用 LINE Messaging API チャネル作成 |
| 2 | `/app/settings` **承認用LINE** — `destinationId` = 上長 userId またはグループ ID、tokens、`allowedUserIds` = 上長（+ 代理） |
| 3 | 設定カードの Webhook URL を LINE Developers に登録、Webhook 有効化、検証 + テスト送信 |
| 4 | AI 社員の承認インボックスを当該 LINE チャネルへ（デフォルト or 社員別） |
| 5 | 当テナントの Telegram 承認経路を無効化 / demote |
| 6 | 本 doc のキックオフチェックリストで受け入れ |

**コード:** 原則 **ゼロ**。real blocker（例: userId 取得手順の doc 穴）のみ doc 追記。

**参照:** [telegram-approval.md — LINE（テナント設定）](./guides/telegram-approval.md#lineテナント設定)

---

### P1 — OA 会話スタブ（設計ロック後・別 GO）

| 項目 | 方針 |
|------|------|
| DB / UI | `org_conversation_adapters` surface=`line` upsert + **承認用 LINE とは別** settings カード |
| Ingress | 承認 webhook と **別 path** 推奨、または共有 webhook でイベントルーティング（postback vs 自由文 wake）— **選定とリスクを doc 化** |
| 最小機能 | テキスト受信 → AI 社員 wake（メンションなし DM 相当）+ 監査。返信は push スタブ（always_human） |
| 禁止 | 個人アカウントリンク |

---

### P2 — OA 会話本実装（別 GO）

- フル `comm.reply` / ファイル meta / `reply_policy` / `parties` / グループ mouth
- Flex テンプレート、リッチメニュー（任意）
- **依然 OA のみ**。個人 LINE は **非対応**

---

## Space Tree キックオフチェックリスト

P0 実証オペ用。P1/P2 は **明示的に対象外**。

### A. LINE OA 準備

- [ ] LINE Developers で Messaging API チャネル作成（Space Tree テナント専用）
- [ ] Messaging API 有効化
- [ ] Channel access token（**長期**）発行・安全保管
- [ ] Channel secret を控える
- [ ] OA 表示名を決定（AI 窓口明示。例: `Staffpass｜スペースツリー`）
- [ ] プロフィール bio に AI 社員 + 上長承認の 1 行を記載

### B. 上長 userId / グループ

- [ ] 上長に OA を友だち追加してもらう
- [ ] userId 取得 — **方法 A:** Webhook の `follow` イベントを Staffpass 側ログ/監査で確認  
- [ ] userId 取得 — **方法 B:** [LINE Official Account Manager](https://manager.line.biz/) のユーザー一覧  
- [ ] （任意）上長 + 代理者のグループトーク作成 → groupId を destinationId に使用
- [ ] `allowedUserIds` に上長（+ 代理）の userId を設定

### C. Staffpass 設定

- [ ] `/app/settings` →「承認を受け取る」→「**承認用LINE**」
- [ ] destinationId / channelAccessToken / channelSecret / allowedUserIds を入力して保存
- [ ] 表示された Webhook URL（`/api/webhooks/line/<ref>`）を LINE Developers に貼付
- [ ] 「Webhook の利用」を ON → 検証成功
- [ ] テスト送信で Flex カード到達を確認

### D. 承認経路切替

- [ ] AI 社員（または org デフォルト）の承認インボックスを LINE チャネルへ
- [ ] 当テナント Telegram 承認を OFF または secondary に（**二重送信しない**）
- [ ] force-approval ツールで E2E: Flex → 承認 postback → poll `approved` → ダッシュボード一致

### E. 受け入れ確認

- [ ] Flex 三択: 承認 / 却下 / 修正依頼 が poll / callback に反映
- [ ] 修正依頼 → テキスト返信 → `revision_requested` + `revisionNote` 保存
- [ ] 自己承認拒否（依頼者本人タップ）が LINE 側でブロックされる
- [ ] secret 不一致 → 401、送信先 / user / テナント不一致 → 処理されない
- [ ] 監査ログに設定変更・テスト送信・配信結果が残る

### F. スコープ外（P0 でやらない）

- [ ] ~~LINE 会話アダプタ（P1/P2）~~
- [ ] ~~個人 LINE アカウント代理~~
- [ ] ~~TOKYO307 社内 Slack Path B の置換~~
- [ ] ~~Sealith commerce on LINE~~

---

## 既存実装メモ（エンジニア向け）

| 項目 | 場所 |
|------|------|
| Flex + postback | `lib/notify/line.ts` — `a:` / `r:` / `e:` + `telegramRef` |
| Webhook | `app/api/webhooks/line/[ref]/route.ts` |
| 設定 UI ラベル | `components/NotificationChannelsClient.tsx` — `承認用LINE` |
| 会話（未出荷） | `app/api/settings/conversation-adapters/route.ts` — Slack のみ |
| テナント手順 | `docs/guides/telegram-approval.md` |

---

## Out of scope（本パイロット）

- 個人 LINE アカウント自動化 / Slack Path B 相当
- TOKYO307 社内オペの Slack 置換
- Sealith commerce on LINE
- 個人 LINE 必須化 → **非対応 / 要別設計**（将来ロードマップのみ）

---

## 関連ドキュメント

- [telegram-approval.md — LINE テナント設定](./guides/telegram-approval.md)
- [approval-loop-runbook.md](./guides/approval-loop-runbook.md)
- [reply-policy.md](./reply-policy.md)
- [egress-policy.md](./egress-policy.md)

---

**実装 GO は設計ロック後。** P0 は上記チェックリストによる設定・オペ実証。P1/P2 は別 GO で起票する。
