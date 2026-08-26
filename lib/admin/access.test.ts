import { describe, expect, test } from "bun:test";
import { matchesSuperAdminAllowlist } from "./allowlist";

describe("super admin allowlist", () => {
  test("matches the preferred immutable user id", () => {
    expect(
      matchesSuperAdminAllowlist({
        userId: "USER-123",
        email: "staff@example.com",
        userIds: " user-123, user-456 ",
      })
    ).toBe(true);
  });

  test("matches email case-insensitively", () => {
    expect(
      matchesSuperAdminAllowlist({
        userId: "user-999",
        email: "Admin@Example.com",
        emails: "ops@example.com, admin@example.com",
      })
    ).toBe(true);
  });

  test("fails closed when allowlists are empty or do not match", () => {
    expect(
      matchesSuperAdminAllowlist({
        userId: "user-999",
        email: "member@example.com",
      })
    ).toBe(false);
    expect(
      matchesSuperAdminAllowlist({
        userId: "user-999",
        email: "member@example.com",
        userIds: "user-123",
        emails: "admin@example.com",
      })
    ).toBe(false);
  });
});
