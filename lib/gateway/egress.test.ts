import { describe, expect, test } from "bun:test";
import { evaluateEgressMatrix } from "@/lib/gateway/egress";
import { resolveInformationDisclosure } from "@/lib/gateway/information-class";
import { DEMO_ORG } from "@/lib/demo-data";

describe("egress matrix", () => {
  test("external × public → allow", () => {
    expect(
      evaluateEgressMatrix({
        audience: "external",
        informationClass: "public",
        fidelity: "source",
        namedRecipients: true,
      }).decision
    ).toBe("allow");
  });

  test("external × internal + summary → summarize; source → deny", () => {
    expect(
      evaluateEgressMatrix({
        audience: "external",
        informationClass: "internal",
        fidelity: "summary",
        namedRecipients: false,
      }).decision
    ).toBe("summarize");
    expect(
      evaluateEgressMatrix({
        audience: "external",
        informationClass: "internal",
        fidelity: "source",
        namedRecipients: false,
      }).decision
    ).toBe("deny");
  });

  test("external × confidential or verbatim → deny", () => {
    expect(
      evaluateEgressMatrix({
        audience: "unknown",
        informationClass: "confidential",
        fidelity: "summary",
        namedRecipients: false,
      }).decision
    ).toBe("deny");
    expect(
      evaluateEgressMatrix({
        audience: "external",
        informationClass: "verbatim",
        fidelity: "source",
        namedRecipients: true,
      }).decision
    ).toBe("deny");
  });

  test("internal × public or internal summary → allow", () => {
    expect(
      evaluateEgressMatrix({
        audience: "internal",
        informationClass: "public",
        fidelity: "source",
        namedRecipients: false,
      }).decision
    ).toBe("allow");
    expect(
      evaluateEgressMatrix({
        audience: "internal",
        informationClass: "internal",
        fidelity: "summary",
        namedRecipients: false,
      }).decision
    ).toBe("allow");
  });

  test("internal × confidential summary → needs_approval", () => {
    expect(
      evaluateEgressMatrix({
        audience: "internal",
        informationClass: "confidential",
        fidelity: "summary",
        namedRecipients: false,
      }).decision
    ).toBe("needs_approval");
  });

  test("internal × verbatim unnamed deny; named needs_approval", () => {
    expect(
      evaluateEgressMatrix({
        audience: "internal",
        informationClass: "verbatim",
        fidelity: "source",
        namedRecipients: false,
      }).decision
    ).toBe("deny");
    expect(
      evaluateEgressMatrix({
        audience: "internal",
        informationClass: "verbatim",
        fidelity: "source",
        namedRecipients: true,
      }).decision
    ).toBe("needs_approval");
  });
});

describe("information class defaults", () => {
  test("unclassified asset → confidential", async () => {
    const result = await resolveInformationDisclosure({
      orgId: DEMO_ORG.id,
      tool: "knowledge.search",
      body: {
        tool: "knowledge.search",
        purpose: "knowledge.lookup",
        jobId: "job_asset",
        args: { assetRef: "kb/does-not-exist" },
      },
    });
    expect(result.informationClass).toBe("confidential");
  });

  test("tagged public asset is public", async () => {
    const result = await resolveInformationDisclosure({
      orgId: DEMO_ORG.id,
      tool: "knowledge.search",
      body: {
        tool: "knowledge.search",
        purpose: "knowledge.lookup",
        jobId: "job_faq",
        args: { assetRef: "kb/public-faq" },
      },
    });
    expect(result.informationClass).toBe("public");
  });

  test("claiming public cannot lower confidential default", async () => {
    const result = await resolveInformationDisclosure({
      orgId: DEMO_ORG.id,
      tool: "comm.send",
      body: {
        tool: "comm.send",
        purpose: "comm.internal",
        jobId: "job_claim",
        informationClass: "public",
        args: { informationClass: "public" },
      },
    });
    expect(result.informationClass).toBe("confidential");
  });

  test("calendar.read busy/free defaults to internal summary", async () => {
    const result = await resolveInformationDisclosure({
      orgId: DEMO_ORG.id,
      tool: "calendar.read",
      body: { tool: "calendar.read", purpose: "comm.internal", jobId: "job_cal" },
    });
    expect(result.informationClass).toBe("internal");
    expect(result.fidelity).toBe("summary");
  });

  test("comm.reply / slack.post to internal default to internal summary", async () => {
    for (const tool of ["comm.reply", "slack.post"] as const) {
      const result = await resolveInformationDisclosure({
        orgId: DEMO_ORG.id,
        tool,
        audience: "internal",
        body: { tool, purpose: "comm.internal", jobId: `job_${tool}` },
      });
      expect(result.informationClass).toBe("internal");
      expect(result.fidelity).toBe("summary");
    }
  });

  test("comm.reply to external or unknown stays confidential source", async () => {
    for (const audience of ["external", "unknown"] as const) {
      const result = await resolveInformationDisclosure({
        orgId: DEMO_ORG.id,
        tool: "comm.reply",
        audience,
        body: { tool: "comm.reply", purpose: "comm.internal", jobId: "job_ext" },
      });
      expect(result.informationClass).toBe("confidential");
      expect(result.fidelity).toBe("source");
    }
  });

  test("mail.send / calendar.confirm / commerce.order stay confidential even internally", async () => {
    for (const tool of ["mail.send", "calendar.confirm", "commerce.order"] as const) {
      const result = await resolveInformationDisclosure({
        orgId: DEMO_ORG.id,
        tool,
        audience: "internal",
        body: { tool, purpose: "ops.admin", jobId: `job_${tool}` },
      });
      expect(result.informationClass).toBe("confidential");
      expect(result.fidelity).toBe("source");
    }
  });

  test("explicit confidential still raises the internal default", async () => {
    const result = await resolveInformationDisclosure({
      orgId: DEMO_ORG.id,
      tool: "comm.reply",
      audience: "internal",
      body: {
        tool: "comm.reply",
        purpose: "comm.internal",
        jobId: "job_raise",
        informationClass: "confidential",
      },
    });
    expect(result.informationClass).toBe("confidential");
  });
});
