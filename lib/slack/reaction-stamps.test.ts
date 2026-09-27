/**
 * Tests for Slack reaction stamps feature.
 *
 * Flag-gated by SLACK_REACTION_STAMPS (default OFF).
 * Required scope: reactions:write. Degrades silently if missing.
 */
import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import {
  addReaction,
  removeReaction,
  transitionReaction,
  addLookingReaction,
  addCompletedReaction,
  addWaitingApprovalReaction,
  REACTION_EMOJI,
  resetScopeMissingLog,
} from "./reaction-stamps";

const makeMockFetch = (body: unknown, status = 200) =>
  (() =>
    Promise.resolve({
      status,
      json: () => Promise.resolve(body),
    })) as typeof fetch;

describe("addReaction", () => {
  const originalEnv = process.env.SLACK_REACTION_STAMPS;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetScopeMissingLog();
  });

  afterEach(() => {
    process.env.SLACK_REACTION_STAMPS = originalEnv;
    globalThis.fetch = originalFetch;
  });

  test("returns added=false when flag is OFF", async () => {
    process.env.SLACK_REACTION_STAMPS = "";
    const result = await addReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toBe(false);
    }
  });

  test("returns error when channel is missing", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    const result = await addReaction({
      orgId: "org_123",
      channel: "",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing_channel_or_timestamp");
    }
  });

  test("returns error when timestamp is missing", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    const result = await addReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "",
      reaction: "looking",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing_channel_or_timestamp");
    }
  });

  test("returns added=false when no token available", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    const result = await addReaction({
      orgId: "org_nonexistent",
      channel: "C123",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toBe(false);
    }
  });

  test("handles already_reacted response gracefully", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    globalThis.fetch = makeMockFetch({ ok: false, error: "already_reacted" }) as typeof fetch;

    const result = await addReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
      reaction: "completed",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toBe(false);
      expect(result.alreadyReacted).toBe(true);
    }

    delete process.env.SLACK_BOT_TOKEN;
  });

  test("degrades silently when missing_scope", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    globalThis.fetch = makeMockFetch({ ok: false, error: "missing_scope" }) as typeof fetch;

    const result = await addReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toBe(false);
      expect(result.degraded).toBe(true);
    }

    delete process.env.SLACK_BOT_TOKEN;
  });

  test("handles channel_not_found gracefully", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    globalThis.fetch = makeMockFetch({ ok: false, error: "channel_not_found" }) as typeof fetch;

    const result = await addReaction({
      orgId: "org_123",
      channel: "C999",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toBe(false);
    }

    delete process.env.SLACK_BOT_TOKEN;
  });

  test("handles not_in_channel gracefully", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    globalThis.fetch = makeMockFetch({ ok: false, error: "not_in_channel" }) as typeof fetch;

    const result = await addReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toBe(false);
    }

    delete process.env.SLACK_BOT_TOKEN;
  });

  test("handles restricted_action gracefully (Slack Connect)", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    globalThis.fetch = makeMockFetch({ ok: false, error: "restricted_action" }) as typeof fetch;

    const result = await addReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toBe(false);
    }

    delete process.env.SLACK_BOT_TOKEN;
  });

  test("successfully adds reaction", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    globalThis.fetch = makeMockFetch({ ok: true }) as typeof fetch;

    const result = await addReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toBe(true);
    }

    delete process.env.SLACK_BOT_TOKEN;
  });
});

describe("removeReaction", () => {
  const originalEnv = process.env.SLACK_REACTION_STAMPS;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetScopeMissingLog();
  });

  afterEach(() => {
    process.env.SLACK_REACTION_STAMPS = originalEnv;
    globalThis.fetch = originalFetch;
  });

  test("returns removed=false when flag is OFF", async () => {
    process.env.SLACK_REACTION_STAMPS = "";
    const result = await removeReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.removed).toBe(false);
    }
  });

  test("handles no_reaction response gracefully", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    globalThis.fetch = makeMockFetch({ ok: false, error: "no_reaction" }) as typeof fetch;

    const result = await removeReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.removed).toBe(false);
      expect(result.notReacted).toBe(true);
    }

    delete process.env.SLACK_BOT_TOKEN;
  });

  test("successfully removes reaction", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    globalThis.fetch = makeMockFetch({ ok: true }) as typeof fetch;

    const result = await removeReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.removed).toBe(true);
    }

    delete process.env.SLACK_BOT_TOKEN;
  });
});

describe("transitionReaction", () => {
  const originalEnv = process.env.SLACK_REACTION_STAMPS;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    process.env.SLACK_REACTION_STAMPS = originalEnv;
    globalThis.fetch = originalFetch;
  });

  test("removes old reaction and adds new one", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    globalThis.fetch = makeMockFetch({ ok: true }) as typeof fetch;

    const result = await transitionReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
      from: "looking",
      to: "completed",
    });

    expect(result.removeResult.ok).toBe(true);
    expect(result.addResult.ok).toBe(true);
    if (result.removeResult.ok && result.addResult.ok) {
      expect(result.removeResult.removed).toBe(true);
      expect(result.addResult.added).toBe(true);
    }

    delete process.env.SLACK_BOT_TOKEN;
  });
});

describe("helper functions", () => {
  const originalEnv = process.env.SLACK_REACTION_STAMPS;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    process.env.SLACK_REACTION_STAMPS = originalEnv;
    globalThis.fetch = originalFetch;
  });

  test("addLookingReaction adds eyes emoji", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

    let calledEmoji = "";
    globalThis.fetch = ((url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calledEmoji = body.name;
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      });
    }) as typeof fetch;

    await addLookingReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
    });

    expect(calledEmoji).toBe(REACTION_EMOJI.looking);

    delete process.env.SLACK_BOT_TOKEN;
  });

  test("addCompletedReaction transitions from looking to check mark", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

    const calledEmojis: string[] = [];
    globalThis.fetch = ((url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calledEmojis.push(body.name);
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      });
    }) as typeof fetch;

    await addCompletedReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
    });

    expect(calledEmojis).toContain(REACTION_EMOJI.looking);
    expect(calledEmojis).toContain(REACTION_EMOJI.completed);

    delete process.env.SLACK_BOT_TOKEN;
  });

  test("addWaitingApprovalReaction transitions from looking to hourglass", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";

    const calledEmojis: string[] = [];
    globalThis.fetch = ((url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calledEmojis.push(body.name);
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      });
    }) as typeof fetch;

    await addWaitingApprovalReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
    });

    expect(calledEmojis).toContain(REACTION_EMOJI.looking);
    expect(calledEmojis).toContain(REACTION_EMOJI.waiting_approval);

    delete process.env.SLACK_BOT_TOKEN;
  });
});

describe("INVARIANT: Flag OFF preserves existing behavior", () => {
  const originalEnv = process.env.SLACK_REACTION_STAMPS;

  afterEach(() => {
    process.env.SLACK_REACTION_STAMPS = originalEnv;
  });

  test("INVARIANT: no reactions added when SLACK_REACTION_STAMPS is empty", async () => {
    process.env.SLACK_REACTION_STAMPS = "";
    const result = await addReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toBe(false);
    }
  });

  test("INVARIANT: no reactions added when SLACK_REACTION_STAMPS is undefined", async () => {
    delete process.env.SLACK_REACTION_STAMPS;
    const result = await addReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toBe(false);
    }
  });

  test("INVARIANT: no reactions added when SLACK_REACTION_STAMPS is false", async () => {
    process.env.SLACK_REACTION_STAMPS = "false";
    const result = await addReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toBe(false);
    }
  });
});

describe("INVARIANT: Silent degradation on scope errors", () => {
  const originalEnv = process.env.SLACK_REACTION_STAMPS;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetScopeMissingLog();
  });

  afterEach(() => {
    process.env.SLACK_REACTION_STAMPS = originalEnv;
    globalThis.fetch = originalFetch;
  });

  test("INVARIANT: missing_scope error degrades silently (no throw)", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    globalThis.fetch = makeMockFetch({ ok: false, error: "missing_scope" }) as typeof fetch;

    const result = await addReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.degraded).toBe(true);
    }

    delete process.env.SLACK_BOT_TOKEN;
  });

  test("INVARIANT: not_allowed_token_type error degrades silently", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    globalThis.fetch = makeMockFetch({ ok: false, error: "not_allowed_token_type" }) as typeof fetch;

    const result = await addReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.degraded).toBe(true);
    }

    delete process.env.SLACK_BOT_TOKEN;
  });
});

describe("INVARIANT: No reactions on inaccessible channels", () => {
  const originalEnv = process.env.SLACK_REACTION_STAMPS;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    process.env.SLACK_REACTION_STAMPS = originalEnv;
    globalThis.fetch = originalFetch;
  });

  test("INVARIANT: channel_not_found returns ok without adding", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    globalThis.fetch = makeMockFetch({ ok: false, error: "channel_not_found" }) as typeof fetch;

    const result = await addReaction({
      orgId: "org_123",
      channel: "C_NONEXISTENT",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toBe(false);
    }

    delete process.env.SLACK_BOT_TOKEN;
  });

  test("INVARIANT: not_in_channel returns ok without adding", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    globalThis.fetch = makeMockFetch({ ok: false, error: "not_in_channel" }) as typeof fetch;

    const result = await addReaction({
      orgId: "org_123",
      channel: "C_NOT_MEMBER",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toBe(false);
    }

    delete process.env.SLACK_BOT_TOKEN;
  });

  test("INVARIANT: message_not_found returns ok without adding", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    globalThis.fetch = makeMockFetch({ ok: false, error: "message_not_found" }) as typeof fetch;

    const result = await addReaction({
      orgId: "org_123",
      channel: "C123",
      timestamp: "0000000000.000000",
      reaction: "looking",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toBe(false);
    }

    delete process.env.SLACK_BOT_TOKEN;
  });

  test("INVARIANT: restricted_action (Slack Connect) returns ok without adding", async () => {
    process.env.SLACK_REACTION_STAMPS = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    globalThis.fetch = makeMockFetch({ ok: false, error: "restricted_action" }) as typeof fetch;

    const result = await addReaction({
      orgId: "org_123",
      channel: "C_SLACK_CONNECT",
      timestamp: "1234567890.123456",
      reaction: "looking",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.added).toBe(false);
    }

    delete process.env.SLACK_BOT_TOKEN;
  });
});

describe("REACTION_EMOJI constants", () => {
  test("looking emoji is eyes", () => {
    expect(REACTION_EMOJI.looking).toBe("eyes");
  });

  test("completed emoji is white_check_mark", () => {
    expect(REACTION_EMOJI.completed).toBe("white_check_mark");
  });

  test("waiting_approval emoji is hourglass_flowing_sand", () => {
    expect(REACTION_EMOJI.waiting_approval).toBe("hourglass_flowing_sand");
  });
});
