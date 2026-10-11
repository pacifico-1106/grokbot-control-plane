/**
 * Slack Web API body encoding by method (hotfix: users.info sent as JSON → user_not_found).
 */
import { describe, expect, test } from "bun:test";
import { SLACK_FORM_METHODS, slackRequestBody } from "@/lib/slack/web-api-request";

describe("slackRequestBody", () => {
  test("users.info → form-encoded, user in the body", () => {
    const req = slackRequestBody("users.info", { user: "U07U3V8040K" });
    expect(req.contentType).toBe("application/x-www-form-urlencoded");
    expect(req.body).toBe("user=U07U3V8040K");
    expect(new URLSearchParams(req.body).get("user")).toBe("U07U3V8040K");
  });

  test("auth.test → form-encoded, empty body", () => {
    const req = slackRequestBody("auth.test", {});
    expect(req.contentType).toBe("application/x-www-form-urlencoded");
    expect(req.body).toBe("");
  });

  test("read methods that do not accept JSON are all form", () => {
    for (const method of [
      "users.info",
      "users.lookupByEmail",
      "users.conversations",
      "conversations.info",
      "conversations.members",
      "team.info",
      "auth.test",
    ]) {
      expect(SLACK_FORM_METHODS.has(method)).toBe(true);
      expect(slackRequestBody(method, { a: "1" }).contentType).toBe("application/x-www-form-urlencoded");
    }
  });

  test("write methods stay JSON (conversations.open, chat.postMessage)", () => {
    const open = slackRequestBody("conversations.open", { users: "U1", return_im: true });
    expect(open.contentType).toBe("application/json; charset=utf-8");
    expect(JSON.parse(open.body)).toEqual({ users: "U1", return_im: true });
    const post = slackRequestBody("chat.postMessage", { channel: "D1", text: "設定しました & ok=1" });
    expect(post.contentType).toBe("application/json; charset=utf-8");
    expect(JSON.parse(post.body)).toEqual({ channel: "D1", text: "設定しました & ok=1" });
  });

  test("a token argument is never put in the body (form or JSON)", () => {
    const form = slackRequestBody("users.info", { user: "U1", token: "xoxb-SECRET" });
    expect(form.body).not.toContain("xoxb-SECRET");
    expect(new URLSearchParams(form.body).has("token")).toBe(false);
    const json = slackRequestBody("chat.postMessage", { channel: "D1", text: "t", token: "xoxb-SECRET" });
    expect(json.body).not.toContain("xoxb-SECRET");
  });

  test("form values are encoded; undefined / null are dropped", () => {
    const req = slackRequestBody("users.lookupByEmail", { email: "a+b@example.com", extra: undefined, none: null });
    expect(req.body).toBe("email=a%2Bb%40example.com");
  });
});
