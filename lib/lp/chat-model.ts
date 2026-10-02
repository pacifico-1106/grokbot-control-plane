/**
 * Chat Completions request parameters per model family for the LP chat.
 *
 * OPENAI_CHAT_MODEL selects the model (default gpt-4o-mini). Verified against
 * POST /v1/chat/completions with function tools on 2026-10-02:
 * - gpt-4o-mini / gpt-4.1-mini: accept max_tokens and max_completion_tokens; reject reasoning_effort.
 * - gpt-5 / gpt-5.x / gpt-6 / o-series: reject max_tokens ("Use 'max_completion_tokens'").
 * - gpt-5.6-luna / gpt-6-luna: function tools on Chat Completions only with reasoning_effort "none"
 *   (the default effort returns 400 when tools are sent).
 * - gpt-5 / gpt-5-mini / gpt-5-nano: no "none" (minimal|low|medium|high) and only the default temperature.
 * temperature is never sent, so every family runs at its default.
 */

export const DEFAULT_CHAT_MODEL = "gpt-4o-mini";

export type ReasoningEffort = "none" | "minimal" | "low";

export function resolveChatModel(env: Record<string, string | undefined> = process.env): string {
  const model = env.OPENAI_CHAT_MODEL?.trim();
  return model ? model : DEFAULT_CHAT_MODEL;
}

/** reasoning_effort to send, or null for models that reject the parameter. */
export function reasoningEffortFor(model: string): ReasoningEffort | null {
  const m = model.trim().toLowerCase();
  if (/-chat(?:-latest)?$/.test(m)) return null; // gpt-5*-chat-latest are non-reasoning aliases
  if (/^gpt-(?:5\.\d+|6(?:\.\d+)?)(?:-|$)/.test(m)) return "none";
  if (/^gpt-5(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) return "minimal";
  if (/^o\d/.test(m)) return "low";
  return null;
}

/** Token limit and reasoning parameters for one Chat Completions request. */
export function chatCompletionParams(model: string, maxOutputTokens: number): Record<string, unknown> {
  const effort = reasoningEffortFor(model);
  return {
    // max_completion_tokens works for gpt-4o-mini too; max_tokens is rejected by reasoning models.
    max_completion_tokens: maxOutputTokens,
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}
