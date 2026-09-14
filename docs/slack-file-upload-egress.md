# Slack ファイル添付エグレス (comm.reply / comm.send)

> **P0 リリース**: Yasaka GO Staffpass Slack egress PDF attach

## 概要

`comm.reply` / `comm.send` で Slack スレッドへ PDF などのファイルを添付送信する機能。バイナリデータは LLM コンテキストを経由せず、Gateway が直接 Slack API へアップロードします。

## Egress ポリシー（P0 制約）

| 条件 | 判定 | 理由 |
|------|------|------|
| 社内 + スレッド指定あり | **許可** | boss DM / 社内スレッドのみ |
| 社外 / 混在チャネル | **拒否** | ファイル本文は社外送信不可 |
| 宛先未確認 (unknown) | **拒否** | fail-closed |
| thread_ts なし | **拒否** | スレッド指定必須 |

**本文のみの送信は egress マトリクス通り**（summarize / allow / deny）。ファイル添付が拒否されても本文は送信される場合があります。

## Slack API フロー (files.uploadV2)

```
1. files.getUploadURLExternal → upload_url + file_id 取得
2. PUT upload_url ← バイナリアップロード
3. files.completeUploadExternal → channel + thread_ts へ共有
```

## 必要スコープ

### `files:write`

> **重要**: Public Distribution Slack App で `files:write` スコープを追加する場合、再インストールが必要です。スコープ追加は人間の承認を経てから行ってください。

**このコードは `files:write` スコープを自動で追加しません。** Slack App の設定画面で手動追加し、各ワークスペースで再インストールを案内してください。

### 設定手順

1. [Slack API Dashboard](https://api.slack.com/apps) → 対象アプリ
2. **OAuth & Permissions** → **Bot Token Scopes**
3. `files:write` を追加
4. **Install to Workspace** で再インストール（Public Distribution の場合は全テナントへ再配布）

### 既存スコープとの関係

| スコープ | 用途 |
|----------|------|
| `chat:write` | メッセージ投稿（既存） |
| `files:write` | ファイルアップロード（**新規追加**） |
| `conversations.open` | DM 開始（既存） |

## Gateway invoke body

```json
{
  "tool": "comm.reply",
  "purpose": "comm.internal",
  "jobId": "job_file_123",
  "conversation": {
    "surface": "slack",
    "orgId": "org_xxx",
    "slackChannelId": "C_INTERNAL",
    "threadId": "1787960001.111111"
  },
  "args": {
    "text": "月次レポートを添付しました。",
    "slackChannelId": "C_INTERNAL",
    "threadId": "1787960001.111111"
  },
  "fileAttachment": {
    "fileRef": "https://storage.example.com/signed/report.pdf",
    "filename": "report.pdf",
    "mimeType": "application/pdf",
    "title": "月次レポート",
    "initialComment": "ご確認ください。"
  }
}
```

### fileAttachment フィールド

| フィールド | 必須 | 説明 |
|------------|------|------|
| `fileRef` | ✓ | 署名付きURL / temp store パス / gateway-held キー |
| `filename` | ✓ | Slack 表示ファイル名 |
| `mimeType` | | MIME タイプ（default: `application/octet-stream`） |
| `bytes` | | ファイルサイズ（監査用） |
| `title` | | Slack 表示タイトル |
| `initialComment` | | ファイル共有時のコメント |

## Safe File Handoff

バイナリデータは LLM コンテキストを経由しません。

| 方式 | 説明 | 例 |
|------|------|----|
| 署名付きURL | Gateway が URL から直接フェッチ | `https://storage.example.com/signed/abc.pdf` |
| Temp store | Gateway が一時ストアから取得 | `temp://abc123` |
| Gateway-held | Gateway セッション内保持 | (将来拡張) |

## 監査ログ

ファイルアップロード成功時:

```json
{
  "action": "slack.file_uploaded",
  "summary": "Slackファイル添付: report.pdf",
  "metadata": {
    "jobId": "job_file_123",
    "channel": "C_INTERNAL",
    "threadTs": "1787960001.111111",
    "fileId": "F0123456789",
    "filename": "report.pdf",
    "bytes": 12345,
    "audience": "internal",
    "mimeType": "application/pdf",
    "fileRef": "https://storage.example.com/signed/report.pdf"
  }
}
```

Egress 拒否時:

```json
{
  "action": "slack.file_egress_denied",
  "summary": "ファイル添付を拒否: file_attachment_external_denied",
  "metadata": {
    "reason": "file_attachment_external_denied",
    "audience": "external",
    "filename": "secret.pdf"
  }
}
```

## エラーコード

| コード | 説明 |
|--------|------|
| `file_attachment_external_denied` | 社外送信不可 |
| `file_attachment_unknown_audience_denied` | 宛先未確認 |
| `file_attachment_thread_required` | thread_ts 必須 |
| `slack_bot_token_missing` | xoxb トークン未設定 |
| `get_upload_url_failed` | Slack API エラー（スコープ不足含む） |
| `file_upload_failed` | アップロード失敗 |
| `complete_upload_failed` | 共有完了失敗 |

## Employee scopes

この機能は既存の `tools:invoke` / `slack:post` スコープで動作します。**Employee 79c1834d などの既存スコープは変更しません。**

Slack App 側の `files:write` スコープ追加は、テナント管理者が Slack App 設定で行います。

## 関連ドキュメント

- [egress-policy.md](./egress-policy.md) — 相手 × 情報区分の出域制御
- [tenant-slack-kickoff-rail.md](./tenant-slack-kickoff-rail.md) — テナント Slack 設定ガイド
