import { describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeEmployees } from "../demo-data";
import {
  bindEmployeeSlackIdentity,
  getEmployeeSlackIdentity,
  getLinkedSlackUserToken,
  revokeEmployeeSlackIdentity,
} from "./slack-identities";

describe("employee Slack identity bind", () => {
  test("mismatch against allowedAccounts slack id does not save", async () => {
    const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");
    const previous = emp.allowedAccounts;
    emp.allowedAccounts = [{ service: "slack", accountId: "U_ANDO" }];
    await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
    let thrown = "";
    try {
      await bindEmployeeSlackIdentity({
        employeeId: emp.id,
        orgId: DEMO_ORG.id,
        slackUserId: "U_OTHER",
        userToken: "xoxp-user",
      });
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown).toBe("slack_identity_mismatch");
    expect(await getEmployeeSlackIdentity(emp.id)).toBeNull();
    emp.allowedAccounts = previous;
  });

  test("matching slack allowedAccounts stores token for gateway only", async () => {
    const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");
    const previous = emp.allowedAccounts;
    emp.allowedAccounts = [{ service: "slack", accountId: "U_ANDO" }];
    try {
      const row = await bindEmployeeSlackIdentity({
        employeeId: emp.id,
        orgId: DEMO_ORG.id,
        slackUserId: "U_ANDO",
        slackTeamId: "T_DEMO",
        displayName: "安藤",
        userToken: "xoxp-secret",
      });
      expect(row.slackUserId).toBe("U_ANDO");
      expect(row.status).toBe("linked");
      const pub = await getEmployeeSlackIdentity(emp.id);
      expect(pub && "userToken" in pub).toBe(false);
      expect(await getLinkedSlackUserToken(emp.id)).toBe("xoxp-secret");
    } finally {
      await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
      emp.allowedAccounts = previous;
    }
  });
});
