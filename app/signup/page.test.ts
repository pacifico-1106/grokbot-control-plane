/**
 * Signup page: local Turnstile widget is always present (P0 bot check).
 * A second unused widget (cf-turnstile-supabase) appears only when
 * SUPABASE_AUTH_CAPTCHA_ENABLED is ON.
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

const { default: SignupPage } = await import("./page");

const FLAG = "SUPABASE_AUTH_CAPTCHA_ENABLED";
const SITE = "NEXT_PUBLIC_TURNSTILE_SITE_KEY";

async function render() {
  return renderToStaticMarkup(await SignupPage({ searchParams: Promise.resolve({}) }));
}

beforeEach(() => {
  delete process.env[FLAG];
  process.env[SITE] = "1x00000000000000000000AA";
});
afterEach(() => {
  delete process.env[FLAG];
  delete process.env[SITE];
});

describe("signup unused-token widget gating", () => {
  test("flag OFF: one local widget, no supabase field", async () => {
    const html = await render();
    expect(html).toContain("cf-turnstile");
    expect(html).toContain("data-action=\"signup\"");
    expect(html).not.toContain("cf-turnstile-supabase");
    expect(html).not.toContain("supabase_auth");
  });

  test("flag ON: second widget with dedicated response field", async () => {
    process.env[FLAG] = "true";
    const html = await render();
    expect(html).toContain("cf-turnstile-supabase");
    expect(html).toContain("supabase_auth");
    expect(html).toContain("data-action=\"signup\"");
  });
});
