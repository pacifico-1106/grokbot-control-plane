/**
 * Integrations page: the gateway connect / handshake / disconnect buttons are
 * rendered only for org owners/admins (server-side decision from the session,
 * same rule as requireOrgAdminSession on POST /api/gateway/link). Members see a
 * read-only status and a note instead — the buttons are not in the markup.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionContext } from "@/lib/auth/session";
import { isOrgAdminSession } from "@/lib/auth/require-org";
import { IntegrationsClient } from "@/components/IntegrationsClient";
import type { OrgMember } from "@/lib/types";

const withRole = (role: OrgMember["role"]): SessionContext => ({
  demo: false,
  userId: `u-${role}`,
  email: `${role}@example.com`,
  orgId: "org-a",
  member: { id: `m-${role}`, orgId: "org-a", email: `${role}@example.com`, displayName: role, role, status: "active" },
});

describe("isOrgAdminSession (same rule as requireOrgAdminSession)", () => {
  test("owner / admin → true; member → false", () => {
    expect(isOrgAdminSession(withRole("owner"))).toBe(true);
    expect(isOrgAdminSession(withRole("admin"))).toBe(true);
    expect(isOrgAdminSession(withRole("member"))).toBe(false);
  });
  test("no session / no membership → false; demo with org → true", () => {
    expect(isOrgAdminSession({ demo: false, userId: null, email: null, orgId: null, member: null })).toBe(false);
    expect(isOrgAdminSession({ demo: false, userId: "u", email: "e", orgId: "org-a", member: null })).toBe(false);
    expect(isOrgAdminSession({ demo: true, userId: null, email: null, orgId: "org_demo", member: null })).toBe(true);
  });
});

describe("IntegrationsClient gateway controls", () => {
  const render = (canManage: boolean) =>
    renderToStaticMarkup(
      createElement(IntegrationsClient, { initialStatus: "pending", initialMode: "managed", bindingRows: [], canManage })
    );
  test("member: no connect / handshake / disconnect buttons, mode is read-only", () => {
    const html = render(false);
    expect(html).not.toContain("Grok Botへ連携");
    expect(html).not.toContain("戻る（ゲートウェイ連携を完了）");
    expect(html).not.toContain("切断");
    expect(html).toContain("組織のオーナーまたは管理者");
    expect(html).toContain("ゲートウェイ連携待ち"); // status stays visible
    expect(html.match(/type="radio"[^>]*disabled/g)?.length).toBe(2);
  });
  test("owner/admin: the three buttons are rendered", () => {
    const html = render(true);
    expect(html).toContain("Grok Botへ連携");
    expect(html).toContain("戻る（ゲートウェイ連携を完了）");
    expect(html).toContain("切断");
  });
});

test("integrations page decides canManage on the server from the session", () => {
  const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  expect(page).toContain("getSessionContext()");
  expect(page).toMatch(/const canManage = isOrgAdminSession\(session\)/);
  expect(page).toMatch(/<IntegrationsClient[\s\S]*canManage=\{canManage\}/);
});
