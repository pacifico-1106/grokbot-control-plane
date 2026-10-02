import { describe, expect, test } from "bun:test";
import { escapeHtml, sanitizeEmailSubject, EMAIL_SUBJECT_MAX } from "./html-escape";
import {
  approvalNeededTemplate,
  approvalResolvedTemplate,
  trialEndingTemplate,
  trialStartedTemplate,
  welcomeTemplate,
} from "./email-templates";
import { renderStubHtml } from "./resend";

const XSS = `<a href="https://evil.example">click</a><img src=x onerror=alert(1)>'&`;

describe("escapeHtml / sanitizeEmailSubject", () => {
  test("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(3)).toBe("3");
  });
  test("subject is single-line and bounded", () => {
    expect(sanitizeEmailSubject("a\r\nBcc: x@example.com")).toBe("a Bcc: x@example.com");
    expect(sanitizeEmailSubject("x".repeat(500)).length).toBe(EMAIL_SUBJECT_MAX);
  });
});

describe("email templates never emit user-controlled HTML", () => {
  const cases: Array<[string, string]> = [
    ["welcome", welcomeTemplate(XSS).html],
    ["trial_ending", trialEndingTemplate(XSS, 3).html],
    ["approval_needed", approvalNeededTemplate(XSS, XSS).html],
    ["approval_resolved", approvalResolvedTemplate(XSS, XSS).html],
    ["stub title", renderStubHtml(XSS, "<p>ok</p>")],
  ];
  for (const [name, html] of cases) {
    test(name, () => {
      expect(html).not.toContain("<a href=\"https://evil.example\"");
      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
    });
  }
  test("trial started coerces to number", () => {
    expect(trialStartedTemplate(14).html).toContain("14日間");
  });
});
