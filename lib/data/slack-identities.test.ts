import { describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeEmployees } from "../demo-data";
import {
  bindEmployeeSlackIdentity,
  getEmployeeSlackIdentity,
  getEmployeesBySlackUserIds,
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

describe("H1 fix: Slack cross-org isolation", () => {
  test("same slack_user_id in different teams - only matching team returned", async () => {
    const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");
    const previous = emp.allowedAccounts;
    emp.allowedAccounts = [{ service: "slack", accountId: "U_SHARED" }];
    try {
      await bindEmployeeSlackIdentity({
        employeeId: emp.id,
        orgId: DEMO_ORG.id,
        slackUserId: "U_SHARED",
        slackTeamId: "T_TEAM_A",
        displayName: "共有ユーザーA",
        userToken: "xoxp-a",
      });
      const rowsA = await getEmployeesBySlackUserIds(["U_SHARED"], "T_TEAM_A");
      expect(rowsA.length).toBe(1);
      expect(rowsA[0].slackTeamId).toBe("T_TEAM_A");
      const rowsB = await getEmployeesBySlackUserIds(["U_SHARED"], "T_TEAM_B");
      expect(rowsB.length).toBe(0);
    } finally {
      await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
      emp.allowedAccounts = previous;
    }
  });

  test("wrong team returns no results (fail-closed)", async () => {
    const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");
    const previous = emp.allowedAccounts;
    emp.allowedAccounts = [{ service: "slack", accountId: "U_SINGLE" }];
    try {
      await bindEmployeeSlackIdentity({
        employeeId: emp.id,
        orgId: DEMO_ORG.id,
        slackUserId: "U_SINGLE",
        slackTeamId: "T_CORRECT",
        displayName: "単一チーム",
        userToken: "xoxp-single",
      });
      const correct = await getEmployeesBySlackUserIds(["U_SINGLE"], "T_CORRECT");
      expect(correct.length).toBe(1);
      const wrong = await getEmployeesBySlackUserIds(["U_SINGLE"], "T_WRONG");
      expect(wrong.length).toBe(0);
    } finally {
      await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
      emp.allowedAccounts = previous;
    }
  });

  test("missing teamId returns empty (fail-closed, no cross-org fan-out)", async () => {
    const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");
    const previous = emp.allowedAccounts;
    emp.allowedAccounts = [{ service: "slack", accountId: "U_NOFANOUT" }];
    try {
      await bindEmployeeSlackIdentity({
        employeeId: emp.id,
        orgId: DEMO_ORG.id,
        slackUserId: "U_NOFANOUT",
        slackTeamId: "T_DEMO",
        displayName: "ファンアウトなし",
        userToken: "xoxp-nofanout",
      });
      const withTeam = await getEmployeesBySlackUserIds(["U_NOFANOUT"], "T_DEMO");
      expect(withTeam.length).toBe(1);
      const noTeam = await getEmployeesBySlackUserIds(["U_NOFANOUT"], undefined);
      expect(noTeam.length).toBe(0);
      const emptyTeam = await getEmployeesBySlackUserIds(["U_NOFANOUT"], "");
      expect(emptyTeam.length).toBe(0);
      const nullTeam = await getEmployeesBySlackUserIds(["U_NOFANOUT"], null);
      expect(nullTeam.length).toBe(0);
    } finally {
      await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
      emp.allowedAccounts = previous;
    }
  });

  test("team_id match is case-insensitive", async () => {
    const emp = getRuntimeEmployees().find((item) => item.id === "emp_comm");
    if (!emp) throw new Error("missing emp_comm");
    const previous = emp.allowedAccounts;
    emp.allowedAccounts = [{ service: "slack", accountId: "U_CASETEST" }];
    try {
      await bindEmployeeSlackIdentity({
        employeeId: emp.id,
        orgId: DEMO_ORG.id,
        slackUserId: "U_CASETEST",
        slackTeamId: "T_MixedCase",
        displayName: "ケーステスト",
        userToken: "xoxp-case",
      });
      const upper = await getEmployeesBySlackUserIds(["U_CASETEST"], "T_MIXEDCASE");
      expect(upper.length).toBe(1);
      const lower = await getEmployeesBySlackUserIds(["u_casetest"], "t_mixedcase");
      expect(lower.length).toBe(1);
      const exact = await getEmployeesBySlackUserIds(["U_CASETEST"], "T_MixedCase");
      expect(exact.length).toBe(1);
    } finally {
      await revokeEmployeeSlackIdentity({ employeeId: emp.id, orgId: DEMO_ORG.id });
      emp.allowedAccounts = previous;
    }
  });
});
