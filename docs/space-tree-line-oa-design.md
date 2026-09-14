# Space Tree パイロット — LINE OA 承認・会話窓口 設計（正本）

**対象:** Space Tree（スペースツリー）テナント / デモ組織  
**ステータス:** **設計ロック済（2026-09-15）** — 実装GO可（P0オペ先行可 / P1は別実装チケット）  
**更新:** 2026-09-15  
**読者:** 導入伴走・運用・エンジニア

---

## 決定サマリ

| 項目 | 決定 |
|------|------|
| **North star** | **LOCKED:** 上長承認を Telegram から **LINE Messaging API（公式アカウント / OA）** へ移行。会話窓口も OA 近似。**個人 LINE 代理はしない** |
| **社内 Slack（Ando Path B）** | **LOCKED:** TOKYO307 / Ando 社内オペ・PDF / `comm.reply` Path B は **維持**。Space Tree 対外・対上長は LINE OA（承認 + 口） |
| **資格情報の分離** | **LOCKED:** 承認用 LINE（`org_notification_channels`）と 会話用 LINE（`org_conversation_adapters` surface=`line`）は **別カード・別 secret**。Slack の「承認 vs 会話投稿」と同型 |
| **表示名** | **LOCKED:** `{employeeDisplayName}（AIスタッフ）`（§P1-e）。テナント共通・安藤ハードコード禁止。静かな本人偽装は禁止 |
| **P0 スコープ** | **LOCKED:** **承認のみ**（実装ほぼ既存）。オペ実証。**P0 単独ではロックしなかった** — P0+P1 セットでロック済 |
| **P1 スコープ** | **LOCKED:** OA 会話スタブ — **実装仕様まで本 doc で固定** |
| **P2** | **LOCKED:** 会話本実装。**別 GO**（本ロック対象外） |

**設計ロック済（2026-09-15）。** 実装 GO 可 — P0 オペ先行可 / P1 は別実装チケット。課金概算は安藤突合 OK。

---

## ロック記録

| 項目 | 内容 |
|------|------|
| **日付** | 2026-09-15 |
| **経路** | 安藤 / 八坂 設計ロック GO |
| **表示名** | `{employeeDisplayName}（AIスタッフ）` — テナント共通。`employeeDisplayName` は発行 AI 社員の displayName（例: displayName `安藤` → `安藤（AIスタッフ）`）。**安藤ハードコード禁止** |
| **ロック範囲** | P0 承認 LINE + P1 会話 OA スタブ（P0 単独はロック対象外 — **P0+P1 をセットでロック**） |

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
│   LINE OA — 上長承認（P0）+ 会話窓口スタブ（P1）             │
│   設計ロック = P0+P1 セット。P2 会話本格は別 GO              │
└─────────────────────────────────────────────────────────────┘
```

- **混在禁止（ストア）:** 承認用 LINE と会話用 LINE の **DB ストアは別**（`org_notification_channels` vs `org_conversation_adapters`）。運用上は同一 channel access token を両カードに貼ることは **許容**（Slack 同型）。
- **Telegram:** Space Tree テナントの承認経路からは **無効化または demote**（二重送信の混乱防止）。タイミングは P0 オペ GO に合わせる。他テナントは影響なし。

---

## 表示名・プロフィール

**LOCKED** — テナント共通ルール（安藤ハードコード禁止）。詳細は §P1-e。

| 要素 | 方針 |
|------|------|
| **OA 表示名** | `{employeeDisplayName}（AIスタッフ）` — `employeeDisplayName` は当該 AI 社員の displayName |
| **プロフィール一文** | §P1-e テンプレート参照（本人LINE代行ではない旨 + Staffpass AI 社員 + 上長承認） |
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

### P0 / P1 / P2 境界

| フェーズ | 内容 | 設計ロック | 実装 GO |
|----------|------|------------|---------|
| **P0** | 承認のみ（Flex + postback）。既存コード + テナント設定・オペ実証 | **LOCKED**（P1 とセット。**P0 単独ではロックしなかった**） | **GO**（オペ先行可） |
| **P1** | OA 会話スタブ — text wake / always_human push / webhook ルーティング | **LOCKED**（本 doc の P1 節） | 別実装チケット |
| **P2** | 会話本実装（reply_policy フル、ファイル、Flex 業務等） | **LOCKED: 別 GO** | 別 GO |

---

### P0 — 承認のみ（実装ほぼ既存・実証オペ）

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

### P1 — OA 会話スタブ（実装仕様・設計ロック対象）

P0 承認と **同一 OA** で会話の「口」を足す。本節が P1 実装の正本。**設計ロック済（P0+P1 セット）。** 実装は別チケット。

#### (a) 受信 wake ＋ push の境界

| 方向 | 経路 | 課金 | 備考 |
|------|------|------|------|
| **Ingress** | LINE webhook — user / group からの **text**（将来 **image meta**） | — | Staffpass が AI 社員を起こす。Slack Path B の mention-less DM に相当する「口」 |
| **Egress（即時 ACK）** | Webhook イベントへの応答 | **Reply**（無料） | 受信確認・軽い応答は可能なら Reply に寄せる |
| **Egress（本文）** | AI 社員 → 相手 | **Push**（課金） | 非同期ジョブ完了後の業務本文は Push |

**P1 最小:** text in → wake + audit →（always_human 承認後）text push out。ファイル本配送・Flex リッチは **P2**。

#### (b) 承認 Webhook とのイベント分離 — **LOCKED**

**同一 Messaging API チャネル／同一 webhook URL を共有**し、ルーティングで分離する（**正本に固定**）。

| イベント | ルーティング |
|----------|--------------|
| postback `a:` / `r:` / `e:` + 承認配信記録あり | 既存承認ハンドラ（`/api/webhooks/line/<ref>` 現行ロジック） |
| 上記以外の text（承認待ち修正テキスト状態でない） | **会話 ingress ハンドラ** |

**リスク・運用:**

- 同一 OA・同一口。設定画面では「承認用 LINE」と「会話投稿 LINE」の **秘密は別ストア** だが、運用上 **同じ channel access token を両方に貼ることを許容**（Slack 同型）。
- **代替（非推奨）:** 会話専用 OA を分ける → 友だち追加・表示名が二重。**P1 では採らない**。

#### (c) always_human

- 会話 **outbound（Push）** は初期 **always_human**（`comm.reply` 相当）。人間承認後にのみ Push 送信。
- 承認タップは既存承認 inbox（LINE Flex）またはダッシュボード。
- Admin の adapter 秘密登録も always_human（Slack `setup.slackAdapter.setBotToken` と同型を将来）。
- **自己承認拒否**を会話経路にも適用（依頼者本人への outbound ブロック）。

#### (d) 秘密分離

| ストア | 用途 | UI ラベル |
|--------|------|-----------|
| `org_notification_channels` | 承認口（既存） | 「承認を受け取る」→ **承認用 LINE** |
| `org_conversation_adapters` surface=`line` | 会話口（P1 で API/UI を slack 以外も許可） | **会話投稿（LINE OA）** |

画面ラベルで混同防止。raw token は保存後に再表示しない。

#### (e) OA 表示名 — **LOCKED**

| 要素 | ルール |
|------|------|
| **表示名** | `{employeeDisplayName}（AIスタッフ）` |
| **例** | AI 社員 displayName が `安藤` の場合 → `安藤（AIスタッフ）` |
| **適用** | テナント共通。表示名に **安藤等をハードコードしない** — 常に当該 AI 社員の `displayName` を使う |
| **プロフィール一文（テンプレート）** | 「{employeeDisplayName}はStaffpass上のAI社員です。本人LINE代行ではありません。重要な操作は上長承認があります。」 |

静かな本人偽装は禁止。

#### (f) 運用モデル（OA 近似）

| パターン | 運用 |
|----------|------|
| **個人対上長** | 上長が OA を友だち追加 → 1:1 トーク。分類は **userId** |
| **個人対グループ** | OA をグループに招待 → グループトーク。**Push はメンバー人数分課金** |
| **禁止** | 「安藤個人 LINE の代行」ではない。**OA が窓口** |

#### (g) コスト影響

- 会話 **outbound Push** は通数に乗る。Reply のみの ACK は乗らない。
- **P0 承認分 + P1 会話 Push** の合計では **コミュニケーション（200 通/月）では足りない想定** → **ライト（¥5,000 / 5,000 通）推奨**（§課金・コスト概算 C 参照）。

#### (h) 実装スコープ

**やる（P1）:**

- `conversation-adapters` API/UI で `surface=line`（channelAccessToken + channelSecret、enabled）
- 会話用イベント経路（承認 postback と **同一 webhook ルーティング分離**）
- text wake → AI 社員（employee 解決: Slack IM route 相当のルート表 or **単一デフォルト社員** — Space Tree パイロットは後者から可）
- outbound push stub + always_human + audit
- 本 doc / キックオフ追記

**やらない（P1 → P2）:**

- `reply_policy` フル、parties 本格、ファイル本文配送、Flex 業務テンプレ、リッチメニュー
- multicast / broadcast、個人 LINE 連携、Path B 相当

#### (i) 受け入れ条件（P1）

1. 上長 1:1 で text → AI 社員が起きる（**監査に残る**）
2. always_human の outbound が承認後に **Push** で届く
3. **同じ OA** で承認 Flex の approve/reject/revise が **壊れない**（回帰）
4. secret が承認カード・会話カードに **再表示されない**
5. グループ 1 通 = **人数通** になることを手順書に明記

---

### P2 — OA 会話本実装（別 GO）

- フル `comm.reply` / ファイル meta / `reply_policy` / `parties` / グループ mouth
- Flex テンプレート、リッチメニュー（任意）
- **依然 OA のみ**。個人 LINE は **非対応**

---

## 課金・コスト概算

Messaging API の月額・通数課金を前提に、Space Tree 実証のコスト幅を固定する。**安藤側概算と突合 OK（2026-09-14）。** 公式プラン名・単価・根拠 URL を明記する。金額は **税別**。見積時点は 2026-09-14 公開ページベース — **契約前に公式ページを再確認すること**。

### 根拠 URL

| 用途 | URL |
|------|-----|
| OA プラン一覧 | https://www.lycbiz.com/jp/service/line-official-account/plan/ |
| Messaging API 料金 | https://developers.line.biz/ja/docs/messaging-api/pricing/ |
| カウント対象の定義 | https://help.linebiz.com/lineadshelp/s/article/L000001124 |

**改定注記（見積再確認必須）**

- **2026-10-01** — スタンダードプラン追加メッセージ従量単価改定
- **2026-12-01** — プレミアム ID 関連改定

---

### 公式プラン（税別）

| プラン名 | 月額固定費 | 無料メッセージ | 追加メッセージ |
|----------|------------|----------------|----------------|
| **コミュニケーションプラン** | ¥0 | 200 通/月 | 不可（超過分は送れない） |
| **ライトプラン** | ¥5,000 | 5,000 通/月 | 不可 |
| **スタンダードプラン** | ¥15,000 | 30,000 通/月 | 従量（目安 〜¥3/通 税別、配信帯で逓減。**2026-10-01 改定あり**） |

- 開設時は **コミュニケーションプラン**。機能差はなく **通数枠の差のみ**。
- チャット Pro 等のオプションは **本実証の必須要件ではない**（承認 Flex + postback の P0 には不要）。

---

### 何が課金通数に入るか（Messaging API）

| API / 経路 | 課金 |
|------------|------|
| **Push** / **Multicast** / **Broadcast** / **Narrowcast** | **カウントされる** |
| **Reply API**（`replyToken` 付き） | **カウントされない** |
| OA マネージャのチャット送受信・応答・あいさつ | **カウントされない** |

**カウント単位:** 「送信対象となった **人数**」。グループへ 1 回 Push しメンバーが 5 人いれば **5 通**。1 リクエスト内の吹き出し数（最大 3）は通数に **乗らない**（人数ベース）。

---

### Staffpass 実装との対応（既存コード）

| 処理 | 実装 | 課金 |
|------|------|------|
| 承認 Flex カード送付 | `sendApprovalToLineChannel` → `/v2/bot/message/push` | **Push → 課金対象** |
| postback 後の即時応答（修正依頼プロンプト等） | `sendLineText` + `replyToken` | **Reply → 無料** |
| 解決後の追記 | `resolveLineApprovalMessage` → `sendLineText`（replyToken なし） | **Push → 課金対象** |
| 会話 OA（P1+）の業務 outbound | push 想定 | **課金** |
| ユーザー発話への即時 reply | reply 経路 | **無料寄り** |

**設計メモ:** `resolveLineApprovalMessage` は現状 replyToken なし Push のため **1 承認あたり最大 2 通**（カード + 追記）になりうる。コスト最適化が必要なら、可能な限り **reply 経路を優先**（P0 必須変更ではない — 実測後に検討）。

---

### スペースツリー実証 — 仮定シナリオ（概算・税別）

以下は **概算用の仮定**。実運用前に月次 Push 実測で補正する。

#### 仮定パラメータ（共通）

| パラメータ | Low | Mid | High |
|------------|-----|-----|------|
| 月間承認件数 | 30 | 100 | 300 |
| 1 承認あたり課金 Push 通数 | 1〜2 通/件（カード Push 1 + 解決追記 Push 0〜1。Reply 確認は 0） | 同左 | 同左 |

---

#### A. P0 承認のみ — 上長 1:1（`destinationId` = userId）

| シナリオ | 月 Push 概算 | 推奨プラン | 月額コスト概算（税別） |
|----------|--------------|------------|------------------------|
| Low（30 件 × 1〜2） | 30〜60 通 | コミュニケーション（200 通） | **¥0**（枠内） |
| Mid（100 件 × 1〜2） | 100〜200 通 | コミュニケーション（200 通）で下限は足りうる。**上限〜 High はライト推奨** | **¥0** または **¥5,000** |
| High（300 件 × 1〜2） | 300〜600 通 | **ライト**（5,000 通） | **¥5,000** |

- **スタンダード（¥15,000）は P0 承認のみでは不要想定。**

---

#### B. P0 承認 — グループ宛（メンバー数 M）

**1 Push = M 通（人数倍）。** グループ destination はコストが **メンバー数倍** になる。

| 例（Mid 100 件、平均 1.5 Push/件、M=5） | 計算 | 結果 |
|------------------------------------------|------|------|
| 100 × 1.5 × 5 | ≈ **750 通/月** | **ライト推奨**（コミュ 200 通では不足） |

| M | Mid 100 件 × 1.5 Push/件 の月通数目安 |
|---|--------------------------------------|
| 3 | ≈ 450 通 → ライト推奨 |
| 5 | ≈ 750 通 → ライト推奨 |
| 10 | ≈ 1,500 通 → ライト枠内だが余裕少 |

---

#### C. P1 以降 — 会話 OA 近似（承認に加算）

| 追加仮定 | Low | Mid | High |
|----------|-----|-----|------|
| 業務 outbound Push / 月（承認分 **別途**） | 200 | 1,000 | 5,000 |

| 合計イメージ（Mid: 承認 100〜200 + 会話 1,000） | 推奨 |
|--------------------------------------------------|------|
| ≈ 1,100〜1,200 通/月 | **ライト**（5,000 通）で当面足りうる |
| 承認 + 会話で **5,000 通超** が見込める | **ライト上限 → スタンダード**（¥15,000 + 超過従量） |

- **Multicast** — 複数宛先一斉は **人数 × 通**。
- **Broadcast** — 友だち全員配信は **爆発しうる**。**実証では原則禁止**（設計・運用ルールで抑止）。

---

### 推奨（コスト・運用）

| # | 推奨 |
|---|------|
| 1 | **P0+P1 開始時点**は **ライトプラン推奨**（承認 + 会話 Push 合算。コミュ 200 通は P1 込みでは不足想定） |
| 2 | P0 承認のみの期間だけなら **コミュニケーション** も可 — 上長は **1:1 userId** 推奨 |
| 3 | **グループは人数倍コスト** — 必要時のみ |
| 4 | **スタンダード** は P2 本格化 or ブロードキャスト用途が出てから |
| 5 | **2026-10-01** 追加メッセージ改定・**2026-12-01** プレミアム ID 改定 — **見積は都度公式ページ再確認** |

---

## Space Tree キックオフチェックリスト

P0 オペ実証用。**P1 実装仕様は本文 P1 節参照 — 設計ロック済。P0 オペ先行可 / P1 は別実装チケット。** P2 は別 GO。

### A. LINE OA 準備

- [ ] LINE Developers で Messaging API チャネル作成（Space Tree テナント専用）
- [ ] Messaging API 有効化
- [ ] Channel access token（**長期**）発行・安全保管
- [ ] Channel secret を控える
- [ ] OA 表示名を **Space Tree AI 社員の `displayName` + `（AIスタッフ）`** に設定（例: displayName `安藤` → `安藤（AIスタッフ）`）
- [ ] プロフィール bio に §P1-e テンプレート（本人LINE代行ではない旨 + Staffpass AI 社員 + 上長承認）を記載

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

### F. P0 キックオフでやらない / ロック後

- [ ] ~~LINE 会話アダプタ実装~~ → **P1 仕様は本文 §P1。別実装チケット**
- [ ] ~~P2（reply_policy フル、ファイル、Flex 業務等）~~ → 別 GO
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
| Admin MCP 診断 | `setup.lineApprovalStatus` — `lib/line/line-approval-status-diagnose.ts` |
| Admin MCP 設定 | `setup.lineApproval.upsert` / `setEmployeeInbox` / `demoteTelegram` — `lib/mcp/admin-tools.ts` |

---

## Admin MCP（Space Tree キックオフレール）

Slack の `setup.slackStatus` / `setup.slackAdapter.setBotToken` と同型で、**承認インボックス用 LINE** の設定を管理 MCP から進められます。

| ツール | 用途 | 承認 |
|--------|------|------|
| `setup.lineApprovalStatus` | LINE 承認チャネル診断（channels / Telegram 衝突 / employeeInboxSummary / nextStepJa） | なし |
| `setup.lineApproval.upsert` | `org_notification_channels` provider=`line` の登録・更新 | always_human |
| `setup.lineApproval.setEmployeeInbox` | 社員別 `approvalChannelId` を LINE へ（または既定へクリア） | always_human |
| `setup.lineApproval.demoteTelegram` | Telegram 承認経路の無効化（`disable` / `clearDefault`） | always_human |

**混同注意:** 承認用 LINE（本ツール群）≠ 会話投稿 LINE（P1 予定）≠ Slack 会話投稿アダプタ。

**canonical `nextStepJa` 順序:**

1. LINE OA / Messaging API 作成（人間）
2. OA 表示名 `{employeeDisplayName}（AIスタッフ）`（人間・§P1-e）
3. 上長が OA を友だち追加 → userId 取得（人間）
4. `setup.lineApproval.upsert` + 人承認
5. Webhook URL を LINE Developers に貼付 + 有効化（人間・自動登録不可）
6. テスト送信 / Flex 承認
7. `setup.lineApproval.setEmployeeInbox` + `setup.lineApproval.demoteTelegram`

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

**設計ロック済（2026-09-15）。** 表示名 = `{employeeDisplayName}（AIスタッフ）`（§P1-e）。実装 GO 可 — P0 オペ先行可 / P1 は別実装チケット。課金・コスト概算は安藤突合 OK。P2 は別 GO。
