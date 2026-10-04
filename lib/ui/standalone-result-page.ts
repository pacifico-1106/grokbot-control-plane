/**
 * Result page for API routes that answer HTML directly (Slack OAuth callbacks:
 * no React / AppShell, and the person may have no Staffpass session).
 *
 * Same look as the app: the theme tokens and the shared rules below are
 * copied verbatim from app/globals.css (lib/ui/standalone-result-page.test.ts
 * fails when they drift). Layout = the login page (centered `.surface` card).
 * Inline <style> only — the routes' CSP is `default-src 'none'; style-src
 * 'unsafe-inline'`, so no external CSS, fonts, images or scripts load.
 *
 * Display rules:
 * - every value is HTML-escaped; links must be http(s) URLs or "/" paths;
 * - a support code is shown on failure pages only, and only when it is a
 *   short [a-z0-9_] code (anything else → "unknown");
 * - callers pass fixed Japanese copy — never query values, DB / Slack errors,
 *   tokens, org ids or stack traces.
 */

export type StandaloneResultPageAction = { href: string; label: string; primary?: boolean };

export type StandaloneResultPageInput = {
  ok: boolean;
  title: string;
  /** What happened (one or two sentences). */
  lead: string;
  /** Extra facts that are safe to show (e.g. the Slack workspace name). */
  details?: Array<{ label: string; value: string }>;
  /** 「次にやること」 — what the person does next. Always shown. */
  nextSteps: string[];
  actions?: StandaloneResultPageAction[];
  /** Failure only: short code to quote when contacting support. Ignored when ok. */
  supportCode?: string | null;
};

/** Copied from app/globals.css (`:root` subset + shared component rules). */
export const STANDALONE_RESULT_PAGE_SHARED_CSS = `
:root {
  --bg: #05090d;
  --bg-elevated: #0a1118;
  --bg-soft: #0f1821;
  --border: #20303d;
  --border-soft: #15232e;
  --text: #f2f7fa;
  --text-muted: #9cadb8;
  --text-faint: #687b88;
  --accent: #d9fbff;
  --accent-fg: #061014;
  --accent-strong: #53e1ef;
  --ok: #49e2a0;
  --warn: #fbbf24;
  --danger: #f87171;
  --radius: 14px;
  --radius-card: 18px;
  --font-jp: "Yu Gothic", YuGothic, "Yu Gothic Medium", "Hiragino Sans",
    "Hiragino Kaku Gothic ProN", var(--font-noto-sans-jp), Meiryo, sans-serif;
}
* {
  box-sizing: border-box;
}
h1,
h2,
h3 {
  font-weight: 700;
  letter-spacing: -0.02em;
  overflow-wrap: anywhere;
}
a {
  color: inherit;
  text-decoration: none;
}
code {
  font-family: var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo,
    Monaco, Consolas, monospace;
  font-weight: 400;
  letter-spacing: 0;
}
.surface {
  background: linear-gradient(145deg, color-mix(in oklab, var(--bg-elevated) 96%, white 4%), var(--bg-elevated));
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  max-width: 100%;
}
.muted {
  color: var(--text-muted);
  font-weight: 600;
}
.faint {
  color: var(--text-faint);
  font-weight: 600;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: var(--radius);
  padding: 10px 18px;
  min-height: 44px;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  border: 1px solid transparent;
  cursor: pointer;
  transition: transform 0.15s ease, opacity 0.15s ease, background 0.15s ease, border-color .15s ease;
  -webkit-tap-highlight-color: transparent;
}
.btn:hover {
  opacity: 0.92;
  transform: translateY(-1px);
}
.btn-primary {
  background: linear-gradient(135deg, var(--accent), #79eaf3);
  color: var(--accent-fg);
  font-weight: 700;
}
.btn-ghost {
  background: transparent;
  border-color: var(--border);
  color: var(--text);
}
.btn-ghost:hover {
  background: var(--bg-soft);
}
.chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 4px 10px;
  min-height: 28px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid var(--border);
  color: var(--text-muted);
  max-width: 100%;
  overflow-wrap: anywhere;
}
.chip-ok {
  color: var(--ok);
  border-color: color-mix(in oklab, var(--ok) 40%, var(--border));
}
.chip-danger {
  color: var(--danger);
  border-color: color-mix(in oklab, var(--danger) 40%, var(--border));
}
.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: .55rem;
  font-family: var(--font-geist-mono), monospace;
  font-size: .68rem;
  letter-spacing: .16em;
  color: var(--accent-strong);
}
.eyebrow::before {
  content: "";
  width: 1.5rem;
  height: 1px;
  background: currentColor;
}
`;

/**
 * Page-only rules: next/font variables do not exist outside the Next layout,
 * so they get local fallbacks; body = app/globals.css body; layout = the login
 * page (`min-h-screen flex items-center justify-center px-4` + `max-w-md
 * surface p-6 md:p-8`).
 */
const PAGE_CSS = `
:root {
  --font-noto-sans-jp: "Noto Sans JP";
  --font-geist-mono: ui-monospace;
}
html { height: 100%; }
body {
  margin: 0;
  min-height: 100%;
  background:
    radial-gradient(circle at 75% -10%, rgba(40, 205, 220, 0.08), transparent 30rem),
    var(--bg);
  color: var(--text);
  font-family: var(--font-jp);
  font-weight: 600;
  letter-spacing: -0.01em;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.page { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px; }
.card { width: 100%; max-width: 28rem; padding: 24px; }
@media (min-width: 768px) { .card { padding: 32px; } }
.brand { font-size: 17px; letter-spacing: -0.02em; color: var(--text); }
.status { margin-top: 20px; }
h1 { margin: 10px 0 0; font-size: 22px; line-height: 1.4; }
.lead { margin: 12px 0 0; font-size: 14px; line-height: 1.8; }
.details { margin: 16px 0 0; padding: 12px 14px; border: 1px solid var(--border-soft); border-radius: var(--radius); background: var(--bg-soft); font-size: 13px; }
.details div { display: flex; gap: 8px; flex-wrap: wrap; }
.details div + div { margin-top: 6px; }
.details dt { color: var(--text-faint); }
.details dd { margin: 0; overflow-wrap: anywhere; }
.next { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-soft); }
.next h2 { margin: 0; font-size: 12px; color: var(--accent-strong); letter-spacing: .08em; }
.next ol { margin: 10px 0 0; padding-left: 1.3rem; font-size: 14px; line-height: 1.8; color: var(--text); }
.next li + li { margin-top: 4px; }
.actions { margin-top: 20px; display: flex; flex-wrap: wrap; gap: 10px; }
.support { margin: 20px 0 0; font-size: 12px; line-height: 1.6; }
.support code { color: var(--text-muted); }
`;

const SUPPORT_CODE_RE = /^[a-z0-9_]{1,64}$/;

export function escapeHtml(value: string): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

/** http(s) absolute URL or a same-origin "/path" (never "//host", javascript:, data:). */
function safeHref(href: string): string | null {
  const raw = String(href || "").trim();
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\")) return raw;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function standaloneSupportCode(code: string | null | undefined): string {
  const raw = String(code ?? "").trim();
  return SUPPORT_CODE_RE.test(raw) ? raw : "unknown";
}

export function renderStandaloneResultPage(input: StandaloneResultPageInput): string {
  const details = (input.details || []).filter((d) => d.value);
  const actions = (input.actions || []).flatMap((a) => {
    const href = safeHref(a.href);
    return href ? [{ ...a, href }] : [];
  });
  const status = input.ok
    ? `<span class="chip chip-ok">完了</span>`
    : `<span class="chip chip-danger">未完了</span>`;
  return (
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)} | Staffpass</title>` +
    `<style>${STANDALONE_RESULT_PAGE_SHARED_CSS}${PAGE_CSS}</style></head>` +
    `<body><div class="page"><main class="surface card">` +
    `<div class="brand">Staffpass</div>` +
    `<div class="status">${status}</div>` +
    `<h1>${escapeHtml(input.title)}</h1>` +
    `<p class="lead muted">${escapeHtml(input.lead)}</p>` +
    (details.length
      ? `<dl class="details">${details
          .map((d) => `<div><dt>${escapeHtml(d.label)}</dt><dd>${escapeHtml(d.value)}</dd></div>`)
          .join("")}</dl>`
      : "") +
    `<section class="next" data-next aria-labelledby="next-h"><h2 id="next-h">次にやること</h2><ol>${input.nextSteps
      .map((s) => `<li>${escapeHtml(s)}</li>`)
      .join("")}</ol></section>` +
    (actions.length
      ? `<div class="actions">${actions
          .map(
            (a) => `<a class="btn ${a.primary ? "btn-primary" : "btn-ghost"}" href="${escapeHtml(a.href)}">${escapeHtml(a.label)}</a>`
          )
          .join("")}</div>`
      : "") +
    (input.ok
      ? ""
      : `<p class="support faint">問い合わせるときは、このコードを伝えてください。問い合わせコード: <code>${escapeHtml(
          standaloneSupportCode(input.supportCode)
        )}</code></p>`) +
    `</main></div></body></html>`
  );
}

/** Headers every standalone result page answers with (inline style only). */
export function standaloneResultPageHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-robots-tag": "noindex",
  };
}
