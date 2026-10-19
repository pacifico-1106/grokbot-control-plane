/**
 * APPROVAL_MAIL_SUBJECT_NO_SUMMARY_ENABLED (default OFF).
 * When ON: approval mail subject is fixed text + kind + short id.
 * Summary stays in the escaped body only. When OFF: today's subjects.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isApprovalMailSubjectNoSummaryEnabled } from "@/lib/feature-flags";
import {
  approvalNeededTemplate,
  approvalResolvedTemplate,
} from "./index";

const FLAG = "APPROVAL_MAIL_SUBJECT_NO_SUMMARY_ENABLED";
const saved = process.env[FLAG];
beforeEach(() => delete process.env[FLAG]);
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

const SUMMARY = "極秘: 取引先A社へ 980万円 の発注 <a href=\"https://evil.example\">x</a>";
const META = { kind: "mail.send", id: "apr_9f3c2a1b" };

describe("APPROVAL_MAIL_SUBJECT_NO_SUMMARY_ENABLED flag", () => {
  test("defaults OFF", () => {
    expect(isApprovalMailSubjectNoSummaryEnabled()).toBe(false);
  });
  test("accepts true/1/on/enabled", () => {
    process.env[FLAG] = "true";
    expect(isApprovalMailSubjectNoSummaryEnabled()).toBe(true);
    process.env[FLAG] = "1";
    expect(isApprovalMailSubjectNoSummaryEnabled()).toBe(true);
    process.env[FLAG] = "on";
    expect(isApprovalMailSubjectNoSummaryEnabled()).toBe(true);
    process.env[FLAG] = "enabled";
    expect(isApprovalMailSubjectNoSummaryEnabled()).toBe(true);
  });
});

describe("flag OFF: today's subjects", () => {
  test("needed subject is 定型+risk; summary is not required in subject today", () => {
    const t = approvalNeededTemplate(SUMMARY, "high", META);
    expect(t.subject).toBe("[要対応] AI社員の承認リクエスト（high）");
    expect(t.html).toContain("極秘");
    expect(t.html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
  });
  test("resolved subject is 定型+結果", () => {
    const t = approvalResolvedTemplate(SUMMARY, "approved", META);
    expect(t.subject).toBe("[AI社員] 承認が解決されました（承認済み）");
    expect(t.html).toContain("極秘");
  });
});

describe("flag ON: fixed + kind + short id; summary only in body", () => {
  beforeEach(() => {
    process.env[FLAG] = "true";
  });

  test("needed subject has no summary", () => {
    const t = approvalNeededTemplate(SUMMARY, "high", META);
    expect(t.subject).toBe("[Staffpass] 承認リクエスト mail.send apr_9f3c");
    expect(t.subject).not.toContain("極秘");
    expect(t.subject).not.toContain("980");
    expect(t.subject).not.toContain("evil");
    expect(t.html).toContain("極秘: 取引先A社へ 980万円");
    expect(t.html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
    expect(t.html).not.toContain(`<a href="https://evil.example"`);
  });

  test("resolved subject has no summary", () => {
    const t = approvalResolvedTemplate(SUMMARY, "approved", META);
    expect(t.subject).toBe("[Staffpass] 承認結果 mail.send apr_9f3c");
    expect(t.subject).not.toContain("極秘");
    expect(t.subject).not.toContain("承認済み");
    expect(t.html).toContain("承認済み");
    expect(t.html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
  });

  test("kind and id are sanitized; missing meta uses safe fallbacks", () => {
    const dirty = {
      kind: "mail.send\r\nBcc: x@evil.example<script>",
      id: "<img src=x>",
    };
    const t = approvalNeededTemplate(SUMMARY, dirty.kind, dirty);
    expect(t.subject).toMatch(/^\[Staffpass\] 承認リクエスト [a-z0-9._-]+ [A-Za-z0-9_-]+$/);
    expect(t.subject).not.toContain("Bcc");
    expect(t.subject).not.toContain("<");
    expect(t.subject).not.toMatch(/[\r\n]/);
    const fallback = approvalNeededTemplate(SUMMARY, "high");
    expect(fallback.subject).toBe("[Staffpass] 承認リクエスト ticket unknown");
  });
});
