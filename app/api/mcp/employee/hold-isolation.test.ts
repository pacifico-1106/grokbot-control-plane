/**
 * /api/mcp/employee must run the same G1 checkOperable + withHoldCallScope
 * (W1 wake / hold re-read) as /api/mcp, stay tenant-scoped, and never accept
 * another org's badge. Demo mode, real resolveEmployeeCredential (no mock).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";

const { DEMO_ORG } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");
const { rotateCredential, getEmployeeById } = await import("@/lib/data");
const { fingerprintSecret } = await import("@/lib/bindings");
const employee = await import("./route");
const shared = await import("../route");

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const OTHER = "emp_ops";
const SECRET = `gb_emp_emp_mouth_hold_${"a".repeat(20)}`;
const OTHER_SECRET = `gb_emp_emp_mouth_other_${"b".repeat(18)}`;
const HOLD_ID = "00000000-0000-4000-8000-00000000b388";
const ENV = ["MCP_EMPLOYEE_BADGE_MCP_ENABLED", "MCP_OAUTH_ENABLED"];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV) (saved[k] = process.env[k]), delete process.env[k];
  process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED = "1";
  hold.__setHoldReaderForTests(null);
  hold.demoSetEmployeeHold(EMP, null);
  hold.demoSetOrgHold(ORG, null);
  await rotateCredential(EMP, ORG, fingerprintSecret(SECRET));
  await rotateCredential(OTHER, DEMO_ORG.id, fingerprintSecret(OTHER_SECRET));
});
afterEach(() => {
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  hold.demoSetEmployeeHold(EMP, null);
  hold.demoSetOrgHold(ORG, null);
  hold.__setHoldReaderForTests(null);
});

const rpc = (
  route: { POST: (req: Request) => Promise<Response> },
  url: string,
  headers: Record<string, string> = {}
) =>
  route.POST(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
  );

const employeeList = (headers: Record<string, string>) =>
  rpc(employee, "https://staffpass.test/api/mcp/employee", headers);
const sharedList = (headers: Record<string, string>) =>
  rpc(shared, "https://staffpass.test/api/mcp", headers);

test("employee mouth: valid badge lists tools; held employee / org / unreadable match /api/mcp", async () => {
  expect((await employeeList({ authorization: `Bearer ${SECRET}` })).status).toBe(200);
  expect((await sharedList({ authorization: `Bearer ${SECRET}` })).status).toBe(200);

  hold.demoSetEmployeeHold(EMP, { kind: "stopped", holdId: HOLD_ID });
  const empHeld = await employeeList({ authorization: `Bearer ${SECRET}` });
  const sharedHeld = await sharedList({ authorization: `Bearer ${SECRET}` });
  expect(empHeld.status).toBe(403);
  expect(sharedHeld.status).toBe(403);
  expect(JSON.stringify(await empHeld.json())).toContain("employee_on_hold");
  expect(empHeld.headers.get("www-authenticate")).toBeNull();

  hold.demoSetEmployeeHold(EMP, null);
  hold.demoSetOrgHold(ORG, { kind: "stopped", holdId: HOLD_ID });
  const empOrg = await employeeList({ authorization: `Bearer ${SECRET}` });
  expect(empOrg.status).toBe(403);
  expect(JSON.stringify(await empOrg.json())).toContain("org_on_hold");
  expect(empOrg.headers.get("www-authenticate")).toBeNull();

  hold.demoSetOrgHold(ORG, null);
  hold.__setHoldReaderForTests({
    employee: async () => {
      throw new Error("db");
    },
    org: async () => {
      throw new Error("db");
    },
  });
  const empDown = await employeeList({ authorization: `Bearer ${SECRET}` });
  const sharedDown = await sharedList({ authorization: `Bearer ${SECRET}` });
  expect(empDown.status).toBe(503);
  expect(sharedDown.status).toBe(503);
  expect(JSON.stringify(await empDown.json())).toContain("hold_state_unavailable");
});

test("employee mouth: another employee's badge cannot see this tenant's whoami", async () => {
  const sales = await getEmployeeById(EMP);
  const ops = await getEmployeeById(OTHER);
  expect(sales?.id).toBe(EMP);
  expect(ops?.id).toBe(OTHER);

  const res = await employee.POST(
    new Request("https://staffpass.test/api/mcp/employee", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${OTHER_SECRET}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "staffpass_whoami", arguments: {} },
      }),
    })
  );
  expect(res.status).toBe(200);
  const dumped = JSON.stringify(await res.json());
  expect(dumped).toContain(OTHER);
  expect(dumped).not.toContain(EMP);
  expect(dumped).not.toContain(SECRET);
});

test("flag OFF: employee mouth stay 404 even with a valid badge (shared /api/mcp unchanged)", async () => {
  delete process.env.MCP_EMPLOYEE_BADGE_MCP_ENABLED;
  expect((await employeeList({ authorization: `Bearer ${SECRET}` })).status).toBe(404);
  expect((await sharedList({ authorization: `Bearer ${SECRET}` })).status).toBe(200);
});
