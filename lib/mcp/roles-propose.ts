/**
 * PROCESS SOURCE for roles.propose.
 * Document text, Drive/Supabase location, voice/transcript, and free text
 * (including conversation logs) are the SAME class of 工程の正本候補.
 * Drive is optional. Missing Drive must not fail the tool.
 */

export const PROCESS_SOURCE_TYPES = ["document", "voice", "text"] as const;
export type ProcessSourceType = (typeof PROCESS_SOURCE_TYPES)[number];

export type ParsedRolesPropose = {
  sourceType: ProcessSourceType;
  text: string;
  location: string;
  transcript: string;
  combinedText: string;
  driveWired: false;
};

export type RolesProposeParseResult =
  | { ok: true; value: ParsedRolesPropose }
  | { ok: false; code: "content_required"; message: string; driveRequired: false };

function field(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function inferSourceType(args: Record<string, unknown>, parts: {
  text: string;
  transcript: string;
  location: string;
}): ProcessSourceType {
  const declared = field(args, "sourceType");
  if (declared === "document" || declared === "voice" || declared === "text") {
    return declared;
  }
  if (parts.transcript && !parts.text) return "voice";
  if (parts.location && !parts.text && !parts.transcript) return "document";
  return "text";
}

export function parseRolesProposeInput(
  args: Record<string, unknown> | null | undefined
): RolesProposeParseResult {
  const raw = args && typeof args === "object" ? args : {};
  const text = field(raw, "text", "documentText", "jobHint", "conversationLog", "freeText");
  const transcript = field(raw, "transcript", "voiceTranscript", "audioTranscript");
  const location = field(
    raw,
    "location",
    "driveLocation",
    "supabaseLocation",
    "opsDocLocation"
  );

  if (!text && !transcript && !location) {
    return {
      ok: false,
      code: "content_required",
      message:
        "工程の正本が必要です。ドキュメント本文・場所・音声書き起こし・自由テキストのいずれか一つで足ります。Drive は必須ではありません。",
      driveRequired: false,
    };
  }

  const combinedParts: string[] = [];
  if (text) combinedParts.push(text);
  if (transcript) combinedParts.push(transcript);
  if (location) combinedParts.push(`場所: ${location}`);

  return {
    ok: true,
    value: {
      sourceType: inferSourceType(raw, { text, transcript, location }),
      text,
      location,
      transcript,
      combinedText: combinedParts.join("\n\n"),
      driveWired: false,
    },
  };
}
