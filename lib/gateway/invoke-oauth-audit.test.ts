import { describe, expect, test } from "bun:test";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { getRuntimeAudit } from "@/lib/demo-data";

/** PR-7: OAuth-authenticated invokes are labelled in audit; gb_emp_ invokes are unchanged. */
const getAudit = () => getRuntimeAudit();

async function invoke(jobId: string, oauth: { grantId: string; clientHost: string } | null) {
  return runGatewayInvoke({
    employeeId: "emp_comm",
    credentialId: "cred_comm",
    oauth,
    body: { tool: "files.read", purpose: "knowledge.lookup", jobId, args: { assetRef: "kb/company-handbook" } },
  });
}

describe("gateway audit authMethod (MCP OAuth)", () => {
  test("oauth invoke → every audit row of the job carries authMethod/oauthGrantId/oauthClientHost", async () => {
    const jobId = `job_oauth_${Date.now()}`;
    await invoke(jobId, { grantId: "grant_123", clientHost: "claude.ai" });
    const rows = getAudit().filter((r) => JSON.stringify(r).includes(jobId));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.metadata.authMethod).toBe("oauth");
      expect(r.metadata.oauthGrantId).toBe("grant_123");
      expect(r.metadata.oauthClientHost).toBe("claude.ai");
    }
  });

  test("gb_emp_ invoke → no auth labels added (unchanged shape)", async () => {
    const jobId = `job_gbemp_${Date.now()}`;
    await invoke(jobId, null);
    const rows = getAudit().filter((r) => JSON.stringify(r).includes(jobId));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect("authMethod" in r.metadata).toBe(false);
      expect("oauthGrantId" in r.metadata).toBe(false);
    }
  });
});
