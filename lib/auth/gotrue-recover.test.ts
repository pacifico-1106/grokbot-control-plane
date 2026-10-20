import { describe, expect, test } from "bun:test";
import {
  GOTRUE_RECOVER_PRE_SEND_ERROR_CODES,
  isGoTrueRecoverPreSendError,
} from "./gotrue-recover";

describe("isGoTrueRecoverPreSendError", () => {
  test("allowlisted 4xx codes that fire before SMTP", () => {
    expect(GOTRUE_RECOVER_PRE_SEND_ERROR_CODES).toContain("captcha_failed");
    expect(GOTRUE_RECOVER_PRE_SEND_ERROR_CODES).toContain("validation_failed");
    expect(GOTRUE_RECOVER_PRE_SEND_ERROR_CODES).toContain("over_email_send_rate_limit");
    expect(isGoTrueRecoverPreSendError({ status: 400, code: "captcha_failed" })).toBe(true);
    expect(isGoTrueRecoverPreSendError({ status: 400, code: "validation_failed" })).toBe(true);
    expect(isGoTrueRecoverPreSendError({ status: 429, code: "over_email_send_rate_limit" })).toBe(true);
    expect(isGoTrueRecoverPreSendError({ status: 429, code: "over_request_rate_limit" })).toBe(true);
    expect(isGoTrueRecoverPreSendError({ status: 400, code: "email_provider_disabled" })).toBe(true);
    expect(isGoTrueRecoverPreSendError({ status: 400, code: "bad_json" })).toBe(true);
    expect(isGoTrueRecoverPreSendError({ status: 400, code: "email_address_not_authorized" })).toBe(true);
  });

  test("5xx, unexpected_failure, timeout, unknown → keep reservation", () => {
    expect(isGoTrueRecoverPreSendError({ status: 500, code: "unexpected_failure" })).toBe(false);
    expect(isGoTrueRecoverPreSendError({ status: 500, code: "captcha_failed" })).toBe(false);
    expect(isGoTrueRecoverPreSendError({ status: 408, code: "request_timeout" })).toBe(false);
    expect(isGoTrueRecoverPreSendError({ status: 500, code: "smtp_blew_up" })).toBe(false);
    expect(isGoTrueRecoverPreSendError({ status: 500 })).toBe(false);
    expect(isGoTrueRecoverPreSendError(null)).toBe(false);
  });
});
