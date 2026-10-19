# Staffpass メール経路と DKIM リプレイ点検

**日付:** 2026-10-19  
**範囲:** 読み取り専用。コード変更・本番設定・DNS 変更はしていない。実メールは送っていない。  
**対象:** `staffpass.sealith.com` と、そこから送信に使っているドメイン。  
**背景:** 楽天カードを名乗るフィッシングが SPF / DKIM / DMARC すべて pass で届いた。署名対象は `h=From:From` だけ（DKIM リプレイ）。

この文書はリポジトリと公開 DNS（`dig`）から分かることに限定する。本番の `EMAIL_FROM`・Resend ダッシュボード・Supabase Auth の SMTP 実値はコードに無い。実際の受信ヘッダは依頼者側で確認する前提。秘密値・検証トークン・公開鍵本体は書かない。

---

## 結論（先に）

| # | 項目 | 現状 | 危険度 |
|---|------|------|--------|
| 1 | 外部へ署名付きメールを出せる経路 | Resend の制御面通知と、Supabase Auth の再設定メールが主。`mail.send` は Resend を使わない。`/api/email` と `/api/trial` はコード上も削除済み | **高**（未確認宛先へ出せる経路がある） |
| 2 | DKIM 署名対象ヘッダ | アプリは `h=` を指定できない。Resend / Supabase SMTP 側の設定。公開 DNS では apex `sealith.com` に Resend セレクタがある | **高**（実ヘッダ未確認。鍵は 1024 bit 相当） |
| 3 | 未確認宛先のサブドメイン分離 | 未実装。送信 From は `EMAIL_FROM` 一本 | **中**（分離すればリプレイの被害範囲を狭められる） |
| 4 | DKIM 輪番と DMARC `rua` 監視 | リポジトリに手順書・cron・実装なし。DNS 上の `rua` は存在する | **中** |
| 5 | SPF | apex はロリポップのみ。Resend 用は `send.sealith.com`。どちらも `~all`。`staffpass.sealith.com` に送信用 TXT は無い | **中** |

いちばん危ないのは「認証なしで、第三者が指定した宛先に、Staffpass 名義の署名付きメールが届く」経路である。signup の歓迎／トライアル開始と、パスワード再設定がそれに当たる。攻撃者が自分の受信箱で正規署名を入手し、`h=` が薄いと件名・本文・宛先を差し替えてリプレイできる。

---

## 1. 署名付きメールを外部に送れる経路

### 送信の層

| 層 | 実装 | 本番の用途 |
|----|------|------------|
| Staffpass Resend | `lib/resend.ts` → `resend.emails.send`。From は `EMAIL_FROM`（未設定時は `Staffpass（AIエージェントの社員証） <noreply@example.com>`） | 制御面の通知。AI 社員の営業メールには使わない（`docs/mail-policy.md`） |
| Supabase Auth SMTP | `resetPasswordForEmail` など。From / SMTP はダッシュボード。リポジトリに値なし | パスワード再設定。招待リンク受信面は実装済みだが、アプリから Invite API は呼んでいない |
| Human Gmail | `lib/google/gmail-send.ts`。`MAIL_SEND_GMAIL_LIVE` 既定 OFF | 承認済み `mail.send` のみ。Resend は使わない |
| AgentMail | 予約。`agentmail.send` は 501 `tool_reserved` | 使わない |

削除済み（コード残存なし、本番 404 確認済みと一致）:

- `POST /api/email` — ディレクトリも `route.ts` も無い（`lib/auth/p0-unauth-401.test.ts` SEC1）
- `POST /api/trial` — 同上。トライアル開始は `POST /api/auth/signup` に統合

### 経路表

略号: **第三** = 認証なしで任意アドレスに送れるか。**入力** = 利用者が入れた文字列が件名や本文に載るか。**CAPTCHA** = Cloudflare Turnstile。

| 経路 | ファイル | 送信 | From | 第三 | 入力が載るか | 回数制限 | CAPTCHA | 承認 | リプレイ危険度 |
|------|----------|------|------|------|--------------|----------|---------|------|----------------|
| サインアップ歓迎・トライアル開始 | `app/api/auth/signup/route.ts` → `lib/email.ts` | Resend | `EMAIL_FROM` | **はい**（入力アドレスへ） | 件名に会社名（HTML は escape、件名は送信時に制御文字除去）。本文は定型 | Layer2 は既定 OFF。ON なら IP 10分5 / 24時間20、宛先 24時間5、作成 1時間30。Turnstile は必須 | **あり**（本番 fail-closed。honeypot あり） | なし | **高** |
| 管理 MCP の org 作成 | `lib/admin-mcp/orgs-create.ts` → `lib/email.ts` | Resend | `EMAIL_FROM` | いいえ（管理 MCP）。指定オーナーへ welcome / trial | 件名に org 名 | ツール側の管理認証。signup 制限は使わない | なし | 管理 MCP の権限 | **中**（内部から未確認宛先へ出せる） |
| サインアップ確認（Supabase） | `lib/auth/session.ts` `createUser({ email_confirm: true })` | 送らない | — | — | — | — | — | — | **なし**。確認メールは出さない |
| 招待 | `app/api/team/members/route.ts` → `lib/team/apply-member-change.ts` | **アプリからは送らない** | — | — | — | ログイン済みの team 権限 | なし | ロール検査のみ | **低**（アプリ経路なし）。`/auth/confirm?type=invite` は受信面だけ。`inviteUserByEmail` / `generateLink` はリポジトリに無い。ダッシュボードからの手送りはコード外 |
| パスワード再設定 | `app/api/auth/forgot-password/route.ts` | **Supabase SMTP** | ダッシュボードの SMTP From（コードに無し） | **はい**（存在するアカウントなら届く。応答は常に同じ） | テンプレは Supabase。アプリは件名/本文を作らない | プロセス内: IP 15分5、宛先 1時間3（サイレント）。サーバレスではインスタンス単位。Supabase 側にも上限あり | **なし** | なし（同一オリジン必須） | **高** |
| LP 相談フォーム（問い合わせ） | `app/lp/ai-employee/consult/page.tsx` → `app/api/lp/ai-employee/inquiry/route.ts` → `lib/lp/notification-outbox.ts` | Resend | `EMAIL_FROM` | **いいえ**（`AI_EMP_INQUIRY_NOTIFY_EMAIL` 固定。投稿者へ自動返信なし） | **はい**。件名 `【AI社員パック問い合わせ】{会社} - {名前}様`。本文に会社・名前・メール・電話・人数・業務（最大2000文字、HTML escape） | フラグ既定 OFF。ON なら IP 1分5 + 全体 1分100（メモリ）。宛先ごとの制限なし | フラグ既定 OFF。ON でも鍵未設定は **通過**（fail-open） | なし | **中**（宛先は運営。件名・本文は攻撃者が作れる） |
| LP handoff | `app/api/lp/handoff/route.ts` → `app/api/cron/lp-handoff-outbox/route.ts` | **メールは未配線**。Slack webhook が実送信。`LP_HANDOFF_NOTIFY_EMAIL` はログして成功扱い | — | いいえ | 要約・連絡先が Slack 本文に載る | `LP_HANDOFF_ENABLED` 既定 OFF。ゲスト CSRF + IP ハッシュ必須 | 会話開始時の Turnstile（フラグ次第） | ゲスト確認（PUT） | **低**（Resend を呼んでいない） |
| `mail.send`（`staffpass_invoke`） | `lib/approvals/fulfill.ts` + `lib/google/gmail-send.ts` | **Gmail**（フラグ ON 時）。Resend 不使用。既定は stub | 連携メールボックスと一致必須 | いいえ（社員証 + ポリシー + 承認） | **はい**（承認カードに件名・本文） | プラン / `actionLimits` / メールポリシー。既定の外部宛は draft 降格 | なし（MCP 認証） | **あり**（外部は draft_only。live は承認後） | **低**（Staffpass ドメインの DKIM ではない） |
| 承認が必要 | `lib/gateway/invoke.ts` ほか → `lib/email.ts` `sendApprovalNeededEmail` | Resend | `EMAIL_FROM` | いいえ（`BILLING_NOTIFY_EMAIL` → `APPROVAL_NOTIFY_EMAIL` → `owner@example.com`） | 件名は定型+リスク。本文に summary（HTML escape） | なし（チケット作成の副作用） | なし | チケット自体が承認対象 | **中**（宛先は運営。summary は AI/利用者が作れる） |
| 承認の結果（運営） | `lib/approvals/resolve-side-effects.ts` | Resend | `EMAIL_FROM` | いいえ（上記と同じ運営宛） | 件名に結果。本文に title と処理者 | なし | なし | 決定後の通知 | **中** |
| 承認の結果（社員の notify 先） | 同上 + `lib/employees/approval-notify-email.ts` | Resend | `EMAIL_FROM` | いいえ（その org の **有効メンバー** のみ。送信直前再検査） | 定型。「結論が出た」とダッシュボード URL のみ | なし | なし | 決定後 | **低** |
| 承認カード本体 | `lib/notify/channels.ts` | Slack / LINE / Telegram。メールではない | — | いいえ | カードに宛先・件名・本文先頭 | チャネル設定 | なし | 承認フロー | 対象外（メール DKIM ではない） |
| 課金（Stripe） | `app/api/webhooks/stripe/route.ts` → `lib/email.ts` | Resend | `EMAIL_FROM` | いいえ（`BILLING_NOTIFY_EMAIL`。顧客へ領収書は出さない） | 件名に event type。本文は id / status | Stripe 署名 + イベント台帳 | なし | Stripe 署名 | **低** |
| LP 初期費用の運営通知 | `lib/lp/setup-fee-payment.ts` | Resend（`BILLING_NOTIFY_EMAIL`）と任意 Slack | `EMAIL_FROM` | いいえ | 定型 + Checkout / event id | フラグ `lpAutoProvisionMode() === "dry_run"` | なし | Stripe 署名 | **低** |
| OAuth 接続 / 再利用検知 | `lib/mcp-oauth/notify.ts` | Resend | `EMAIL_FROM` | いいえ（その org の owner/admin） | 件名に社員名と client host | consent / token の制限 | なし | 人間の同意後 | **低〜中** |
| 配送失敗アラート | `lib/notify/delivery-failure-alert.ts` | Resend | `EMAIL_FROM` | いいえ（テナント owner/admin + `APPROVAL_ALERT_OPS_EMAILS`） | 定型。id と理由コードのみ | フラグ既定 OFF。org×種別×inbox 30分1 | なし | なし | **低** |
| チャネル stuck / hold / 連携コードロック / DCR 上限 | `lib/channel-classify/stuck-notify.ts`、`lib/safety/hold*.ts`、`lib/comm/link-code-guard.ts`、`lib/mcp-oauth/notify.ts` | Resend（ops） | `EMAIL_FROM` | いいえ（`APPROVAL_ALERT_OPS_EMAILS`） | 定型。id / 理由のみ | 各種フラグとスロットル | なし | なし | **低** |
| 社員証期限切れ | `lib/data/credential-expiry-notices.ts` + `app/api/cron/telegram-digest` | 承認 inbox（Slack 等）。Resend は使わない | — | いいえ | id のみ | フラグ + 閾値あたり1回 | なし | なし | 対象外 |
| AI 同士 wake 上限 | `lib/notify/ai-peer-wake-notice.ts` | 承認 inbox | — | いいえ | id のみ | フラグ既定 OFF | なし | なし | 対象外 |

### 補足

- **問い合わせの自動返信は無い。** 投稿者のアドレスへは送らない。運営の固定宛先だけ。
- **`orgs.create` の `invite=true`** は Supabase 招待メールを出さない。乱数パスワードで `email_confirm: true` し、Resend の welcome / trial を送る。パスワードはメールに載せない。
- **承認メールの運営宛**は env。未設定時のコード既定は `owner@example.com`（到達しないプレースホルダ）。本番の実宛先はリポジトリに無い。
- テストランナー `scripts/test-local.mjs` は `.env` を読まない。今回の点検テストも `RESEND_API_KEY` 等を外して実行した。

### 現状 / 危険度 / 直し方

**現状:** 未確認の第三者宛に Staffpass 名義で出せるのは、(1) 公開 signup の Resend 2通、(2) 公開パスワード再設定の Supabase メール。相談フォームは運営宛だが件名・本文は入力次第。`mail.send` は別レイヤ。

**危険度: 高**（signup / 再設定）。相談フォームは **中**。

**直し方（コード・PR 案）:**

- signup / `orgs.create` の歓迎メールを、項目 3 の未確認用 From に分ける（フラグ既定 OFF）。
- `SIGNUP_RATE_LIMIT_ENABLED` と `SIGNUP_ATTEMPT_LOG_ENABLED` を本番で ON にする前提の確認テストを足す（フラグ自体は既存）。
- パスワード再設定に Turnstile を足す（同一オリジンだけではボットを止めない）。
- 相談フォーム: 件名を固定（「LP 問い合わせ」+ id のみ）。会社名と本文は内部票またはハッシュ。`LP_INQUIRY_BOT_PROTECTION_ENABLED` / `LP_INQUIRY_RATE_LIMIT_ENABLED` を fail-closed に近づける（鍵未設定は 503）。
- 承認必要メールの summary を件名に出さない（結果メールはすでに定型化済み）。

**直し方（DNS / 設定・八坂さんの GO が必要）:**

- 本番 `EMAIL_FROM` の正確なアドレスを確認し、未確認用ドメインと分ける。
- Supabase Auth の SMTP From を、本番通知と別サブドメインにする。
- signup Layer2 フラグと LP ボット対策フラグの本番値を確認する。
- ダッシュボードからの手送り Invite を使っているなら、それも未確認用ドメインに載せる。

---

## 2. DKIM の署名対象ヘッダ（コードと設定から分かること）

### Resend

アプリは `from` / `to` / `subject` / `html` / `text` / `tags` だけ渡す（`lib/resend.ts`）。`headers`、`DKIM-Signature`、`h=`、セレクタは渡していない。署名対象は Resend（背後は Amazon SES）が決める。

公開資料上のよくある形は `s=resend`、`h=from:to:subject:date:message-id`。**これは実メールのヘッダで確認すること。** 楽天カード事例のように `h=From:From` だけ、という保証はコードからはできない。

件名は `sanitizeEmailSubject` で制御文字を落とし 200 文字まで。HTML は呼び出し側が escape する前提。DKIM の `h=` は変えない。

### コードから分かる送信元ドメイン

| 情報源 | 分かること |
|--------|------------|
| `EMAIL_FROM` | 唯一の From。本番値はリポジトリに無い。例は `noreply@your-verified-domain.com` |
| 既定フォールバック | `noreply@example.com`（未設定時。本番では使わない想定） |
| アプリホスト | `https://staffpass.sealith.com`（MCP / OAuth issuer / 確認 URL） |
| 公開 DNS | apex `sealith.com` に `resend._domainkey` がある → Resend 認証ドメインは **apex** が有力 |
| 公開 DNS | `send.sealith.com` に SES の MX と `include:amazonses.com` → Return-Path / MAIL FROM 用サブドメインが有力 |
| `staffpass.sealith.com` | Vercel CNAME のみ。SPF / DKIM / DMARC レコードなし。**送信ドメインではない** |

From が `@sealith.com` なら、DKIM `d=sealith.com` と relaxed DMARC で揃いやすい。From が `@staffpass.sealith.com` や `@send.sealith.com` なら、今の公開レコードでは DKIM が無い。**本番 From は受信ヘッダで確定してほしい。**

### Supabase Auth SMTP

パスワード再設定だけがアプリから Auth メールを起こす。`createUser` は `email_confirm: true` なので確認メールは出さない。Invite API は呼ばない。

From・SMTP ホスト・DKIM は Supabase ダッシュボード（カスタム SMTP なら Resend SMTP の可能性）。リポジトリに `config.toml` も SMTP 環境変数も無い。カスタム SMTP 未設定なら Supabase 共有送信になり、Staffpass ドメインの DKIM は付かない。

### Gmail `mail.send`

連携メールボックスの Google 署名。Staffpass / sealith の DKIM リプレイ対象ではない。

### 現状 / 危険度 / 直し方

**現状:** 署名ヘッダはプロバイダ任せ。公開 DNS は apex の Resend 1024 bit 相当鍵と、`send.sealith.com` の SES MAIL FROM。BIMI レコードは無い。

**危険度: 高**（実 `h=` 未確認 + 短い鍵 + 未確認宛先への送信）。

**直し方（コード・PR 案）:**

- 送信ラッパに「この通は未確認宛先」を渡せるようにする（項目 3）。DKIM `h=` 自体はアプリから変えられない。
- 運用チェックリストに「受信ヘッダで `h=` に From / To / Subject / Date / Message-ID / Content-Type があること」を書く。

**直し方（DNS / 設定・八坂さんの GO が必要）:**

- 実メールで `DKIM-Signature` の `d=` / `s=` / `h=` / `bh=` を確認する。
- `h=` が From だけ、または Subject / To / 本文を外しているなら、Resend サポートまたは送信ドメインの作り直しを依頼する（アプリでは直せない）。
- 1024 bit 鍵を 2048 bit に輪番（項目 4）。
- 本番 `EMAIL_FROM` を、公開されている DKIM ドメインと一致させる。
- Supabase SMTP を使うなら、その From も同じ方針で分ける。

---

## 3. 未確認宛先を別サブドメインにする案

### 方針

本番の承認・課金・運営アラートは今の送信ドメインのまま。BIMI は付けない。未確認の第三者宛だけを例: `mail-unverified.sealith.com` に出す。送信数は厳しく制限する。

| 種別 | From の例 | 載せるもの |
|------|-----------|------------|
| 確認済み・内部 | 現行 `EMAIL_FROM`（例: `noreply@sealith.com`） | 承認結果、課金、OAuth、hold、ops |
| 未確認 | `Staffpass <noreply@mail-unverified.sealith.com>` | signup 歓迎 / トライアル開始、将来の Auth 招待・再設定 |

同一 DKIM 鍵を共有しない。未確認側でリプレイされても、本番通知ドメインの信用は残す。

### フラグ（既定 OFF）

```
UNVERIFIED_MAIL_FROM_ENABLED=false
EMAIL_FROM_UNVERIFIED=Staffpass <noreply@mail-unverified.sealith.com>
```

OFF のときは今日と同じ（全部 `EMAIL_FROM`）。ON かつ `EMAIL_FROM_UNVERIFIED` が空なら **送らない**（fail-closed）。

### コード側 PR 案（この点検では実装しない）

1. **`lib/resend.ts`**
   - `SendEmailInput` に `audience: "verified" | "unverified"`（既定 `verified`）。
   - `getEmailFrom(audience)`。`unverified` はフラグ ON のときだけ `EMAIL_FROM_UNVERIFIED`。
   - stub ログに audience を出す（アドレスは出さない）。
2. **未確認に分類する呼び出し**
   - `lib/email.ts` の `sendWelcomeEmail` / `sendTrialStartedEmail`。
   - `lib/admin-mcp/orgs-create.ts` 経由の同じ 2 通。
   - 将来 Resend に移す Auth メール。
3. **verified のまま**
   - 承認・課金・OAuth・hold・stuck・DCR・配送失敗・LP 問い合わせ（運営固定宛）。
4. **制限（フラグ ON 時に必須）**
   - signup Layer2 を要求（未設定なら 503）。
   - 未確認 From の 1 時間あたり通数を別カウンタで持つ（IP と宛先）。
5. **テスト**
   - フラグ OFF: From は現行。
   - フラグ ON・env なし: 送信しない。
   - フラグ ON: welcome だけ未確認 From。承認メールは現行 From。
   - `env -u LP_HANDOFF_NOTIFY_SLACK_WEBHOOK -u APPROVAL_ALERT_OPS_EMAILS -u BILLING_NOTIFY_EMAIL -u RESEND_API_KEY` で実行。実送信禁止。
6. **やらないこと**
   - BIMI。
   - 未確認ドメインを LP / ダッシュボードの「公式」表記に出すこと。
   - 未確認メールに承認ボタンや請求リンクを載せること（今の welcome もリンクはアプリ origin）。

### DNS / Resend（八坂さんの GO）

- `mail-unverified.sealith.com` を Resend で別ドメイン認証。
- `resend._domainkey.mail-unverified.sealith.com`（2048 bit）。
- MAIL FROM 例: `send.mail-unverified.sealith.com`（apex `send.sealith.com` と混ぜない）。
- SPF は `include:amazonses.com -all`（または最初だけ `~all`）。
- `_dmarc.mail-unverified.sealith.com` は `p=reject`、`rua` は本番と別にしてもよい。BIMI なし。
- Supabase の再設定メールも、GO 後にこの SMTP From へ。
- 送信上限を Resend ダッシュボードでもかける。

### 現状 / 危険度 / 直し方

**現状:** From は一本。未確認と本番通知が同じ DKIM 信用を共有する。

**危険度: 中**（分離は被害範囲の縮小。signup 制限の方が先に効く）。

**直し方:** 上の PR 案（フラグ既定 OFF）と、八坂さん GO の DNS / Resend / Supabase SMTP。

---

## 4. DKIM 輪番と DMARC `rua` 監視

### リポジトリ

| 探しもの | 結果 |
|----------|------|
| DKIM / DMARC / SPF / `_domainkey` / `rua` の実装・手順 | **ヒットなし** |
| 鍵輪番の runbook | **なし** |
| `rua` を読む cron / worker | **なし**。`vercel.json` の cron は telegram-digest、expire-trials、stuck-watch、lp-handoff-outbox、mcp-events-deliver、oauth-purge のみ |
| BIMI | コードも DNS もなし |

`docs/mail-policy.md` は `mail.send` の承認ポリシー。送信ドメインの認証運用は書いていない。

公開 DNS の `_dmarc.sealith.com` には `rua=mailto:dmarc@sealith.com` がある。集計を読んでいる実装はこのリポジトリに無い。人がその受信箱を見ているかはコードからは分からない。

### 現状 / 危険度 / 直し方

**現状:** 輪番も `rua` 監視もコード化されていない。公開鍵は 1024 bit 相当（`p=` の形。本体は記載しない）。

**危険度: 中**（漏えい・弱い鍵・リプレイに気づきにくい）。

**直し方（コード・PR 案）:**

- `docs/ops/email-auth-rotation.md`（GO 後）: 2048 bit 再発行、新旧セレクタの重ね期間、Resend 再検証、受信ヘッダ確認、古い `p=` の削除。
- 任意: `rua` を週次で要約するジョブ（別受信箱。このリポジトリの外でも可）。

**直し方（DNS / 設定・八坂さんの GO が必要）:**

- Resend で 2048 bit に出し直し、新セレクタを公開してから旧 `resend._domainkey` を落とす。
- `dmarc@sealith.com` の所有者と、未読になっていないかを確認する。必要なら専用箱または外部 DMARC 監視。
- 四半期ごとの輪番をカレンダーに入れる。

---

## 5. 公開 DNS（`dig`、2026-10-19）

秘密値・サイト検証トークン・DKIM 公開鍵本体は載せていない。

### 一覧

| 名前 | 種別 | 結果 |
|------|------|------|
| `sealith.com` TXT | SPF | `v=spf1 include:_spf.lolipop.jp ~all`（Web ホスト）。Resend / SES は **含まない** |
| `sealith.com` MX | 受信 | `mx01.lolipop.jp` |
| `_dmarc.sealith.com` TXT | DMARC | `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc@sealith.com; fo=1; pct=100`。`ruf` なし。`sp=` なし |
| `resend._domainkey.sealith.com` TXT | DKIM | あり。セレクタ `resend`。RSA。公開鍵の形は 1024 bit 相当 |
| `staffpass.sealith.com` | アプリ | Vercel CNAME。独自の SPF / DKIM / DMARC なし（CNAME 先を辿るだけ） |
| `_dmarc.staffpass.sealith.com` | | なし。組織ドメイン `_dmarc.sealith.com` にフォールバック |
| `send.sealith.com` TXT | SPF | `v=spf1 include:amazonses.com ~all` |
| `send.sealith.com` MX | MAIL FROM | `feedback-smtp.ap-northeast-1.amazonses.com`（Resend / SES の典型） |
| `resend._domainkey.send.sealith.com` | DKIM | **なし**（DKIM は apex 側） |
| `_dmarc.send.sealith.com` | | なし |
| `bounce.sealith.com` | Stripe | CNAME `custom-email-domain.stripe.com` + `v=spf1 include:amazonses.com ~all`。Staffpass Resend とは別 |
| `mail.sealith.com` / `email.` / `auth.` / `noreply.` / `notifications.` / `mail-unverified.` | | レコードなし |
| 他セレクタ（`google` / `selector1` / `s1` / `k1` / `default` / `amazonses` / `mail`） | | apex になし |
| `default._bimi.sealith.com` | BIMI | なし |
| NS | | `dns01/02.muumuu-domain.com`（ムームー / ロリポップ） |

`include` の範囲:

- apex: `_spf.lolipop.jp` → ロリポップの IPv4。Resend の送信 IP はここには入らない。
- `send.sealith.com`: `amazonses.com`（SES 全体の include）。
- どちらも末尾は **`~all`（SoftFail）**。`-all` ではない。

DMARC は `adkim=r` / `aspf=r`。Header From が `@sealith.com`、Return-Path が `@send.sealith.com`、DKIM `d=sealith.com` なら relaxed で揃い得る。`p=quarantine` は fail を隔離寄りにするが、**pass したリプレイは止めない**。

参考（Staffpass 送信ではない）:

- `tokyo307inc.com`: `v=spf1 include:_spf.google.com ~all`、`_dmarc` は `p=none; rua=mailto:tyasaka@tokyo307inc.com`。Google Workspace。法務連絡先はここ。

### 現状 / 危険度 / 直し方

**現状:** Resend は apex DKIM + `send.` の SES MAIL FROM。apex SPF はロリポップのみで Resend を含まない（Envelope が `send.` なら矛盾しない）。`~all`。BIMI なし。アプリホストに送信レコードは無い。

**危険度: 中**（設定の食い違いより、pass したリプレイと弱い鍵の方が本体）。

**直し方（コード・PR 案）:** なし（DNS はコード外）。点検結果をこの文書に固定するだけ。

**直し方（DNS / 設定・八坂さんの GO が必要）:**

- 受信ヘッダで Envelope From と Header From を確認する。
- 送信 IP の棚卸し後、`send.sealith.com` を `-all` へ（段階的でも可）。apex はロリポップ受信用のままでよい。
- 未確認用サブドメインを足す（項目 3）。apex の DKIM を未確認と共有しない。
- `staffpass.sealith.com` から送る計画はしない（Vercel ホスト）。
- BIMI を付けるなら確認済みドメインだけ。未確認側には付けない。

---

## 推奨する順番

1. **今すぐ（設定・GO）:** 実メールの `h=` / `d=` / `s=` を見る。signup と再設定を自分の箱で 1 通ずつ（このエージェントは送らない）。
2. **今すぐ（設定・GO）:** `SIGNUP_RATE_LIMIT_ENABLED` と LP ボット対策の本番値を確認。再設定に CAPTCHA。
3. **短い PR:** 未確認 From フラグ（既定 OFF）。承認メールの件名から summary を外す。相談フォーム件名の固定。
4. **GO 後の DNS:** `mail-unverified` の認証、2048 bit 輪番、`rua` の所有者確認、`send.` の `-all`。

`h=` が From だけのときは、項目 3 の分離より先に Resend 側の署名範囲を直す。同じ鍵・同じドメインのままアプリだけ分けても、入手済みの正規署名は再利用できる。

---

## この点検でやらなかったこと

- コード変更、本番 env / DNS / Resend / Supabase の変更
- 実メール送信
- 本番 `EMAIL_FROM` や SMTP 認証情報の読み出し
- 受信トレイの実ヘッダ確認（依頼者側）
- `dmarc@sealith.com` の中身の閲覧
