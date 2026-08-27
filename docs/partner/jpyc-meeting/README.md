# JPYC × Sealith / lifetime-esim 打合せ資料

相手方（JPYC株式会社）共有用。秘密鍵・APIキー・シードは含みません。

> 2026-08-27更新: JPYC社の2026-08-26付書面回答を反映済みです。
> Phase 1は「JPYC EX公式サイトへの外部リンクのみ」「直接送金＋Sealith
> Watcher＋merchant Safe」です。旧WebView／EX連携API案は採用しません。

## ファイル

| ファイル | 用途 |
|----------|------|
| `agenda-one-pager.md` / `.html` / `.pdf` | アジェンダ（A4・1枚） |
| `architecture-overview.md` / `.html` / `.pdf` | アーキテクチャ・フロー説明 |
| `print-pdf.mjs` | HTML → PDF 再生成（Playwright + Chrome） |

正本はSealithの`docs/agent-payments/0006-jpyc-official-response-2026-08-26.md`
および`0000-current-jpyc-ex-handoff.md`です。

## PDF 再生成

```bash
node docs/partner/jpyc-meeting/print-pdf.mjs
```

## プレースホルダ

`{{DATE}}` `{{LOCATION}}` `{{JPYC_ATTENDEE_*}}` `{{OUR_ATTENDEE_*}}` `{{ACTION_*}}` `{{OWNER_*}}` `{{DUE_*}}` `{{OUR_CONTACT_*}}` `{{JPYC_CONTACT_*}}` を打合せ前に置換してください。
