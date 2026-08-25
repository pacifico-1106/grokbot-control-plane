import { describe, expect, test } from "bun:test";
import { ALL_SCOPES } from "@/lib/employees/policy-draft";
import { domainOfScope, SCOPE_DOMAINS } from "./domains";

describe("scope risk domains", () => {
  test("maps every supported employee scope", () => {
    expect(Object.keys(SCOPE_DOMAINS).sort()).toEqual([...ALL_SCOPES].sort());
    for (const scope of ALL_SCOPES) expect(domainOfScope(scope)).toBeTruthy();
  });
});
