/**
 * createConfigChangeRequest records whether the declared requester matches the
 * real Slack speaker (woke audit), shows it to the approver, and uses the
 * declared name in requester copy only when verified. Optional enforcement:
 * P1_CONFIG_CHANGE_REQUESTER_VERIFY_ENFORCE (default OFF).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import { appendAuditEvent, listAuditEvents } from "@/lib/data/audit";
import { getApprovalById } from "@/lib/data/approvals";
import {
  createConfigChangeRequest,
  isPendingConfigChange,
  requesterNoticeForApproval,
  type ConfigChangeDeps,
} from "@/lib/config-change-request/service";
import { parseConfigChangeMetadata } from "@/lib/config-change-request/core";

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const FLAGS = ["P1_CONFIG_CHANGE_REQUEST_ENABLED", "P1_CONFIG_CHANGE_REQUESTER_VERIFY_ENFORCE"];
const backup = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
const deps: Partial<ConfigChangeDeps> = {
  resolveApprover: async () => ({ ok: true, surface: "slack_dm", channelId: "nc_test" }),
  notify: async () => true,
};

let seq = 0;
const uniq = (p: string) => `${p}${Date.now().toString(36).toUpperCase()}${++seq}`;

async function seedWake(channel: string, ts: string, speakerId: string, employeeId = EMP, orgId = ORG) {
  await appendAuditEvent({
    orgId, employeeId, credentialId: null, action: "slack.mention_wake", purpose: "slack.mention",
    summary: "Slackメンションで社員を起こした",
    metadata: { reason: "woke", channel, ts, thread_ts: null, eventId: uniq("Ev"), speakerId, speakerTeamId: "T_DEMO" },
  });
}

function request(channel: string, ts: string, requestedBy: Record<string, unknown>) {
  return createConfigChangeRequest(
    {
      orgId: ORG, employeeId: EMP, credentialId: `cred_${EMP}`,
      args: {
        kind: "instructions", jobId: uniq("job-"), requestedBy,
        conversation: { surface: "slack", slackChannelId: channel, threadTs: ts },
        instructions: { mode: "append", text: `追記 ${uniq("x")}` },
      },
    },
    deps
  );
}

beforeEach(() => {
  process.env.P1_CONFIG_CHANGE_REQUEST_ENABLED = "1";
  delete process.env.P1_CONFIG_CHANGE_REQUESTER_VERIFY_ENFORCE;
});
afterEach(() => {
  for (const k of FLAGS) {
    if (backup[k] === undefined) delete process.env[k];
    else process.env[k] = backup[k];
  }
});

describe("requester verification (stricter copy, no flag)", () => {
  test("declared Slack user is the speaker → verified, name kept, recorded in metadata + audit", async () => {
    const channel = uniq("C");
    await seedWake(channel, "1700000000.0001", "U0TANAKA");
    const res = await request(channel, "1700000000.0001", { name: "田中", slackUserId: "U0TANAKA" });
    if (!isPendingConfigChange(res)) throw new Error(res.code);
    expect(res.summary.startsWith("田中さんから次の変更依頼が来ています: ")).toBe(true);
    expect(res.summary).toContain("一致");
    expect(res.requesterAckJa.startsWith("田中さん")).toBe(true);
    const approval = await getApprovalById(res.approvalId, ORG);
    expect(parseConfigChangeMetadata(approval?.metadata)?.requesterVerification?.status).toBe("verified");
    const audit = (await listAuditEvents(ORG, 5000)).find(
      (e) => e.action === "config.change_requested" && e.metadata.approvalId === res.approvalId
    );
    expect((audit?.metadata.requesterVerification as { status: string }).status).toBe("verified");
  });

  test("someone else spoke → mismatch warning; declared name not used toward the requester", async () => {
    const channel = uniq("C");
    await seedWake(channel, "1700000000.0002", "U0SATO");
    const res = await request(channel, "1700000000.0002", { name: "社長", slackUserId: "U0TANAKA" });
    if (!isPendingConfigChange(res)) throw new Error(res.code);
    expect(res.summary).toContain("⚠");
    expect(res.summary).toContain("U0SATO");
    expect(res.summary.startsWith("社長さん")).toBe(false);
    expect(res.requesterAckJa.startsWith("ご依頼者さん")).toBe(true);
    const approval = await getApprovalById(res.approvalId, ORG);
    expect(requesterNoticeForApproval({ ...approval!, status: "rejected" })?.startsWith("ご依頼者さん")).toBe(true);
  });

  test("a wake of ANOTHER employee in the same channel does not verify", async () => {
    const channel = uniq("C");
    await seedWake(channel, "1700000000.0003", "U0TANAKA", "emp_ops");
    const res = await request(channel, "1700000000.0003", { name: "田中", slackUserId: "U0TANAKA" });
    if (!isPendingConfigChange(res)) throw new Error(res.code);
    expect(res.summary).toContain("未確認");
  });

  test("legacy ticket without requesterVerification → generic name in notices", async () => {
    const channel = uniq("C");
    await seedWake(channel, "1700000000.0004", "U0TANAKA");
    const res = await request(channel, "1700000000.0004", { name: "田中", slackUserId: "U0TANAKA" });
    if (!isPendingConfigChange(res)) throw new Error(res.code);
    const approval = await getApprovalById(res.approvalId, ORG);
    const meta = { ...(approval!.metadata!.configChange as Record<string, unknown>) };
    delete meta.requesterVerification;
    const legacy = { ...approval!, status: "rejected" as const, metadata: { ...approval!.metadata, configChange: meta } };
    expect(requesterNoticeForApproval(legacy)?.startsWith("ご依頼者さん")).toBe(true);
  });
});

describe("P1_CONFIG_CHANGE_REQUESTER_VERIFY_ENFORCE", () => {
  test("ON + not verified → refused, nothing created, refusal audited", async () => {
    process.env.P1_CONFIG_CHANGE_REQUESTER_VERIFY_ENFORCE = "1";
    const channel = uniq("C");
    const res = await request(channel, "1700000000.0005", { name: "田中", slackUserId: "U0TANAKA" });
    expect(res.code).toBe("requester_not_verified");
    expect(res.applied).toBe(false);
    const refused = (await listAuditEvents(ORG, 5000)).find(
      (e) => e.action === "config.change_refused" && e.metadata.code === "requester_not_verified"
    );
    expect(refused).toBeDefined();
  });
  test("ON + verified → pending approval as usual", async () => {
    process.env.P1_CONFIG_CHANGE_REQUESTER_VERIFY_ENFORCE = "1";
    const channel = uniq("C");
    await seedWake(channel, "1700000000.0006", "U0TANAKA");
    const res = await request(channel, "1700000000.0006", { name: "田中", slackUserId: "U0TANAKA" });
    expect(res.code).toBe("needs_approval");
  });
  test("OFF (default) + not verified → still pending (approver sees 未確認)", async () => {
    const res = await request(uniq("C"), "1700000000.0007", { name: "田中", slackUserId: "U0TANAKA" });
    if (!isPendingConfigChange(res)) throw new Error(res.code);
    expect(res.summary).toContain("未確認");
  });
});
