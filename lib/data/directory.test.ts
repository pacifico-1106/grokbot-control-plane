import { describe, expect, test } from "bun:test";
import { DEMO_ORG } from "../demo-data";
import { getOrgChannel, upsertOrgChannel } from "./directory";

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
});
