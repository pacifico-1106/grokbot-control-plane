/**
 * Employee badge voice (character / register).
 * Lives next to scopes and manager. Audience sets a FLOOR: external
 * (including unknown) cannot drop below polite, even if the badge is frank.
 * Forbidden-word scan is cheap and fail-closed — not DLP, not NLP.
 */
import type {
  Audience,
  EffectiveVoice,
  EmployeeVoice,
  VoiceEndings,
  VoiceRegister,
  VoiceTemplate,
} from "@/lib/types";

/** Documented polite-template forbidden list (keep small). */
export const POLITE_FORBIDDEN = [
  "了解",
  "ぶっちゃけ",
  "ヤバい",
  "マジで",
  "ごめん",
] as const;

export const POLITE_SIGN_OFF = "何卒よろしくお願いいたします";

export const VOICE_FORBIDDEN_CODE = "voice_forbidden_phrase";
export const VOICE_FORBIDDEN_MESSAGE_JA =
  "対外（または社員の声）の禁止語が含まれています。";
export const WHOAMI_VOICE_NOTE_JA =
  "対外の相手では丁寧が下限です。モデルは whoami の voice に従います。宛先が社外のときは Gateway が丁寧に引き上げます。";

export const POLITE_VOICE: EmployeeVoice = {
  template: "polite",
  register: "polite",
  endings: "desumasu",
  forbidden: [...POLITE_FORBIDDEN],
  signOff: POLITE_SIGN_OFF,
  externalFloor: "polite",
};

export const FRANK_VOICE: EmployeeVoice = {
  template: "frank",
  register: "frank",
  endings: "either",
  forbidden: [],
  signOff: null,
  externalFloor: "polite",
};

const TEMPLATES: VoiceTemplate[] = ["polite", "frank", "custom"];
const REGISTERS: VoiceRegister[] = ["polite", "frank"];
const ENDINGS: VoiceEndings[] = ["desumasu", "da-dearu", "either"];

function isTemplate(value: unknown): value is VoiceTemplate {
  return typeof value === "string" && TEMPLATES.includes(value as VoiceTemplate);
}
function isRegister(value: unknown): value is VoiceRegister {
  return typeof value === "string" && REGISTERS.includes(value as VoiceRegister);
}
function isEndings(value: unknown): value is VoiceEndings {
  return typeof value === "string" && ENDINGS.includes(value as VoiceEndings);
}

export function uniqueTrimmedPhrases(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of values) {
    const phrase = String(item ?? "").trim();
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    out.push(phrase);
  }
  return out;
}

export function defaultVoice(): EmployeeVoice {
  return { ...POLITE_VOICE, forbidden: [...POLITE_VOICE.forbidden] };
}

export function voiceFromTemplate(template: VoiceTemplate): EmployeeVoice {
  if (template === "frank") {
    return { ...FRANK_VOICE, forbidden: [...FRANK_VOICE.forbidden] };
  }
  if (template === "custom") {
    const polite = defaultVoice();
    return { ...polite, template: "custom" };
  }
  return defaultVoice();
}

/**
 * Radio helper: polite/frank replace the badge; custom keeps current fields.
 */
export function applyVoiceTemplate(
  template: VoiceTemplate,
  previous?: EmployeeVoice | null
): EmployeeVoice {
  if (template === "polite" || template === "frank") {
    return voiceFromTemplate(template);
  }
  const base = previous ? normalizeVoice(previous) : defaultVoice();
  return { ...base, template: "custom", externalFloor: "polite" };
}

export function normalizeVoice(raw: unknown): EmployeeVoice {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaultVoice();
  }
  const row = raw as Record<string, unknown>;
  const template = isTemplate(row.template) ? row.template : "polite";
  const preset = template === "frank" ? FRANK_VOICE : POLITE_VOICE;
  const register = isRegister(row.register) ? row.register : preset.register;
  const endings = isEndings(row.endings) ? row.endings : preset.endings;
  const forbidden = Array.isArray(row.forbidden)
    ? uniqueTrimmedPhrases(row.forbidden)
    : [...preset.forbidden];
  let signOff: string | null;
  if (row.signOff === null) {
    signOff = null;
  } else if (typeof row.signOff === "string") {
    const trimmed = row.signOff.trim();
    signOff = trimmed || null;
  } else if (row.signOff === undefined) {
    signOff = preset.signOff;
  } else {
    signOff = preset.signOff;
  }
  return {
    template,
    register,
    endings,
    forbidden,
    signOff,
    externalFloor: "polite",
  };
}

export function effectiveVoice(
  badge: EmployeeVoice | unknown,
  audience: Audience | "internal" | "external"
): EffectiveVoice {
  const voice = normalizeVoice(badge);
  const effectiveAudience = audience === "internal" ? "internal" : "external";
  if (effectiveAudience === "internal") {
    return { ...voice, forbidden: [...voice.forbidden], floorApplied: false };
  }
  return {
    template: voice.template,
    register: "polite",
    endings: "desumasu",
    forbidden: uniqueTrimmedPhrases([...voice.forbidden, ...POLITE_VOICE.forbidden]),
    signOff: voice.signOff || POLITE_SIGN_OFF,
    externalFloor: "polite",
    floorApplied: true,
  };
}

/** Concatenate args.text / body / message (outbound conversation copy only). */
export function outboundConversationText(
  args: Record<string, unknown> | undefined | null
): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const key of ["text", "body", "message"] as const) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) parts.push(value);
  }
  return parts.join("\n");
}

/**
 * Case-sensitive JP phrase scan. Phrases are trimmed; haystack is not lowercased.
 */
export function findForbiddenPhrase(
  text: string,
  forbidden: string[] | undefined | null
): string | null {
  const haystack = text.trim();
  if (!haystack) return null;
  for (const raw of forbidden ?? []) {
    const phrase = raw.trim();
    if (!phrase) continue;
    if (haystack.includes(phrase)) return phrase;
  }
  return null;
}

export const VOICE_TEMPLATE_LABELS_JA: Record<VoiceTemplate, string> = {
  polite: "丁寧（対外向け）",
  frank: "率直（社内）",
  custom: "カスタム",
};

export const VOICE_ENDINGS_LABELS_JA: Record<VoiceEndings, string> = {
  desumasu: "ですます",
  "da-dearu": "だ・である",
  either: "どちらでも",
};

export const VOICE_REGISTER_LABELS_JA: Record<VoiceRegister, string> = {
  polite: "丁寧",
  frank: "率直",
};

export const VOICE_HELPER_JA =
  "対外の相手では丁寧が下限です。モデルは whoami の voice に従います。";
