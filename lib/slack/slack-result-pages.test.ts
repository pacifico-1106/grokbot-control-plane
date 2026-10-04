/**
 * Result pages that Slack OAuth callbacks answer with HTML directly (no React):
 * - 「Staffpass承認」 install (/api/slack/approval-app/callback, install/start 503)
 * - employee re-authorize link (/api/slack/oauth/callback link flow, /api/slack/oauth/link)
 *
 * Display only: success never shows an error / support code, every page says
 * what the person does next, failure pages show only fixed Japanese copy for
 * known codes (+ a short support code), every value is escaped, and the pages
 * use the app's shared theme (tokens from app/globals.css).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { authorizeLinkFailedNoticeJa, authorizeLinkHtmlResponse, authorizeLinkResultHtml } from "@/lib/slack/authorize-link";
import { AUTHORIZE_LINK_CONSUMED_FAILURE_REASONS } from "@/lib/slack/authorize-link-guidance";
import { SHARED_APPROVAL_INSTALL_START_PATH, sharedApprovalResultHtml } from "@/lib/slack/shared-approval-app";

const SUCCESS_NEXT = "承認者の設定は AI が申請します。確認が届いたら 1 回押すだけです";
const INTERNALS = [
  "duplicate key value violates unique constraint",
  "xoxb-LEAK-TOKEN-123",
  "org_internal_123",
  "at completeSharedApprovalInstall (/var/task/lib/slack/shared-approval-app.ts:120:7)",
  "invalid_auth",
  "<script>alert(1)</script>",
];

const SHARED_FAILURE_CODES = [
  "team_bound_to_other_org",
  "enterprise_install_not_supported",
  "team_mismatch_org",
  "not_bot_token",
  "app_mismatch",
  "auth_failed",
  "exchange_failed",
  "denied",
  "state_invalid",
  "state_reused",
  "session_mismatch",
  "flag_off",
  "unconfigured",
  "lookup_failed",
  "save_failed",
] as const;
/** Pressing again cannot fix these: the page must not offer a retry button. */
const SHARED_NO_RETRY = new Set(["team_bound_to_other_org", "flag_off", "unconfigured"]);

function globalsRootTokens(): Record<string, string> {
  const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)![1];
  const out: Record<string, string> = {};
  for (const m of root.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].replace(/\s+/g, " ").trim();
  return out;
}
const THEME_TOKENS = ["--bg", "--bg-elevated", "--bg-soft", "--border", "--border-soft", "--text", "--text-muted", "--text-faint", "--accent", "--accent-fg", "--accent-strong", "--ok", "--danger", "--radius", "--radius-card"];

function visibleText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");
}

async function sharedPage(input: { ok: boolean; code: string; teamName?: string }, status?: number) {
  const res = sharedApprovalResultHtml(input, status);
  return { res, html: await res.text() };
}

function expectSharedTheme(html: string) {
  const tokens = globalsRootTokens();
  expect(html).toContain("<style>");
  for (const name of THEME_TOKENS) expect(html).toContain(`${name}: ${tokens[name]};`);
  expect(html).toMatch(/class="[^"]*\bsurface\b/);
  expect(html).toContain('lang="ja"');
}

describe("shared approval app result page (Staffpass承認)", () => {
  test("success: no error / support code, says the AI files the approver request and the person presses once", async () => {
    const { res, html } = await sharedPage({ ok: true, code: "installed", teamName: "Route WS" });
    expect(res.status).toBe(200);
    expect(html).toContain("Staffpass承認 を追加しました");
    expect(html).not.toContain("エラーコード");
    expect(html).not.toContain("問い合わせコード");
    expect(visibleText(html)).not.toContain("installed");
    expect(html).toContain("次にやること");
    expect(html).toContain(SUCCESS_NEXT);
    expect(html).toContain("Route WS");
    // Internal tool names never reach the page.
    expect(html).not.toContain("setup.slackApprover.set");
  });

  test("success page uses the app theme (tokens from app/globals.css) and the settings link", async () => {
    const { html } = await sharedPage({ ok: true, code: "installed", teamName: "Route WS" });
    expectSharedTheme(html);
    expect(html).toMatch(/class="[^"]*\bbtn\b[^"]*"[^>]*>設定画面へ戻る|href="[^"]*\/app\/settings"[^>]*class="[^"]*\bbtn\b/);
  });

  for (const code of SHARED_FAILURE_CODES) {
    test(`failure ${code}: next step in Japanese, support code only, no "エラーコード" label`, async () => {
      const { html } = await sharedPage({ ok: false, code }, 400);
      expect(html).toContain("Staffpass承認 を追加できませんでした");
      expect(html).toContain("次にやること");
      expect(html).toMatch(/もう一度|運営に連絡|管理者/);
      expect(html).toContain("問い合わせコード");
      expect(html).toContain(`<code>${code}</code>`);
      expect(html).not.toContain("エラーコード");
      expectSharedTheme(html);
      const retry = html.includes(`${SHARED_APPROVAL_INSTALL_START_PATH}"`);
      expect(retry).toBe(!SHARED_NO_RETRY.has(code));
    });
  }

  test("failure copy differs per reason (not one generic sentence)", async () => {
    const steps = new Set<string>();
    for (const code of SHARED_FAILURE_CODES) {
      const { html } = await sharedPage({ ok: false, code }, 400);
      steps.add(/<section[^>]*data-next[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "");
    }
    expect(steps.has("")).toBe(false);
    expect(steps.size).toBeGreaterThanOrEqual(8);
  });

  test("unknown / internal codes are never shown (escaped or not); support code becomes 'unknown'", async () => {
    for (const code of INTERNALS) {
      const { html } = await sharedPage({ ok: false, code }, 400);
      expect(html).not.toContain(code);
      expect(html).not.toContain(code.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
      expect(html).toContain("<code>unknown</code>");
      expect(html).toContain("次にやること");
    }
  });

  test("team name is escaped", async () => {
    const { html } = await sharedPage({ ok: true, code: "installed", teamName: `<img src=x onerror="alert(1)">` });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  test("headers unchanged: no-store, no-referrer, noindex, CSP allows inline style only", async () => {
    const { res } = await sharedPage({ ok: false, code: "state_invalid" }, 400);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
  });
});

describe("re-authorize link result page (#240)", () => {
  test("ok: no error / support code, says nothing else to do", () => {
    const html = authorizeLinkResultHtml("ok");
    expect(html).toContain("Slack 連携が完了しました");
    expect(html).not.toContain("エラーコード");
    expect(html).not.toContain("問い合わせコード");
    expect(html).toContain("次にやること");
    expect(html).toContain("このタブは閉じてかまいません");
    expectSharedTheme(html);
  });

  for (const code of AUTHORIZE_LINK_CONSUMED_FAILURE_REASONS) {
    test(`burned ${code}: DM template kept + reason-specific next step + support code`, () => {
      const html = authorizeLinkResultHtml("burned", code);
      expect(html).toContain(authorizeLinkFailedNoticeJa(code));
      expect(html).toContain("次にやること");
      expect(html).toContain("管理者");
      expect(html).toContain("問い合わせコード");
      expect(html).toContain(`<code>${code}</code>`);
      expectSharedTheme(html);
    });
  }

  test("burned copy says why, per reason", () => {
    expect(authorizeLinkResultHtml("burned", "team_mismatch")).toContain("ワークスペース");
    expect(authorizeLinkResultHtml("burned", "user_mismatch")).toContain("アカウント");
    expect(authorizeLinkResultHtml("burned", "allowed_accounts_mismatch")).toContain("連携してよいアカウント");
  });

  test("denied / invalid / error: next step + support code, never the raw code given", () => {
    const denied = authorizeLinkResultHtml("denied", "denied");
    expect(denied).toContain("もう一度");
    expect(denied).toContain("<code>denied</code>");
    const invalid = authorizeLinkResultHtml("invalid");
    expect(invalid).toContain("管理者");
    expect(invalid).toContain("<code>invalid_link</code>");
    for (const kind of ["denied", "invalid", "error"] as const) {
      const html = authorizeLinkResultHtml(kind);
      expect(html).toContain("次にやること");
      expect(html).toContain("問い合わせコード");
      expect(html).not.toContain("エラーコード");
      expectSharedTheme(html);
    }
    for (const code of INTERNALS) {
      const html = authorizeLinkResultHtml("error", code);
      expect(html).not.toContain(code);
      expect(html).not.toContain(code.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
      expect(html).toContain("<code>error</code>");
    }
  });

  test("response: status / headers unchanged except CSP now allows the inline theme style", async () => {
    const res = authorizeLinkHtmlResponse("burned", 400, "user_mismatch");
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(await res.text()).toContain("問い合わせコード");
  });
});
