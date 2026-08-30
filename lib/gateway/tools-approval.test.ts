import { describe, expect, test } from "bun:test";
import { GATEWAY_TOOL_DEFS, toolRequiresHumanApproval } from "./tools";

describe("toolRequiresHumanApproval", () => {
  test("mail.send / calendar.confirm default to human; comm.reply never forced by sibling scopes", () => {
    expect(toolRequiresHumanApproval(GATEWAY_TOOL_DEFS["mail.send"])).toBe(true);
    expect(toolRequiresHumanApproval(GATEWAY_TOOL_DEFS["calendar.confirm"])).toBe(true);
    expect(toolRequiresHumanApproval(GATEWAY_TOOL_DEFS["comm.reply"])).toBe(false);
    expect(toolRequiresHumanApproval(GATEWAY_TOOL_DEFS["slack.post"])).toBe(false);
  });

  test("operator can loosen send/confirm to risk_based or auto", () => {
    expect(
      toolRequiresHumanApproval(GATEWAY_TOOL_DEFS["mail.send"], {
        "mail.send": "risk_based",
      })
    ).toBe(false);
    expect(
      toolRequiresHumanApproval(GATEWAY_TOOL_DEFS["calendar.confirm"], {
        "calendar.confirm": "auto",
      })
    ).toBe(false);
    expect(
      toolRequiresHumanApproval(GATEWAY_TOOL_DEFS["mail.send"], {
        "mail.send": "always_human",
      })
    ).toBe(true);
  });
});

describe("choosable money / destructive / browser hints", () => {
  test("commerce.order / files.write / browser.use default to human", () => {
    expect(toolRequiresHumanApproval(GATEWAY_TOOL_DEFS["commerce.order"])).toBe(true);
    expect(toolRequiresHumanApproval(GATEWAY_TOOL_DEFS["files.write"])).toBe(true);
    expect(toolRequiresHumanApproval(GATEWAY_TOOL_DEFS["browser.use"])).toBe(true);
    expect(toolRequiresHumanApproval(GATEWAY_TOOL_DEFS["drive.share_external"])).toBe(true);
  });

  test("operator can loosen order / write / browser to auto or risk_based", () => {
    expect(
      toolRequiresHumanApproval(GATEWAY_TOOL_DEFS["commerce.order"], {
        "commerce.order": "auto",
      })
    ).toBe(false);
    expect(
      toolRequiresHumanApproval(GATEWAY_TOOL_DEFS["files.write"], {
        "files.write": "risk_based",
      })
    ).toBe(false);
    expect(
      toolRequiresHumanApproval(GATEWAY_TOOL_DEFS["browser.use"], {
        "browser.use": "auto",
      })
    ).toBe(false);
    expect(
      toolRequiresHumanApproval(GATEWAY_TOOL_DEFS["commerce.order"], {
        "commerce.order": "always_human",
      })
    ).toBe(true);
  });
});
