import { describe, expect, test } from "bun:test";
import {
  GOOGLE_ALLOWED_SCOPES,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_FORBIDDEN_SCOPES,
  GOOGLE_SCOPE_CALENDAR_FREEBUSY,
  GOOGLE_SCOPE_EMAIL,
  GOOGLE_SCOPE_OPENID,
  validateGrantedScopes,
} from "./scopes";

describe("Google OAuth scopes", () => {
  test("GOOGLE_CALENDAR_SCOPES contains only allowed scopes", () => {
    const scopes = GOOGLE_CALENDAR_SCOPES.split(" ");
    for (const scope of scopes) {
      expect(GOOGLE_ALLOWED_SCOPES.has(scope)).toBe(true);
    }
  });

  test("GOOGLE_CALENDAR_SCOPES includes required freebusy scope", () => {
    expect(GOOGLE_CALENDAR_SCOPES).toContain(GOOGLE_SCOPE_CALENDAR_FREEBUSY);
    expect(GOOGLE_CALENDAR_SCOPES).toContain(GOOGLE_SCOPE_OPENID);
    expect(GOOGLE_CALENDAR_SCOPES).toContain(GOOGLE_SCOPE_EMAIL);
  });

  test("GOOGLE_ALLOWED_SCOPES and GOOGLE_FORBIDDEN_SCOPES are disjoint", () => {
    for (const scope of GOOGLE_FORBIDDEN_SCOPES) {
      expect(GOOGLE_ALLOWED_SCOPES.has(scope)).toBe(false);
    }
  });

  test("forbidden scopes include dangerous calendar access", () => {
    expect(GOOGLE_FORBIDDEN_SCOPES.has("https://www.googleapis.com/auth/calendar")).toBe(true);
    expect(GOOGLE_FORBIDDEN_SCOPES.has("https://www.googleapis.com/auth/calendar.events")).toBe(true);
    expect(GOOGLE_FORBIDDEN_SCOPES.has("https://www.googleapis.com/auth/calendar.readonly")).toBe(true);
  });
});

describe("validateGrantedScopes", () => {
  test("accepts exact required scopes", () => {
    const result = validateGrantedScopes(GOOGLE_CALENDAR_SCOPES);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("accepts subset with required freebusy scope", () => {
    const result = validateGrantedScopes(
      `${GOOGLE_SCOPE_OPENID} ${GOOGLE_SCOPE_CALENDAR_FREEBUSY}`
    );
    expect(result.valid).toBe(true);
  });

  test("rejects empty scopes", () => {
    const result = validateGrantedScopes("");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("no_scopes_granted");
  });

  test("rejects whitespace-only scopes", () => {
    const result = validateGrantedScopes("   ");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("no_scopes_granted");
  });

  test("rejects missing freebusy scope", () => {
    const result = validateGrantedScopes(`${GOOGLE_SCOPE_OPENID} ${GOOGLE_SCOPE_EMAIL}`);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("calendar_freebusy_scope_missing");
  });

  test("rejects forbidden full calendar scope", () => {
    const result = validateGrantedScopes(
      `${GOOGLE_CALENDAR_SCOPES} https://www.googleapis.com/auth/calendar`
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("forbidden_scopes_granted");
    expect(result.forbidden).toContain("https://www.googleapis.com/auth/calendar");
  });

  test("rejects forbidden events scope", () => {
    const result = validateGrantedScopes(
      `${GOOGLE_CALENDAR_SCOPES} https://www.googleapis.com/auth/calendar.events`
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("forbidden_scopes_granted");
    expect(result.forbidden).toContain("https://www.googleapis.com/auth/calendar.events");
  });

  test("rejects unknown scopes (fail-closed)", () => {
    const result = validateGrantedScopes(
      `${GOOGLE_CALENDAR_SCOPES} https://www.googleapis.com/auth/drive`
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("unknown_scopes_granted");
    expect(result.unknown).toContain("https://www.googleapis.com/auth/drive");
  });

  test("rejects multiple forbidden scopes and lists all", () => {
    const result = validateGrantedScopes(
      `${GOOGLE_CALENDAR_SCOPES} https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events`
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("forbidden_scopes_granted");
    expect(result.forbidden?.length).toBe(2);
  });
});
