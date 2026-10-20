/**
 * Forgot-password page: Turnstile widget only when PASSWORD_RESET_TURNSTILE_ENABLED is ON.
 * When SUPABASE_AUTH_CAPTCHA_ENABLED is also ON, the unused token is minted
 * via execute-mode so the visitor only sees one widget.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/script", () => ({
  default: (props: { src?: string }) => createElement("script", { src: props.src ?? "" }),
}));
mock.module("next/image", () => ({
  default: (props: { src?: string; alt?: string }) => createElement("img", { src: props.src, alt: props.alt ?? "" }),
}));
mock.module("next/link", () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) => createElement("a", { href }, children),
}));

const { default: ForgotPasswordPage } = await import("./page");

const FLAG = "PASSWORD_RESET_TURNSTILE_ENABLED";
const SB_FLAG = "SUPABASE_AUTH_CAPTCHA_ENABLED";
const SITE = "NEXT_PUBLIC_TURNSTILE_SITE_KEY";

async function render(sp: { sent?: string; error?: string } = {}) {
  return renderToStaticMarkup(await ForgotPasswordPage({ searchParams: Promise.resolve(sp) }));
}

beforeEach(() => {
  delete process.env[FLAG];
  delete process.env[SB_FLAG];
  delete process.env[SITE];
});
afterEach(() => {
  delete process.env[FLAG];
  delete process.env[SB_FLAG];
  delete process.env[SITE];
});

describe("forgot-password Turnstile widget gating", () => {
  test("flag OFF: no widget even if a site key is present", async () => {
    process.env[SITE] = "1x00000000000000000000AA";
    const html = await render();
    expect(html).not.toContain("cf-turnstile");
    expect(html).not.toContain("challenges.cloudflare.com");
    expect(html).not.toContain("1x00000000000000000000AA");
  });

  test("flag ON: widget + script only when site key is set", async () => {
    process.env[FLAG] = "true";
    process.env[SITE] = "1x00000000000000000000AA";
    const html = await render();
    expect(html).toContain('data-auth-turnstile="visible"');
    expect(html).not.toMatch(/class="cf-turnstile"/);
    expect(html).toContain("challenges.cloudflare.com/turnstile/v0/api.js");
    expect(html).toContain("1x00000000000000000000AA");
    expect(html).toContain("password_reset");
  });

  test("flag ON without site key: no widget (server still fail-closes)", async () => {
    process.env[FLAG] = "true";
    const html = await render();
    expect(html).not.toContain("cf-turnstile");
    expect(html).not.toContain("challenges.cloudflare.com");
  });

  test("supabase flag ON, local OFF: one widget (token is forwarded unused)", async () => {
    process.env[SB_FLAG] = "true";
    process.env[SITE] = "1x00000000000000000000AA";
    const html = await render();
    expect(html).toContain('data-auth-turnstile="visible"');
    expect(html).toContain("1x00000000000000000000AA");
    expect(html).not.toContain("cf-turnstile-supabase");
  });

  test("both flags ON: one user-facing widget; supabase token is execute-mode", async () => {
    process.env[FLAG] = "true";
    process.env[SB_FLAG] = "true";
    process.env[SITE] = "1x00000000000000000000AA";
    const html = await render();
    expect(html).toContain('data-auth-turnstile="visible"');
    expect(html).toContain("password_reset");
    expect(html).toContain("cf-turnstile-supabase");
    expect(html).toContain("supabase_auth");
    expect(html).toContain('data-execution="execute"');
    expect(html).toContain('data-appearance="execute"');
    expect(html).not.toContain("interaction-only");
    expect(html).not.toMatch(/class="cf-turnstile"/);
    expect(html.match(/data-auth-turnstile="visible"/g)).toHaveLength(1);
  });

  test("sent=1 hides the form and uses the same completion copy for every address", async () => {
    const html = await render({ sent: "1" });
    expect(html).toContain(
      "入力したメールアドレスが登録されている場合、パスワード再設定のメールを送りました。"
    );
    expect(html).not.toContain("再設定メールを送信");
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain("登録されていません");
    expect(html).not.toContain("アカウントがありません");
  });

  test("submit button is disabled and labeled while sending", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./page.tsx", import.meta.url), "utf8")
    );
    const formSrc = await import("node:fs").then((fs) => {
      try {
        return fs.readFileSync(new URL("../../../components/ForgotPasswordForm.tsx", import.meta.url), "utf8");
      } catch {
        return src;
      }
    });
    expect(formSrc).toMatch(/disabled=\{busy\}/);
    expect(formSrc).toMatch(/送信中/);
  });

  test("turnstile_required / turnstile_failed show captcha copy, not an account oracle", async () => {
    process.env[FLAG] = "true";
    const required = await render({ error: "turnstile_required" });
    const failed = await render({ error: "turnstile_failed" });
    expect(required).toContain("ロボットでないことの確認");
    expect(failed).toContain("確認に失敗しました");
    expect(required).not.toContain("登録されていません");
    expect(failed).not.toContain("登録されていません");
    expect(required).not.toContain("アカウントがありません");
    expect(failed).not.toContain("アカウントがありません");
  });
});
