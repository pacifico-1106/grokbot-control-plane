/**
 * One LP chat turn against OpenAI Chat Completions: prompt, tool loop and the
 * server-side guarantees on the result (handoff card, no fake in-chat approval).
 *
 * Shared by POST /api/chat/turn and scripts/lp-chat-eval.ts so the eval runs the
 * exact production loop. Tool execution and fetch are injected.
 */
import { MAX_OUTPUT_TOKENS, MAX_TOOL_CALLS_PER_TURN, type ToolResult } from "@/lib/lp/chat-tools";
import {
  buildChatMessages,
  detectDelegationTopic,
  offeredToolNames,
  selectToolDefinitions,
  type ChatCapabilities,
  type HistoryMessage,
} from "@/lib/lp/chat-prompt";
import { chatCompletionParams } from "@/lib/lp/chat-model";
import {
  HANDOFF_CARD_REPLY,
  HANDOFF_OFF_REPLY,
  buildServerHandoffCard,
  contactLinkCard,
  detectHandoffIntent,
  looksLikeFakeHandoffText,
} from "@/lib/lp/handoff-intent";

export interface ChatTurnInput {
  model: string;
  openaiKey: string;
  caps: ChatCapabilities;
  history: HistoryMessage[];
  text: string;
  runTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  fetchImpl?: typeof fetch;
  /** Eval hooks (scripts/lp-chat-eval.ts A/B runs); production uses the defaults. */
  buildMessages?: typeof buildChatMessages;
  forceKnowledgeSearch?: boolean;
}

export interface ChatTurnResult {
  reply: string;
  cards: unknown[];
  citations: Array<{ title: string; url: string | null }>;
  toolCallsUsed: string[];
  inputTokens: number;
  outputTokens: number;
}

/** OpenAI returned a non-2xx status or no choice; the route answers 502. */
export class ChatModelError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "openai_no_choice" : `openai_http_${status}`);
  }
}

type ToolCall = { id: string; type: string; function: { name: string; arguments: string } };
type Message = { role: string; content: string; tool_call_id?: string; tool_calls?: ToolCall[] };

/**
 * The chat bubble renders plain text (whitespace-pre-wrap), so Markdown from the model
 * shows up raw. Eval 2026-10-02: gpt-4o-mini wrote **bold**, "- " lists and
 * "[プランの詳細を確認する](/lp/ai-employee/checkout?plan=proper)" next to the real card;
 * gpt-6-luna occasionally ended a Japanese question with the Arabic "؟".
 */
export function plainChatText(reply: string): string {
  return reply
    .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "・")
    .replace(/\u061F/g, "？")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const { model, openaiKey, caps, history, text, runTool } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const tools = selectToolDefinitions(caps);
  const allowedThisTurn = offeredToolNames(caps);

  // Each request carries the transcript so far; without it every turn looked like the
  // first one and the model just repeated the greeting (prod smoke 2026-10-02).
  const messages: Message[] = (input.buildMessages ?? buildChatMessages)(caps, history, text);

  // A visitor asking for a person must always get a working path, never a fake
  // in-chat "approval" (prod smoke 2026-10-02 turn 3).
  const handoffIntent = detectHandoffIntent(text);
  const forceHandoffTool = handoffIntent && allowedThisTurn.has("handoff_offer");
  // Questions about what can be delegated are answered from the approved KB, not from
  // the model's guesses (owner feedback 2026-10-02 21:19 JST: replies had no substance).
  const forceKnowledgeSearch =
    !handoffIntent &&
    allowedThisTurn.has("knowledge_search") &&
    (input.forceKnowledgeSearch ?? detectDelegationTopic(text));

  let reply = "";
  const citations: ChatTurnResult["citations"] = [];
  const cards: unknown[] = [];
  const toolCallsUsed: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  let toolCallCount = 0;
  let continueLoop = true;
  // One extra round lets the model answer after the tool budget is used up.
  let rounds = 0;

  while (continueLoop && rounds <= MAX_TOOL_CALLS_PER_TURN) {
    rounds++;
    const toolsAllowed = tools.length > 0 && toolCallCount < MAX_TOOL_CALLS_PER_TURN;
    const forcedTool =
      rounds === 1 ? (forceHandoffTool ? "handoff_offer" : forceKnowledgeSearch ? "knowledge_search" : null) : null;
    const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        ...(tools.length > 0
          ? {
              tools,
              tool_choice: !toolsAllowed
                ? "none"
                : forcedTool
                  ? { type: "function", function: { name: forcedTool } }
                  : "auto",
            }
          : {}),
        ...chatCompletionParams(model, MAX_OUTPUT_TOKENS),
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) throw new ChatModelError(response.status);

    const data = (await response.json()) as {
      choices: Array<{
        message: { role: string; content: string | null; tool_calls?: ToolCall[] };
        finish_reason: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    if (data.usage) {
      inputTokens += data.usage.prompt_tokens || 0;
      outputTokens += data.usage.completion_tokens || 0;
    }

    const choice = data.choices?.[0];
    if (!choice) throw new ChatModelError(null);

    const assistantMessage = choice.message;
    messages.push({
      role: assistantMessage.role,
      content: assistantMessage.content || "",
      ...(assistantMessage.tool_calls ? { tool_calls: assistantMessage.tool_calls } : {}),
    });

    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      for (const toolCall of assistantMessage.tool_calls) {
        if (toolCallCount >= MAX_TOOL_CALLS_PER_TURN) {
          // Every tool_call id needs a tool message, or the next OpenAI request is rejected.
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ success: false, error: "tool_budget_exceeded" }),
          });
          continue;
        }

        const toolName = toolCall.function.name;
        let toolArgs: Record<string, unknown>;
        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          toolArgs = {};
        }

        const toolResult: ToolResult = allowedThisTurn.has(toolName as never)
          ? await runTool(toolName, toolArgs)
          : { success: false, error: "tool_not_allowed" };
        toolCallsUsed.push(toolName);
        toolCallCount++;

        if (toolResult.citations) citations.push(...toolResult.citations);

        if (toolResult.data && typeof toolResult.data === "object" && "type" in toolResult.data) {
          const dataType = (toolResult.data as { type?: string }).type;
          const duplicateHandoff =
            dataType === "handoff_preview" &&
            cards.some((c) => (c as { type?: string } | null)?.type === "handoff_preview");
          if ((dataType === "proposal_card" || dataType === "handoff_preview") && !duplicateHandoff) {
            cards.push(toolResult.data);
          }
        }

        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(toolResult) });
      }
    } else {
      reply = assistantMessage.content || "";
      continueLoop = false;
    }

    // A named tool_choice (forced handoff_offer / knowledge_search) comes back with
    // finish_reason "stop" *and* tool_calls on gpt-4o-mini; ending the loop there left the
    // reply empty (eval 2026-10-02). Only a reply without tool calls ends the turn.
    if (choice.finish_reason === "stop" && !(assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0)) {
      reply = assistantMessage.content || reply;
      continueLoop = false;
    }
  }

  reply = plainChatText(reply);

  const hasHandoffCard = cards.some(
    (c) => !!c && typeof c === "object" && (c as { type?: string }).type === "handoff_preview"
  );
  const fakeHandoff = looksLikeFakeHandoffText(reply);
  if (caps.handoffEnabled && (handoffIntent || fakeHandoff)) {
    if (!hasHandoffCard) {
      cards.push(buildServerHandoffCard(history, text));
      toolCallsUsed.push("handoff_offer:server");
    }
    if (!hasHandoffCard || fakeHandoff || !reply.trim()) reply = HANDOFF_CARD_REPLY;
  } else if (!caps.handoffEnabled && fakeHandoff) {
    reply = HANDOFF_OFF_REPLY;
    cards.push(contactLinkCard());
  }

  if (!reply.trim()) {
    reply = cards.length > 0
      ? "内容をご確認ください。"
      : "申し訳ありません、うまく回答できませんでした。言い換えてお試しいただくか、ページの「相談する」からご連絡ください。";
  }

  return { reply, cards, citations, toolCallsUsed, inputTokens, outputTokens };
}
