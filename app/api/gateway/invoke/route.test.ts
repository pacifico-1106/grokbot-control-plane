import { beforeEach, expect, mock, test } from "bun:test";

/**
 * Regression: POST /api/gateway/invoke must not run a tool for an employee
 * identified only by x-employee-id / body.employeeId (no 社員証 secret).
 * Anyone who knows (or guesses) an employee id could otherwise act as it.
 */

const VALID_SECRET = "gb_emp_test_valid_fixture";
let invokeCalls: Array<{ employeeId: string; credentialId?: string | null }> = [];

mock.module("@/lib/auth/employee-credential", () => ({
  extractEmployeeSecret(req: Request): string | null {
    const headerCred = (req.headers.get("x-staffpass-credential") || "").trim();
    if (headerCred) return headerCred;
    const m = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") || "").trim());
    return m?.[1]?.trim() || null;
  },
  async resolveEmployeeCredential(req: Request) {
    const raw =
      (req.headers.get("x-staffpass-credential") || "").trim() ||
      /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") || "").trim())?.[1]?.trim();
    if (raw === VALID_SECRET) {
      return {
        ok: true,
        credential: { employeeId: "emp_1", credentialId: "cred_1", orgId: "org_a" },
      };
    }
    return { ok: false, code: "invalid_credential", httpStatus: 401, message: "invalid" };
  },
}));
mock.module("@/lib/gateway/invoke", () => ({
  async runGatewayInvoke(input: { employeeId: string; credentialId?: string | null }) {
    invokeCalls.push({ employeeId: input.employeeId, credentialId: input.credentialId });
    return { httpStatus: 200, body: { ok: true } };
  },
}));

const { POST } = await import("./route");

function call(headers: Record<string, string>, body: Record<string, unknown>) {
  return POST(
    new Request("https://staffpass.test/api/gateway/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

const baseBody = { tool: "calendar.propose", purpose: "sales.outreach", jobId: "job_1" };

beforeEach(() => {
  invokeCalls = [];
});

test("x-employee-id without a credential is refused (fail-closed)", async () => {
  const res = await call({ "x-employee-id": "emp_1" }, baseBody);
  expect(res.status).toBe(401);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.code).toBe("credential_required");
  expect(res.headers.get("www-authenticate") || "").toContain("Bearer");
  expect(invokeCalls.length).toBe(0);
});

test("body.employeeId without a credential is refused (fail-closed)", async () => {
  const res = await call({}, { ...baseBody, employeeId: "emp_1" });
  expect(res.status).toBe(401);
  expect(invokeCalls.length).toBe(0);
});

test("no identity at all is refused", async () => {
  const res = await call({}, baseBody);
  expect(res.status).toBe(401);
  expect(invokeCalls.length).toBe(0);
});

test("invalid credential is refused", async () => {
  const res = await call({ authorization: "Bearer gb_emp_wrong" }, baseBody);
  expect(res.status).toBe(401);
  expect(invokeCalls.length).toBe(0);
});

test("valid Bearer credential still works and binds identity from the credential", async () => {
  const res = await call({ authorization: `Bearer ${VALID_SECRET}` }, baseBody);
  expect(res.status).toBe(200);
  expect(invokeCalls).toEqual([{ employeeId: "emp_1", credentialId: "cred_1" }]);
});

test("valid x-staffpass-credential header still works", async () => {
  const res = await call({ "x-staffpass-credential": VALID_SECRET }, baseBody);
  expect(res.status).toBe(200);
  expect(invokeCalls.length).toBe(1);
});

test("valid credential + matching x-employee-id is accepted (legacy bots send both)", async () => {
  const res = await call(
    { authorization: `Bearer ${VALID_SECRET}`, "x-employee-id": "emp_1" },
    { ...baseBody, employeeId: "emp_1" }
  );
  expect(res.status).toBe(200);
  expect(invokeCalls.length).toBe(1);
});

test("valid credential + mismatched x-employee-id / body.employeeId is refused", async () => {
  const r1 = await call(
    { authorization: `Bearer ${VALID_SECRET}`, "x-employee-id": "emp_other" },
    baseBody
  );
  expect(r1.status).toBe(403);
  const r2 = await call(
    { authorization: `Bearer ${VALID_SECRET}` },
    { ...baseBody, employeeId: "emp_other" }
  );
  expect(r2.status).toBe(403);
  expect(invokeCalls.length).toBe(0);
});
