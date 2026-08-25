import { test, expect } from "@playwright/test";

/**
 * Public-contract checks. DEMO has a synthetic org, so list endpoints
 * stay 200 there; unauth 401s are covered by bun:test with a mocked session.
 */
test.describe("P0 public vs signed-poll contract", () => {
  test("GET /api/health stays public", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBeTruthy();
  });

  test("GET /api/approvals/status without params is 400 (not 401)", async ({
    request,
  }) => {
    const res = await request.get("/api/approvals/status");
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("id_and_token_required");
  });

  test("GET /api/approvals/status signed poll works without session", async ({
    request,
  }) => {
    const res = await request.get(
      "/api/approvals/status?id=apr_1&token=st_demo_apr1_status_token_aaaaaaaa"
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBeTruthy();
    expect(body.approvalId).toBe("apr_1");
  });

  test("GET /api/approvals/status wrong token is 404", async ({ request }) => {
    const res = await request.get(
      "/api/approvals/status?id=apr_1&token=definitely-wrong"
    );
    expect(res.status()).toBe(404);
  });
});
