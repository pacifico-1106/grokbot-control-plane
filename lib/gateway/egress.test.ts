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

  test("calendar.read busy/free defaults to internal summary", async () => {
    const result = await resolveInformationDisclosure({
      orgId: DEMO_ORG.id,
      tool: "calendar.read",
      body: { tool: "calendar.read", purpose: "comm.internal", jobId: "job_cal" },
    });
    expect(result.informationClass).toBe("internal");
    expect(result.fidelity).toBe("summary");
  });
});
