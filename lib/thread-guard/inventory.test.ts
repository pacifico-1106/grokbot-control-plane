import { describe, expect, it } from "bun:test";
import { POSTING_PATH_INVENTORY } from "@/lib/comm-reply-dedup/inventory";
import { THREAD_GUARD_COVERAGE } from "@/lib/thread-guard/inventory";

describe("thread single-flight coverage", () => {
  it("every posting path has a thread-guard decision (and no stale ids)", () => {
    const ids = POSTING_PATH_INVENTORY.map((p) => p.id).sort();
    expect(Object.keys(THREAD_GUARD_COVERAGE).sort()).toEqual(ids);
  });
  it("every conversation path that a dedup guard covers is leased or a same-reply continuation", () => {
    for (const p of POSTING_PATH_INVENTORY) {
      if (p.coverage !== "guarded" || p.tools.includes("sns.publish")) continue;
      expect({ id: p.id, c: THREAD_GUARD_COVERAGE[p.id].coverage }).toEqual({
        id: p.id,
        c: expect.stringMatching(/^(leased|same_reply)$/),
      });
    }
  });
});
