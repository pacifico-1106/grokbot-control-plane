import { afterEach, describe, expect, test } from "bun:test";
import { readInboundNoticeConfig } from "@/lib/inbound-notice/config";

const KEYS = [
  "INBOUND_CALL_NOTICE_ORG_ID",
  "INBOUND_CALL_NOTICE_EMPLOYEE_ID",
  "INBOUND_CALL_NOTICE_SLACK_TEAM_ID",
  "INBOUND_CALL_NOTICE_SLACK_CHANNEL_IDS",
  "INBOUND_CALL_NOTICE_SLACK_BOT_IDS",
  "INBOUND_CALL_NOTICE_SLACK_APP_IDS",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function fill() {
  process.env.INBOUND_CALL_NOTICE_ORG_ID = "org_demo";
  process.env.INBOUND_CALL_NOTICE_EMPLOYEE_ID = "emp_comm";
  process.env.INBOUND_CALL_NOTICE_SLACK_TEAM_ID = "T_DUMMY";
  process.env.INBOUND_CALL_NOTICE_SLACK_CHANNEL_IDS = "C_DUMMY,C_OTHER";
  process.env.INBOUND_CALL_NOTICE_SLACK_BOT_IDS = "B_DUMMY";
  process.env.INBOUND_CALL_NOTICE_SLACK_APP_IDS = "A_DUMMY";
}

describe("readInboundNoticeConfig (prototype: one employee + env channel allowlist)", () => {
  test("reads a single target employee from env", () => {
    fill();
    const c = readInboundNoticeConfig();
    expect(c).toEqual({
      orgId: "org_demo",
      employeeId: "emp_comm",
      slackTeamId: "T_DUMMY",
      channelIds: ["C_DUMMY", "C_OTHER"],
      botIds: ["B_DUMMY"],
      appIds: ["A_DUMMY"],
    });
  });

  test("missing employee id → null (fail closed)", () => {
    fill();
    delete process.env.INBOUND_CALL_NOTICE_EMPLOYEE_ID;
    expect(readInboundNoticeConfig()).toBeNull();
  });
});
