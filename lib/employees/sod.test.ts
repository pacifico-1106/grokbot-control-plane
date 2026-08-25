import { describe, expect, test } from "bun:test";
import { evaluateSod } from "./sod";

describe("separation of duties", () => {
  test("safe and one non-browser high-risk domain stay ok", () => {
    expect(evaluateSod(["mail:draft", "files:read"]).level).toBe("ok");
    expect(evaluateSod(["mail:send", "mail:draft"]).level).toBe("ok");
  });

  test("browser-only access warns", () => {
    expect(evaluateSod(["browser:use", "tools:read"]).level).toBe("warn");
  });

  test("two high-risk domains force human approval", () => {
    const verdict = evaluateSod(["mail:send", "commerce:order"]);
    expect(verdict.level).toBe("force_human");
    expect(verdict.domains).toEqual(["comm_external", "money"]);
  });
});
