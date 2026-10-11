# 承認の届け失敗・ボタン失敗アラート（APPROVAL_DELIVERY_FAILURE_ALERT）

テスト承認はありません。**最初の本物の承認依頼が実地確認**です。
その本物の承認が「届かない」「ボタンで処理できない」とき、承認は**されないまま**（従来どおり fail-closed）で、
このフラグが ON なら管理者と運営に見える形で知らせます。

| フラグ | 既定 | 意味 |
| --- | --- | --- |
| `APPROVAL_DELIVERY_FAILURE_ALERT` | OFF | ON で下記アラートを出す |
| `PLATFORM_OPS_ORG_ID` | （既存） | 運営 org。設定時のみ運営向け監査ミラー |
| `APPROVAL_ALERT_OPS_EMAILS` | 空 | 任意。運営へのメール（カンマ区切り、最大10件） |

## いつ出るか

- **届け失敗**（`approval_delivery.failed`）: 本物の承認依頼が、どの承認口にも届かなかったとき
  （Slack/Telegram/LINE の送信エラー、資格情報不足による skip、承認口が1つも無い `no_approval_inbox`）。
- **ボタン失敗**（`approval_button.failed`）: 署名検証を通った Slack ボタン押下を処理できなかったとき
  （`not_in_allowed_list` / `external_team_user` / `delivery_mismatch` / 期限切れ `card_expired` /
  `approver_not_allowed` / `app_mismatch` / `team_mismatch` / 処理例外 `handler_error`）。
  - 署名不正（401）は出しません（未認証の外部からアラートを乱発させないため）。
  - すでに決裁済みのカードの再押下は通常操作なので出しません。

## どこに出るか

1. テナント: 監査 `admin.notificationChannel`（auditClass=admin → ダッシュボードの変更履歴）。
2. テナント管理者: 同じ org の**ほかの**有効な承認口（失敗した口には送らない、最大3件）に短文 +
   同じ org の active な owner/admin へメール。
3. 運営: `PLATFORM_OPS_ORG_ID` へ監査ミラー（`targetOrgId`・承認ID・理由コードのみ）+ 任意メール。

本文は承認ID・理由コードだけ。承認の中身・トークン・シークレットは載せません。
同じ org × 種類 × 承認口 につき 30 分に1回（インスタンス内スロットル）。抑止した件数は次の監査に `suppressedSinceLast` で残ります。
アラート処理は例外を投げず、承認の結果を変えません。
