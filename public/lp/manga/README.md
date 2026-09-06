# Manga LP Images

This directory should contain 8 manga panel images for the `/lp/manga` landing page.

## Required Files

- `01.png` - Title: 便利なのに、説明できない — ChatGPTだけでは足りない理由
- `02.png` - Employee pastes contract into ChatGPT; CEO worry; no audit
- `03.png` - Why ChatGPT/Claude/Gemini alone fail (no ID, no approval, no stop)
- `04.png` - Staffpass = AI employee badge (Slack, approval, audit)
- `05.png` - Sealith = confidential file courier (encrypt, open/revoke, expiry)
- `06.png` - Either alone or both works; with boundaries vs AI alone chaos
- `07.png` - What changes for SME CEO (explain, stop, system)
- `08.png` - CTA art (buttons are implemented in HTML)

## Image Specifications

- Format: PNG
- Recommended dimensions: 640x640 or similar vertical aspect ratio
- The page uses `object-fit: contain` so images won't be cropped

## How to Add Images

Copy your manga panel images to this directory:

```bash
cp /path/to/your/manga/01.png public/lp/manga/
cp /path/to/your/manga/02.png public/lp/manga/
# ... etc
```

Or if you have them in `docs/sealith-staffpass-pack/manga/`:

```bash
cp docs/sealith-staffpass-pack/manga/*.png public/lp/manga/
```
