# P0 User-token Channel Mention Ingress — Ops Guide

**日付:** 2026-09-19  
**関連設計:** [p0-user-mention-ingress-design-20260919.md](./p0-user-mention-ingress-design-20260919.md)  
**ステータス:** PoC実装完了、フラグOFF（本番未有効化）

---

## 概要

このドキュメントは、P0 User-token channel mention ingress を有効化するためのオペレーション手順をまとめたものです。

**目的:** 外部 Slack Connect チャネルで AI社員をメンションで起こせるようにする（相手方 WS に Staffpass アプリ不要）。

---

## 1. 前提条件

### 1.1 L1 承認済みスコープ

```
User Token Scopes:
  chat:write         — postingAs=user の投稿
  users:read         — ユーザー情報取得
  channels:read      — チャネル情報取得（legacy）
  groups:read        — プライベートチャネル情報取得（legacy）
  im:history         — DM イベント受信（既存 Path B）
  files:write        — ファイルアップロード
  channels:history   — 【P0追加】public channel イベント受信
  groups:history     — 【P0追加】private channel イベント受信
```

### 1.2 禁止スコープ（要求してはならない）

- `admin.*` — 管理権限は不要
- `search:read` — 検索能力は不要
- `files:read` — D1 handoff で制御

---

## 2. Slack App 設定手順

### 2.1 User Token Scopes の追加

1. [api.slack.com/apps](https://api.slack.com/apps) → Staffpass アプリを選択
2. **OAuth & Permissions** → **User Token Scopes** セクション
3. 以下のスコープを追加:
   - `channels:history`
   - `groups:history`
4. **Save Changes**

### 2.2 User Event Subscriptions の追加

1. **Event Subscriptions** → **Subscribe to events on behalf of users** セクション
2. 以下のイベントを追加:
   - `message.channels` — public channel のメッセージイベント
   - `message.groups` — private channel のメッセージイベント
3. **Save Changes**

### 2.3 アプリ再インストール（不要な場合あり）

スコープ変更後、ワークスペース管理者による再インストールが必要な場合があります。
Slack の UI に「Reinstall your app」バナーが表示されたら従ってください。

---

## 3. 社員 re-OAuth タイミング

### 3.1 re-OAuth が必要な社員

**既存の Slack 連携済み社員は、新スコープを持っていません。**

以下の条件を満たす社員は re-OAuth が必要:
- `postingAs = "user"` で Slack 投稿を行う社員
- 外部 Slack Connect チャネルで起こされたい社員

### 3.2 re-OAuth フロー

1. Staffpass ダッシュボード → 社員設定 → Slack 連携
2. 「Slack を再連携」ボタンをクリック
3. Slack OAuth フローで新スコープを承認
4. 連携完了

### 3.3 対象社員: ともり（テスト）

| フィールド | 値 |
|-----------|-----|
| 社員名 | ともり |
| Org | Mirai |
| employeeId | `fd8ab2f7-b906-4890-8fbc-824a8b564597` |
| テストチャネル | 307room Connect `#aitest` |
| ホーム Slack ID | `U0C2B3LEAPL`（要確認: コード/データから取得） |

**re-OAuth タイミング:**
- Slack App のスコープ更新後
- このコードのデプロイ後
- フラグ有効化前（または同時）

---

## 4. フラグ有効化

### 4.1 環境変数

```bash
P0_USER_CHANNEL_MENTION_INGRESS=1
```

### 4.2 Vercel 設定

1. Vercel Dashboard → Project Settings → Environment Variables
2. `P0_USER_CHANNEL_MENTION_INGRESS` = `1` を追加
3. Production / Preview / Development 環境を選択
4. Redeploy

### 4.3 有効化前チェックリスト

- [ ] Slack App に `channels:history`, `groups:history` スコープが追加済み
- [ ] Slack App に `message.channels`, `message.groups` イベント購読が追加済み
- [ ] テスト対象社員（ともり）が re-OAuth 済み
- [ ] テストチャネル（`#aitest`）が `shared_external` または `internal` に分類済み
- [ ] G7 Bot path が Connect チャネルで動作しないことを確認（切り離し確認）

---

## 5. Yasaka / Ando タップチェックリスト

| ロック | 担当 | 内容 | 確認 |
|--------|------|------|------|
| L1 | Yasaka | User OAuth スコープ拡大承認 | ☐ |
| L2 | Ando | Connect 相手方検証（Stablo 側でイベント受信確認） | ☐ |
| L3 | Yasaka | 社員 OAuth 再フロー UX 設計承認 | ☐ |
| L4 | Yasaka | 監査フィールド仕様承認 | ☐ |
| L5 | Ando | ロールアウト戦略（feature flag vs 一括） | ☐ |

---

## 6. Connect チャネルの注意事項

### 6.1 チャネルメンバーシップ要件

Connect チャネル `#aitest` で AI社員を起こすには:

1. **AI社員の user token がそのチャネルにアクセスできる必要がある**
2. これは AI社員のホーム Slack identity（例: `U0C2B3LEAPL`）が:
   - Connect チャネルのメンバーである、または
   - 招待されている
3. **相手方 WS（307room）に Staffpass アプリは不要**

### 6.2 イベント受信フロー

```
1. 相手方ユーザー (Stablo) が #aitest で @ともり をメンション
2. Slack が User-token event を Staffpass webhook に送信
   - envelope.team_id = T_STABLO (発言者のチーム)
   - authorizations[].team_id = T_MIRAI (購読者のチーム)
   - authorizations[].user_id = U0C2B3LEAPL (ともりの Slack ID)
3. Staffpass が明示マップ照合 (DL-2)
4. 分類済みチャネル + バインド済み社員 → wake
5. 未分類/未バインド → skip + 監査
```

---

## 7. トラブルシューティング

### 7.1 イベントが届かない

1. Slack App の Event Subscriptions が有効か確認
2. Request URL が正しいか確認: `https://staffpass.sealith.com/api/webhooks/slack/events`
3. `message.channels` / `message.groups` が購読されているか確認
4. 社員が re-OAuth 済みか確認

### 7.2 wake されない

1. フラグ `P0_USER_CHANNEL_MENTION_INGRESS=1` が設定されているか確認
2. チャネルが分類済み（`internal` or `shared_external`）か確認
3. 社員の Slack identity がバインド済みか確認
4. 監査ログで skip reason を確認

### 7.3 監査ログの確認

```sql
SELECT * FROM audit_events 
WHERE action IN (
  'slack.user_token_channel_wake',
  'slack.user_token_channel_wake_skipped'
)
ORDER BY created_at DESC
LIMIT 50;
```

---

## 8. ロールバック手順

フラグを OFF にするだけで、既存の Bot mention ingress / G7 path に影響なく無効化できます。

```bash
P0_USER_CHANNEL_MENTION_INGRESS=0
# または環境変数を削除
```

---

## 9. 次のステップ（Out of Scope for this PR）

- [ ] 本番フラグ ON
- [ ] Token rotation / credential lease 本実装 (DL-1)
- [ ] Revoke / re-OAuth UX polish (L3)
- [ ] Connect Stablo L2 検証環境
- [ ] `channels:read` / `groups:read` / `files:write` の整理（別クリーンアップ）

---

## 変更履歴

| 日付 | 著者 | 内容 |
|------|------|------|
| 2026-09-19 | Agent | 初版作成。P0 PoC 実装に合わせたオペレーションガイド |
