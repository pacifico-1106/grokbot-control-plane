/**
 * Every caller of getNotificationChannelSecretsById passes an org-scoped id
 * as the FIRST argument (tsc enforces the 2-arg signature; this test also
 * checks that the first argument is an orgId expression, including aliased
 * imports like `getNotificationChannelSecretsById as getNotificationChannelSecrets`).
 * Plus demo-mode behaviour: org mismatch → {}.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getNotificationChannelSecretsById,
  resetDemoNotificationChannels,
  upsertNotificationChannel,
} from "@/lib/data/notification-channels";
import { PUT } from "@/app/api/settings/notification-channels/route";
import { diagnoseSlackDmApprovalSetup } from "@/lib/admin-mcp/slack-dm-setup";
import { DEMO_ORG } from "@/lib/demo-data";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FN = "getNotificationChannelSecretsById";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function splitTopLevelArgs(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if ("([{".includes(ch)) depth += 1;
    if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

type CallSite = { file: string; line: number; args: string[] };

function callSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of [...sourceFiles(join(ROOT, "lib")), ...sourceFiles(join(ROOT, "app"))]) {
    const src = readFileSync(file, "utf8");
    if (!src.includes(FN)) continue;
    const names = new Set<string>([FN]);
    for (const m of src.matchAll(new RegExp(`${FN}\\s+as\\s+([A-Za-z_$][\\w$]*)`, "g"))) names.add(m[1]);
    for (const name of names) {
      const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\(`, "g");
      for (const m of src.matchAll(re)) {
        const before = src.slice(0, m.index);
        if (/(function|export async function|async function)\s*$/.test(before)) continue; // the definition
        let depth = 1;
        let i = m.index! + m[0].length;
        const start = i;
        while (i < src.length && depth > 0) {
          if (src[i] === "(") depth += 1;
          if (src[i] === ")") depth -= 1;
          i += 1;
        }
        sites.push({
          file: relative(ROOT, file),
          line: before.split("\n").length,
          args: splitTopLevelArgs(src.slice(start, i - 1)),
        });
      }
    }
  }
  return sites;
}

describe("callers", () => {
  test("every call passes (orgId, channelId) with an org-scoped first argument", () => {
    const sites = callSites();
    // Sanity: the scan really finds the known callers on main.
    expect(sites.length).toBeGreaterThanOrEqual(8);
    for (const site of sites) {
      expect({ site: `${site.file}:${site.line}`, argc: site.args.length }).toEqual({ site: `${site.file}:${site.line}`, argc: 2 });
      expect({ site: `${site.file}:${site.line}`, org: /(^|\.)orgId$/.test(site.args[0]) }).toEqual({
        site: `${site.file}:${site.line}`,
        org: true,
      });
    }
  });
});

describe("demo mode", () => {
  test("org match returns secrets; org mismatch / blank org returns {}", async () => {
    resetDemoNotificationChannels();
    const a = await upsertNotificationChannel({
      orgId: "org_callers_a",
      provider: "slack",
      enabled: true,
      config: { channelId: "C0CALLERSA", allowedUserIds: ["U0CALLERS01"] },
      secrets: { botToken: "xoxb-callers-a-SECRET", signingSecret: "sig" },
    });
    expect((await getNotificationChannelSecretsById("org_callers_a", a.id)).botToken).toBe("xoxb-callers-a-SECRET");
    expect(await getNotificationChannelSecretsById("org_callers_b", a.id)).toEqual({});
    expect(await getNotificationChannelSecretsById("", a.id)).toEqual({});
  });
});

describe("main callers stay org-scoped (demo mode)", () => {
  const OTHER_ORG = "org_callers_other_tenant";
  const OTHER_TOKEN = "xoxb-callers-other-SECRET";
  const savedFetch = globalThis.fetch;
  let auths: string[] = [];

  function installFetch() {
    auths = [];
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      auths.push(String((init?.headers as Record<string, string> | undefined)?.authorization || ""));
      return new Response(JSON.stringify({ ok: true, team_id: "TCALLERS", user_id: "UBOT" }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  async function seedOtherOrgInbox() {
    resetDemoNotificationChannels();
    return upsertNotificationChannel({
      orgId: OTHER_ORG,
      provider: "slack",
      enabled: true,
      config: { channelId: "C0OTHERORG1", allowedUserIds: ["U0OTHERORG1"] },
      secrets: { botToken: OTHER_TOKEN, signingSecret: "sig-other" },
    });
  }

  test("settings PUT (dashboard): another org's channel id never loads its stored bot token", async () => {
    const other = await seedOtherOrgInbox();
    installFetch();
    const res = await PUT(
      new Request("http://localhost/api/settings/notification-channels", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: other.id,
          provider: "slack",
          enabled: true,
          channelId: "C0MINE00001",
          allowedUserIds: "U0MINE00001",
          botToken: "",
          signingSecret: "",
        }),
      })
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("bot_token_required");
    expect(auths.some((a) => a.includes(OTHER_TOKEN))).toBe(false);
  });

  test("setup.slackDmApprovalStatus diagnose: only this org's inbox tokens are probed", async () => {
    await seedOtherOrgInbox();
    installFetch();
    const out = await diagnoseSlackDmApprovalSetup(DEMO_ORG.id);
    expect(JSON.stringify(out)).not.toContain(OTHER_TOKEN);
    expect(auths.some((a) => a.includes(OTHER_TOKEN))).toBe(false);
  });
});
