import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mintSetupLink,
  redeemSetupLink,
  buildSetupLinkResponse,
  buildSetupGuidance,
  getSetupLinkNextStepJa,
  type SetupLinkKind,
} from "./setup-links";

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

    test("mints a valid setup link for slack_authorize", () => {
      const result = mintSetupLink({
        kind: "slack_authorize",
        orgId: "org_sample_shoji",
        employeeId: "emp_sales",
      });

      expect(result.ok).toBe(true);
      expect(result.url).toContain("/api/slack/oauth/start");
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
      const redeemed = redeemSetupLink(result.token);
      expect(redeemed.ok).toBe(true);
      if (redeemed.ok) {
        expect(redeemed.metadata).toEqual({ channelType: "slack", priority: "high" });
      }
    });
  });

  describe("redeemSetupLink", () => {
    test("redeems a valid token", () => {
      const minted = mintSetupLink({
        kind: "org_kickoff",
        orgId: "org_sample_shoji",
      });

      const result = redeemSetupLink(minted.token);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.kind).toBe("org_kickoff");
        expect(result.orgId).toBe("org_sample_shoji");
      }
    });

    test("redeems token with employeeId", () => {
      const minted = mintSetupLink({
        kind: "employee_connector_oauth",
        orgId: "org_sample_shoji",
        employeeId: "emp_sales",
      });

      const result = redeemSetupLink(minted.token);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.kind).toBe("employee_connector_oauth");
        expect(result.orgId).toBe("org_sample_shoji");
        expect(result.employeeId).toBe("emp_sales");
      }
    });

    test("rejects invalid token format", () => {
      const result = redeemSetupLink("invalid-token-no-dot");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("invalid");
        expect(result.messageJa).toContain("無効");
      }
    });

    test("rejects tampered token", () => {
      const minted = mintSetupLink({
        kind: "org_kickoff",
        orgId: "org_sample_shoji",
      });

      const tampered = minted.token.slice(0, -5) + "xxxxx";
      const result = redeemSetupLink(tampered);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("tampered");
        expect(result.messageJa).toContain("改ざん");
      }
    });

    test("rejects expired token", () => {
      const minted = mintSetupLink({
        kind: "org_kickoff",
        orgId: "org_sample_shoji",
        expiresInSeconds: -1,
      });

      const result = redeemSetupLink(minted.token);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("expired");
        expect(result.messageJa).toContain("有効期限");
      }
    });

    test("rejects malformed base64", () => {
      const result = redeemSetupLink("!!!invalid!!!.abcd1234");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Malformed base64 fails signature verification, so it's detected as tampered
        expect(["invalid", "tampered"]).toContain(result.code);
      }
    });
  });

  describe("buildSetupLinkResponse", () => {
    test("builds response with URL and nextStepJa", () => {
      const link = mintSetupLink({
        kind: "slack_authorize",
        orgId: "org_sample_shoji",
      });

      const response = buildSetupLinkResponse(link);
      expect(response.setupUrl).toBe(link.url);
      expect(response.expiresAt).toBe(link.expiresAt);
      expect(response.nextStepJa).toContain("Slack");
      expect(response.nextStepJa).toContain("連携");
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
      const guidance = buildSetupGuidance("slack_authorize", {
        mintLink: true,
        orgId: "org_sample_shoji",
        employeeId: "emp_sales",
      });
      expect(guidance.kind).toBe("slack_authorize");
      expect(guidance.setupUrl).toBeTruthy();
      expect(guidance.setupUrl).toContain("/api/slack/oauth/start");
      expect(guidance.expiresAt).toBeTruthy();
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

      const redeemed1 = redeemSetupLink(link1.token);
      const redeemed2 = redeemSetupLink(link2.token);

      expect(redeemed1.ok).toBe(true);
      expect(redeemed2.ok).toBe(true);
      if (redeemed1.ok && redeemed2.ok) {
        expect(redeemed1.orgId).toBe("org_a");
        expect(redeemed2.orgId).toBe("org_b");
      }
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
