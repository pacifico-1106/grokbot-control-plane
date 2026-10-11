import { afterEach, describe, expect, mock, test } from "bun:test";

/**
 * lp_page is written to lp_inquiries / lp_journeys only with LP_LEAD_PAGE_DB_ENABLED ON
 * (the column arrives with migration 20261012300000; code deployed first must not
 * write an unknown column). Values are re-checked against the allowlist on write and read.
 */
const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
let returnRow: Record<string, unknown> = {};
function builder(table: string) {
  const b: Record<string, unknown> = {};
  b.insert = (row: Record<string, unknown>) => {
    inserts.push({ table, row });
    return b;
  };
  b.select = () => b;
  b.eq = () => b;
  b.gt = () => b;
  b.single = async () => ({ data: { id: "row_1", created_at: "2026-10-12T00:00:00Z", expires_at: "2026-10-13T00:00:00Z", retention_until: "x", ...returnRow }, error: null });
  b.maybeSingle = b.single;
  return b;
}
mock.module("@/lib/supabase", () => ({ createSupabaseAdminClient: () => ({ from: (t: string) => builder(t) }) }));

const ENV = ["LP_INQUIRY_DB_ENABLED", "LP_LEAD_PAGE_DB_ENABLED", "LP_CHAT_ENABLED"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  inserts.length = 0;
  returnRow = {};
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const { createInquiry } = await import("@/lib/lp/inquiry-data");
const { createJourney } = await import("@/lib/lp/journeys");

const inquiry = { source: "form" as const, plan: "intern" as const, billingPreference: "monthly" as const, company: "c", contactName: "n", email: "e@example.jp", useCase: "use case", consentGiven: true };

describe("lp_inquiries.lp_page", () => {
  test("flag OFF: insert has no lp_page key (safe before the migration)", async () => {
    process.env.LP_INQUIRY_DB_ENABLED = "true";
    await createInquiry({ ...inquiry, lpPage: "ai-employee-corp" });
    expect(inserts[0].table).toBe("lp_inquiries");
    expect("lp_page" in inserts[0].row).toBe(false);
  });
  test("flag ON: lp_page written from the allowlist; tampered → ai-employee", async () => {
    process.env.LP_INQUIRY_DB_ENABLED = "true";
    process.env.LP_LEAD_PAGE_DB_ENABLED = "true";
    await createInquiry({ ...inquiry, lpPage: "ai-employee-corp" });
    expect(inserts[0].row.lp_page).toBe("ai-employee-corp");
    await createInquiry({ ...inquiry, lpPage: "evil" as never });
    expect(inserts[1].row.lp_page).toBe("ai-employee");
  });
});

describe("lp_journeys.lp_page", () => {
  const j = { tokenHash: "h", aiDisclosureAccepted: true, privacyVersion: "2026-10" };
  test("flag OFF: no lp_page key", async () => {
    process.env.LP_CHAT_ENABLED = "true";
    await createJourney({ ...j, lpPage: "ai-employee-corp" });
    const row = inserts.find((i) => i.table === "lp_journeys")!.row;
    expect("lp_page" in row).toBe(false);
  });
  test("flag ON: lp_page written; read back through the allowlist (unknown DB value → null)", async () => {
    process.env.LP_CHAT_ENABLED = "true";
    process.env.LP_LEAD_PAGE_DB_ENABLED = "true";
    returnRow = { lp_page: "ai-employee-corp" };
    const created = await createJourney({ ...j, lpPage: "ai-employee-corp" });
    expect(inserts.find((i) => i.table === "lp_journeys")!.row.lp_page).toBe("ai-employee-corp");
    expect(created?.lpPage).toBe("ai-employee-corp");
    inserts.length = 0;
    returnRow = { lp_page: "tampered" };
    expect((await createJourney({ ...j, lpPage: "nope" as never }))?.lpPage).toBeNull();
    expect(inserts.find((i) => i.table === "lp_journeys")!.row.lp_page).toBe("ai-employee");
  });
});
