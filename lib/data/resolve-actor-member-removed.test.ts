import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * 木村 decision (PR #263, 5): resolveActorMember is deleted. It carried the
 * production owner / first-member fallback; nothing may call or re-export it
 * (demo uses resolveDemoActor in lib/team/demo-actor.ts).
 */

const ROOT = resolve(import.meta.dir, "../..");
const SELF = relative(ROOT, import.meta.path);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

test("lib/data/members no longer exports resolveActorMember", async () => {
  const members = await import("./members");
  expect("resolveActorMember" in members).toBe(false);
});

test("lib/data (barrel) no longer re-exports resolveActorMember", async () => {
  const data = await import("./index");
  expect("resolveActorMember" in data).toBe(false);
});

test("no source or test file references resolveActorMember", () => {
  const hits = ["app", "lib", "components", "hooks", "tests", "scripts", "e2e"]
    .flatMap((d) => {
      try {
        return files(join(ROOT, d));
      } catch {
        return [];
      }
    })
    .map((p) => relative(ROOT, p))
    .filter((p) => p !== SELF && readFileSync(join(ROOT, p), "utf8").includes("resolveActorMember"));
  expect(hits).toEqual([]);
});
