import { describe, expect, test } from "bun:test";
import {
  CREDENTIALS_REQUIRED_MESSAGE,
  LOGIN_FAILED_MESSAGE,
  RATE_LIMITED_MESSAGE,
  SESSION_REQUIRED_MESSAGE,
  isSessionNotice,
  loginErrorMessage,
  loginFailureSearchParams,
} from "./login-errors";

describe("loginErrorMessage", () => {
  test("login_failed → generic Japanese copy (no field leak)", () => {
    expect(loginErrorMessage("login_failed")).toBe(LOGIN_FAILED_MESSAGE);
    expect(LOGIN_FAILED_MESSAGE).toBe("メールアドレスまたはパスワードが違います");
  });

  test("unknown codes and missing codes still use the generic copy", () => {
    expect(loginErrorMessage(undefined)).toBe(LOGIN_FAILED_MESSAGE);
    expect(loginErrorMessage("no_such_user")).toBe(LOGIN_FAILED_MESSAGE);
    expect(loginErrorMessage('{"error":"login_failed"}')).toBe(LOGIN_FAILED_MESSAGE);
  });

  test("does not echo raw JSON or error codes", () => {
    const shown = loginErrorMessage("login_failed");
    expect(shown).not.toContain("login_failed");
    expect(shown).not.toContain("{");
    expect(shown).not.toContain("error");
  });

  test("credentials_required asks for both fields", () => {
    expect(loginErrorMessage("credentials_required")).toBe(
      CREDENTIALS_REQUIRED_MESSAGE
    );
  });

  test("rate limit by code or HTTP 429", () => {
    expect(loginErrorMessage("rate_limited")).toBe(RATE_LIMITED_MESSAGE);
    expect(loginErrorMessage("login_failed", 429)).toBe(RATE_LIMITED_MESSAGE);
  });

  test("session expired banner copy", () => {
    expect(loginErrorMessage("session_expired")).toBe(SESSION_REQUIRED_MESSAGE);
    expect(loginErrorMessage("session")).toBe(SESSION_REQUIRED_MESSAGE);
    expect(isSessionNotice("session")).toBe(true);
    expect(isSessionNotice("expired")).toBe(true);
    expect(isSessionNotice("login_failed")).toBe(false);
  });
});

describe("loginFailureSearchParams", () => {
  test("preserves email and omits default next", () => {
    expect(
      loginFailureSearchParams({
        code: "login_failed",
        email: "owner@example.com",
        next: "/app",
      })
    ).toBe("error=login_failed&email=owner%40example.com");
  });

  test("keeps a custom next path", () => {
    expect(
      loginFailureSearchParams({
        code: "credentials_required",
        next: "/admin",
      })
    ).toBe("error=credentials_required&next=%2Fadmin");
  });
});
