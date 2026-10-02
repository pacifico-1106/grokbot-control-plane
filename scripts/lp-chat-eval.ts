/**
 * LP AI相談 chat eval: runs scripted visitor conversations through the production
 * prompt + tool loop (lib/lp/chat-turn.ts) against the real OpenAI API and prints
 * Markdown transcripts with tool calls and token usage.
 *
 * Tools run the real handlers; knowledge_search is served from the published FAQ
 * seed in supabase/migrations/20261001200000_lp_knowledge_base.sql (same substring
 * match as search_published_kb), catalog_get from the hardcoded catalog
 * (LP_CATALOG_DB_ENABLED unset). No database, no prod writes.
 *
 * Usage (needs OPENAI_API_KEY in the environment; never printed):
 *   bun --no-env-file scripts/lp-chat-eval.ts --models gpt-4o-mini,gpt-6-luna [--out file.md]
 *   [--prompt-module @/lib/lp/other-prompt] [--greeting text] [--no-force-kb] [--label text] [--only 0,2]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeKnowledgeSearch, executeTool, type KbSearchFn } from "@/lib/lp/chat-tools";
import type { KbDocument } from "@/lib/lp/knowledge-base";
import { buildChatMessages, sanitizeHistory, type ChatCapabilities } from "@/lib/lp/chat-prompt";
import { buildTurnHistory, LP_CHAT_GREETING } from "@/lib/lp/client-session";
import { runChatTurn } from "@/lib/lp/chat-turn";

export const CONVERSATIONS: Array<{ name: string; turns: string[] }> = [
  { name: "秘書業務（prod journey 9c9d4485 の発話）", turns: ["秘書業務", "日常の業務すべて", "Google", "急いでない", "おすすめのプランで進めたいです"] },
  { name: "問い合わせ対応＋料金", turns: ["問い合わせ対応を任せたい、料金は？", "メールの問い合わせが月100件くらいです"] },
  { name: "担当者希望", turns: ["担当の方と話したいです"] },
  { name: "承認（勝手に送らない？）", turns: ["AI社員が勝手にメールを送ったりしませんか？"] },
  { name: "承認の緩和（聞かれたときだけ）", turns: ["承認なしで自動で進めることもできますか？"] },
  { name: "未掲載の連携（GitHub監視・一次対応）", turns: ["GitHubと連携して、リポジトリの監視やアラートの一次対応までやってもらえますか？"] },
];

const SEED = "supabase/migrations/20261001200000_lp_knowledge_base.sql";

/** Published FAQ documents from the KB seed migration. */
export function loadSeedKb(root = process.cwd()): KbDocument[] {
  const sql = readFileSync(join(root, SEED), "utf8");
  const docs = new Map<string, { title: string; url: string | null }>();
  for (const m of sql.matchAll(/\('[0-9a-f-]+',\s*'([^']+)',\s*'([^']+)',\s*(NULL|'[^']*'),\s*'public'\)/g)) {
    docs.set(m[1], { title: m[2], url: m[3] === "NULL" ? null : m[3].slice(1, -1) });
  }
  const out: KbDocument[] = [];
  for (const m of sql.matchAll(/\('([a-z0-9-]+)',\s*'([^']+)'\)/g)) {
    const d = docs.get(m[1]);
    if (!d) continue;
    out.push({ documentId: m[1], documentKey: m[1], title: d.title, sourceUrl: d.url, revision: 1, content: m[2], releaseKey: "2026-10-01-initial" });
  }
  return out;
}

/** Same semantics as search_published_kb: ILIKE substring on title/key/content, title hits first. */
export function seedSearch(docs: KbDocument[]): KbSearchFn {
  return async (query, limit = 3) => {
    const q = query.toLowerCase();
    const hit = (s: string) => s.toLowerCase().includes(q);
    const rows = docs
      .filter((d) => hit(d.title) || hit(d.documentKey) || hit(d.content))
      .sort((a, b) => Number(!hit(a.title)) - Number(!hit(b.title)))
      .slice(0, limit);
    return { releaseId: "seed", releaseKey: "2026-10-01-initial", status: rows.length ? "found" : "not_found", passages: rows };
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.error("OPENAI_API_KEY is not set");
    process.exit(2);
  }
  const models = (arg("models") ?? "gpt-4o-mini").split(",").map((s) => s.trim()).filter(Boolean);
  const promptModule = arg("prompt-module");
  const buildMessages: typeof buildChatMessages = promptModule
    ? ((await import(promptModule)) as { buildChatMessages: typeof buildChatMessages }).buildChatMessages
    : buildChatMessages;
  const noForceKb = process.argv.includes("--no-force-kb");
  const greeting = arg("greeting") ?? LP_CHAT_GREETING;
  const label = arg("label") ?? (promptModule ? `prompt ${promptModule}` : "current prompt");
  const only = arg("only")?.split(",").map(Number);
  const conversations = only ? CONVERSATIONS.filter((_, i) => only.includes(i)) : CONVERSATIONS;
  const caps: ChatCapabilities = { toolsEnabled: true, handoffEnabled: true };
  const search = seedSearch(loadSeedKb());
  const runTool = (name: string, args: Record<string, unknown>) =>
    name === "knowledge_search"
      ? executeKnowledgeSearch(args as { query?: string }, search)
      : executeTool(name, args, { journeyId: "eval" });

  const out: string[] = [`# LP chat eval: ${label}`, ""];
  for (const model of models) {
    out.push(`## ${model}`, "");
    for (const conv of conversations) {
      out.push(`### ${conv.name}`, "", `> AI（挨拶）: ${greeting}`, "");
      const transcript: Array<{ role: string; text: string }> = [{ role: "assistant", text: greeting }];
      let inTok = 0;
      let outTok = 0;
      for (const text of conv.turns) {
        const history = sanitizeHistory(buildTurnHistory(transcript));
        const t0 = Date.now();
        try {
          // Each logged tool call is captured via a wrapper so arguments are visible.
          const calls: string[] = [];
          const r = await runChatTurn({
            model,
            openaiKey,
            caps,
            history,
            text,
            buildMessages,
            ...(noForceKb ? { forceKnowledgeSearch: false } : {}),
            runTool: async (name, args) => {
              calls.push(`${name}(${JSON.stringify(args)})`);
              return runTool(name, args);
            },
          });
          inTok += r.inputTokens;
          outTok += r.outputTokens;
          out.push(`**訪問者**: ${text}`, "");
          out.push(`**AI**: ${r.reply.replace(/\n+/g, " ")}`, "");
          const cardTypes = r.cards.map((c) => {
            const card = c as { type?: string; displayName?: string };
            return card.displayName ? `${card.type}(${card.displayName})` : String(card.type);
          });
          const extra = [
            r.toolCallsUsed.length ? `tools: ${calls.join(" → ")}${r.toolCallsUsed.includes("handoff_offer:server") ? " → handoff_offer:server" : ""}` : "tools: なし",
            cardTypes.length ? `cards: ${cardTypes.join(", ")}` : null,
            `tokens: in ${r.inputTokens} / out ${r.outputTokens}`,
            `${Date.now() - t0}ms`,
          ].filter(Boolean);
          out.push(`<sub>${extra.join(" ｜ ")}</sub>`, "");
          transcript.push({ role: "user", text }, { role: "assistant", text: r.reply });
        } catch (e) {
          out.push(`**訪問者**: ${text}`, "", `**ERROR**: ${(e as Error).message}`, "");
          transcript.push({ role: "user", text });
        }
      }
      out.push(`合計 tokens: in ${inTok} / out ${outTok}`, "");
    }
  }
  const md = out.join("\n");
  const file = arg("out");
  if (file) writeFileSync(file, md);
  console.log(md);
}

if ((import.meta as ImportMeta & { main?: boolean }).main) await main();
