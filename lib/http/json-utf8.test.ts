/**
 * 2026-10-12 (木村 / 八坂さん): Japanese text in our JSON error responses is
 * garbled in browsers. On Node (Vercel) NextResponse.json sets a bare
 * `application/json` (no charset); bun's test runtime adds one, so these
 * tests pin the exact header we set ourselves: `application/json; charset=utf-8`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authRequiredResponse } from "@/lib/auth/require-org";
import { activeMemberRequiredResponse } from "@/lib/auth/active-member";
import { identityLinkForbiddenResponse } from "@/lib/auth/identity-link-gate";

const UTF8 = "application/json; charset=utf-8";

describe("shared auth / billing JSON error responses carry charset=utf-8", () => {
  test("authRequiredResponse: 401, same body, explicit utf-8", async () => {
    const res = authRequiredResponse();
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe(UTF8);
    expect(await res.json()).toEqual({ ok: false, error: "auth_required", message: "認証と組織が必要です" });
  });

  test("authRequiredResponse with a custom message keeps the header", async () => {
    const res = authRequiredResponse("ログインしてください");
    expect(res.headers.get("content-type")).toBe(UTF8);
    expect((await res.json()).message).toBe("ログインしてください");
  });

  test("activeMemberRequiredResponse / identityLinkForbiddenResponse", () => {
    expect(activeMemberRequiredResponse().headers.get("content-type")).toBe(UTF8);
    expect(identityLinkForbiddenResponse().headers.get("content-type")).toBe(UTF8);
  });

  test("inventory: the shared helpers build no bare NextResponse.json (all through jsonUtf8)", () => {
    const files = [
      "lib/auth/require-org.ts",
      "lib/auth/require-credential-admin.ts",
      "lib/auth/active-member.ts",
      "lib/auth/identity-link-gate.ts",
      "lib/team/demo-actor.ts",
      "lib/billing/plan-api-gate.ts",
      "lib/billing/entitlements.ts",
      "lib/security/cron-secret.ts",
    ];
    for (const file of files) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      expect({ file, bare: (src.match(/NextResponse\.json\(/g) || []).length }).toEqual({ file, bare: 0 });
    }
  });
});
