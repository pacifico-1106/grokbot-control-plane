/**
 * #284 decision 2 (木村 2026-10-05): the URLs Staffpass hands to humans for
 * "connect this employee's Slack" (setup link kind slack_authorize, the Slack
 * status diagnose template, slack.dmSetup.status rows) point at the
 * admin-issued re-authorize link /api/slack/oauth/link — never at the session
 * start route /api/slack/oauth/start, which now requires hire_issue_credentials
 * (a capability-less recipient would land on ?slack=forbidden).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mintSetupLink, buildSetupGuidance, getSetupLinkNextStepJa } from "@/lib/security/setup-links";
import { computeSlackStatusNextStepJa, slackAuthorizeUrlTemplate } from "@/lib/slack/slack-status-diagnose";
import { SLACK_AUTHORIZE_LINK_PATH } from "@/lib/slack/authorize-link";

const START = "/api/slack/oauth/start";
/** A string literal / template that builds the start URL (comments may name the route). */
const START_LITERAL = /["'`][^"'`\n]*\/api\/slack\/oauth\/start/;

describe("setup link kind slack_authorize", () => {
  test("is never minted as a URL (neither the start route nor a token-less link); guidance names the issue tool", () => {
    // #284 follow-up: the link route only accepts tokens issued by
    // setup.slackAuthorizeLink.issue, so the setup-link minter refuses this kind.
    expect(() => mintSetupLink({ kind: "slack_authorize", orgId: "org_1", employeeId: "emp_1" })).toThrow();
    const guidance = buildSetupGuidance("slack_authorize", { mintLink: true, orgId: "org_1", employeeId: "emp_1" });
    expect(guidance.setupUrl).toBeUndefined();
    expect(guidance.nextStepJa).not.toContain(START);
    expect(guidance.nextStepJa).toContain(SLACK_AUTHORIZE_LINK_PATH);
  });

  test("next step says how the single-use link is issued (admin MCP, human approval)", () => {
    expect(getSetupLinkNextStepJa("slack_authorize")).toContain("setup.slackAuthorizeLink.issue");
  });
});

describe("Slack diagnose template", () => {
  test("template points at /api/slack/oauth/link", () => {
    expect(slackAuthorizeUrlTemplate()).toContain(SLACK_AUTHORIZE_LINK_PATH);
    expect(slackAuthorizeUrlTemplate()).not.toContain(START);
  });

  test("Path B next step names the link issue tool and never the start route", () => {
    const base = {
      botTokenPresent: true,
      authTest: { ok: true, bot_id: "B1", user_id: "U1" },
      botHasFilesWrite: true,
      botFilesWriteCode: "ok",
      adapterEnabled: true,
      imRoutesCount: 1,
      postingMismatch: [] as string[],
    };
    const employee = {
      employeeId: "emp_diag",
      displayName: "診断社員",
      postingAs: "user" as const,
      slackIdentityLinked: false,
      slackIdentityStatus: null,
      needsPathB: true,
      fileUploadReady: false,
      needsReoauthForFilesWrite: false,
      authorizeUrlTemplate: slackAuthorizeUrlTemplate(),
    };
    const readiness = { pathBEmployeeCount: 1, linkedCount: 0, fileUploadReadyCount: 0, needsReoauthCount: 0, needsAuthorizeCount: 1, ready: false };
    const msg = computeSlackStatusNextStepJa({ ...base, employees: [employee], pathBReadiness: readiness } as never);
    expect(msg).toContain("setup.slackAuthorizeLink.issue");
    expect(msg).toContain("emp_diag");
    expect(msg).not.toContain(START);
    const reoauth = computeSlackStatusNextStepJa({
      ...base,
      employees: [{ ...employee, slackIdentityLinked: true, slackIdentityStatus: "linked", needsReoauthForFilesWrite: true }],
      pathBReadiness: { ...readiness, linkedCount: 1, needsAuthorizeCount: 0, needsReoauthCount: 1 },
    } as never);
    expect(reoauth).toContain("setup.slackAuthorizeLink.issue");
    expect(reoauth).not.toContain(START);
  });
});

describe("no human-facing builder hands out the session start route", () => {
  test("lib/** (non-test) never builds a /api/slack/oauth/start URL", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && START_LITERAL.test(readFileSync(path, "utf8"))) {
          offenders.push(relative(root, path));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
