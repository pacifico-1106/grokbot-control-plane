import { describe, expect, test } from "bun:test";
import { signSlackOAuthState, verifySlackOAuthState } from "./oauth";

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
