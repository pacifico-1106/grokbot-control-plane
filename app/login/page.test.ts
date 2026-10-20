/**
 * Login page Turnstile widget: only when SUPABASE_AUTH_CAPTCHA_ENABLED is ON
 * and a site key is present. Flag OFF HTML must not include the widget.
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
mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));

const { default: LoginPage } = await import("./page");

const FLAG = "SUPABASE_AUTH_CAPTCHA_ENABLED";
const SITE = "NEXT_PUBLIC_TURNSTILE_SITE_KEY";

async function render() {
  return renderToStaticMarkup(
    await LoginPage({ searchParams: Promise.resolve({}) })
  );
}

beforeEach(() => {
  delete process.env[FLAG];
  delete process.env[SITE];
});
afterEach(() => {
  delete process.env[FLAG];
  delete process.env[SITE];
});

describe("login Turnstile widget gating", () => {
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
    expect(html).toContain("cf-turnstile");
    expect(html).toContain("challenges.cloudflare.com/turnstile/v0/api.js");
    expect(html).toContain("1x00000000000000000000AA");
  });

  test("flag ON without site key: no widget", async () => {
    process.env[FLAG] = "true";
    const html = await render();
    expect(html).not.toContain("cf-turnstile");
    expect(html).not.toContain("challenges.cloudflare.com");
  });

  test("flag ON: only one user-facing widget (login forwards a single unused token)", async () => {
    process.env[FLAG] = "true";
    process.env[SITE] = "1x00000000000000000000AA";
    const html = await render();
    expect(html).toContain("cf-turnstile");
    expect(html).not.toContain("cf-turnstile-supabase");
    expect(html).not.toContain("interaction-only");
    const userFacing = html.match(/class="cf-turnstile"/g) ?? [];
    expect(userFacing).toHaveLength(1);
  });

  test("submit button is disabled and labeled while sending", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../components/LoginForm.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/disabled=\{busy\}/);
    expect(src).toMatch(/サインイン中/);
    expect(src).toMatch(/beginAuthSubmit|busyRef|if \(busy\) return/);
  });
});
