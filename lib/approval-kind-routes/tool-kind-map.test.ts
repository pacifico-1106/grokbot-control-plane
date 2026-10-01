/**
 * P1 Approval Kind Routes — Tool Kind Map Tests
 *
 * Verifies the fixed tool→kind mapping cannot be bypassed.
 */
import { describe, expect, test } from "bun:test";
import {
  getToolApprovalKind,
  isAccountKindTool,
  getToolsForKind,
  TOOL_KIND_MAP,
} from "./tool-kind-map";

describe("getToolApprovalKind", () => {
  describe("post kind tools", () => {
    test("slack.post → post", () => {
      expect(getToolApprovalKind("slack.post")).toBe("post");
    });

    test("comm.reply → post", () => {
      expect(getToolApprovalKind("comm.reply")).toBe("post");
    });

    test("comm.send → post", () => {
      expect(getToolApprovalKind("comm.send")).toBe("post");
    });

    test("sns.publish → post", () => {
      expect(getToolApprovalKind("sns.publish")).toBe("post");
    });
  });

  describe("mail kind tools", () => {
    test("mail.send → mail", () => {
      expect(getToolApprovalKind("mail.send")).toBe("mail");
    });

    test("mail.draft → mail", () => {
      expect(getToolApprovalKind("mail.draft")).toBe("mail");
    });
  });

  describe("account kind tools", () => {
    test("employees.issue → account", () => {
      expect(getToolApprovalKind("employees.issue")).toBe("account");
    });

    test("link → account", () => {
      expect(getToolApprovalKind("link")).toBe("account");
    });

    test("policy.patch → account", () => {
      expect(getToolApprovalKind("policy.patch")).toBe("account");
    });

    test("parties.upsert → account", () => {
      expect(getToolApprovalKind("parties.upsert")).toBe("account");
    });

    test("channels.classify → account", () => {
      expect(getToolApprovalKind("channels.classify")).toBe("account");
    });

    test("orgs.create → account", () => {
      expect(getToolApprovalKind("orgs.create")).toBe("account");
    });

    test("approvalRoutes.patch → account", () => {
      expect(getToolApprovalKind("approvalRoutes.patch")).toBe("account");
    });
  });

  describe("account kind prefix detection", () => {
    test("admin.* → account", () => {
      expect(getToolApprovalKind("admin.hire")).toBe("account");
      expect(getToolApprovalKind("admin.unknown")).toBe("account");
    });

    test("setup.* → account", () => {
      expect(getToolApprovalKind("setup.newTool")).toBe("account");
    });

    test("orgs.* → account", () => {
      expect(getToolApprovalKind("orgs.newAction")).toBe("account");
    });

    test("approvalWorkflow.* → account", () => {
      expect(getToolApprovalKind("approvalWorkflow.patch")).toBe("account");
      expect(getToolApprovalKind("approvalWorkflow.newAction")).toBe("account");
    });

    test("approvalRoutes.* → account", () => {
      expect(getToolApprovalKind("approvalRoutes.patch")).toBe("account");
      expect(getToolApprovalKind("approvalRoutes.newAction")).toBe("account");
    });
  });

  describe("decision kind tools", () => {
    test("decision.request → decision", () => {
      expect(getToolApprovalKind("decision.request")).toBe("decision");
    });
  });

  describe("other (unmapped) tools", () => {
    test("unknown tool → other", () => {
      expect(getToolApprovalKind("unknown.tool")).toBe("other");
    });

    test("empty string → other", () => {
      expect(getToolApprovalKind("")).toBe("other");
    });

    test("null → other", () => {
      expect(getToolApprovalKind(null)).toBe("other");
    });

    test("undefined → other", () => {
      expect(getToolApprovalKind(undefined)).toBe("other");
    });
  });

  describe("security: mapping is immutable", () => {
    test("TOOL_KIND_MAP is frozen", () => {
      expect(Object.isFrozen(TOOL_KIND_MAP)).toBe(true);
    });

    test("cannot modify mapping", () => {
      expect(() => {
        (TOOL_KIND_MAP as Record<string, string>)["slack.post"] = "other";
      }).toThrow();
    });
  });
});

describe("isAccountKindTool", () => {
  test("returns true for account tools", () => {
    expect(isAccountKindTool("employees.issue")).toBe(true);
    expect(isAccountKindTool("link")).toBe(true);
    expect(isAccountKindTool("policy.patch")).toBe(true);
    expect(isAccountKindTool("admin.hire")).toBe(true);
  });

  test("returns false for non-account tools", () => {
    expect(isAccountKindTool("slack.post")).toBe(false);
    expect(isAccountKindTool("mail.send")).toBe(false);
    expect(isAccountKindTool("decision.request")).toBe(false);
    expect(isAccountKindTool("unknown")).toBe(false);
  });
});

describe("getToolsForKind", () => {
  test("returns all post tools", () => {
    const tools = getToolsForKind("post");
    expect(tools).toContain("slack.post");
    expect(tools).toContain("comm.reply");
    expect(tools).toContain("comm.send");
    expect(tools).toContain("sns.publish");
  });

  test("returns all mail tools", () => {
    const tools = getToolsForKind("mail");
    expect(tools).toContain("mail.send");
    expect(tools).toContain("mail.draft");
  });

  test("returns account tools from explicit map", () => {
    const tools = getToolsForKind("account");
    expect(tools).toContain("employees.issue");
    expect(tools).toContain("link");
    expect(tools).toContain("policy.patch");
  });

  test("returns decision tools", () => {
    const tools = getToolsForKind("decision");
    expect(tools).toContain("decision.request");
  });

  test("returns empty for other (unmapped)", () => {
    const tools = getToolsForKind("other");
    expect(tools).toEqual([]);
  });
});
