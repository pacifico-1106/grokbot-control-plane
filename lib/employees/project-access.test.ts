import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PROJECT_ACCESS,
  PROJECT_SCOPE_DENIED_CODE,
  defaultProjectAccess,
  defaultSelectedProjectIds,
  employeeCanAccessAsset,
  employeeCanAccessProject,
  normalizeProjectAccess,
} from "./project-access";

const DEFAULT_ID = "prj_company";
const OTHER_ID = "prj_project_a";

describe("project access (WHICH)", () => {
  test("default hire access is company-only", () => {
    const access = defaultProjectAccess();
    expect(access).toEqual(DEFAULT_PROJECT_ACCESS);
    expect(access.mode).toBe("company");
    expect(access.projectIds).toEqual([]);
    expect(normalizeProjectAccess(undefined).mode).toBe("company");
    expect(normalizeProjectAccess(null).mode).toBe("company");
    const employee = { projectAccess: access };
    expect(employeeCanAccessProject(employee, DEFAULT_ID, DEFAULT_ID)).toBe(true);
    expect(employeeCanAccessProject(employee, OTHER_ID, DEFAULT_ID)).toBe(false);
    expect(
      employeeCanAccessAsset(employee, { projectId: OTHER_ID }, DEFAULT_ID)
    ).toBe(false);
    expect(
      employeeCanAccessAsset(employee, { projectId: null }, DEFAULT_ID)
    ).toBe(true);
  });

  test("unknown asset denies for company and selected, allows all", () => {
    expect(
      employeeCanAccessAsset({ projectAccess: { mode: "company", projectIds: [] } }, null, DEFAULT_ID)
    ).toBe(false);
    expect(
      employeeCanAccessAsset(
        { projectAccess: { mode: "selected", projectIds: [OTHER_ID] } },
        null,
        DEFAULT_ID
      )
    ).toBe(false);
    expect(
      employeeCanAccessAsset({ projectAccess: { mode: "all", projectIds: [] } }, null, DEFAULT_ID)
    ).toBe(true);
  });

  test("selected includes listed ids only; company default is UI not implicit", () => {
    const selected = {
      projectAccess: { mode: "selected" as const, projectIds: [OTHER_ID] },
    };
    expect(employeeCanAccessProject(selected, OTHER_ID, DEFAULT_ID)).toBe(true);
    expect(employeeCanAccessProject(selected, DEFAULT_ID, DEFAULT_ID)).toBe(false);
    expect(defaultSelectedProjectIds(DEFAULT_ID, defaultProjectAccess())).toEqual([DEFAULT_ID]);
    expect(
      defaultSelectedProjectIds(DEFAULT_ID, { mode: "selected", projectIds: [OTHER_ID] })
    ).toEqual([OTHER_ID]);
  });

  test("mode all can use any project", () => {
    const all = { projectAccess: { mode: "all" as const, projectIds: [] } };
    expect(employeeCanAccessProject(all, OTHER_ID, DEFAULT_ID)).toBe(true);
    expect(employeeCanAccessAsset(all, { projectId: OTHER_ID }, DEFAULT_ID)).toBe(true);
  });

  test("denied code is project_scope_denied", () => {
    expect(PROJECT_SCOPE_DENIED_CODE).toBe("project_scope_denied");
  });
});
