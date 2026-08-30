import { afterEach, describe, expect, test } from "bun:test";
import {
  parseSnsSurface,
  publishSnsPost,
  snsCredentialsPresent,
  snsSurfaceLabelJa,
} from "./sns";

const originalFetch = globalThis.fetch;
const savedEnv = {
  xUser: process.env.X_USER_ACCESS_TOKEN,
  xBearer: process.env.X_BEARER_TOKEN,
  liToken: process.env.LINKEDIN_ACCESS_TOKEN,
  liUrn: process.env.LINKEDIN_AUTHOR_URN,
  note: process.env.NOTE_API_TOKEN,
  yt: process.env.YOUTUBE_ACCESS_TOKEN,
};

function restore() {
  globalThis.fetch = originalFetch;
  const apply = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  apply("X_USER_ACCESS_TOKEN", savedEnv.xUser);
  apply("X_BEARER_TOKEN", savedEnv.xBearer);
  apply("LINKEDIN_ACCESS_TOKEN", savedEnv.liToken);
  apply("LINKEDIN_AUTHOR_URN", savedEnv.liUrn);
  apply("NOTE_API_TOKEN", savedEnv.note);
  apply("YOUTUBE_ACCESS_TOKEN", savedEnv.yt);
}

afterEach(restore);

describe("sns adapter", () => {
  test("parses x aliases and labels", () => {
    expect(parseSnsSurface("x")).toBe("x");
    expect(parseSnsSurface("twitter")).toBe("x");
    expect(parseSnsSurface("LinkedIn")).toBe("linkedin");
    expect(parseSnsSurface("slack")).toBe(null);
    expect(snsSurfaceLabelJa("x")).toBe("X");
    expect(snsSurfaceLabelJa("youtube")).toBe("YouTube");
  });

  test("missing surface / body returns Japanese error", async () => {
    const none = await publishSnsPost({ text: "hello" });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toContain("媒体が指定されていません");
    const empty = await publishSnsPost({ surface: "x", text: "  " });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("投稿本文が空");
  });

  test("missing X credentials does not call fetch", async () => {
    delete process.env.X_USER_ACCESS_TOKEN;
    delete process.env.X_BEARER_TOKEN;
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return Response.json({ data: { id: "1" } });
    }) as typeof fetch;
    expect(snsCredentialsPresent("x")).toBe(false);
    const result = await publishSnsPost({ surface: "x", text: "公開する本文" });
    expect(called).toBe(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("認証情報が未設定");
      expect(result.error).toContain("X");
      expect(result.surface).toBe("x");
    }
  });

  test("X official POST /2/tweets when user token is set", async () => {
    process.env.X_USER_ACCESS_TOKEN = "x-user-token";
    let url = "";
    let auth = "";
    let payload: Record<string, unknown> = {};
    globalThis.fetch = (async (input, init) => {
      url = String(input);
      auth = String((init?.headers as Record<string, string> | undefined)?.authorization || "");
      payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      return Response.json({ data: { id: "1234567890" } });
    }) as typeof fetch;
    const result = await publishSnsPost({ surface: "x", text: "八坂の投稿" });
    expect(result).toEqual({
      ok: true,
      delivery: "sns",
      surface: "x",
      id: "1234567890",
    });
    expect(url).toBe("https://api.x.com/2/tweets");
    expect(auth).toBe("Bearer x-user-token");
    expect(payload.text).toBe("八坂の投稿");
  });

  test("note/youtube stay unwired even with a token", async () => {
    process.env.NOTE_API_TOKEN = "note-token";
    process.env.YOUTUBE_ACCESS_TOKEN = "yt-token";
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return Response.json({});
    }) as typeof fetch;
    const note = await publishSnsPost({ surface: "note", text: "本文" });
    const yt = await publishSnsPost({ surface: "youtube", text: "本文" });
    expect(called).toBe(0);
    expect(note.ok).toBe(false);
    expect(yt.ok).toBe(false);
    if (!note.ok) expect(note.error).toContain("公式投稿APIは未配線");
    if (!yt.ok) expect(yt.error).toContain("YouTube");
  });
});
