/**
 * 09:34 addition: an external-treated deny points to channels.classify with
 * the channel id and an example call, on every surface; DMs and unrelated
 * reasons get none.
 */
import { describe, expect, test } from "bun:test";
import { egressDenyNextStep } from "@/lib/channel-classify/deny-hook";

const deny = (reason: string) => ({ decision: "deny", reason, audience: "external" });

describe("egressDenyNextStep", () => {
  const cases = [
    { conversation: { surface: "line", lineId: "Cnextline0001" }, surface: "line", id: "Cnextline0001" },
    { conversation: { surface: "telegram", telegramChatId: "-100424242" }, surface: "telegram", id: "-100424242" },
    { conversation: { surface: "slack", slackChannelId: "G0NEXTPRIV1" }, surface: "slack", id: "G0NEXTPRIV1" },
  ];
  for (const c of cases) {
    test(`${c.surface}: channel id + example call`, () => {
      const next = egressDenyNextStep({ tool: "comm.send", conversation: c.conversation, args: {} } as never, deny("external_confidential_denied"));
      expect(next?.tool).toBe("channels.classify");
      expect(next?.surface).toBe(c.surface);
      expect(next?.externalId).toBe(c.id);
      expect(next?.example.arguments.externalId).toBe(c.id);
      expect(next?.messageJa).toContain(c.id);
    });
  }

  test("other external-treated reasons (internal source / verbatim) also point to channels.classify", () => {
    for (const reason of ["external_internal_source_denied", "external_verbatim_denied"]) {
      expect(egressDenyNextStep({ tool: "comm.reply", conversation: { surface: "slack", slackChannelId: "C0NEXT0002" }, args: {} } as never, deny(reason))?.tool).toBe("channels.classify");
    }
  });

  test("a Slack DM or a body without a channel → null", () => {
    expect(egressDenyNextStep({ tool: "comm.reply", conversation: { surface: "slack", slackChannelId: "D0NEXTIM01" }, args: {} } as never, deny("external_confidential_denied"))).toBeNull();
    expect(egressDenyNextStep({ tool: "mail.send", conversation: { surface: "mail", email: "x@example.com" }, args: {} } as never, deny("external_confidential_denied"))).toBeNull();
  });
});
