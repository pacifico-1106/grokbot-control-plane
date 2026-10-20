/**
 * Empty-reason 「解除を申請」: disable the button and show 理由を入力してください.
 * TOKYO307 ORG_HOLD retest: 八坂さんが空欄のまま押して何も起きなかった。
 *
 * Stop reason stays optional. Release reason is required (server 400 + UI gate).
 * Employee / org / leave all render the same HoldPanel — keep that one form aligned.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const HINT = "理由を入力してください";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-holdrr";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkTsx(p, out);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function requiredReasonForms(): Array<{ path: string; text: string }> {
  return ["components", "app"].flatMap((d) => walkTsx(join(ROOT, d)))
    .map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, "utf8") }))
    .filter((f) =>
      f.text.includes("/api/holds/release/request") ||
      /placeholder="[^"]*理由（必須）"/.test(f.text) ||
      f.text.includes(">解除を申請<"),
    );
}

describe("hasRequiredReason", () => {
  test("blank and whitespace are not a reason; a real string is", async () => {
    const { hasRequiredReason } = await import("@/lib/safety/required-reason");
    expect(hasRequiredReason("")).toBe(false);
    expect(hasRequiredReason("   ")).toBe(false);
    expect(hasRequiredReason("\n\t")).toBe(false);
    expect(hasRequiredReason(null)).toBe(false);
    expect(hasRequiredReason(undefined)).toBe(false);
    expect(hasRequiredReason("誤停止")).toBe(true);
    expect(hasRequiredReason(" 確認済み ")).toBe(true);
  });
  test("the hint copy is the one 八坂さん needed on the empty-reason button", async () => {
    const { REQUIRED_REASON_HINT_JA } = await import("@/lib/safety/required-reason");
    expect(REQUIRED_REASON_HINT_JA).toBe(HINT);
  });
});

describe("required-reason hold forms stay aligned (employee / org / leave)", () => {
  test("HoldPanel is the one required-reason form, used on /app and the employee page", () => {
    const forms = requiredReasonForms();
    expect(forms.map((f) => f.path)).toEqual(["components/holds/HoldPanel.tsx"]);
    const app = readFileSync(join(ROOT, "app/app/page.tsx"), "utf8");
    const employee = readFileSync(join(ROOT, "app/app/employees/[id]/page.tsx"), "utf8");
    expect(app).toContain('<HoldPanel scope="org" />');
    expect(employee).toContain("<HoldPanel employeeId={employee.id} />");
  });

  test("every required-reason form uses RequiredReasonSubmit (hint + disabled until hasRequiredReason)", () => {
    for (const f of requiredReasonForms()) {
      expect(f.text).toContain("RequiredReasonSubmit");
      expect(f.text).toContain('placeholder="解除の理由（必須）"');
    }
    const submit = readFileSync(join(ROOT, "components/holds/RequiredReasonSubmit.tsx"), "utf8");
    expect(submit).toContain("hasRequiredReason");
    expect(submit).toContain("REQUIRED_REASON_HINT_JA");
    expect(submit).toMatch(/disabled=\{busy \|\| !hasRequiredReason\(reason\)\}/);
  });

  test("stop reason stays optional (do not gate 緊急停止 on a reason)", () => {
    const src = readFileSync(join(ROOT, "components/holds/HoldPanel.tsx"), "utf8");
    expect(src).toContain('placeholder="理由（任意・社内向け）"');
    expect(src).toContain('className="btn btn-danger" disabled={busy}');
    expect(src).toContain('post("/api/holds/stop"');
  });
});

describe("RequiredReasonSubmit empty reason", () => {
  test("blank / whitespace → button disabled and 理由を入力してください; filled → enabled, no hint", async () => {
    const { RequiredReasonSubmit } = await import("@/components/holds/RequiredReasonSubmit");
    const render = (reason: string) =>
      renderToStaticMarkup(
        createElement(RequiredReasonSubmit, {
          reason,
          onReasonChange: () => undefined,
          placeholder: "解除の理由（必須）",
          submitLabel: "解除を申請",
          busy: false,
          onSubmit: () => undefined,
        }),
      );
    const empty = render("");
    expect(empty).toContain(HINT);
    expect(empty).toMatch(/<button[^>]*disabled[^>]*>解除を申請/);
    const spaces = render("   ");
    expect(spaces).toContain(HINT);
    expect(spaces).toMatch(/<button[^>]*disabled[^>]*>解除を申請/);
    const filled = render("誤停止");
    expect(filled).not.toContain(HINT);
    expect(filled).not.toMatch(/<button[^>]*disabled[^>]*>解除を申請/);
    expect(filled).toContain("解除を申請");
  });
});

const { DEMO_ORG } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");
const store = await import("@/lib/safety/hold-store");
const notify = await import("@/lib/safety/hold-notify");

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
let savedFlags: Record<string, string | undefined> = {};
beforeEach(() => {
  savedFlags = { E: process.env.EMPLOYEE_HOLD_ENABLED, O: process.env.ORG_HOLD_ENABLED };
  process.env.EMPLOYEE_HOLD_ENABLED = "true";
  process.env.ORG_HOLD_ENABLED = "true";
  notify.__setHoldNotifierForTests({ tenant: async () => undefined, ops: async () => undefined });
  store.__resetDemoHoldsForTests();
});
afterEach(() => {
  if (savedFlags.E === undefined) delete process.env.EMPLOYEE_HOLD_ENABLED;
  else process.env.EMPLOYEE_HOLD_ENABLED = savedFlags.E;
  if (savedFlags.O === undefined) delete process.env.ORG_HOLD_ENABLED;
  else process.env.ORG_HOLD_ENABLED = savedFlags.O;
  notify.__setHoldNotifierForTests(null);
  store.__resetDemoHoldsForTests();
});

describe("POST /api/holds/release/request empty reason → 400", () => {
  const web = async (path: string, member: string, body: Record<string, unknown>) => {
    const mod = await import(path);
    const res: Response = await mod.POST(new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost", "x-member-id": member },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  test("missing / blank / whitespace / non-string reason is 400 release_reason_required; hold stays on", async () => {
    const stop = await web("@/app/api/holds/stop/route", "mem_1", { employeeId: EMP, reason: "様子がおかしい" });
    expect(stop.status).toBe(200);
    const holdId = String(stop.body.holdId);
    const cases: Record<string, unknown>[] = [
      { holdId },
      { holdId, reason: "" },
      { holdId, reason: "   " },
      { holdId, reason: "\n" },
      { holdId, reason: 1 },
      { holdId, reason: null },
    ];
    for (const body of cases) {
      const reqd = await web("@/app/api/holds/release/request/route", "mem_2", body);
      expect(reqd).toMatchObject({ status: 400, body: { ok: false, error: "release_reason_required" } });
    }
    expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" })).ok).toBe(false);
  });
});
