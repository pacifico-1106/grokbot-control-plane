import { describe, expect, test } from "bun:test";
import { POSTING_PATH_INVENTORY } from "@/lib/comm-reply-dedup/inventory";
import { THREAD_GUARD_COVERAGE } from "@/lib/thread-guard/inventory";

describe("thread single-flight coverage", () => {
  test("every posting path has a thread-guard decision (and no stale ids)", () => {
    const ids = POSTING_PATH_INVENTORY.map((p) => p.id).sort();
    expect(Object.keys(THREAD_GUARD_COVERAGE).sort()).toEqual(ids);
  });
  test("every conversation path that a dedup guard covers is leased or a same-reply continuation", () => {
    for (const p of POSTING_PATH_INVENTORY) {
      if (p.coverage !== "guarded" || p.tools.includes("sns.publish")) continue;
      expect({ id: p.id, ok: ["leased", "same_reply"].includes(THREAD_GUARD_COVERAGE[p.id].coverage) }).toEqual({ id: p.id, ok: true });
    }
  });
  // 木村 #286 pre-flag item 4: approved LINE / Telegram replies are a listed
  // path in BOTH inventories, and the fulfil-time thread guard covers them.
  test("pre-flag 4: approved caller-delivered replies are listed and leased at fulfil", () => {
    const path = POSTING_PATH_INVENTORY.find((p) => p.id === "fulfill.caller_delivered");
    expect(path?.surfaces).toEqual(expect.arrayContaining(["line", "telegram"]));
    expect(THREAD_GUARD_COVERAGE["fulfill.caller_delivered"]?.coverage).toBe("leased");
    expect(THREAD_GUARD_COVERAGE["invoke.caller_delivered"]?.where).toMatch(/TTL/);
  });
});
