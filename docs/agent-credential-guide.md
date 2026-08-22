# AI社員 社員証（Agent Credential）ガイド

Sealith Agent Token の概念（目的制約・一度きりの秘密・失効・監査）を参考に、
Grok Bot 制御面向けに書き直したスリム版です。転送 handoff API は含みません。

## 形式

```text
Authorization: Bearer gb_emp_<id>_<secret>
```

生の秘密値は発行時に一度だけ表示します。DB には SHA-256 ハッシュのみ保存します。

## 制約できるもの

- scopes（tools / mail / files / browser / commerce / audit / approvals）
- allowedPurposes（狭い業務目的）
- approvalPolicy（auto / risk_based / always_human）
- 有効期限 / 失効

## 推奨

1. ワークフロー単位で社員証を分ける（チーム単位ではない）
2. allowedPurposes を狭く保つ
3. 送信・発注は always_human または risk_based ゲート
4. 短い有効期限 + 未使用の失効

## ゲートウェイ

- GET /api/gateway/health — 連携ヘルス
- POST /api/gateway/link — linked / pending / disconnected

本番の Cursor Grok Bot パートナー API が利用可能になったら、ここを OAuth / workspace 紐付けに置き換えます。
