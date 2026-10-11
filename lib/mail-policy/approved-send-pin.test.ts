import { describe, expect, test } from "bun:test";
import {
  buildMailSendPin,
  canonicalJson,
  checkApprovedMailSendPin,
  collectPinnedMailFields,
  parseMailSendPin,
  type MailSendPinBody,
} from "@/lib/mail-policy/approved-send-pin";

const APPROVED: MailSendPinBody = {
  args: {
    to: "buyer@customer.example",
    cc: ["a@customer.example", "b@customer.example"],
    bcc: "hidden@customer.example",
    subject: "件名",
    body: "本文",
    attachments: [{ name: "q.pdf", size: 1 }],
  },
  email: "top@customer.example",
  conversation: { surface: "email", email: "conv@customer.example", threadId: "t1" },
};

const check = (approved: MailSendPinBody, request: MailSendPinBody) =>
  checkApprovedMailSendPin({ metadata: { mailSendPin: buildMailSendPin(approved) }, body: request });

describe("canonicalJson", () => {
  test("object key order does not matter, array order does", () => {
    expect(canonicalJson({ b: 1, a: [2, 1] })).toBe(canonicalJson({ a: [2, 1], b: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
  test("strings are exact (whitespace / case kept)", () => {
    expect(canonicalJson("A@x.example")).not.toBe(canonicalJson("a@x.example"));
    expect(canonicalJson("a@x.example ")).not.toBe(canonicalJson("a@x.example"));
  });
});

describe("collectPinnedMailFields", () => {
  test("every args key, top-level email and conversation.email only", () => {
    expect([...collectPinnedMailFields(APPROVED).keys()].sort()).toEqual([
      "args.attachments", "args.bcc", "args.body", "args.cc", "args.subject", "args.to", "conversation.email", "email",
    ]);
  });
  test("null and undefined mean not set", () => {
    expect(collectPinnedMailFields({ args: { cc: null, bcc: undefined }, email: null }).size).toBe(0);
  });
  test("a non-object args is pinned as a whole", () => {
    expect([...collectPinnedMailFields({ args: "to=x" }).keys()]).toEqual(["args"]);
  });
});

describe("checkApprovedMailSendPin", () => {
  test("identical request → exact_match", () => {
    expect(check(APPROVED, structuredClone(APPROVED))).toEqual({ ok: true, mode: "exact_match" });
  });

  test("no mail fields at all → approved_content (send the approved mail as-is)", () => {
    expect(check(APPROVED, {})).toEqual({ ok: true, mode: "approved_content" });
    expect(check(APPROVED, { args: {} })).toEqual({ ok: true, mode: "approved_content" });
    expect(check(APPROVED, { conversation: { surface: "email" } })).toEqual({ ok: true, mode: "approved_content" });
  });

  test("other conversation fields are not mail content", () => {
    const request = structuredClone(APPROVED);
    (request.conversation as Record<string, unknown>).threadId = "t2";
    expect(check(APPROVED, request).ok).toBe(true);
  });

  test("missing / unknown-version / malformed pin → approved_send_pin_missing", () => {
    for (const metadata of [{}, { mailSendPin: null }, { mailSendPin: { v: 2, alg: "sha256", fields: {} } }, { mailSendPin: { v: 1, alg: "sha256", fields: { "args.to": "zz" } } }, { mailSendPin: "x" }]) {
      expect(checkApprovedMailSendPin({ metadata, body: APPROVED })).toEqual({ ok: false, code: "approved_send_pin_missing" });
      expect(checkApprovedMailSendPin({ metadata, body: {} })).toEqual({ ok: false, code: "approved_send_pin_missing" });
    }
  });

  test("an approval pinned with no fields still rejects a request that brings content", () => {
    const r = check({}, { args: { to: "x@customer.example" } });
    expect(r).toEqual({ ok: false, code: "approved_send_content_mismatch", mismatchedFields: ["args.to"], mismatchCount: 1 });
  });

  test("prototype-like keys are just fields", () => {
    const approved = { args: JSON.parse('{"__proto__": {"x": 1}, "to": "a@customer.example"}') };
    expect(check(approved, JSON.parse(JSON.stringify(approved))).ok).toBe(true);
    const r = check(approved, { args: { to: "a@customer.example" } });
    expect(r.ok).toBe(false);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  test("reported field names are capped (count stays exact)", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 80; i += 1) many[`k${String(i).padStart(2, "0")}${"x".repeat(i === 0 ? 200 : 0)}`] = "v";
    const r = check({}, { args: many });
    expect(r.ok).toBe(false);
    if (!r.ok && r.code === "approved_send_content_mismatch") {
      expect(r.mismatchCount).toBe(80);
      expect(r.mismatchedFields.length).toBe(50);
      expect(r.mismatchedFields[0].length).toBeLessThanOrEqual(81);
    }
  });

  test("the pin holds digests only", () => {
    const pin = buildMailSendPin(APPROVED);
    expect(parseMailSendPin({ mailSendPin: pin })).toEqual(pin);
    expect(JSON.stringify(pin)).not.toContain("customer.example");
    expect(JSON.stringify(pin)).not.toContain("本文");
  });

  test("seeded fuzz: accepted iff the request equals the approval field-by-field (canonical)", () => {
    let seed = 20261004;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    const values: unknown[] = ["a@customer.example", "A@customer.example", "a@customer.example ", ["a@customer.example"], ["a@customer.example", "b@customer.example"], ["b@customer.example", "a@customer.example"], "", 0, false, { name: "x" }, null, undefined];
    const keys = ["to", "recipient", "email", "cc", "bcc", "subject", "title", "body", "text", "from", "replyTo", "attachments"];
    const gen = (): MailSendPinBody => {
      const args: Record<string, unknown> = {};
      for (const key of keys) if (rnd() < 0.4) args[key] = pick(values);
      const body: MailSendPinBody = { args };
      if (rnd() < 0.2) body.email = pick(values);
      if (rnd() < 0.2) body.conversation = { email: pick(values) };
      return body;
    };
    const canonicalFields = (b: MailSendPinBody) => canonicalJson(Object.fromEntries(collectPinnedMailFields(b)));
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const approved = gen();
      const request = rnd() < 0.3 ? structuredClone(approved) : gen();
      const r = check(approved, request);
      const requestEmpty = collectPinnedMailFields(request).size === 0;
      const same = canonicalFields(approved) === canonicalFields(request);
      expect(r.ok).toBe(same || requestEmpty);
      if (r.ok) accepted += 1;
      else rejected += 1;
    }
    expect(accepted).toBeGreaterThan(1000);
    expect(rejected).toBeGreaterThan(1000);
  });
});
