import { describe, expect, test } from "bun:test";
import {
  resolveIngressHandoffSync,
  extractSealithIntent,
} from "./resolve";
import type { OrgIngressHandoffPolicy, IngressHandoffRule } from "@/lib/types";

const DEFAULT_RULE: IngressHandoffRule = {
  id: "ihr_default",
  applyTo: "all",
  body: "full",
  attachment: "meta",
  attachmentApproval: "none",
  sealith: "off",
  audit: { jobId: true, sealithTransferId: false },
};

function makePolicy(rules: Partial<IngressHandoffRule>[]): OrgIngressHandoffPolicy {
  return {
    version: 1,
    rules: rules.map((r, i) => ({
      ...DEFAULT_RULE,
      id: `ihr_${i}`,
      ...r,
    })),
    updatedAt: new Date().toISOString(),
    updatedBy: "admin_mcp",
  };
}

describe("resolveIngressHandoffSync", () => {
  test("returns default rule when policy is null", () => {
    const result = resolveIngressHandoffSync(null, {
      channelId: "C123",
      classification: "internal",
    });
    expect(result.isDefault).toBe(true);
    expect(result.rule.applyTo).toBe("all");
    expect(result.rule.body).toBe("full");
    expect(result.rule.attachment).toBe("meta");
  });

  test("returns default rule when policy has no rules", () => {
    const result = resolveIngressHandoffSync(
      { version: 1, rules: [], updatedAt: "", updatedBy: "admin_mcp" },
      { channelId: "C123", classification: "internal" }
    );
    expect(result.isDefault).toBe(true);
  });

  test("matches applyTo=all rule", () => {
    const policy = makePolicy([
      { applyTo: "all", body: "none", attachment: "none", sealith: "suggest" },
    ]);
    const result = resolveIngressHandoffSync(policy, {
      channelId: "C123",
      classification: "internal",
    });
    expect(result.isDefault).toBe(false);
    expect(result.rule.body).toBe("none");
    expect(result.rule.sealith).toBe("suggest");
    expect(result.matchedApplyTo).toBe("all");
  });

  test("matches applyTo=channels rule when channelId matches", () => {
    const policy = makePolicy([
      {
        applyTo: "channels",
        channelIds: ["C_SENSITIVE", "C_LEGAL"],
        body: "prefix",
        bodyPrefixChars: 100,
        attachment: "none",
      },
      { applyTo: "all", body: "full", attachment: "file" },
    ]);
    const result = resolveIngressHandoffSync(policy, {
      channelId: "C_SENSITIVE",
      classification: "internal",
    });
    expect(result.isDefault).toBe(false);
    expect(result.rule.body).toBe("prefix");
    expect(result.rule.bodyPrefixChars).toBe(100);
    expect(result.matchedApplyTo).toBe("channels");
  });

  test("case-insensitive channelId matching", () => {
    const policy = makePolicy([
      {
        applyTo: "channels",
        channelIds: ["C_SENSITIVE"],
        body: "none",
      },
      { applyTo: "all", body: "full" },
    ]);
    const result = resolveIngressHandoffSync(policy, {
      channelId: "c_sensitive",
      classification: "internal",
    });
    expect(result.rule.body).toBe("none");
    expect(result.matchedApplyTo).toBe("channels");
  });

  test("skips applyTo=channels rule when channelId does not match", () => {
    const policy = makePolicy([
      {
        applyTo: "channels",
        channelIds: ["C_SENSITIVE"],
        body: "none",
      },
      { applyTo: "all", body: "full" },
    ]);
    const result = resolveIngressHandoffSync(policy, {
      channelId: "C_OTHER",
      classification: "internal",
    });
    expect(result.rule.body).toBe("full");
    expect(result.matchedApplyTo).toBe("all");
  });

  test("matches applyTo=classified_external_sensitive for shared_external", () => {
    const policy = makePolicy([
      {
        applyTo: "classified_external_sensitive",
        body: "prefix",
        bodyPrefixChars: 50,
        attachment: "meta",
        sealith: "required",
      },
      { applyTo: "all", body: "full", attachment: "file" },
    ]);
    const result = resolveIngressHandoffSync(policy, {
      channelId: "C_SHARED",
      classification: "shared_external",
    });
    expect(result.isDefault).toBe(false);
    expect(result.rule.body).toBe("prefix");
    expect(result.rule.sealith).toBe("required");
    expect(result.matchedApplyTo).toBe("classified_external_sensitive");
  });

  test("matches applyTo=classified_external_sensitive for unknown (fail-closed)", () => {
    const policy = makePolicy([
      {
        applyTo: "classified_external_sensitive",
        body: "none",
        attachment: "none",
      },
      { applyTo: "all", body: "full", attachment: "file" },
    ]);
    const result = resolveIngressHandoffSync(policy, {
      channelId: "C_NEW",
      classification: "unknown",
    });
    expect(result.rule.body).toBe("none");
    expect(result.matchedApplyTo).toBe("classified_external_sensitive");
  });

  test("skips applyTo=classified_external_sensitive for internal", () => {
    const policy = makePolicy([
      {
        applyTo: "classified_external_sensitive",
        body: "none",
      },
      { applyTo: "all", body: "full" },
    ]);
    const result = resolveIngressHandoffSync(policy, {
      channelId: "C_INTERNAL",
      classification: "internal",
    });
    expect(result.rule.body).toBe("full");
    expect(result.matchedApplyTo).toBe("all");
  });

  test("first-match-wins ordering", () => {
    const policy = makePolicy([
      {
        applyTo: "channels",
        channelIds: ["C_VIP"],
        body: "none",
        attachment: "none",
      },
      {
        applyTo: "classified_external_sensitive",
        body: "prefix",
        bodyPrefixChars: 100,
      },
      { applyTo: "all", body: "full" },
    ]);

    const vipResult = resolveIngressHandoffSync(policy, {
      channelId: "C_VIP",
      classification: "shared_external",
    });
    expect(vipResult.rule.body).toBe("none");
    expect(vipResult.matchedApplyTo).toBe("channels");

    const externalResult = resolveIngressHandoffSync(policy, {
      channelId: "C_OTHER",
      classification: "shared_external",
    });
    expect(externalResult.rule.body).toBe("prefix");
    expect(externalResult.matchedApplyTo).toBe("classified_external_sensitive");

    const internalResult = resolveIngressHandoffSync(policy, {
      channelId: "C_TEAM",
      classification: "internal",
    });
    expect(internalResult.rule.body).toBe("full");
    expect(internalResult.matchedApplyTo).toBe("all");
  });

  test("preserves classification in result", () => {
    const policy = makePolicy([{ applyTo: "all", body: "full" }]);
    const result = resolveIngressHandoffSync(policy, {
      channelId: "C123",
      classification: "shared_external",
    });
    expect(result.classification).toBe("shared_external");
  });

  test("handles empty channelIds array", () => {
    const policy = makePolicy([
      { applyTo: "channels", channelIds: [], body: "none" },
      { applyTo: "all", body: "full" },
    ]);
    const result = resolveIngressHandoffSync(policy, {
      channelId: "C123",
      classification: "internal",
    });
    expect(result.rule.body).toBe("full");
    expect(result.matchedApplyTo).toBe("all");
  });
});

describe("extractSealithIntent", () => {
  test("sealith=off", () => {
    const rule: IngressHandoffRule = {
      ...DEFAULT_RULE,
      sealith: "off",
    };
    const intent = extractSealithIntent(rule);
    expect(intent.mode).toBe("off");
    expect(intent.required).toBe(false);
  });

  test("sealith=suggest", () => {
    const rule: IngressHandoffRule = {
      ...DEFAULT_RULE,
      sealith: "suggest",
    };
    const intent = extractSealithIntent(rule);
    expect(intent.mode).toBe("suggest");
    expect(intent.required).toBe(false);
  });

  test("sealith=required with hints", () => {
    const rule: IngressHandoffRule = {
      ...DEFAULT_RULE,
      sealith: "required",
      sealithRequiredHints: ["contract", "nda"],
      sealithRequiredOtherText: "秘密保持契約",
    };
    const intent = extractSealithIntent(rule);
    expect(intent.mode).toBe("required");
    expect(intent.required).toBe(true);
    expect(intent.hints).toEqual(["contract", "nda"]);
    expect(intent.otherText).toBe("秘密保持契約");
  });
});
