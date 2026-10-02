/**
 * POST /api/chat/turn
 * 
 * Send a chat message and get AI response.
 * Feature flag LP_CHAT_ENABLED must be ON.
 * 
 * Uses OpenAI chat completions with tool calling.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isLpChatEnabled, isLpChatToolsEnabled, isLpHandoffEnabled } from "@/lib/feature-flags";
import {
  getJourneyByTokenHash,
  parseGuestCookie,
  verifySignature,
  hashToken,
  incrementTurnCount,
  recordChatTurn,
} from "@/lib/lp/journeys";
import {
  executeTool,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  type ToolResult,
} from "@/lib/lp/chat-tools";
import { getPublishedRelease } from "@/lib/lp/knowledge-base";
import {
  buildChatMessages,
  offeredToolNames,
  sanitizeHistory,
  selectToolDefinitions,
  type ChatCapabilities,
} from "@/lib/lp/chat-prompt";
import {
  HANDOFF_CARD_REPLY,
  HANDOFF_OFF_REPLY,
  buildServerHandoffCard,
  contactLinkCard,
  detectHandoffIntent,
  looksLikeFakeHandoffText,
} from "@/lib/lp/handoff-intent";

const GUEST_COOKIE_NAME = "lp_guest";
const CSRF_HEADER_NAME = "x-csrf-token";
const CSRF_COOKIE_NAME = "lp_csrf";

// System prompt, tool selection and history handling live in lib/lp/chat-prompt.ts.

interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

export async function POST(req: Request) {
  if (!isLpChatEnabled()) {
    return NextResponse.json(
      { ok: false, error: "feature_disabled", message: "チャット機能は現在利用できません" },
      { status: 503 }
    );
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey || openaiKey.startsWith("replace_me")) {
    return NextResponse.json(
      { ok: false, error: "chat_unavailable", message: "チャット機能は現在利用できません" },
      { status: 503 }
    );
  }

  const cookieStore = await cookies();
  const guestCookie = cookieStore.get(GUEST_COOKIE_NAME)?.value;

  if (!guestCookie) {
    return NextResponse.json(
      { ok: false, error: "auth_required", message: "セッションが必要です" },
      { status: 401 }
    );
  }

  const parsed = parseGuestCookie(guestCookie);
  if (!parsed || !verifySignature(parsed.token, parsed.signature)) {
    return NextResponse.json(
      { ok: false, error: "invalid_session", message: "無効なセッションです" },
      { status: 401 }
    );
  }

  const csrfHeader = req.headers.get(CSRF_HEADER_NAME);
  const csrfCookie = cookieStore.get(CSRF_COOKIE_NAME)?.value;

  if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
    return NextResponse.json(
      { ok: false, error: "csrf_invalid", message: "無効なリクエストです" },
      { status: 403 }
    );
  }

  const tokenHash = hashToken(parsed.token);
  const journey = await getJourneyByTokenHash(tokenHash);

  if (!journey) {
    return NextResponse.json(
      { ok: false, error: "session_expired", message: "セッションの有効期限が切れました" },
      { status: 401 }
    );
  }

  let body: { text?: string; clientTurnId?: string; history?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json", message: "リクエストが不正です" },
      { status: 400 }
    );
  }

  const { text, clientTurnId } = body;
  const history = sanitizeHistory(body.history);

  if (!text || typeof text !== "string") {
    return NextResponse.json(
      { ok: false, error: "text_required", message: "メッセージを入力してください" },
      { status: 400 }
    );
  }

  if (text.length > 2000) {
    return NextResponse.json(
      { ok: false, error: "text_too_long", message: "メッセージは2000文字以内で入力してください" },
      { status: 400 }
    );
  }

  const turnNumber = await incrementTurnCount(journey.id);
  if (turnNumber === null) {
    return NextResponse.json(
      { ok: false, error: "turn_limit_exceeded", message: "このセッションの上限に達しました。新しいセッションを開始してください。" },
      { status: 429 }
    );
  }

  const kbRelease = await getPublishedRelease();
  const model = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";

  const caps: ChatCapabilities = {
    toolsEnabled: isLpChatToolsEnabled(),
    handoffEnabled: isLpHandoffEnabled(),
  };
  const tools = selectToolDefinitions(caps);
  const allowedThisTurn = offeredToolNames(caps);

  // Each request carries the transcript so far; without it every turn looked like the
  // first one and the model just repeated the greeting (prod smoke 2026-10-02).
  const messages: Array<{ role: string; content: string; tool_call_id?: string }> = buildChatMessages(
    caps,
    history,
    text
  );

  // A visitor asking for a person must always get a working path, never a fake
  // in-chat "approval" (prod smoke 2026-10-02 turn 3).
  const handoffIntent = detectHandoffIntent(text);
  const forceHandoffTool = handoffIntent && allowedThisTurn.has("handoff_offer");

  if (handoffIntent && !caps.handoffEnabled) {
    await recordChatTurn({
      journeyId: journey.id,
      turnNumber,
      clientTurnId,
      kbReleaseId: kbRelease?.releaseId,
      model: "rule:handoff_disabled",
      toolCalls: ["contact_link"],
    });
    return NextResponse.json({
      ok: true,
      reply: HANDOFF_OFF_REPLY,
      cards: [contactLinkCard()],
      kbReleaseId: kbRelease?.releaseId,
      turnNumber,
    });
  }

  let reply = "";
  const citations: Array<{ title: string; url: string | null }> = [];
  const cards: Array<unknown> = [];
  const toolCallsUsed: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    let toolCallCount = 0;
    let continueLoop = true;
    // One extra round lets the model answer after the tool budget is used up.
    let rounds = 0;

    while (continueLoop && rounds <= MAX_TOOL_CALLS_PER_TURN) {
      rounds++;
      const toolsAllowed = tools.length > 0 && toolCallCount < MAX_TOOL_CALLS_PER_TURN;
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
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
                  : forceHandoffTool && rounds === 1
                    ? { type: "function", function: { name: "handoff_offer" } }
                    : "auto",
              }
            : {}),
          max_tokens: MAX_OUTPUT_TOKENS,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        console.error("[chat] OpenAI API error:", response.status);
        return NextResponse.json(
          { ok: false, error: "ai_error", message: "AI応答の取得に失敗しました" },
          { status: 502 }
        );
      }

      const data = await response.json() as {
        choices: Array<{
          message: {
            role: string;
            content: string | null;
            tool_calls?: Array<{
              id: string;
              type: string;
              function: { name: string; arguments: string };
            }>;
          };
          finish_reason: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      if (data.usage) {
        inputTokens += data.usage.prompt_tokens || 0;
        outputTokens += data.usage.completion_tokens || 0;
      }

      const choice = data.choices?.[0];
      if (!choice) {
        return NextResponse.json(
          { ok: false, error: "ai_error", message: "AI応答の取得に失敗しました" },
          { status: 502 }
        );
      }

      const assistantMessage = choice.message;
      messages.push({
        role: assistantMessage.role,
        content: assistantMessage.content || "",
        ...(assistantMessage.tool_calls ? { tool_calls: assistantMessage.tool_calls } : {}),
      } as { role: string; content: string });

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

          const toolResult = allowedThisTurn.has(toolName as never)
            ? await executeTool(toolName, toolArgs, { journeyId: journey.id })
            : ({ success: false, error: "tool_not_allowed" } satisfies ToolResult);
          toolCallsUsed.push(toolName);
          toolCallCount++;

          if (toolResult.citations) {
            citations.push(...toolResult.citations);
          }

          if (toolResult.data && typeof toolResult.data === "object" && "type" in toolResult.data) {
            const dataType = (toolResult.data as { type?: string }).type;
            const duplicateHandoff =
              dataType === "handoff_preview" &&
              cards.some((c) => (c as { type?: string } | null)?.type === "handoff_preview");
            if ((dataType === "proposal_card" || dataType === "handoff_preview") && !duplicateHandoff) {
              cards.push(toolResult.data);
            }
          }

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult),
          });
        }
      } else {
        reply = assistantMessage.content || "";
        continueLoop = false;
      }

      if (choice.finish_reason === "stop") {
        reply = assistantMessage.content || reply;
        continueLoop = false;
      }
    }

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

    await recordChatTurn({
      journeyId: journey.id,
      turnNumber,
      clientTurnId,
      kbReleaseId: kbRelease?.releaseId,
      inputTokens,
      outputTokens,
      model,
      toolCalls: toolCallsUsed.length > 0 ? toolCallsUsed : undefined,
    });

    return NextResponse.json({
      ok: true,
      reply,
      citations: citations.length > 0 ? citations : undefined,
      cards: cards.length > 0 ? cards : undefined,
      kbReleaseId: kbRelease?.releaseId,
      turnNumber,
    });
  } catch (error) {
    console.error("[chat] Chat error:", error);
    return NextResponse.json(
      { ok: false, error: "chat_error", message: "エラーが発生しました" },
      { status: 500 }
    );
  }
}
