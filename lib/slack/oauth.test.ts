import { describe, expect, test } from "bun:test";
import { signSlackOAuthState, verifySlackOAuthState, SLACK_USER_SCOPES } from "./oauth";

describe("Slack OAuth state", () => {
  test("round-trips org+employee and rejects wrong nonce", () => {
    process.env.SLACK_CLIENT_SECRET = "test-slack-client-secret-value";
    const signed = signSlackOAuthState({
      orgId: "org_demo",
      employeeId: "emp_comm",
      nonce: "nonce-1",
    });
    const ok = verifySlackOAuthState(signed, "nonce-1");
    expect(ok?.orgId).toBe("org_demo");
    expect(ok?.employeeId).toBe("emp_comm");
    expect(verifySlackOAuthState(signed, "nonce-other")).toBeNull();
    expect(verifySlackOAuthState("tampered." + signed.split(".")[1], "nonce-1")).toBeNull();
  });
});

/**
 * P0 User-token channel mention ingress scope tests.
 * @see docs/p0-user-mention-ingress-design-20260919.md §3 (DL-1 最小スコープ)
 */
describe("Slack user token scopes (P0 user-token channel mention)", () => {
  const scopes = SLACK_USER_SCOPES.split(",");

  test("includes im:history (existing Path B DM)", () => {
    expect(scopes).toContain("im:history");
  });

  test("includes channels:history (P0 user-token channel events)", () => {
    expect(scopes).toContain("channels:history");
  });

  test("includes groups:history (P0 user-token private channel events)", () => {
    expect(scopes).toContain("groups:history");
  });

  test("includes chat:write (postingAs=user replies)", () => {
    expect(scopes).toContain("chat:write");
  });

  test("includes users:read (Slack user info)", () => {
    expect(scopes).toContain("users:read");
  });

  test("does NOT include admin.* scopes (DL-1 forbidden)", () => {
    const adminScopes = scopes.filter((s) => s.startsWith("admin.") || s.startsWith("admin:"));
    expect(adminScopes).toEqual([]);
  });

  test("does NOT include search:read (DL-1 forbidden)", () => {
    expect(scopes).not.toContain("search:read");
  });

  test("does NOT include files:read (DL-1 forbidden - D1 handoff separate)", () => {
    expect(scopes).not.toContain("files:read");
  });

  test("complete scope string matches expected L1-approved set", () => {
    const expected = [
      "chat:write",
      "users:read",
      "channels:read",
      "groups:read",
      "im:history",
      "files:write",
      "channels:history",
      "groups:history",
    ];
    expect(scopes.sort()).toEqual(expected.sort());
  });
});
