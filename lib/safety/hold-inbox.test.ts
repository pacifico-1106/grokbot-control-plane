/**
 * S3 inbox 「緊急停止」 (Slack / LINE / Telegram): stop ONLY, reply carries the web link;
 * gate = delivered card + approver allow-list + member binding. Release is never offered.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-holds3i";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const { DEMO_ORG } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");
const store = await import("@/lib/safety/hold-store");
const notify = await import("@/lib/safety/hold-notify");
const { stopFromInbox } = await import("@/lib/safety/hold-inbox");
const { showHoldStopButton } = await import("@/lib/safety/hold-config");
const { createApproval } = await import("@/lib/data/approvals");
const { recordNotificationDelivery } = await import("@/lib/data/notification-channels");
const { setDemoWorkflowVoterBinding } = await import("@/lib/approval-workflow/data");

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
let ref = "";
let saved: string | undefined;
beforeEach(async () => {
  saved = process.env.EMPLOYEE_HOLD_ENABLED;
  process.env.EMPLOYEE_HOLD_ENABLED = "true";
  notify.__setHoldNotifierForTests({ tenant: async () => undefined, ops: async () => undefined });
  store.__resetDemoHoldsForTests();
  const created = await createApproval({ orgId: ORG, employeeId: EMP, credentialId: "cred_sales", title: "t", purpose: "sales.outreach", summary: "s", risk: "low", tool: "slack.post" });
  ref = created.approval.telegramRef!;
  for (const [provider, channelId] of [["slack", "ch_slack"], ["line", "ch_line"], ["telegram", "ch_tg"]] as const) {
    await recordNotificationDelivery({ approval: created.approval, channelId, provider, externalMessageId: "m1" });
  }
  const verifiedAt = new Date().toISOString();
  setDemoWorkflowVoterBinding({ orgId: ORG, provider: "slack", channelKey: "ch_slack", userId: "U_ADMIN", memberId: "mem_2", verifiedAt });
  setDemoWorkflowVoterBinding({ orgId: ORG, provider: "line", channelKey: "ch_line", userId: "L_ADMIN", memberId: "mem_2", verifiedAt });
  setDemoWorkflowVoterBinding({ orgId: ORG, provider: "telegram", channelKey: "ch_tg", userId: "777", memberId: "mem_1", verifiedAt });
});
afterEach(() => {
  if (saved === undefined) delete process.env.EMPLOYEE_HOLD_ENABLED; else process.env.EMPLOYEE_HOLD_ENABLED = saved;
  notify.__setHoldNotifierForTests(null);
  store.__resetDemoHoldsForTests();
});
const operable = async () => (await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" })).ok;

describe("stopFromInbox", () => {
  for (const [provider, channelId, userId] of [["slack", "ch_slack", "U_ADMIN"], ["line", "ch_line", "L_ADMIN"], ["telegram", "ch_tg", "777"]] as const) {
    test(`${provider}: a bound approver stops; the reply says release is web-only and links there`, async () => {
      const r = await stopFromInbox({ orgId: ORG, provider, channelId, userId, ref, externalMessageId: "m1" });
      expect(r.code).toBe("stopped");
      expect(await operable()).toBe(false);
      expect(r.text).toContain(`/app/employees/${EMP}`);
      expect(r.text).toContain("解除はダッシュボードからのみ");
    });
  }
  test("flag OFF → nothing stopped", async () => {
    delete process.env.EMPLOYEE_HOLD_ENABLED;
    expect((await stopFromInbox({ orgId: ORG, provider: "slack", channelId: "ch_slack", userId: "U_ADMIN", ref })).code).toBe("hold_disabled");
    expect(await operable()).toBe(true);
  });
  test("unbound presser → refused with a link to the web stop", async () => {
    const r = await stopFromInbox({ orgId: ORG, provider: "slack", channelId: "ch_slack", userId: "U_STRANGER", ref });
    expect(r.code).toBe("member_binding_required");
    expect(r.text).toContain(`/app/employees/${EMP}`);
    expect(await operable()).toBe(true);
  });
  test("card not delivered to this channel, or another message → refused", async () => {
    expect((await stopFromInbox({ orgId: ORG, provider: "slack", channelId: "ch_other", userId: "U_ADMIN", ref })).code).toBe("delivery_mismatch");
    expect((await stopFromInbox({ orgId: ORG, provider: "slack", channelId: "ch_slack", userId: "U_ADMIN", ref, externalMessageId: "m2" })).code).toBe("delivery_mismatch");
    expect(await operable()).toBe(true);
  });
  test("another org's ref → not found", async () => {
    expect((await stopFromInbox({ orgId: "org_other", provider: "slack", channelId: "ch_slack", userId: "U_ADMIN", ref })).ok).toBe(false);
    expect(await operable()).toBe(true);
  });
});

describe("cards: 「緊急停止」 only with the flag, only on employee tickets, never on release tickets", () => {
  test("showHoldStopButton", () => {
    expect(showHoldStopButton({ employeeId: EMP, tool: "slack.post" })).toBe(true);
    expect(showHoldStopButton({ employeeId: "", tool: "policy.patch" })).toBe(false);
    expect(showHoldStopButton({ employeeId: EMP, tool: "employee.hold.release", metadata: { adminTool: "employee.hold.release" } })).toBe(false);
    delete process.env.EMPLOYEE_HOLD_ENABLED;
    expect(showHoldStopButton({ employeeId: EMP, tool: "slack.post" })).toBe(false);
  });
  test("all three card builders use it, and no inbox handler offers a release action", () => {
    for (const f of ["lib/notify/slack.ts", "lib/notify/telegram.ts", "lib/notify/line.ts"]) {
      expect(readFileSync(join(ROOT, f), "utf8")).toContain("showHoldStopButton(approval)");
    }
    for (const f of ["app/api/webhooks/slack/interactivity/route.ts", "app/api/webhooks/line/[ref]/route.ts", "lib/notify/telegram-channel-webhook.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src).toContain("stopFromInbox");
      expect(src).not.toMatch(/approveHoldRelease|requestHoldRelease/);
    }
  });
});
