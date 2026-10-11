import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildChatMessages, buildSystemPrompt } from "@/lib/lp/chat-prompt";
import { runChatTurn, stripCampaignMentions } from "@/lib/lp/chat-turn";
import { executeTool } from "@/lib/lp/chat-tools";
import * as handoffIntent from "@/lib/lp/handoff-intent";
import { LP_CHAT_GREETING } from "@/lib/lp/client-session";

/** AI 相談 for pattern B: variant-aware prompt, no 先行100枠 in any answer, B links on cards. */
const CAPS = [false, true].flatMap((t) => [false, true].map((h) => ({ toolsEnabled: t, handoffEnabled: h })));
const golden = JSON.parse(readFileSync("lib/lp/__fixtures__/system-prompt.ai-employee.json", "utf8")) as Record<string, string>;

describe("system prompt", () => {
  test("original prompt unchanged (default and explicit ai-employee)", () => {
    for (const c of CAPS) {
      const key = `tools=${c.toolsEnabled},handoff=${c.handoffEnabled}`;
      expect(buildSystemPrompt(c)).toBe(golden[key]);
      expect(buildSystemPrompt(c, "ai-employee")).toBe(golden[key]);
    }
  });
  test("B prompt: service name, no campaign/slot talk, never the phrase itself", () => {
    for (const c of CAPS) {
      const p = buildSystemPrompt(c, "ai-employee-corp");
      expect(p).toContain("Staffpass（AIエージェントの社員証）");
      expect(p).toMatch(/キャンペーン/);
      expect(p).not.toMatch(/先行\s*100\s*枠/);
      expect(p.startsWith(golden[`tools=${c.toolsEnabled},handoff=${c.handoffEnabled}`])).toBe(false);
    }
    const msgs = buildChatMessages(CAPS[3], [], "料金は？", "ai-employee-corp");
    expect(msgs[0].content).toBe(buildSystemPrompt(CAPS[3], "ai-employee-corp"));
  });
  test("canned replies and greeting never mention 先行100枠", () => {
    const canned = [LP_CHAT_GREETING, ...(Object.values(handoffIntent).filter((v) => typeof v === "string") as string[])];
    for (const s of canned) expect(s).not.toMatch(/先行\s*100\s*枠/);
  });
});

describe("stripCampaignMentions (B replies)", () => {
  test("removes every form of 先行100枠 and the sentence around it", () => {
    for (const raw of [
      "現在、先行100枠の募集中です。プロパーがおすすめです。",
      "先行 100 枠はまだ空きがあります。プロパーがおすすめです。",
      "先行１００枠（12月以降開始）があります。プロパーがおすすめです。",
      "【先行100枠】プロパーがおすすめです。",
    ]) {
      const out = stripCampaignMentions(raw);
      expect(out).not.toMatch(/先行\s*[0-9０-９]+\s*枠/);
      expect(out).not.toContain("１００");
      expect(out).toContain("プロパーがおすすめです。");
    }
  });
  test("text without the phrase is unchanged", () => {
    const s = "日報の下書きから任せられます。どの作業から始めたいですか？";
    expect(stripCampaignMentions(s)).toBe(s);
  });
});

function fakeOpenAi(reply: string, toolCall?: { name: string; args: Record<string, unknown> }) {
  let n = 0;
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> };
    n++;
    const msg =
      toolCall && n === 1 && body.messages.at(-1)?.role !== "tool"
        ? { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) } }] }
        : { role: "assistant", content: reply };
    return new Response(JSON.stringify({ choices: [{ message: msg, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
}
const caps = { toolsEnabled: true, handoffEnabled: false };

describe("runChatTurn lpPage", () => {
  test("B: a model reply mentioning 先行100枠 reaches the visitor without it", async () => {
    const r = await runChatTurn({
      model: "m", openaiKey: "k", caps, history: [], text: "料金は？", lpPage: "ai-employee-corp",
      runTool: async () => ({ success: true, data: {} }), fetchImpl: fakeOpenAi("今なら先行100枠です。インターンは月5万円です。"),
    });
    expect(r.reply).not.toContain("先行100枠");
    expect(r.reply).toContain("インターンは月5万円です。");
  });
  test("original: reply passes through unchanged (no new filtering on page A)", async () => {
    const r = await runChatTurn({
      model: "m", openaiKey: "k", caps, history: [], text: "料金は？",
      runTool: async () => ({ success: true, data: {} }), fetchImpl: fakeOpenAi("今なら先行100枠です。インターンは月5万円です。"),
    });
    expect(r.reply).toBe("今なら先行100枠です。インターンは月5万円です。");
  });
  test("B system prompt is the one sent to the model", async () => {
    let system = "";
    const f = (async (_u: unknown, init?: RequestInit) => {
      system = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    await runChatTurn({ model: "m", openaiKey: "k", caps, history: [], text: "こんにちは", lpPage: "ai-employee-corp", runTool: async () => ({ success: true, data: {} }), fetchImpl: f });
    expect(system).toBe(buildSystemPrompt(caps, "ai-employee-corp"));
  });
});

describe("proposal card link", () => {
  test("B → checkout link carries from=ai-employee-corp; original unchanged; tampered → original", async () => {
    const card = async (lpPage?: unknown) =>
      ((await executeTool("proposal_prepare", { sku: "intern" }, { journeyId: "j", lpPage } as never)).data as { checkoutUrl: string }).checkoutUrl;
    expect(await card("ai-employee-corp")).toBe("/lp/ai-employee/checkout?plan=intern&from=ai-employee-corp");
    expect(await card()).toBe("/lp/ai-employee/checkout?plan=intern");
    expect(await card("https://evil.example")).toBe("/lp/ai-employee/checkout?plan=intern");
  });
});
