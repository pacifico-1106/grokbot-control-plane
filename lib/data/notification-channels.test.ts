import { afterEach, describe, expect, test } from "bun:test";
import {
  listNotificationChannels,
  resetDemoNotificationChannels,
  resolveEmployeeApprovalChannel,
  upsertNotificationChannel,
} from "@/lib/data/notification-channels";

const ORG = "org_inbox_test";

afterEach(() => {
  resetDemoNotificationChannels(ORG);
});

describe("per-employee approval inboxes", () => {
  test("unique-provider no longer blocks a second telegram row", async () => {
    const first = await upsertNotificationChannel({
      orgId: ORG,
      provider: "telegram",
      enabled: true,
      label: "安藤の既定",
      config: { chatId: "111" },
      secrets: { botToken: "tok-a", webhookSecret: "sec-a" },
    });
    const second = await upsertNotificationChannel({
      orgId: ORG,
      provider: "telegram",
      enabled: true,
      isDefault: false,
      label: "八坂のDM",
      config: { chatId: "222", allowedUserIds: ["yasaka"] },
      secrets: { botToken: "tok-b", webhookSecret: "sec-b" },
    });
    expect(first.id).not.toBe(second.id);
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
    const listed = await listNotificationChannels(ORG);
    expect(listed.filter((row) => row.provider === "telegram").length).toBe(2);
    expect(listed[0]?.id).toBe(first.id);
  });

  test("notify resolves employee channel else org default", async () => {
    const def = await upsertNotificationChannel({
      orgId: ORG,
      provider: "telegram",
      enabled: true,
      label: "既定",
      config: { chatId: "111" },
      secrets: { botToken: "tok-a", webhookSecret: "sec-a" },
    });
    const yasaka = await upsertNotificationChannel({
      orgId: ORG,
      provider: "telegram",
      enabled: true,
      isDefault: false,
      label: "八坂",
      config: { chatId: "222" },
      secrets: { botToken: "tok-b", webhookSecret: "sec-b" },
    });
    const unset = await resolveEmployeeApprovalChannel(ORG, { approvalChannelId: null });
    expect(unset?.id).toBe(def.id);
    const pointed = await resolveEmployeeApprovalChannel(ORG, {
      approvalChannelId: yasaka.id,
    });
    expect(pointed?.id).toBe(yasaka.id);
    const missing = await resolveEmployeeApprovalChannel(ORG, {
      approvalChannelId: "chn_missing",
    });
    expect(missing?.id).toBe(def.id);
  });
});
