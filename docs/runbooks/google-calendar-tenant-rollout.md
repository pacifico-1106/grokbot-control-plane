# Google Calendar テナント展開マニュアル

本書は、テナントに Google Calendar 連携（`calendar.freebusy` 読み取り）を展開するためのオペレータ向けマニュアルです。

**フィーチャーフラグ**: `GOOGLE_CALENDAR_READ_ENABLED`（デフォルト OFF）

---

## OAuth クライアントの構成

### 1 Staffpass = 1 OAuth クライアント（オペレータ側、一度だけ）

Google Cloud OAuth 2.0 クライアント ID は **Staffpass アプリ全体で 1 つ**（オペレータ側の共有リソース）です。テナントごとに作成するものではありません。

- **リダイレクト URI**: `https://staffpass.sealith.com/api/google/oauth/callback`
- テナントがカスタムドメインを取得した場合のみ、そのドメインの URI を追加

### Google アプリ審査までの制限

**未審査のアプリは最大 100 人のテストユーザーに制限されます**。

- `calendar.freebusy` は「センシティブ」スコープです
- 本番前に Google 審査（verification）を完了することを推奨します
- 審査には以下が必要:
  - プライバシーポリシー
  - ドメイン検証
  - 使用目的の説明

---

## Workspace サードパーティアプリ制限の原則

### 重要な原則

Workspace の「**構成されていないサードパーティアプリをブロック**」設定は、**接続する Google アカウントを所有する Workspace** にのみ影響します。

- **Bot 側の Google コネクタも OAuth アプリです** — Workspace 管理者がブロックしていれば、同様にブロックされます。これは回避策ではありません。
- 相手方（counterparty）が自社 Workspace のサードパーティアプリ制限を有効にしていても、**相手方がアプリに接続しなければ**その制限は適用されません。

---

## 推奨パターン

### パターン A: AI 社員アカウントを管理 Workspace に配置（推奨）

AI 社員用の Google アカウントを、**オペレータが管理する Workspace、または Staffpass を許可済みの Workspace** に配置します。

**相手方（counterparty）の設定**:
- Google の標準共有機能で、AI 社員アカウントにカレンダーを共有
- 「空き時間のみ」の共有レベルで十分（free/busy only）
- 相手方はアプリに接続しないため、相手方管理者のサードパーティアプリ制限は適用されない
- 相手方に必要な設定: 「**外部カレンダー共有を許可**」（free/busy レベルで OK）

### パターン B: 顧客 Workspace 内の AI 社員アカウント

AI 社員アカウントが顧客の Workspace 内に存在する必要がある場合は、**顧客の管理者が Staffpass を一度許可する必要があります**。

**顧客管理者の設定**:
- Admin console → Security → API controls → App access control
- Staffpass OAuth クライアント ID を信頼

> **注意**: 正確な UI はバージョンにより異なる場合があります。上記を参考に設定してください。

---

## フラグ ON 後の運用手順

### 1. Google アカウント接続

社員証画面から「**Google カレンダー接続**」をクリックし、OAuth フローを完了します。

接続するアカウントは:
- AI 社員専用の Google アカウント
- オペレータが管理する Workspace、または Staffpass を許可済みの Workspace のアカウント

### 2. カレンダー許可リストへの追加

`calendar.allowlist.patch` ツールで、読み取り許可するカレンダー ID を登録します。

```
tools/call: calendar.allowlist.patch
arguments: {
  "action": "add",
  "calendarId": "example@group.calendar.google.com",
  "label": "営業チームカレンダー"
}
```

**承認が必要です**（`forceNeedsApproval`）。

### 3. 空き時間の読み取り

`calendar.read` で許可リスト内のカレンダーの空き時間を取得できます。

**重要**:
- **free/busy のみ** — 予定の詳細内容は取得しません
- 許可リストにないカレンダー ID は拒否されます

### 4. 結果の解釈

| フィールド | 意味 |
|-----------|------|
| `busyByCalendar` | カレンダーごとの空き時間（busy intervals） |
| `readErrors` | カレンダーごとのエラー（アクセス不可など） |
| `refused` | 許可リストにないため拒否されたカレンダー ID |
| `queried` | 実際にクエリされたカレンダー ID |
| `busyDataComplete` | 全カレンダーの読み取りが完了したか（`false` = 一部エラー） |

---

## トラブルシューティング

### OAuth / 接続エラー

| 症状 | コード | 原因 | 対処 |
|------|--------|------|------|
| 同意画面で「管理者がブロック」 | `admin_policy_enforced` / `access_denied` | 接続アカウントの Workspace でサードパーティアプリがブロックされている | アカウントを別の Workspace に移す、または管理者に Staffpass 許可を依頼 |
| 同意画面で「拒否」 | `access_denied` | ユーザーが同意を拒否した | 再度接続を試行 |
| テストユーザーでない | `access_denied` | 未審査アプリで 100 人上限超過 | Google Cloud Console でテストユーザーに追加 |

### カレンダー読み取りエラー

| 症状 | コード | 原因 | 対処 |
|------|--------|------|------|
| カレンダーが見つからない | `notFound` / `notShared` | カレンダーが共有されていない | オーナーに AI 社員アカウントへの共有を依頼（free/busy レベルで OK） |
| アクセス拒否 | `notShared` | 外部共有が無効 | オーナーの Workspace 管理者に「外部カレンダー共有」の許可を依頼 |
| 許可リストにない | `refused` | `calendar.allowlist.patch` で未登録 | ツールでカレンダー ID を許可リストに追加（承認必要） |

### 接続状態エラー

| 症状 | コード | 原因 | 対処 |
|------|--------|------|------|
| Google 未接続 | `no_google_identity` | AI 社員が Google アカウント未連携 | 社員証画面から「Google カレンダー接続」を実行 |
| トークン更新失敗 | `token_refresh_failed` | リフレッシュトークンが無効化 | 社員証画面から Google 再連携 |
| 再認可必要 | `needs_reauth` | トークンスコープ変更またはユーザーが取り消し | 社員証画面から Google 再連携 |

---

## 相手方への案内テンプレート

### カレンダー共有の依頼（日本語）

```
件名: カレンダー共有のお願い（空き時間確認用）

お世話になっております。

日程調整をスムーズに行うため、カレンダーの空き時間を確認させていただきたく、
以下のアカウントへのカレンダー共有をお願いいたします。

共有先: [AI社員のGoogleアカウント]
共有レベル: 「予定の有無のみ表示」（free/busy only）で十分です

※ 予定の詳細内容は確認いたしません。空き時間のみを参照いたします。

【設定手順】
1. Google カレンダーを開く
2. 左側のカレンダー名にカーソルを合わせ、⋮ → 設定と共有
3. 「特定のユーザーと共有」セクションで「ユーザーを追加」
4. 上記アカウントを入力し、権限を「予定の有無のみ表示」に設定

ご不明点がございましたらお気軽にお問い合わせください。
```

---

## 関連ドキュメント

- [google-calendar-freebusy-integration.md](../google-calendar-freebusy-integration.md) — 技術仕様・セキュリティ考慮事項
- [tenant-slack-kickoff-rail.md](../tenant-slack-kickoff-rail.md) — Slack 設定 RAIL（類似構成の参考）
- [scheduling-policy.md](../scheduling-policy.md) — A1 スケジューリングポリシー
