/**
 * Successful badge resolve must touch credentials.last_used_at.
 * Failures (missing / invalid / expired) must not.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";
import { DEMO_ORG } from "@/lib/demo-data";
import { fingerprintSecret } from "@/lib/bindings";
import { rotateCredential } from "@/lib/data";

const touches: string[] = [];
const mocks = scopedModuleMocks();
await mocks.mock("@/lib/data/credential-last-used", {
  touchCredentialLastUsed: async (id: string | null | undefined) => {
    if (id) touches.push(id);
  },
});

const { resolveEmployeeCredential } = await import("./employee-credential");

const SECRET = `gb_emp_lastused_${"x".repeat(24)}`;
const EMP = "emp_sales";

beforeEach(() => {
  touches.length = 0;
});
afterEach(() => {
  touches.length = 0;
});

function req(headers: Record<string, string> = {}) {
  return new Request("https://staffpass.test/api/mcp", { headers });
}

describe("resolveEmployeeCredential touches last_used_at only on success", () => {
  test("valid badge → touchCredentialLastUsed(credentialId)", async () => {
    await rotateCredential(EMP, DEMO_ORG.id, fingerprintSecret(SECRET));
    const r = await resolveEmployeeCredential(req({ authorization: `Bearer ${SECRET}` }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(touches).toEqual([r.credential.credentialId!]);
  });

  test("missing credential → no touch", async () => {
    const r = await resolveEmployeeCredential(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_credential");
    expect(touches).toEqual([]);
  });

  test("empty Bearer / empty x-staffpass-credential → missing_credential, no touch", async () => {
    const a = await resolveEmployeeCredential(req({ authorization: "Bearer " }));
    const b = await resolveEmployeeCredential(req({ "x-staffpass-credential": "   " }));
    expect(a.ok === false && a.code).toBe("missing_credential");
    expect(b.ok === false && b.code).toBe("missing_credential");
    expect(touches).toEqual([]);
  });

  test("unknown gb_emp_ secret → invalid_credential, no touch", async () => {
    const r = await resolveEmployeeCredential(
      req({ authorization: "Bearer gb_emp_not_a_real_secret_0123456789abcdef" })
    );
    expect(r.ok === false && r.code).toBe("invalid_credential");
    expect(touches).toEqual([]);
  });
});
