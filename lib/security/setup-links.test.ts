import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mintSetupLink,
  buildSetupLinkResponse,
  buildSetupGuidance,
  getSetupLinkNextStepJa,
  type SetupLinkKind,
} from "./setup-links";

// #294: minting needs a signing secret (no hard-coded fallback any more).
const SECRET_ENV = "SETUP_LINK_SIGNING_SECRET";
let savedSecret: string | undefined;
beforeEach(() => {
  savedSecret = process.env[SECRET_ENV];
  process.env[SECRET_ENV] = "fixture-setup-links-test-secret";
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env[SECRET_ENV];
  else process.env[SECRET_ENV] = savedSecret;
});

/** Decode a minted token's payload (the in-repo redeemer was removed in #294). */
function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf-8"));
}

describe("setup-links", () => {
  describe("mintSetupLink", () => {
    test("mints a valid setup link for org_kickoff", () => {
      const result = mintSetupLink({
        kind: "org_kickoff",
        orgId: "org_sample_shoji",
      });

      expect(result.ok).toBe(true);
      expect(result.kind).toBe("org_kickoff");
      expect(result.url).toContain("/app/getting-started");
      expect(result.url).toContain("setup_token=");
      expect(result.token).toBeTruthy();
      expect(result.expiresAt).toBeTruthy();
      expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    test("mints a valid setup link for employee_connector_oauth", () => {
      const result = mintSetupLink({
        kind: "employee_connector_oauth",
        orgId: "org_sample_shoji",
        employeeId: "emp_sales",
      });

      expect(result.ok).toBe(true);
      expect(result.kind).toBe("employee_connector_oauth");
      expect(result.url).toContain("/app/employees/emp_sales/connector");
    });

    test("refuses slack_authorize (#284 follow-up: issued only by setup.slackAuthorizeLink.issue)", () => {
      expect(() =>
        mintSetupLink({
          kind: "slack_authorize",
          orgId: "org_sample_shoji",
          employeeId: "emp_sales",
        })
      ).toThrow("slack_authorize_requires_issue");
    });

    test("mints a valid setup link for workspace_bot_install", () => {
      const result = mintSetupLink({
        kind: "workspace_bot_install",
        orgId: "org_sample_shoji",
      });

      expect(result.ok).toBe(true);
      expect(result.url).toContain("/api/slack/bot-install/start");
    });

    test("mints a valid setup link for line_oauth_setup", () => {
      const result = mintSetupLink({
        kind: "line_oauth_setup",
        orgId: "org_sample_shoji",
      });

      expect(result.ok).toBe(true);
      expect(result.url).toContain("/app/settings/notifications/line");
    });

    test("respects custom expiry", () => {
      const result = mintSetupLink({
        kind: "org_kickoff",
        orgId: "org_sample_shoji",
        expiresInSeconds: 600,
      });

      const expiresAt = new Date(result.expiresAt).getTime();
      const expectedMin = Date.now() + 590000;
      const expectedMax = Date.now() + 610000;
      expect(expiresAt).toBeGreaterThan(expectedMin);
      expect(expiresAt).toBeLessThan(expectedMax);
    });

    test("caps expiry at 24 hours", () => {
      const result = mintSetupLink({
        kind: "org_kickoff",
        orgId: "org_sample_shoji",
        expiresInSeconds: 999999,
      });

      const expiresAt = new Date(result.expiresAt).getTime();
      const maxExpiry = Date.now() + 86400000 + 1000;
      expect(expiresAt).toBeLessThan(maxExpiry);
    });

    test("includes metadata in token", () => {
      const result = mintSetupLink({
        kind: "approval_inbox_setup",
        orgId: "org_sample_shoji",
        metadata: { channelType: "slack", priority: "high" },
      });

      expect(result.ok).toBe(true);
      expect(payloadOf(result.token).metadata).toEqual({ channelType: "slack", priority: "high" });
    });
  });

  describe("minted token payload", () => {
    test("carries kind / orgId / employeeId / expiresAt", () => {
      const minted = mintSetupLink({ kind: "employee_connector_oauth", orgId: "org_sample_shoji", employeeId: "emp_sales" });
      const payload = payloadOf(minted.token);
      expect(payload.kind).toBe("employee_connector_oauth");
      expect(payload.orgId).toBe("org_sample_shoji");
      expect(payload.employeeId).toBe("emp_sales");
      expect(payload.expiresAt).toBe(minted.expiresAt);
    });
  });

  describe("buildSetupLinkResponse", () => {
    test("builds response with URL and nextStepJa", () => {
      const link = mintSetupLink({
        kind: "workspace_bot_install",
        orgId: "org_sample_shoji",
      });

      const response = buildSetupLinkResponse(link);
      expect(response.setupUrl).toBe(link.url);
      expect(response.expiresAt).toBe(link.expiresAt);
      expect(response.nextStepJa).toContain("Slack");
      expect(response.nextStepJa).toContain("インストール");
    });
  });

  describe("getSetupLinkNextStepJa", () => {
    const kinds: SetupLinkKind[] = [
      "org_kickoff",
      "employee_connector_oauth",
      "slack_authorize",
      "workspace_bot_install",
      "approval_inbox_setup",
      "line_oauth_setup",
      "slack_bot_token_setup",
    ];

    for (const kind of kinds) {
      test(`returns nextStepJa for ${kind}`, () => {
        const nextStepJa = getSetupLinkNextStepJa(kind);
        expect(nextStepJa).toBeTruthy();
        expect(nextStepJa.length).toBeGreaterThan(10);
        expect(nextStepJa).not.toContain("チャットに貼");
        expect(nextStepJa).not.toContain("秘密");
      });
    }
  });

  describe("buildSetupGuidance", () => {
    test("builds guidance without minting link", () => {
      const guidance = buildSetupGuidance("org_kickoff");
      expect(guidance.kind).toBe("org_kickoff");
      expect(guidance.descriptionJa).toContain("初期設定");
      expect(guidance.nextStepJa).toBeTruthy();
      expect(guidance.setupUrl).toBeUndefined();
    });

    test("builds guidance with minted link", () => {
      const guidance = buildSetupGuidance("employee_connector_oauth", {
        mintLink: true,
        orgId: "org_sample_shoji",
        employeeId: "emp_sales",
      });
      expect(guidance.kind).toBe("employee_connector_oauth");
      expect(guidance.setupUrl).toBeTruthy();
      expect(guidance.setupUrl).toContain("/app/employees/emp_sales/connector");
      expect(guidance.expiresAt).toBeTruthy();
    });

    test("slack_authorize guidance never carries a URL (single-use link is issued with setup.slackAuthorizeLink.issue)", () => {
      const guidance = buildSetupGuidance("slack_authorize", {
        mintLink: true,
        orgId: "org_sample_shoji",
        employeeId: "emp_sales",
      });
      expect(guidance.kind).toBe("slack_authorize");
      expect(guidance.setupUrl).toBeUndefined();
      expect(guidance.nextStepJa).toContain("setup.slackAuthorizeLink.issue");
    });

    test("does not mint without orgId", () => {
      const guidance = buildSetupGuidance("org_kickoff", { mintLink: true });
      expect(guidance.setupUrl).toBeUndefined();
    });
  });

  describe("security properties", () => {
    test("different tokens for same config", () => {
      const link1 = mintSetupLink({ kind: "org_kickoff", orgId: "org_sample" });
      const link2 = mintSetupLink({ kind: "org_kickoff", orgId: "org_sample" });
      expect(link1.token).not.toBe(link2.token);
    });

    test("token is tenant-scoped", () => {
      const link1 = mintSetupLink({ kind: "org_kickoff", orgId: "org_a" });
      const link2 = mintSetupLink({ kind: "org_kickoff", orgId: "org_b" });

      expect(payloadOf(link1.token).orgId).toBe("org_a");
      expect(payloadOf(link2.token).orgId).toBe("org_b");
    });

    test("nextStepJa never contains secrets or paste instructions", () => {
      const link = mintSetupLink({
        kind: "slack_bot_token_setup",
        orgId: "org_sample_shoji",
      });

      expect(link.nextStepJa).not.toContain("xoxb");
      expect(link.nextStepJa).not.toContain("token");
      expect(link.nextStepJa).not.toMatch(/貼り?(直|付け)/);
    });
  });
});
