# JPYC × Sealith / lifetime-esim 打合せ資料

相手方（JPYC株式会社）共有用。NDA締結済前提。秘密鍵・APIキー・シードは含みません。

## ファイル

| ファイル | 用途 |
|----------|------|
| `agenda-one-pager.md` / `.html` / `.pdf` | アジェンダ（A4・1枚） |
| `architecture-overview.md` / `.html` / `.pdf` | アーキテクチャ・フロー説明 |
| `print-pdf.mjs` | HTML → PDF 再生成（Playwright + Chrome） |

## PDF 再生成

```bash
node docs/partner/jpyc-meeting/print-pdf.mjs
```

## プレースホルダ

`{{DATE}}` `{{LOCATION}}` `{{JPYC_ATTENDEE_*}}` `{{OUR_ATTENDEE_*}}` `{{ACTION_*}}` `{{OWNER_*}}` `{{DUE_*}}` `{{OUR_CONTACT_*}}` `{{JPYC_CONTACT_*}}` を打合せ前に置換してください。
