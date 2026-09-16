import { test, expect } from "bun:test";
import { publicApproval } from "./public";
import type { ApprovalRequest } from "@/lib/types";
test("public DTO removes private inputs, both fulfillment aliases and polling credentials without mutating internal data", () => {
  const raw = { statusToken: "poll-secret", pollPath: "/?token=poll-secret", metadata: {
    adminFulfillment: { ok: true, oneTimeSecret: "fixture-secret", employeeId: "e" },
    fulfillment: { oneTimeSecret: "fixture-secret" },
    adminMutation: { botTokenCiphertext: "encrypted-secret", secretsCiphertext: "encrypted-line", enabled: true },
    nested: [{ secret_hash: "credential-hash", authorization: "Bearer fixture", label: "business" }],
    authorization: { amount: 50, currency: "JPY" },
  } } as unknown as ApprovalRequest;
  const result = publicApproval(raw);
  expect(JSON.stringify(result).includes("secret")).toBe(false);
  expect(result.metadata.authorization).toEqual({ amount: 50, currency: "JPY" });
  expect(result.metadata.adminMutation).toEqual({ enabled: true });
  expect((raw.metadata.adminFulfillment as Record<string, unknown>).oneTimeSecret).toBe("fixture-secret");
});
