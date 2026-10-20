# D（P1）設計メモ: 秘密検知で止まった 1 通だけを通す許可と、秘密を預ける画面

- 日付: 2026-10-09
- 起票: 森（設計レビュー: 木村）
- 出典: `kimura-20261009-weekly-feedback` の「D (P1)」、週次フィードバックのトリアージ #6、稲森トリアージの P1-a と P2-b
- 位置付け: **設計メモのみ。実装しない。** 本 PR はコード、migration、env、フラグのどれも変更しない。
- **D4 credential lease（AI に秘密を貸す仕組み）の実装には、八坂の別 GO が必要。** 本メモはその GO を前提にしない。§6.6 と §9 で境界を示す。
- **改訂（2026-10-09 22:55 木村レビュー反映）**: 一般指摘 1〜6（§11 に対応表）と、決定事項 D-0〜D-11 を反映した。**D-8（預け入れの保管先）と D-12（D4 lease の GO）は八坂の判断待ち**（木村が八坂に確認）。D-8 で一時受け渡し箱を採る場合の仕様は §6.7 に書いた。**実装は八坂の GO が出るまで着手しない。**

---

## 0. 前提の確認（実装前にやること）

- HUB の件（再設定 URL を含む送信が止まった件）が **#281 のデプロイ前か後か**を、木村が確認する。確認は読み取りのみ（prod は PostgREST GET の範囲）。
  - デプロイ前なら、#281 で誤検知が減っている可能性がある。その場合、本機能の優先度は下げてよい。
  - デプロイ後なら、本メモの「1 通だけの許可」で受ける。ただし §2.3 のとおり**再設定 URL は許可の対象外**とし、§6 の預け入れ画面に回す。
- 確認結果は §10 の決定事項 D-0 に記入する。

## 1. 目的と範囲

| 対象 | 内容 |
|---|---|
| A. 1 通だけの許可（one-shot permit） | 秘密検知（`lib/security/secret-detector.ts`）で `secret_detected_in_payload` になった送信のうち、**汎用ヒューリスティックだけで止まった 1 通**について、承認者が「この本文に限って 1 回だけ通す」許可を出せるようにする。 |
| B. 秘密を預ける画面（deposit） | チャットに秘密を書かずに済むよう、Staffpass の画面で秘密を預ける・人へ渡す経路を用意する（P0-A #117/#118 の「チャットに秘密を出さない。入力は Staffpass の画面か IdP の画面で行う」の受け皿）。 |
| 範囲外 | D4 lease（AI 実行時に秘密を差し込む仕組み）の実装、Sealith 拡張、カード系フロー、検知パターン自体の変更（credential URL 分類器の追加は §2.3 で設計のみ）。 |

**変えないこと（不変条件）**

1. 検知されたら止める、という既定は変えない（`retryable: false` も維持）。許可は「承認者が明示的に出した 1 回」だけの例外。
2. クライアント側のフラグ（`allowSecrets` など）で検知を回避できない、という既存テストは残す。許可はサーバー側の permit 行でしか効かない。
3. 監査（`secret_detection.*`）に本文、値、値の一部、**値や本文のハッシュを書かない**（`lib/security/secret-detection-audit.ts` の規則）。本メモの HMAC は permit 行にだけ置き、監査には書かない（§3.3）。
4. AI（LLM）は秘密の値を受け取らない。承認カード（Slack/LINE/Telegram）にも値を出さない。
5. **許可が外すのは秘密検知（secret detector）の判定だけ。** egress（宛先の社内／社外判定と egress ポリシー）、topic gate（話題による承認）、`always_human`、承認後の fulfil 時の再確認は、許可があってもすべてそのまま効く（§3.7）。
6. **初期は社内宛てだけ。** 社外の宛先への送信には許可を出さない（§2.4、§4）。

## 2. 1 通だけの許可: 対象になる検知・ならない検知

### 2.1 対象（eligible）

**汎用（generic）ヒューリスティックだけ**で止まった場合に限る。推奨する初期セットは次のとおり。

| パターン | 初期 | 理由 |
|---|---|---|
| `base64_long_secret` | 対象 | 長い不透明な文字列の推定。業務の ID、署名済みでない長いトークン状の文字列で誤検知しやすい。 |
| `hex_long_secret` | 対象 | 同上（ハッシュ値、コミット SHA の連結など）。 |
| `password_inline` / `secret_inline` / `api_key_inline` / `bearer_token` / `refresh_token` | **対象外（既定）** | キーワードと値の組で、実際の秘密である確率が高い。初期は対象外（D-3 決定。誤検知の監査を見て判断）。 |
| `aws_secret_key` | **対象外** | 文脈条件（境界、混在文字種、キーワード、AKIA）を満たした時だけ当たるので、実物の可能性が高い。 |

### 2.2 常に対象外（named / specific パターン）

`slack_token`、`slack_webhook`、`openai_key`、`openai_proj`、`staffpass_employee`（gb_emp_）、`staffpass_admin`（gb_adm_）、`stripe_key`、`stripe_restricted`、`github_token`、`github_classic`、`aws_access_key`、`google_api_key`、`jwt_token`、`private_key_header`、およびカード系（`card_*`、Luhn 検証付き。カードは専用フローがある）。

- 判定は**「1 通の中のすべての検知が eligible のときだけ許可を申請できる」**。named が 1 つでも混じれば申請自体を出さない。
- パターン名の分類は `lib/security/secret-permit-eligibility.ts`（新規予定）に許可リスト方式（allowlist）で持つ。新しいパターンを detector に足した時、既定は「対象外」になる（fail-closed）。

### 2.3 credential URL（再設定・招待リンク）は常に対象外

- **現状の穴**: detector は素の URL を汎用の長さパターンから外している（Staffpass の setup link が署名付きトークンを持つため）。そのため、パスワード再設定 URL や招待リンクは**今は検知されずに通る**。
- 本機能の除外条件として、新しい分類器 `classifyCredentialUrl`（設計のみ）を置く。**分類は広めに取る**（取りこぼすと許可で秘密が出るため。誤って除外しても「許可が出せない＝今と同じブロック」で済む）。
  - **前処理: セーフリンクを先に剥がす。** Outlook Safe Links（`*.safelinks.protection.outlook.com` の `url=`）、Google のリダイレクト（`google.com/url?q=`）、Slack のリダイレクト、Proofpoint / Mimecast 等の書き換え URL は、中の URL を取り出して（入れ子も繰り返し剥がす。上限回数を超えたら除外扱い）判定する。
  - **形での判定（語に関係なく除外）**: パス、クエリ、フラグメントのどこかに**長くランダムな部分**（例: 20 文字以上で英数字・`-`・`_` の混在、またはエントロピーが一定以上）を持つ URL はすべて除外する。再設定・招待・マジックリンクは語が付かない形も多いため、語の一覧だけには頼らない。
  - 語での判定（補助）: パスや host の語 `reset`、`password`、`passwd`、`recover`、`invite`、`invitation`、`magic`、`signin`/`login` + トークン、`verify`、`confirm`、`activate`、`onboard`。クエリパラメータ `token`、`code`、`key`、`otp`、`sig`/`signature`、`ticket`、`auth`、`reset_token`、`invite_token`。
  - **Staffpass リンクの例外**: 自社の Staffpass setup link（`lib/security/setup-links.ts` の形式）を `staffpass_setup_link` として別扱いにするのは、**host が自社ドメインと完全一致（サフィックス一致や部分一致は不可）し、かつ署名の検証に通った場合だけ**。どちらかを満たさなければ通常の credential URL として除外する。
- 本メモの範囲では、分類器は**許可の除外に使う**。credential URL そのものを新たにブロックするかは決定事項 D-4 のとおり `exclude_only` で始める。ただし**最初の実装 PR に `observe`（検知して記録するだけ）を入れ**、今は検知されずに通っている再設定 URL 等の件数を数える（§9）。
- 対象外の秘密を人に渡したい場合の受け皿は §6 の預け入れ画面（再設定 URL も「預けて、相手に 1 回だけ見せる」で渡す）。

### 2.4 対象の面（surface）

| surface | 初期 | 理由 |
|---|---|---|
| `gateway_invoke`（社員 AI の外部送信: chat/mail 系ツール） | 対象 | HUB の件はここ。 |
| `admin_queue`（admin MCP） | 対象外 | 管理系の操作に秘密を通す理由がない。 |
| `config_change_request` | 対象外 | 設定値の秘密は預け入れ（§6）か D4 で扱う。 |

### 2.5 宛先: 初期は社内だけ

- 許可を申請できるのは、**宛先がすべて社内**（既存の egress / 台帳の判定で internal）の送信だけ。社外または判定できない宛先が 1 つでも含まれれば、申請を出さない（従来どおりブロック）。
- 社外宛ては範囲外。将来社外を足す場合は、**許可できるのは owner だけ**にする（指名 admin は不可。D-2）。

## 3. 1 通だけの許可: 仕組み

### 3.1 流れ

```
[AI] tool call ──► gateway: detectSecretInPayload → ブロック
                    │ (フラグ ON かつ §2 で eligible)
                    ├─ secret_detection.blocked を監査（既存）
                    ├─ permit 申請を作る（approval_requests に kind=secret_permit）
                    │    + 解決後の値（§3.2）の HMAC を secret_permits に pending で保存
                    │    + 承認者が確認するための本文を暗号化して一時保存（§3.5）
                    └─ 応答: 既存の 403 エラー + { permitRequest: { requestId, status:"pending" } }
[承認者] Staffpass 画面 / Slack カード（値なし）で確認 → 許可 or 却下
                    └─ RPC 1 本で「permit を granted に」+「監査 secret_permit.granted」を同一トランザクション
                       （監査が書けなければロールバック → 許可は存在しない）
[AI] 同じ本文で再送 + secretPermitId
                    ├─ 宛先の解決（U→D の書き換え、autoroute 等）を通常どおり行う
                    ├─ 再度 detect（結果の pattern 集合が許可時と一致すること）
                    ├─ 解決後の値で HMAC を再計算して定数時間比較（一致すれば「秘密検知だけ」を外す）
                    ├─ egress、topic gate、always_human など他のゲートを通常どおり判定（§3.7）
                    │    └─ 承認待ちになった場合: permit は消費しない（fulfil 時に再判定）
                    ├─ 他のゲートをすべて通過した後に、条件付き UPDATE で消費（granted → consumed）
                    ├─ 監査 secret_permit.consumed（書けなければ送らない）
                    └─ 送信
```

- 再送以外の経路（別ツール、別社員、別 credential、本文 1 文字違い、宛先違い）では permit は一致しない。
- AI は `secretPermitId` を知るだけで、承認の操作はできない（§4）。

### 3.2 HMAC で本文に結び付ける

- 鍵: 新 env `SECRET_PERMIT_HMAC_KEY`（32 byte 以上）から、HKDF-SHA256 で **org ごとに導出**（`info = "staffpass.secret_permit.v1:" + orgId`）。org をまたいだ照合を不可能にする。
- **HMAC は宛先などを解決した後の値に対して取る**（AI が書いた生の payload ではなく、実際に送られる値に結び付けるため）。
  - Slack 等のチャンネル: U→D の書き換え（#288）や autoroute の後の**実際の送信先チャンネル ID**。
  - メール: `to` / `cc` / `bcc` を正規化した値（小文字化、前後の空白除去、表示名を落としたアドレスだけ、項目ごとに重複除去してソート）。
  - 添付: 各添付の**内容のハッシュ**（SHA-256。ファイル名だけでは差し替えを検知できない）と、その並び。
  - **permitId**: permit 行の ID を含める（同じ本文の別の申請の HMAC と区別し、行の付け替えを防ぐ）。
- 対象（canonical message）:
  ```
  "staffpass.secret_permit.v2\n"
  + permitId + "\n"
  + orgId + "\n" + employeeId + "\n" + credentialId + "\n"
  + surface + "\n" + tool + "\n"
  + canonicalJson({
      resolvedDestination,      // 解決後のチャンネル ID、または正規化した to/cc/bcc
      attachmentSha256: [...],  // 添付の内容ハッシュ（順序どおり）
      body: payload から secretPermitId / approvalId / jobId 等の制御フィールドと、上で置き換えた宛先・添付を除いたもの
    })
  ```
  - `canonicalJson` はキーをソートし undefined を落とす既存実装（`lib/mail-policy/approved-send-pin.ts` と同じ規則）を共有する。
  - 宛先や添付を変えれば不一致になる。同じ指定でも、解決結果が変わった（例: autoroute の行き先が変わった）場合も不一致になる。
- 素の SHA-256 にしない理由: 短い秘密（例: 8 桁の数字）なら、DB を読める者が総当たりで値を戻せる。サーバー鍵付きの HMAC なら DB 単体の漏えいでは戻せない。
- 比較は `timingSafeEqual`。

### 3.3 監査の「ハッシュを書かない」規則との整合

- HMAC は `secret_permits.body_hmac` にだけ保存する。このテーブルは service_role 専用（RLS で authenticated を全拒否、§5）。
- 監査（`audit_logs`）の metadata には **permitId、requestId、surface、tool、pattern 名、fieldPath、matchLength、actor（承認者の memberId と経路）、宛先の区分（`recipientClass`: internal / external）、宛先 ID（解決後のチャンネル ID、またはメールアドレスの ID 相当）、理由コード**だけを書く。HMAC、本文、値、値の一部は書かない。
- permit 行は消費または期限切れの後、`body_hmac` を NULL にする（§5 の保持期間）。

### 3.4 1 回限り・短い有効期限

- 申請（pending）の有効期限: 30 分（決定事項 D-5）。
- 許可（granted）の有効期限: **許可から 10 分**（決定事項 D-5）。
- 消費は条件付き UPDATE 1 本で行う:
  ```sql
  update secret_permits
     set status = 'consumed', consumed_at = now(), body_hmac = null
   where id = $1 and org_id = $2 and employee_id = $3
     and status = 'granted' and expires_at > now()
  returning id;
  ```
  0 行なら拒否（`secret_permit_invalid`。理由は区別しない: 不一致、期限切れ、消費済み、他 org のどれでも同じコード）。
- 同時に 2 回再送しても、片方だけが 1 行を得る。
- 消費後、送信が下流で失敗しても permit は戻さない（再申請が必要）。重複送信より安全側。
- 消費するのは**他のゲートをすべて通過した後**（§3.7）。他のゲートで拒否・承認待ちになった再送では消費しない。

### 3.5 承認者が何を見て判断するか

- Slack/LINE/Telegram のカード: パターン名、fieldPath、文字数、ツール、宛先の種類（社内／社外）、申請者、**値を含まない形のヒント**（下記）だけ。**値と本文は出さない。**「Staffpass で確認」のリンクを付ける。
- Staffpass の承認画面（承認者だけが開ける）: 本文を表示するが、**検知した範囲は伏せ字**にし、前後の文脈（例: 前後 40 文字）だけ見せる。伏せ字の範囲は「最初の 2 文字 + ●」も出さない（完全に伏せる）。伏せ字の横に形のヒントを出す（D-6）。
- **形のヒント（値を含まない）**: 承認者が「業務の ID か、本物の秘密か」を判断する材料として、値そのものではなく形だけを出す。例:
  - 「16 進 40 文字（SHA-1 の形）」「16 進 64 文字（SHA-256 の形）」
  - 「base64。デコードすると JSON」「base64。デコードするとバイナリ」
  - 「UUID の形」「英数字 32 文字」
  - エントロピーの帯（低／中／高）
  - ヒントの計算はサーバー側で行い、文字数・文字種・形の名前だけを出す。値の一部、先頭や末尾の文字、デコード後の中身は出さない。
- そのための本文は `secret_permit_payloads` に AES-256-GCM で暗号化して置く（鍵は新 env `SECRET_PERMIT_PAYLOAD_KEY`。通知設定用の `NOTIFICATION_CONFIG_ENCRYPTION_KEY` と分ける）。決定・期限切れ・消費のどれかで**行ごと削除**する。
- 本文を保存せず、承認者はメタデータだけで判断する（ブラインド承認）案は採らない（D-6 決定: 伏せ字の本文 + 形のヒント）。

### 3.6 監査が書けなければ許可しない（fail-closed）

| 時点 | 監査 | 書けなかったとき |
|---|---|---|
| 申請作成 | `secret_detection.blocked`（既存）+ `secret_permit.requested` | 申請を作らない（ブロックはそのまま） |
| 許可 | `secret_permit.granted`（permit 更新と同一トランザクションの RPC） | ロールバック。許可は存在しない |
| 却下 | `secret_permit.denied` | 却下は書けなくても permit は granted にならないので安全。ただし再試行する |
| 消費 | `secret_permit.consumed` | 送信しない（permit は消費済みのまま。再申請が必要） |
| 不一致の再送 | `secret_permit.rejected`（reason: mismatch/expired/used/not_found） | ブロックのまま |

監査の org は既存と同じく credential から決める（リクエスト本文の org を信じない）。

### 3.7 許可が外すのは秘密検知だけ（他のゲートとの関係）

- 許可（一致した permit）が外すのは `secret_detected_in_payload` の判定だけ。次はすべて**許可があってもそのまま効く**:
  - egress（宛先の社内／社外判定、egress ポリシー、未分類チャンネルの扱い）
  - topic gate（話題による承認。機微な話題なら承認待ち）
  - `always_human`（社員の承認方針・ツール別の承認）
  - 承認後の fulfil 時の再確認（宛先・本文の pin など既存の再確認）
- 順序: 秘密検知（permit 一致の確認）→ 他のゲート → **すべて通過した後に permit を消費** → 送信。他のゲートで拒否された場合、permit は消費しない（期限内なら、原因を直して同じ本文で再送できる）。
- **他のゲートで承認待ちになった場合**: その時点では permit を消費しない。承認後の fulfil で**秘密検知をもう一度実行**し、同じ HMAC（解決後の値・permitId で計算）が一致すれば、fulfil の時点で消費して送る。permit の有効期限は fulfil の時点で判定する（期限切れなら fulfil は秘密検知で止まり、再申請が必要）。
- テスト（実装時）: permit 一致 + egress 拒否 → 送られず消費されない。permit 一致 + topic gate → 承認待ち、消費なし → 承認後 fulfil で再検知・一致・消費・送信。permit 一致 + always_human → 同様。

## 4. 誰が許可できるか（#279 の承認者モデルに合わせる）

- 判定は #279 の `checkApproverAuthority` を使う。`requiredApproverKind` は **`owner_or_designated_admin`**（D-2 決定）。将来社外宛てを足す場合、社外宛ての許可は **owner だけ**。
- **次の人は許可できない**:
  - **申請者**: その社員 AI に依頼した人（#279 の `requesterMemberIdsFromMetadata` / `requesterMemberId`）。#289 の `requesterSlackUserId`（AI が申告した依頼者。申告であって検証済みではない、という #289 の限界をそのまま引き継ぐ。申告が無い／偽りの場合に備えて、下の「AI は許可できない」で別に守る）。
  - **AI を起こした検証済みの発話者（wake speaker）**: その送信のもとになった会話で AI を起こした人のうち、検証済み（Slack の署名検証済みイベントの user など）の人。申告ではなく検証済みの値なので、申請者の申告が欠けていても自己許可を防げる。
- **AI は許可できない。** 社員 credential（`gb_emp_`）と admin MCP credential（`gb_adm_`）は、permit の許可 API を呼べない（API は人のセッションか、検証済みの投票者バインディング経由の押下だけを受ける）。admin MCP にも許可ツールを作らない。
- **単独 owner の例外**: org の owner が 1 人だけで、指名 admin もいない場合、#279 と同じく owner は自分の依頼でも許可できる。ただし:
  - 監査に `selfApprovalException: "single_owner"` を残す。
  - 本機能では例外を**既定 OFF** にする（秘密の扱いは通常の承認より重いため。D-1 決定。org ごとにフラグで ON）。
- Slack/LINE/Telegram で押した場合は、#279 の検証済み投票者バインディング（押した人の外部 ID → member）を必須にする。バインディングが無い押下は「Staffpass で確認してください」に誘導し、許可しない。
- 実行時にも `assertApproverAuthorityForExecution` 相当で、許可者がまだ権限を持っているかを確認する（許可から消費までの間に権限を外された場合は拒否）。
- 前提フラグ: `APPROVER_AUTHORITY_ENABLED` が OFF の org では、本機能も申請を出さない（従来どおりブロックのみ）。

## 5. 脅威モデルと BOLA / RLS / 自己承認の分析

### 5.1 脅威モデル

| # | 脅威 | 対策 |
|---|---|---|
| T1 | AI（プロンプトインジェクションを含む）が本物の秘密を外へ出すため、許可を取りにいく | named/カード/credential URL は申請不可（§2）。AI は許可できない（§4）。カードに値を出さない。 |
| T2 | 許可を得た後、AI が本文を差し替えて送る | 本文 HMAC 一致が必須。再 detect で pattern 集合の一致も見る。 |
| T3 | 1 つの許可を何度も使う | 条件付き UPDATE で 1 回だけ。 |
| T4 | 他 org、他社員の permit を使う | HMAC 鍵を org ごとに導出 + 行の org/employee/credential 一致を UPDATE の条件に入れる。 |
| T5 | 申請者が自分で許可する（自己承認） | #279 の requester 判定 + AI を起こした検証済みの発話者も許可不可 + 単独 owner 例外の扱い（§4）。 |
| T6 | Slack 等の押下のなりすまし | 検証済み投票者バインディング必須。 |
| T7 | DB の読み取りから値が漏れる | HMAC は鍵付き。本文は暗号化して短期保存、決定時に削除。監査に値もハッシュも無い。 |
| T8 | 監査を落として痕跡なく許可する | 監査と許可を同一トランザクション。書けなければ許可なし。 |
| T9 | 承認疲れで何でも許可される | 許可は 1 通ずつ。1 日の上限（org ごとに 5 件、社員ごとに 2 件。D-7）と、承認画面に「預け入れ画面を使う」導線。 |
| T10 | 期限切れ後の再利用 | `expires_at > now()` を UPDATE 条件に入れる。 |
| T11 | クライアントフラグでの回避（`allowSecrets` 等） | permit 行以外では通らない。既存テストを残し、`secretPermitId` 付きでも行が無ければ拒否するテストを足す。 |
| T12 | 許可を足がかりに他のゲート（egress、topic gate、always_human）も抜ける | 許可が外すのは秘密検知だけ。消費は他のゲートの通過後（§3.7）。 |
| T13 | 宛先の解決結果の差し替え（U→D 書き換え、autoroute の行き先変更）や添付の差し替え | HMAC は解決後の宛先と添付の内容ハッシュに対して取る（§3.2）。 |
| T14 | 社外へ秘密を出す | 初期は社内宛てだけ（§2.5）。 |
| T15 | セーフリンクで包んだ再設定 URL を通す | 分類の前にセーフリンクを剥がす。長いランダム部分のある URL は語に関係なく除外（§2.3）。 |

### 5.2 BOLA

- permit/申請の ID はランダム（推測不能）だが、**ID の秘匿に頼らない**。すべての読み書きで `org_id` をセッションまたは credential から決め、行の `org_id` と照合する（URL やボディの org を信じない）。
- 承認画面の取得 API は、(1) セッションの org = 行の org、(2) セッションの member が §4 の承認者、の両方を満たさない限り 404 を返す（存在を漏らさない）。
- 社員 AI 側の再送では、credential の employee/org = 行の employee/org を UPDATE 条件に含める。

### 5.3 RLS

- 新テーブル（§7）はすべて `enable row level security` + authenticated/anon に対するポリシーを作らない（全拒否）。アクセスは service_role のサーバーコードだけ。
- テナント書き込みの棚卸し（tenant write inventory）に新しい書き込み箇所を登録する（#279 で `recovery.ts:approval_requests:update` を足したのと同じ手順）。
- テスト: authenticated ロールで select/insert/update が 0 行／拒否になることを migration テストで確認する。

### 5.4 自己承認

- 判定点は 2 か所: 許可 API（人の操作時）と、消費時の再確認（`assertApproverAuthorityForExecution` 相当）。
- 許可できない人: 申請者と、AI を起こした検証済みの発話者（§4）。どちらも両方の判定点で見る。
- AI の credential は承認 API の認証方式を満たさない（人のセッションか検証済み押下だけ）。これを route テストで固定する。
- 単独 owner 例外は既定 OFF（D-1 決定）。

## 6. 秘密を預ける画面（deposit）

### 6.1 使い方（ユースケース）

1. **人から人へ渡す**: 例えば HUB の再設定 URL を、チャットに書かずに相手へ渡す。預ける → 相手に「1 回だけ見られるリンク」を送る → 見たら消える。
2. **社員 AI が使う業務用の秘密を預ける**（例: 業務システムのログイン）: 預けるところまでは本メモの範囲。**AI がそれを使う（差し込む）のは D4 lease で、八坂の別 GO が必要**。それまでは「預けた、参照 ID がある」状態に留まる。

### 6.2 D4 の設計ロックとの関係

`docs/staffpass-situation-policy-catalog.md` の D4 で確定していること:
1. Staffpass の jsonb に生の秘密を置かない（参照メタデータだけ）。
2. 秘密の保管と短命な差し込みは Sealith 拡張が本命。専用 vault は Sealith が間に合わない場合だけ。
3. 作成・更新・削除は admin エージェント + 人を通す。

このため、預け入れ画面の**保管先**は次から選ぶ（D-8。**八坂の判断待ち**）:

| 案 | 内容 | 評価 |
|---|---|---|
| (a) Sealith に直接保管 | 画面は Staffpass、保管は Sealith。Staffpass には参照 ID だけ。 | 設計ロックに最も合う。Sealith 側の API が前提。 |
| (b) Staffpass の「一時受け渡し箱」 | 専用テーブルに暗号化して保管。**既定 24 時間・最長 7 日、閲覧 1 回で削除**。vault ではなく transit。仕様は §6.7。 | ユースケース 1 には十分。ロック 1（jsonb に生秘密を置かない）は満たすが、ロック 2 の「専用 vault の例外」に当たるかを八坂に確認する。 |
| (c) 保管しない | 画面から直接相手の画面へ（同時接続が必要） | 実用性が低い。 |

**推奨**: ユースケース 1 は (b)、ユースケース 2 は (a)（D4 GO の後）。以下は (b) の設計。

> **D-8 は八坂の判断待ち**（木村が八坂に確認中）。(b) を採るかどうかが決まるまで、§6.3〜§6.7 は設計案であり、実装しない。

### 6.3 保管と暗号化

- テーブル `secret_deposits`（§7）。値は封筒暗号化（envelope encryption）:
  - 行ごとにランダムなデータ鍵（DEK、32 byte）で AES-256-GCM。
  - DEK は鍵暗号鍵（KEK、新 env `SECRET_DEPOSIT_KEK`。通知設定用の鍵とも permit 用の鍵とも分ける）で AES-256-GCM で包む。
  - AAD に `org_id` と `deposit_id` を入れる（行の付け替えで復号できないようにする）。
  - 形式は `lib/notify/crypto.ts` の `v1.iv.tag.ct` に合わせ、`kid`（鍵 ID）を足して鍵のローテーションに備える。
- 平文は DB、ログ、監査、エラー応答、Sentry 等に出さない。リクエストのログで本文を落とす（既存の redaction の対象に deposit の route を足す）。
- 指紋: 値の識別用に「HMAC（org 導出鍵）の先頭 8 文字」を画面に出す案（同じ値を 2 回預けたかの確認用）は、D-9 の決定で**出さない**（必要が出たら追加）。監査にも出さない。

### 6.4 アクセス

| 操作 | 誰が | 経路 |
|---|---|---|
| 預け入れリンクを作る | 承認者（owner / 指名 admin）、または org の member が自分用に | Staffpass 画面。admin MCP からは「リンクを作る申請」だけ（人の承認で作る。D4 ロック 3） |
| 預ける（入力） | リンクを開いた org の member（ログイン必須） | `setup-links.ts` 方式の短命な署名付きリンク（15 分、1 回限り）→ Staffpass の入力画面 |
| 見る（1 回） | 預けた人が指定した受け取り手（org の member、ログイン必須） | 閲覧リンク（既定 24 時間・最長 7 日、1 回限り、見た時点で削除。開く試行回数に上限。§6.7） |
| 社外の人に渡す | 初期は不可（D-10 決定） | — |
| メタデータを見る・取り消す | 預けた人、承認者 | Staffpass 画面 |
| AI が使う | **不可**（D4 lease の GO 後に別設計） | — |
| LLM に値を渡す | **常に不可** | — |

- リンクの ID や署名を推測できても、セッションの org と受け取り手の member 一致を見る（§5.2 と同じ BOLA の考え方）。
- 預ける人と見る人が同じ場合は、受け渡しの意味がないので拒否する（自分用の保管は D4/Sealith の範囲）。

### 6.5 監査

`secret_deposit.link_created`、`.deposited`、`.revealed`、`.revoked`、`.expired`、`.reveal_denied`。metadata は depositId、ラベル（人が付けた名前。値を書かないよう入力欄で注意書きと検知を行う）、actor、受け取り手の memberId、理由コードだけ。値、値の一部、ハッシュは書かない。**監査が書けなければ、その操作（預け入れ・閲覧）を行わない。** 閲覧は「監査を書く → 復号して返す → 行を削除」の順。

### 6.6 D4 lease との境界（八坂 GO）

- 本メモは「預け入れて参照 ID を持つ」までを設計する。**社員 AI の実行時に秘密を差し込む D4 lease の実装は、八坂の別 GO が出るまで着手しない。**
- 預け入れ画面の実装（§6.2 (b)）自体も、保管先の決定 D-8 で (b) を八坂が了承した後に着手する。

### 6.7 一時受け渡し箱の仕様（D-8 で (b) を採る場合。木村 10/9 指定）

| 項目 | 仕様 |
|---|---|
| 有効期限 | **既定 24 時間、最長 7 日**（作成時に指定。7 日を超える指定は拒否） |
| 閲覧 | 1 回だけ。**開いた時点で `ciphertext` と `wrapped_dek` の両方を NULL にする**（同じ UPDATE で。暗号文だけ消して DEK を残す、またはその逆はしない） |
| 開く試行の上限 | 閲覧リンクごとに試行回数の上限を設ける（例: 5 回。ログイン済みでも受け取り手でない、署名不一致、期限切れなどの失敗を数える）。上限に達したら、その預け入れを `revoked` にして `ciphertext` と `wrapped_dek` を NULL にし、預けた人に知らせる（値は送らない） |
| 期限切れ | 期限で `expired` にし、`ciphertext` と `wrapped_dek` を即 NULL（D-11） |
| 順序 | 閲覧は「監査を書く → 復号 → 同じトランザクションで `ciphertext` / `wrapped_dek` を NULL → 値を返す」。監査が書けなければ開かない |
| 応答 | `Cache-Control: no-store`。値は応答本文にだけ載せ、ログ・監査・エラーには出さない |
| 監査 | `secret_deposit.revealed` / `.reveal_denied`（試行回数を含む）/ `.reveal_locked`（上限到達）/ `.expired`。値・ハッシュは書かない |

## 7. データモデル（案）

```sql
-- 1 通だけの許可
create table secret_permits (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references orgs(id),
  employee_id      uuid not null,
  credential_id    uuid not null,
  approval_request_id uuid not null references approval_requests(id),
  surface          text not null check (surface = 'gateway_invoke'),
  tool             text not null,
  patterns         text[] not null,          -- eligible なパターン名だけ
  field_paths      text[] not null,
  body_hmac        bytea,                    -- 消費・期限切れで NULL
  hmac_kid         text not null,
  status           text not null check (status in ('pending','granted','denied','consumed','expired')),
  requester_member_id uuid,                  -- #279 の requesterMemberId
  granted_by_member_id uuid,
  grant_channel    text,                     -- web / slack / line / telegram
  self_approval_exception text,              -- 'single_owner' or null
  requested_at     timestamptz not null default now(),
  request_expires_at timestamptz not null,
  granted_at       timestamptz,
  expires_at       timestamptz,              -- 許可の有効期限
  consumed_at      timestamptz
);
create unique index on secret_permits (approval_request_id);
alter table secret_permits enable row level security;   -- ポリシーなし = service_role のみ

create table secret_permit_payloads (       -- 承認者確認用。決定・期限で行削除
  permit_id   uuid primary key references secret_permits(id) on delete cascade,
  org_id      uuid not null,
  ciphertext  text not null,                -- v1.kid.iv.tag.ct
  mask_ranges jsonb not null,               -- 伏せ字の範囲（位置と長さのみ）
  delete_after timestamptz not null
);
alter table secret_permit_payloads enable row level security;

-- 預け入れ（§6.2 (b) を採る場合）
create table secret_deposits (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id),
  label         text not null,
  created_by_member_id uuid not null,
  recipient_member_id  uuid,               -- 受け渡し用
  wrapped_dek   text,                      -- 閲覧・期限切れ・取り消しで NULL
  ciphertext    text,                      -- 閲覧・期限切れ・取り消しで NULL（行は監査参照用に残す）
  kid           text not null,
  status        text not null check (status in ('awaiting_input','stored','revealed','revoked','expired')),
  expires_at    timestamptz not null,      -- 既定 24 時間、最長 7 日
  reveal_attempts int not null default 0,  -- 開く試行の失敗回数（上限で revoked）
  created_at    timestamptz not null default now(),
  revealed_at   timestamptz,
  check (expires_at <= created_at + interval '7 days')
);
alter table secret_deposits enable row level security;

create table secret_deposit_links (        -- 入力用・閲覧用の 1 回限りリンク
  id          uuid primary key default gen_random_uuid(),
  deposit_id  uuid not null references secret_deposits(id) on delete cascade,
  org_id      uuid not null,
  purpose     text not null check (purpose in ('input','reveal')),
  token_hash  bytea not null,              -- リンクのトークンは HMAC で保存
  expires_at  timestamptz not null,
  used_at     timestamptz
);
alter table secret_deposit_links enable row level security;
```

- 許可と監査を同時に書く RPC: `grant_secret_permit(p_permit_id, p_org_id, p_member_id, p_channel, p_audit jsonb)`（`security definer`、service_role だけに `execute` を付与）。
- 期限切れの掃除: 既存の定期ジョブに「`expires_at` を過ぎた permit を expired にして `body_hmac` を NULL、payload 行（暗号文）を削除」「期限切れの deposit の `ciphertext` と `wrapped_dek` を NULL」を足す。**値・HMAC・暗号文・包んだ DEK は期限の時点で即消去**し、メタデータだけの行は 90 日で削除（D-11 決定）。
- 1 日の許可上限（D-7）: org ごとに 5 件、社員ごとに 2 件。`secret_permits` の `granted_at` で数え、上限を超える許可は `secret_permit_daily_limit` で拒否（監査あり）。

## 8. API の形（案）

### 8.1 ブロック時の応答（gateway、フラグ ON かつ eligible の場合だけ追加）

```jsonc
// 403。既存のエラー応答はそのまま。retryable:false も維持
{
  "ok": false,
  "code": "secret_detected_in_payload",
  "pattern": "base64_long_secret",
  "fieldPath": "args.text",
  "redactedPreview": "[REDACTED]",
  "retryable": false,
  "permitRequest": {                 // 追加
    "requestId": "apr_…",
    "status": "pending",
    "expiresAt": "2026-10-09T13:30:00Z",
    "hint": "承認者が Staffpass で 1 回だけの許可を出した後、同じ本文で secretPermitId を付けて再送してください。"
  }
}
```

eligible でない場合（named パターン、credential URL、社外の宛先を含む等）は `permitRequest` を付けず、`hint` で預け入れ画面を案内する（`"secretDeposit": { "available": true }`。リンクは人向けで、AI には URL を渡さない）。

### 8.2 状態確認（社員 AI）

`GET /api/gateway/secret-permits/{requestId}` → `{ status: "pending"|"granted"|"denied"|"expired"|"consumed", secretPermitId?: "spm_…", expiresAt }`。credential の org/employee と一致しなければ 404。

### 8.3 再送

既存の invoke に `secretPermitId` を付けるだけ。本文は 1 文字も変えない。失敗は `secret_permit_invalid`（理由は区別しない）。

### 8.4 承認者（人のセッション）

- `GET  /api/secret-permits/{id}` → メタデータ + 伏せ字の本文（承認者だけ。他は 404）
- `POST /api/secret-permits/{id}/grant` → `{ ok: true, expiresAt }`。監査が書けなければ `503 secret_permit_audit_unavailable`、許可なし。
- `POST /api/secret-permits/{id}/deny`
- Slack/LINE/Telegram のボタンは既存の承認 decide 経路に `kind=secret_permit` で乗せ、検証済み投票者バインディングを必須にする。

### 8.5 預け入れ（§6.2 (b)）

- `POST /api/secret-deposits` `{ label, recipientMemberId, ttlHours（既定 24、最大 168） }` → `{ depositId, inputLink }`（入力リンクは画面にだけ表示）
- `POST /api/secret-deposits/input/{token}` `{ value }` → `{ depositId, status: "stored" }`（値は返さない）
- `POST /api/secret-deposits/reveal/{token}` → `{ value }`（1 回だけ。開いた時点で `ciphertext` と `wrapped_dek` を NULL。試行回数の上限あり。応答に `Cache-Control: no-store`）
- `POST /api/secret-deposits/{id}/revoke`
- admin MCP: `secretDeposit.requestInputLink`（人の承認で作る）だけ。値を受け取る・見るツールは作らない。

## 9. フラグと展開

| フラグ | 既定 | 内容 |
|---|---|---|
| `SECRET_ONE_SHOT_PERMIT_ENABLED` | OFF | §3 の申請・許可・消費。`APPROVER_AUTHORITY_ENABLED` も ON の org だけで動く。 |
| `SECRET_PERMIT_SINGLE_OWNER_SELF_GRANT` | OFF | 単独 owner の自己許可（D-1）。 |
| `CREDENTIAL_URL_CLASSIFIER_MODE` | `exclude_only` | `exclude_only`（許可の除外だけ）→ `observe`（`secret_detection.suspected` に記録）→ `enforce`（ブロック）。D-4 決定: `exclude_only` で始めるが、最初の実装 PR に `observe` を入れる（下記）。 |
| `SECRET_DEPOSIT_ENABLED` | OFF | §6 の預け入れ画面。 |
| D4 lease | — | **フラグも実装もない。八坂の別 GO が必要。** |

テナント固有のハードコードはしない（org 単位の有効化は既存の org 設定で行う）。

**展開の順序**

1. 本設計メモの合意（木村: 10/9 22:55 に一般指摘 1〜6 と D-0〜D-11 を決定済み）。**D-8（保管先）と D-12（D4 lease）は八坂の判断待ち。実装は八坂の GO の後。**
2. 実装 PR 1: eligibility 分類（named/generic/credential URL。セーフリンクの剥がし、長いランダム部分の判定、Staffpass リンクの完全一致 + 署名検証）+ テスト。**`observe` を含める**: credential URL を検知して `secret_detection.suspected` に記録するだけ（ブロックしない。値・URL は記録せず、分類名・host の区分・件数だけ）。今は通っている再設定 URL 等の件数を数え、`enforce` に進むかの判断材料にする。
3. 実装 PR 2: permit のテーブル・RPC・gateway の申請と消費・承認 API（フラグ OFF）。fail-first のテスト: 本文 1 文字違い、宛先違い（解決後の宛先違いを含む）、添付の内容違い、2 回目、期限切れ、他 org、社外宛て、申請者の許可、AI を起こした発話者の許可、AI credential での許可、監査失敗、`allowSecrets` での回避、egress / topic gate / always_human が許可後も効くこと、承認待ち → fulfil での再検知と消費、1 日上限（org 5 / 社員 2）。
4. 実装 PR 3: 承認画面（伏せ字）とカード（値なし）。
5. 実装 PR 4: 預け入れ画面（D-8 の決定後。(b) なら §6.7 の仕様）。
6. 社内 org で ON → 1 週間の監査確認 → 個別 org で ON（本番の env や設定の変更は担当外。手順書を書いて渡す）。

## 10. 決定事項（2026-10-09 22:55 木村）と未決事項

| ID | 論点 | 決定 | 決める人 / 状態 |
|---|---|---|---|
| D-0 | HUB の件は #281 のデプロイ前か後か | 推奨どおり: 読み取り（PostgREST GET）で確認してから実装の優先度を決める | 木村 / **決定** |
| D-1 | 単独 owner の自己許可を認めるか | 推奨どおり: 既定 OFF（`SECRET_PERMIT_SINGLE_OWNER_SELF_GRANT`、org ごとに ON） | 木村 / **決定** |
| D-2 | 許可できるのは owner だけか、指名 admin も含むか | `owner_or_designated_admin`。**将来の社外宛ては owner だけ** | 木村 / **決定** |
| D-3 | キーワード系（`password_inline` 等）を eligible にするか | 推奨どおり: 初期は対象外。誤検知の監査を見て判断 | 木村 / **決定** |
| D-4 | credential URL を新たにブロックするか | `exclude_only` で開始。**ただし最初の実装 PR に `observe`（検知して記録）を入れ、今通っている再設定 URL の件数を数える** | 木村 / **決定** |
| D-5 | 有効期限（申請 30 分／許可 10 分） | 推奨どおり | 木村 / **決定** |
| D-6 | 承認者に何を見せるか | **伏せ字の本文 + 値を含まない形のヒント（§3.5）**。本文は決定時に削除 | 木村 / **決定** |
| D-7 | 1 日の許可上限 | **org ごとに 5 件、社員ごとに 2 件** | 木村 / **決定** |
| D-8 | 預け入れの保管先（Sealith / Staffpass 一時受け渡し箱 / 保管しない） | 推奨: 人への受け渡しは Staffpass 一時受け渡し箱、AI 向けは Sealith（D4）。(b) を採る場合の仕様は §6.7（既定 24 時間・最長 7 日、開いた時点で暗号文と包んだ DEK を NULL、開く試行に上限） | **八坂 / 判断待ち**（木村が確認中。D4 設計ロック 2 に関わる） |
| D-9 | 預けた値の指紋（HMAC 先頭 8 文字）を画面に出すか | 推奨どおり: 出さない（必要が出たら追加） | 木村 / **決定** |
| D-10 | 社外の受け取り手に見せるか（メール OTP） | 推奨どおり: 初期は不可 | 木村 / **決定** |
| D-11 | permit / deposit 行の保持期間 | **90 日。値・HMAC・暗号文・包んだ DEK は期限で即消去** | 木村 / **決定** |
| D-12 | D4 lease の実装 GO | 本メモの範囲外 | **八坂 / 判断待ち** |

## 11. 木村レビュー（10/9 22:55）の一般指摘と反映先

| # | 指摘 | 反映先 |
|---|---|---|
| 1 | HMAC は解決後の値（U→D 書き換え・autoroute 後のチャンネル ID、正規化した to/cc/bcc、添付の内容ハッシュ、permitId）に対して取る | §3.1、§3.2、T13 |
| 2 | 許可が外すのは秘密検知だけ。egress、topic gate、always_human、承認後の fulfil はそのまま効くと明記。消費は他のゲートをすべて通過した後。承認待ち後の fulfil では秘密検知を再実行し、同じ HMAC の一致を認める | 不変条件 5、§3.1、§3.4、§3.7、T12 |
| 3 | 初期は社内宛てだけ。社外は範囲外。将来社外を足すときは owner だけが許可できる | 不変条件 6、§2.5、§4、D-2、T14 |
| 4 | 承認者に値を含まない形のヒント（「16 進 40 文字、SHA-1 の形」「base64 でデコードすると JSON」、エントロピーの帯）を出す | §3.5、D-6 |
| 5 | 許可できない人: 申請者と、AI を起こした検証済みの発話者。監査に宛先の区分（社内／社外）と宛先 ID を足す | §3.3、§4、§5.4、T5 |
| 6 | credential URL の分類は広く: 長くランダムなパス／クエリ／フラグメントを持つ URL はすべて除外。先にセーフリンクを剥がす。Staffpass リンクの例外は host の完全一致かつ署名検証済みの場合だけ | §2.3、T15 |
