import { afterEach, describe, expect, test } from "bun:test";
import { upsertConversationAdapter } from "./conversation-adapters";
import { DEMO_ORG } from "../demo-data";
import { getOrgChannel, upsertOrgChannel, upsertOrgParty } from "./directory";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("upsertOrgChannel Connect lock", () => {
  test("shared_external cannot switch to internal", async () => {
    const existing = await getOrgChannel(DEMO_ORG.id, "slack", "C_SHARED");
    expect(existing?.classification).toBe("shared_external");
    let thrown = "";
    try {
      await upsertOrgChannel({
        orgId: DEMO_ORG.id,
        surface: "slack",
        externalId: "C_SHARED",
        classification: "internal",
      });
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown).toBe("connect_cannot_be_internal");
    const after = await getOrgChannel(DEMO_ORG.id, "slack", "C_SHARED");
    expect(after?.classification).toBe("shared_external");
  });

  test("internal channel can stay internal", async () => {
    const row = await upsertOrgChannel({
      orgId: DEMO_ORG.id,
      surface: "slack",
      externalId: "C_INTERNAL",
      classification: "internal",
    });
    expect(row.classification).toBe("internal");
  });

  test("conversations.info ext-shared forces shared_external on save", async () => {
    await upsertConversationAdapter({
      orgId: "org_inspect_test",
      surface: "slack",
      enabled: true,
      secrets: { botToken: "xoxb-inspect" },
    });
    globalThis.fetch = (async (input) => {
      expect(String(input)).toContain("conversations.info");
      return Response.json({
        ok: true,
        channel: { is_ext_shared: true, is_ext_shared_plus: false },
      });
    }) as typeof fetch;
    try {
      const row = await upsertOrgChannel({
        orgId: "org_inspect_test",
        surface: "slack",
        externalId: "C_CONNECT_NEW",
        classification: "internal",
      });
      expect(row.classification).toBe("shared_external");
      expect(row.mixed).toBe(true);
    } finally {
      await upsertConversationAdapter({
        orgId: "org_inspect_test",
        surface: "slack",
        enabled: false,
        secrets: {},
      });
    }
  });

  test("slack_channel party cannot be saved internal when channel is ext-shared", async () => {
    let thrown = "";
    try {
      await upsertOrgParty({
        orgId: DEMO_ORG.id,
        kind: "slack_channel",
        identifier: "C_SHARED",
        audience: "internal",
      });
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown).toBe("connect_cannot_be_internal");
  });
});
