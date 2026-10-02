import { describe, expect, test } from "bun:test";
import { DEFAULT_CHAT_MODEL, chatCompletionParams, reasoningEffortFor, resolveChatModel } from "@/lib/lp/chat-model";

describe("OPENAI_CHAT_MODEL", () => {
  test("defaults to gpt-4o-mini", () => {
    expect(DEFAULT_CHAT_MODEL).toBe("gpt-4o-mini");
    expect(resolveChatModel({})).toBe("gpt-4o-mini");
    expect(resolveChatModel({ OPENAI_CHAT_MODEL: "  " })).toBe("gpt-4o-mini");
    expect(resolveChatModel({ OPENAI_CHAT_MODEL: "gpt-6-luna" })).toBe("gpt-6-luna");
  });
});

describe("request params per family (verified against the API 2026-10-02)", () => {
  test("never max_tokens or temperature; max_completion_tokens always", () => {
    for (const m of ["gpt-4o-mini", "gpt-4.1-mini", "gpt-5-mini", "gpt-5.4-mini", "gpt-5.6-luna", "gpt-6-luna", "o4-mini"]) {
      const p = chatCompletionParams(m, 1024);
      expect(p.max_completion_tokens).toBe(1024);
      expect("max_tokens" in p).toBe(false);
      expect("temperature" in p).toBe(false);
    }
  });
  test("reasoning_effort: omitted for gpt-4o/4.1, none for gpt-5.x/gpt-6 (tools need it), minimal for gpt-5 minis", () => {
    expect(reasoningEffortFor("gpt-4o-mini")).toBeNull();
    expect("reasoning_effort" in chatCompletionParams("gpt-4o-mini", 10)).toBe(false);
    expect(reasoningEffortFor("gpt-4.1-mini")).toBeNull();
    expect(reasoningEffortFor("gpt-6-luna")).toBe("none");
    expect(reasoningEffortFor("gpt-6.1-sol")).toBe("none");
    expect(reasoningEffortFor("gpt-5.6-luna")).toBe("none");
    expect(reasoningEffortFor("gpt-5.4-mini")).toBe("none");
    expect(reasoningEffortFor("gpt-5.4-mini-2026-03-17")).toBe("none");
    expect(reasoningEffortFor("gpt-5-mini")).toBe("minimal");
    expect(reasoningEffortFor("gpt-5-mini-2025-08-07")).toBe("minimal");
    expect(reasoningEffortFor("gpt-5.2-chat-latest")).toBeNull();
    expect(reasoningEffortFor("o4-mini")).toBe("low");
  });
});
