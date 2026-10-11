# Slack DM 自動ルート（SLACK_DM_AUTOROUTE_ENABLED, Plan A）

既定 OFF。テナント共通の仕組み（テナント固有 ID はコードに無い）。

## 何をするか
社員の Slack 本人認可（employee_slack_identities = linked）と、相手台帳（org_parties）の
**internal な slack_user（人が parties.upsert を承認したもの）**から、社員↔相手の 1:1 DM を
社員の user token で `conversations.open` し、その D… を internal 分類＋IM ルートとして登録する。
登録は既存の `applyChannelClassification`（channels.classify と同じ書き込み経路）を使う。

| トリガー | 動作 |
|---|---|
| Slack 認可の完了（/api/slack/oauth/callback） | その社員 × org の internal slack_user 全員（応答後に `after()` で実行） |
| parties.upsert の履行（人承認後） | internal → org の linked 社員全員 × その相手 / external → その相手の自動ルートを削除し DM を unknown に戻す |
| Slack 認可の解除（DELETE /api/employees/[id]/slack-identity） | その社員の自動ルートを削除し DM を unknown に戻す |

どれも冪等（2 回目は no-op、監査も増えない）。1 回の実行で相手は最大 50 人（超過分は `limit_exceeded` で skip 監査）。

## 作らない条件（fail-closed）
- 相手が org_parties の internal slack_user でない（internalAudienceRule のチーム自動社内は使わない）／社員本人
- `auth.test`: token が社員本人・同じ team でない、`x-oauth-scopes` が取れない、`im:write` または `users:read` が無い
- `users.info`: `is_stranger`、team_id が社員の team と違う（Enterprise Grid の別ワークスペース含む）、team 不明、ゲスト（restricted / ultra_restricted）、bot / app user、削除済み、API エラー
- DM: D… でない、`is_ext_shared` / `is_shared` / `is_org_shared` / `is_pending_ext_shared`
- 既存 org_channels が shared_external または mixed（人の分類は上書きしない）
- 同じ DM が別の社員（他 org 含む）にルート済み
- 人の channels.classify で作ったルート（source=manual）は自動削除しない

## 監査（ダッシュボード変更履歴）
action `admin.channel`、metadata `{auditClass:"admin", event:"slack_dm_autoroute.created|skipped|failed|removed", trigger, reason, counterpartSlackUserId, channelId, employeeId}`。
token・本文は入れない。Slack のエラーは短いコードだけ残す。

## 必要な設定
1. Staffpass Slack アプリ（api.slack.com）→ OAuth & Permissions → **User Token Scopes に `im:write`**
2. `SLACK_USER_SCOPE_IM_WRITE=1`（社員 OAuth の user_scope に im:write を足す。1 より先に ON にしない＝invalid_scope になる）
3. migration `20261004000000_slack_im_route_autoroute.sql`
4. `SLACK_DM_AUTOROUTE_ENABLED=1`
5. 社員が Slack 認可（既にリンク済みの社員は 1 回やり直し）

## Plan B（設計メモのみ・未実装）
im:write を足せない場合の代替。user-token `message.im` が im_no_route になったとき（`lib/slack/im-no-route-audit.ts`）、
送信者 `event.user` が同 org の internal slack_user party で、users.info（社員 token、users:read は既存）で
同 team・非 stranger・非ゲスト、かつ D… に非 internal の分類が無ければ、既存の admin 承認キュー
（channels.classify, always_human, employeeId 付き）にカードを自動起票し、承認者がボタン 1 回で作成する。
- re-OAuth 不要（im:history だけで動く）。最初の 1 通は起動しない（本文を保存しない方針のため再生しない）。
- `lib/slack/mention-ingress.ts` を触るため #230 と衝突する。Plan A が使える限り実装しない。
- フラグ案: `SLACK_DM_AUTOROUTE_FROM_IM`（既定 OFF）、起票は org×DM ごとに 1 回（既存の 10 分抑制と同じ形）。
