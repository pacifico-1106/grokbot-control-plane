import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetDemoAiPeerWake } from "@/lib/data/ai-peer-wake";
import { GET, POST, DELETE } from "./route";

const savedAllow = process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED;
const savedGuard = process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED;

function req(method: string, body?: Record<string, unknown>, url = "https://staffpass.test/api/settings/ai-peer-wake") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", "x-member-id": "mem_1" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  resetDemoAiPeerWake();
  delete process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED;
  delete process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED;
});

afterEach(() => {
  resetDemoAiPeerWake();
  if (savedAllow === undefined) delete process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED;
  else process.env.AI_PEER_WAKE_ALLOWLIST_ENABLED = savedAllow;
  if (savedGuard === undefined) delete process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED;
  else process.env.AI_PEER_WAKE_THREAD_GUARD_ENABLED = savedGuard;
});

describe("GET/POST /api/settings/ai-peer-wake", () => {
  test("GET returns flags, empty allowlist, and employees of this org", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.flags.allowlist).toBe(false);
    expect(body.flags.threadGuard).toBe(false);
    expect(body.flags.cap).toBe(4);
    expect(Array.isArray(body.allowlist)).toBe(true);
    expect(body.employees.some((e: { id: string }) => e.id === "emp_comm")).toBe(true);
  });

  test("POST allowlist then DELETE is org-scoped to the session", async () => {
    const created = await POST(req("POST", {
      action: "allowlist",
      fromEmployeeId: "emp_comm",
      toEmployeeId: "emp_sns",
    }));
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.allowlist.fromEmployeeId).toBe("emp_comm");
    const id = createdBody.allowlist.id as string;
    const listed = await (await GET()).json();
    expect(listed.allowlist.some((row: { id: string }) => row.id === id)).toBe(true);
    const deleted = await DELETE(req("DELETE", undefined, `https://staffpass.test/api/settings/ai-peer-wake?id=${id}`));
    expect(deleted.status).toBe(200);
  });

  test("AI-shaped actor cannot be smuggled as createdBy; session actor is used", async () => {
    const created = await POST(req("POST", {
      action: "allowlist",
      fromEmployeeId: "emp_comm",
      toEmployeeId: "emp_sns",
      createdBy: "ai:emp_comm",
    }));
    expect(created.status).toBe(200);
    const body = await created.json();
    expect(body.allowlist.createdBy).toBe("member:mem_1");
  });
});
