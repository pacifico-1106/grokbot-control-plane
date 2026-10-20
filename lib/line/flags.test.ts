import { afterEach, describe, expect, test } from "bun:test";
import {
  isLineApproverBindingMatchEnabled,
  isLineApproverLinkEnabled,
  isLineResolveFollowupReplyEnabled,
  isLineWorkflowRevisionReplyEnabled,
} from "@/lib/line/flags";

const KEYS = [
  "LINE_APPROVER_LINK_ENABLED",
  "LINE_APPROVER_BINDING_MATCH",
  "LINE_WORKFLOW_REVISION_REPLY",
  "LINE_RESOLVE_FOLLOWUP_REPLY",
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("LINE approval flags (default OFF)", () => {
  test("unset → OFF", () => {
    for (const k of KEYS) delete process.env[k];
    expect(isLineApproverLinkEnabled()).toBe(false);
    expect(isLineApproverBindingMatchEnabled()).toBe(false);
    expect(isLineWorkflowRevisionReplyEnabled()).toBe(false);
    expect(isLineResolveFollowupReplyEnabled()).toBe(false);
  });

  test("only explicit truthy values turn them ON", () => {
    for (const v of ["", "0", "false", "off", "no", "yes please"]) {
      for (const k of KEYS) process.env[k] = v;
      expect(isLineApproverLinkEnabled()).toBe(false);
      expect(isLineApproverBindingMatchEnabled()).toBe(false);
      expect(isLineWorkflowRevisionReplyEnabled()).toBe(false);
      expect(isLineResolveFollowupReplyEnabled()).toBe(false);
    }
    for (const v of ["true", "1", "on", "TRUE"]) {
      process.env.LINE_APPROVER_LINK_ENABLED = v;
      expect(isLineApproverLinkEnabled()).toBe(true);
    }
  });
});
