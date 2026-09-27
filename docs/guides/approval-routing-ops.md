# 承認ルーティングシステム 運用手順書

本ドキュメントは、AI社員の承認ルーティングシステムの設定・運用手順をテナント管理者向けに説明します。

---

## 目次

1. [システム概要](#システム概要)
2. [テナント管理者向け：設定手順](#テナント管理者向け設定手順)
3. [事例A：TOKYO307](#事例atokyo307)
4. [事例B：みらい社中](#事例bみらい社中)
5. [本番有効化前チェックリスト](#本番有効化前チェックリスト)
6. [既知の制限事項](#既知の制限事項)
7. [運用担当者向け付録](#運用担当者向け付録)

---

## システム概要

### 承認クラスとルーティング

承認リクエストは2つのクラスに分類され、それぞれ異なる承認者にルーティングされます。

| クラス | 対象ツール | デフォルト承認者 | 配信先 |
|--------|-----------|-----------------|--------|
| **account（管理系）** | OAuth, Install, employees.issue, policy, classify, parties, finance/billing/card | 組織のアカウント承認者（デフォルト＝組織オーナー） | 組織のデフォルト承認チャンネル |
| **business（業務系）** | reply, send, scheduling | 担当者 | Slack DMまたは元スレッド |

### 分類ルール

- 承認クラスはツールのメタデータ（`metadata.approvalClass`）で決定されます
- 未分類のツールは `admin`（管理系）として扱われます
- 承認者が設定されていない場合は**フェイルクローズド**（承認不可）

### フラグとデフォルト値

| フラグ | デフォルト | 説明 |
|--------|---------|------|
| `SLACK_APPROVAL_STRICT` | OFF | Slack承認の厳格検証を有効化 |
| `ADMIN_APPROVER_POLICY_REQUIRED` | OFF | 管理系承認に明示的ポリシーを要求 |
| `orgs.admin_approver_enforcement` | OFF | 組織単位の管理系承認強制 |
| `APPROVAL_RECIPIENT_ROUTING` | OFF | 受信者ベースルーティングを有効化 |

> **重要**: すべてのフラグはデフォルトOFFです。ONにするには完全なセキュリティ監査の後、オーナーによる個別のGO判断が必要です。

---

## テナント管理者向け：設定手順

### ステップ1：アカウント承認者の設定

アカウント承認者は、管理系（account-class）の承認リクエストを受け取る担当者です。

1. ダッシュボードの「組織設定」→「承認ワークフロー」を開く
2. 「アカウント承認者」セクションで承認者を選択
   - 未設定の場合、組織オーナーがデフォルト承認者となります
   - 組織オーナーが存在しない場合、管理系承認は**失敗します**（フェイルクローズド）

### ステップ2：投票者バインディングの登録

外部アイデンティティ（Slack / Telegram / LINE）を組織メンバーに紐付けます。

1. Admin MCPで `approvalWorkflow.bindVoter` を実行
   - このツールは **always_human**（常に人間承認が必要）です
   - 組織オーナーの承認カードが発行されます

2. 対象メンバーにSlack DMで検証コードが送信されます

3. **本人確認**: メンバーはDM内の「確認」ボタンをクリック
   - 検証コードが一致することを確認
   - team_id検証により、Slack Connectの外部ユーザーは拒否されます

4. バインディングは180日で期限切れとなります（設定可能）

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Admin MCP       │────▶│ 承認カード発行    │────▶│ オーナー承認     │
│ bindVoter実行   │     │ (always_human)   │     │                 │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                        ┌──────────────────┐              │
                        │ Slack DM送信     │◀─────────────┘
                        │ 検証コード付き    │
                        └────────┬─────────┘
                                 │
                        ┌────────▼─────────┐
                        │ 本人が「確認」    │
                        │ ボタンをクリック  │
                        └────────┬─────────┘
                                 │
                        ┌────────▼─────────┐
                        │ バインディング    │
                        │ 有効化           │
                        └──────────────────┘
```

### ステップ3：内部承認チャンネルの作成・登録

承認カードを配信する専用のSlackチャンネルを設定します。

1. Slackで内部チャンネルを作成（例：`#approval-inbox`）

2. **重要**: 以下のチャンネルは承認チャンネルとして使用できません
   - Slack Connectチャンネル（`is_ext_shared`）
   - 外部共有チャンネル（`is_shared`）
   - 外部共有保留中のチャンネル（`is_pending_ext_shared`）

3. ダッシュボードまたはAdmin MCPでチャンネルを登録
   - 登録時に `auth.test` APIで `expectedTeamId` が自動取得されます
   - この team_id は外部ユーザー拒否に使用されます

4. クロスオルグ投票はブロックされます
   - 承認ボタンを押したユーザーの team_id がチャンネルの expectedTeamId と一致しない場合、拒否されます
   - エフェメラルメッセージで拒否理由が表示されます

### ステップ4：テスト承認の実行

設定が正しいことを確認するため、テスト承認を実行します。

1. テスト用のAI社員で承認が必要な操作を実行
2. 承認カードが正しいチャンネル/DMに配信されることを確認
3. 承認ボタンをクリックし、承認フローが完了することを確認
4. 外部ユーザー（Slack Connect経由）での承認が拒否されることを確認

### ステップ5：強制設定の有効化（運用担当者が実施）

> **注意**: このステップは運用担当者が実施します。テナント管理者は依頼のみ。

1. ステップ1〜4が完了していることを確認
2. 完全なセキュリティ監査を実施
3. 以下の順序でフラグをON
   - `SLACK_APPROVAL_STRICT=true`
   - `ADMIN_APPROVER_POLICY_REQUIRED=true`
   - `orgs.admin_approver_enforcement=true`（組織単位）

### ロールバック手順

問題が発生した場合、フラグをOFFにすることで既存のW1動作（任意の単一承認者）に戻せます。

```bash
# 環境変数のロールバック
SLACK_APPROVAL_STRICT=false
ADMIN_APPROVER_POLICY_REQUIRED=false

# 組織単位の設定（DBで直接更新が必要）
UPDATE orgs SET admin_approver_enforcement = false WHERE id = '<org_id>';
```

### フェイルクローズドの動作

以下の状況では承認がブロックされます（承認不可）：

| 状況 | 結果 |
|------|------|
| 管理系承認で承認者が未設定かつ組織オーナーが不在 | `admin_policy_required` エラー |
| 投票者バインディングが未設定（強制モード時） | 承認ボタン無効 |
| Slack Connect外部ユーザーの承認試行 | エフェメラル拒否メッセージ |
| expectedTeamIdが設定されていない（厳格モード時） | 承認拒否 |

---

## 事例A：TOKYO307

### 要件

- **組織**: TOKYO307
- **アカウント承認者**: 組織オーナー（八坂さん）、Telegramをデフォルトインボックスとして使用
- **業務系AI社員オーバーライド**: 山下さんが reply/send/scheduling を承認
- **Slackワークスペース**: 307room
- **内部承認チャンネル**: 307roomワークスペース内に新規作成（例：`#approvals-business`、名前は要検討）
- **制約**: 山下さんは finance/billing/card の承認を受け取ってはいけない

### 設定内容

#### 1. アカウント承認者（八坂さん）

八坂さんは組織オーナーとして、自動的にアカウント承認者のデフォルトになります。

Telegram投票者バインディングを事前に登録：

```
Admin MCP: approvalWorkflow.bindVoter
  memberId: <八坂さんのmemberId>
  provider: "telegram"
  externalUserId: <八坂さんのTelegram ID>
```

#### 2. 業務系承認者（山下さん）オーバーライド

AI社員の設定で、業務系（reply/send/scheduling）の承認者として山下さんを指定：

```json
{
  "approvalWorkflow": {
    "routes": [
      {
        "class": "business",
        "stages": [
          {
            "id": "business_stage_1",
            "nameJa": "業務承認",
            "voterUserIds": ["<山下さんのuserId>"],
            "quorum": { "type": "any" },
            "onReject": "fail_closed"
          }
        ]
      }
    ]
  }
}
```

#### 3. 内部承認チャンネル（307roomワークスペース内）

307roomワークスペース内に新しい内部承認チャンネルを作成し、登録します：

1. 307roomワークスペースで新しいチャンネルを作成（例：`#approvals-business`）
2. **重要**: Slack Connectチャンネルは使用不可（登録時に自動拒否）
3. ダッシュボードまたはAdmin MCPで承認インボックスとして登録

#### 4. 山下さんがfinance/billing/cardを受け取らない・承認できない保証

> **重要**: この保証は**すべてのフラグがONの場合にのみ**有効です。

##### フラグがONの場合（強制モード）

以下のフラグがすべてONの場合、山下さんはfinance/billing/card承認を受け取ることも解決することもできません：

- `SLACK_APPROVAL_STRICT=true`
- `ADMIN_APPROVER_POLICY_REQUIRED=true`
- `orgs.admin_approver_enforcement=true`
- `APPROVAL_RECIPIENT_ROUTING=true`（受信者ベース配信）

**コード上の保証**:

- finance/billing/card は `admin.billing`, `admin.external_contract_card` などの管理系ツールに分類されます
- 管理系承認は**アカウント承認者**（八坂さん）にルーティングされます
- 山下さんは業務系ルートにのみ登録されているため、管理系承認カードを受け取りません

**拒否コード**:

| 状況 | 拒否コード |
|------|-----------|
| 明示的なadminルートがない場合（オーナーデフォルト使用時） | `non_owner_on_admin_ticket` |
| 明示的なadminルートがある場合 | `business_voter_on_admin_ticket` |

`canResolverResolveAdminApproval()` 関数により、山下さんが管理系チケットを解決しようとしても上記のコードで拒否されます。

```
┌─────────────────────────────────────────────────────────────────┐
│               承認ルーティング（強制モードON時）                  │
├─────────────────────────────────────────────────────────────────┤
│  finance/billing/card   ───▶  admin-class  ───▶  八坂さん(TG)  │
│  reply/send/scheduling  ───▶  business     ───▶  山下さん(Slack)│
└─────────────────────────────────────────────────────────────────┘
```

##### フラグがOFFの場合（レガシーW1動作）

フラグがOFFの場合、従来のW1パス（任意の単一承認者による承認）が有効です。この場合：

- 管理系承認カードは**組織のデフォルト承認チャンネル**に配信される可能性があります
- そのチャンネルのメンバーであれば誰でも承認ボタンを押せます
- 山下さんがそのチャンネルにいれば、管理系承認を解決できてしまいます

##### 有効化前の暫定対策

フラグをONにするまでの間、以下の対策を行ってください：

1. **山下さんを管理系カードが配信されるチャンネルに追加しない**
   - 管理系承認用のチャンネルと業務系承認用のチャンネルを分離
   - 山下さんは業務系専用チャンネル（`#approvals-business`）のみに参加

2. **管理系カードは八坂さんのTelegramインボックスに配信**
   - 八坂さんのTelegramを管理系承認のデフォルトインボックスとして設定
   - Slackチャンネルには管理系カードを配信しない

3. **業務系チャンネルを組織のデフォルトインボックスに設定しない**
   - `#approvals-business` は業務系専用
   - 組織のデフォルトインボックスは八坂さんのTelegram、または管理者専用Slackチャンネル

---

## 事例B：みらい社中

### 要件

- **組織**: みらい社中（別組織・別Slackワークスペース）
- **業務承認者**: 上原さん、仲田さん
- **制約**: Slack Connect共有チャンネルに承認カードを送信しない
- **各担当者が行う手順**（招待/ガイドメールに記載）

### 上原さんの手順

1. **Slackワークスペースに参加**
   - みらい社中のSlackワークスペースへの招待を承諾

2. **ダッシュボードにログイン**
   - Staffpassダッシュボードにログイン
   - みらい社中の組織メンバーとして参加を確認

3. **投票者バインディングの確認依頼** 🔒
   - 組織オーナーに投票者バインディング登録を依頼
   - **このステップは組織オーナーの承認カード（always_human）が必要です**

4. **Slack DMで本人確認**
   - 検証コード付きのDMを受信
   - 「確認」ボタンをクリックして本人確認を完了

### 仲田さんの手順

上原さんと同様の手順を実施します。

### 組織オーナーの手順

1. **上原さんの投票者バインディング登録** 🔒
   ```
   Admin MCP: approvalWorkflow.bindVoter
     memberId: <上原さんのmemberId>
     provider: "slack"
     channelId: <内部承認チャンネルID>
   ```
   → **always_human承認カードが発行されます**

2. **仲田さんの投票者バインディング登録** 🔒
   ```
   Admin MCP: approvalWorkflow.bindVoter
     memberId: <仲田さんのmemberId>
     provider: "slack"
     channelId: <内部承認チャンネルID>
   ```
   → **always_human承認カードが発行されます**

3. **内部承認チャンネルの登録**
   - みらい社中のワークスペース内に専用チャンネルを作成
   - Slack Connect共有チャンネルは使用不可（自動拒否）

### Slack Connect共有チャンネルのブロック

以下のチェックにより、共有チャンネルへの承認カード配信は自動的にブロックされます：

```typescript
// channel-validation.ts より
if (channel.is_ext_shared) {
  return { ok: false, code: "slack_connect_channel", ... };
}
if (channel.is_shared) {
  return { ok: false, code: "shared_channel", ... };
}
```

登録時にSlack APIで `conversations.info` を呼び出し、外部共有フラグをチェックします。

---

## 本番有効化前チェックリスト

### 前提条件

- [ ] **②** 投票者バインディング登録が完了している
- [ ] **③** 内部承認チャンネルの登録が完了している
- [ ] 完全なセキュリティ監査が完了している
- [ ] 八坂さんのTelegram投票者バインディングが事前登録されている

### 有効化手順

1. **セキュリティ監査の完了確認**
   - クロスオルグ漏洩防止の検証
   - フェイルクローズド動作の検証
   - 投票者バインディングの検証フローの確認

2. **フラグ有効化（順序厳守）**
   ```bash
   # 1. Slack厳格モード
   SLACK_APPROVAL_STRICT=true
   
   # 2. 管理系ポリシー要求
   ADMIN_APPROVER_POLICY_REQUIRED=true
   
   # 3. 組織単位の強制（対象組織のみ）
   UPDATE orgs SET admin_approver_enforcement = true WHERE id = '<org_id>';
   ```

3. **受信者ルーティング（オプション、後述の制限事項参照）**
   - `APPROVAL_RECIPIENT_ROUTING=true` は追加マイグレーション後に有効化

---

## 既知の制限事項

### APPROVAL_RECIPIENT_ROUTING有効化前に修正が必要な問題

**問題**: `approval_notification_deliveries` テーブルの一意制約

現在の一意制約:
```sql
UNIQUE (approval_id, channel_id)
```

DMデリバリーとチャンネルデリバリーが同じ `channel_id` を共有する場合、衝突が発生します。

**修正内容**（#126コードデプロイ後に適用）:

1. マイグレーション適用
   ```sql
   -- 20260927200000_delivery_per_recipient.sql
   ALTER TABLE approval_notification_deliveries
     ADD COLUMN recipient TEXT,
     ADD COLUMN recipient_kind TEXT DEFAULT 'channel';
   
   -- 一意制約の変更
   ALTER TABLE approval_notification_deliveries
     DROP CONSTRAINT approval_notification_deliveries_approval_id_channel_id_key,
     ADD CONSTRAINT approval_notification_deliveries_unique
       UNIQUE (approval_id, channel_id, recipient);
   ```

2. `onConflict` の変更（コード側）

**ステータス**: #126のコードデプロイ後、マイグレーション適用が必要

---

## 運用担当者向け付録

### フラグ一覧と影響範囲

| フラグ | 影響範囲 | ON時の動作 | OFF時の動作 |
|--------|---------|-----------|------------|
| `SLACK_APPROVAL_STRICT` | 全組織 | team_id検証必須、expectedTeamId未設定で拒否 | 従来のSlack承認動作 |
| `ADMIN_APPROVER_POLICY_REQUIRED` | 全組織 | 管理系承認に明示的ルートまたはオーナー必須 | W1動作（任意の承認者） |
| `admin_approver_enforcement` | 組織単位 | DB/RPCレベルで承認者検証を強制 | アプリレベルのみ |
| `APPROVAL_RECIPIENT_ROUTING` | 全組織 | 受信者ベース配信（DM/スレッド） | チャンネル配信のみ |

### DBテーブル参照

- `orgs.admin_approver_enforcement`: 組織単位の強制フラグ
- `approval_workflow_voter_bindings`: 投票者バインディング
- `org_notification_channels`: 承認インボックス設定
- `approval_notification_deliveries`: 配信記録

### セキュリティ不変条件

1. **クロスオルグ分離**: メンバーとチャンネルの orgId が一致しない場合は拒否
2. **フェイルクローズド**: 未検証バインディングは投票不可
3. **Slack Connect拒否**: 外部共有チャンネルへの承認配信をブロック
4. **team_id検証**: 異なるワークスペースのユーザーは承認不可

### 関連PR

- PR #122: 管理系承認の明示的ポリシー要求
- PR #123: Slack承認パスの厳格化
- PR #124: 投票者バインディング登録と身元確認
- PR #125: 単一Slackインタラクティビティエンドポイント
- PR #126: チャンネル非依存デリバリーアダプター層

---

*最終更新: 2026-09-27*
