import { describe, expect, test } from "bun:test";
import {
  FRANK_VOICE,
  POLITE_FORBIDDEN,
  POLITE_SIGN_OFF,
  POLITE_VOICE,
  defaultVoice,
  effectiveVoice,
  findForbiddenPhrase,
  normalizeVoice,
  outboundConversationText,
} from "./voice";

describe("employee badge voice", () => {
  test("polite template defaults", () => {
    const voice = defaultVoice();
    expect(voice).toEqual(POLITE_VOICE);
    expect(voice.template).toBe("polite");
    expect(voice.register).toBe("polite");
    expect(voice.endings).toBe("desumasu");
    expect(voice.forbidden).toEqual([...POLITE_FORBIDDEN]);
    expect(voice.signOff).toBe(POLITE_SIGN_OFF);
    expect(voice.externalFloor).toBe("polite");
    expect(normalizeVoice(undefined)).toEqual(POLITE_VOICE);
    expect(normalizeVoice(null)).toEqual(POLITE_VOICE);
  });

  test("frank employee + external audience → polite floor and extra forbidden", () => {
    const effective = effectiveVoice(FRANK_VOICE, "external");
    expect(effective.register).toBe("polite");
    expect(effective.endings).toBe("desumasu");
    expect(effective.floorApplied).toBe(true);
    expect(effective.signOff).toBe(POLITE_SIGN_OFF);
    for (const phrase of POLITE_FORBIDDEN) {
      expect(effective.forbidden).toContain(phrase);
    }
    expect(effectiveVoice(FRANK_VOICE, "unknown").register).toBe("polite");
  });

  test("frank + internal → frank remains", () => {
    const effective = effectiveVoice(FRANK_VOICE, "internal");
    expect(effective.register).toBe("frank");
    expect(effective.endings).toBe("either");
    expect(effective.forbidden).toEqual([]);
    expect(effective.signOff).toBeNull();
    expect(effective.floorApplied).toBe(false);
  });

  test("forbidden scan is case-sensitive and trims phrases", () => {
    expect(findForbiddenPhrase("  了解しました  ", ["了解"])).toBe("了解");
    expect(findForbiddenPhrase("了解", [" 了解 "])).toBe("了解");
    expect(findForbiddenPhrase("承知しました", ["了解"])).toBeNull();
    expect(outboundConversationText({ text: "本文", body: "  ", message: "追記" })).toContain("本文");
    expect(outboundConversationText({ tool: "skip" })).toBe("");
  });
});
