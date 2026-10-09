/**
 * #285 follow-up (木村 2026-10-09 21:27 JST), items 1–3.
 *
 * 1. ReDoS: the JWT regex was quadratic (1M chars of "eyJ" took ~114 s; also on
 *    main). Every pattern the detector runs gets an adversarial timing test at
 *    the per-string cap; the per-string cap is lowered and a whole-payload cap
 *    (characters + number of strings) is added.
 * 2. The weak AWS context keyword `secret` needs a word boundary
 *    (`secretary` / `secrets` are not context; `secret: <AWS key>` still blocks).
 * 3. The caps through all 4 paths: over a cap → refused, exactly one
 *    secret_detection.blocked audit row, no value characters.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { runGatewayInvoke } from "@/lib/gateway/invoke";
import { callStaffpassMcpTool } from "@/lib/mcp/tools";
import { queueAdminTool } from "@/lib/admin-mcp/queue";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { createConfigChangeRequest, type ConfigChangeDeps } from "@/lib/config-change-request/service";
import { listAuditEvents } from "@/lib/data/audit";
import * as det from "@/lib/security/secret-detector";
import { SECRET_DETECTION_BLOCKED } from "@/lib/security/secret-detection-audit";

// Generous but bounded: linear scans take a few ms here; quadratic ones take seconds to minutes.
const PER_PATTERN_MS = 1000;
const PER_STRING_MS = 1500;
const PER_PAYLOAD_MS = 4000;

const AWS_EX_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

type Catalog = ReadonlyArray<{ name: string; pattern: RegExp }>;
const catalog = (): Catalog => (det as unknown as { SECRET_DETECTOR_REGEXES_FOR_TEST: Catalog }).SECRET_DETECTOR_REGEXES_FOR_TEST;
const perStringCap = (): number => det.MAX_SCAN_LENGTH;
const payloadCaps = () => (det as unknown as { MAX_PAYLOAD_SCAN_CHARS: number; MAX_PAYLOAD_SCAN_STRINGS: number });

const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

/** Adversarial seeds per pattern: its literal prefix repeated, with near-miss tails. */
const SEEDS: Record<string, string[]> = {
  slack_token: ["xoxb-", "xoxb", "xox"],
  slack_webhook: ["hooks.slack.com/services/T", "hooks.slack.com/services/TA/B", "hooks.slack.com/services/"],
  openai_key: ["sk-", "sk-a", " sk-aaaaaaaaaaaaaaaaaaa"],
  openai_proj: ["sk-proj-", " sk-proj-aaaaaaaaaaaaaaaaaaa ", "sk-proj"],
  staffpass_employee: ["gb_emp_", "gb_emp_0123456789abcdef_", "gb_emp_0123456789abcdef_0"],
  staffpass_admin: ["gb_adm_", "gb_adm_0123456789abcdef_", "gb_adm_0123456789abcdef_0"],
  stripe_key: ["sk_live_", "sk_live_a", "sk_test_"],
  stripe_restricted: ["rk_live_", "rk_test_a", "rk_"],
  github_token: ["ghp_", "ghp_a", "gho_"],
  github_classic: ["ghp_", "ghp_a"],
  aws_access_key: ["AKIA", "AKIA0123456789ABCDE", "ASIA"],
  aws_secret_key: ["aB3/", "aB3+", "secret aB3 "],
  google_api_key: ["AIza", "AIzaaaaa"],
  bearer_token: ["Bearer ", "Bearer\t", "Bearer a"],
  jwt_token: ["eyJ", "eyJa.", "eyJa.eyJ", "eyJa.eyJa.", ".eyJ", "EYJ"],
  refresh_token: ["refresh_token:", "refresh_token: a", "refresh-token=", ":"],
  api_key_inline: ["api_key=", "api_key= a", "apikey:"],
  password_inline: ["password: ", "password:", ": ", "password:a "],
  secret_inline: ["secret: ", "secret:", "secret:a "],
  private_key_header: ["-----BEGIN ", "-----BEGIN RSA ", " "],
  base64_long_secret: ["A".repeat(63) + " ", "A".repeat(63) + "=", "A/"],
  hex_long_secret: ["a".repeat(63) + " ", "0"],
  card_visa: ["4", "4111111111111", "41111111111111 "],
  card_mastercard: ["5", "51", "5100000000000 "],
  card_amex: ["3", "34", "37000000000 "],
  card_discover: ["6011", "65", "6011000 "],
  card_jcb: ["35", "2131", "1800", "3530000 "],
  card_generic_16: ["1234-", "1234 1234 1234 ", "0"],
  card_generic_15: ["1234 123456 ", "0"],
  url_path_span: ["a.", "a-", "ab.cd/", "http://a.", "a.b:1/"],
  aws_secret_candidate: ["aB3/", "aB3/".repeat(10) + "=", "aB3/".repeat(10) + "_"],
  aws_secret_keyword: ["aws ", "aws_", "secret access ", "secret_access_"],
  aws_secret_context_weak: ["secret", "Secret", "SECRET", "clientSecret"],
  aws_access_key_id: ["AKIA", "ASIA0"],
  percent_run: ["%2", "%41", "%"],
  allowlist_email: ["a", "a@", "a.", "a@a."],
  allowlist_iso_date: ["2026-10-05", "0"],
  allowlist_short_upper: ["A"],
  bare_url: ["http://", "a"],
};

/** Generic adversarial shapes every pattern also gets. */
const GENERIC_SEEDS = ["a", "a1B2", "-", "_", ".", " ", "%", "\\n", "あ"];

function runRegex(re: RegExp, value: string): void {
  if (re.global) {
    for (const _ of value.matchAll(re)) void _;
  } else {
    re.test(value);
  }
}

describe("item 1: adversarial timing for every pattern the detector runs", () => {
  test("the catalog lists every pattern and each one has adversarial seeds", () => {
    const names = catalog().map((c) => c.name);
    expect(names.length).toBeGreaterThanOrEqual(30);
    for (const required of ["jwt_token", "aws_secret_key", "base64_long_secret", "card_visa", "url_path_span", "aws_secret_context_weak", "percent_run"]) {
      expect(names).toContain(required);
    }
    const missing = names.filter((n) => !SEEDS[n]);
    expect(missing).toEqual([]);
  });

  test(`each regex on its adversarial inputs at the per-string cap stays under ${PER_PATTERN_MS} ms`, () => {
    const n = perStringCap();
    const slow: string[] = [];
    for (const { name, pattern } of catalog()) {
      for (const seed of [...(SEEDS[name] ?? []), ...GENERIC_SEEDS]) {
        for (const value of [fill(seed, n), `${fill(seed, n - 1)}!`]) {
          const t0 = performance.now();
          runRegex(pattern, value);
          const ms = performance.now() - t0;
          if (ms > PER_PATTERN_MS) slow.push(`${name} × ${JSON.stringify(seed.slice(0, 12))}: ${ms.toFixed(0)} ms`);
        }
      }
    }
    expect(slow).toEqual([]);
  });

  test(`detectSecretInString on every adversarial input at the per-string cap stays under ${PER_STRING_MS} ms`, () => {
    const n = perStringCap();
    const seeds = [...new Set([...Object.values(SEEDS).flat(), ...GENERIC_SEEDS])];
    const slow: string[] = [];
    for (const seed of seeds) {
      const value = fill(seed, n);
      const t0 = performance.now();
      det.detectSecretInString(value, { fieldPath: "args.message" });
      const ms = performance.now() - t0;
      if (ms > PER_STRING_MS) slow.push(`${JSON.stringify(seed.slice(0, 12))}: ${ms.toFixed(0)} ms`);
    }
    expect(slow).toEqual([]);
  });

  test("1M characters of repeated 'eyJ' (the reported input) returns quickly", () => {
    const t0 = performance.now();
    const r = det.detectSecretInString(fill("eyJ", 1_000_000));
    const ms = performance.now() - t0;
    expect(r.ok).toBe(false); // over the per-string cap → refused without scanning
    expect(ms).toBeLessThan(PER_STRING_MS);
    // At exactly the cap it is scanned, also quickly.
    const t1 = performance.now();
    det.detectSecretInString(fill("eyJ", perStringCap()));
    expect(performance.now() - t1).toBeLessThan(PER_STRING_MS);
  });

  test("the JWT rule keeps its meaning (same matches as before, linear)", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    for (const v of [jwt, `token=${jwt}`, `x${jwt}`, `prefix_${jwt}`, `abc-${jwt} end`, jwt.toUpperCase(), `Authorization:${jwt}`]) {
      const r = det.detectSecretInPayload({ args: { message: v } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(["jwt_token", "bearer_token"]).toContain(r.pattern);
    }
    for (const v of ["eyJ", "eyJa.eyJ.x", "eyJa.eyJa.", "eyJa..eyJa.b", "eyJ.eyJa.b", "aeyJ.eyJa.b x", "eyJa.xeyJa.b"]) {
      expect(det.detectSecretInString(v).ok).toBe(true);
    }
    // In-run eyJ (not at the start of the first segment) still counts, as before.
    expect(det.detectSecretInString("zzzeyJa.eyJb.c").ok).toBe(false);
  });

  test("the per-string cap is lowered from 1M and the payload caps exist", () => {
    expect(perStringCap()).toBeLessThan(1_000_000);
    expect(perStringCap()).toBeGreaterThanOrEqual(100_000);
    const caps = payloadCaps();
    expect(typeof caps.MAX_PAYLOAD_SCAN_CHARS).toBe("number");
    expect(typeof caps.MAX_PAYLOAD_SCAN_STRINGS).toBe("number");
    expect(caps.MAX_PAYLOAD_SCAN_CHARS).toBeGreaterThanOrEqual(perStringCap());
  });

  test(`worst-case payloads just under the payload caps stay under ${PER_PAYLOAD_MS} ms`, () => {
    const { MAX_PAYLOAD_SCAN_CHARS, MAX_PAYLOAD_SCAN_STRINGS } = payloadCaps();
    const per = perStringCap();
    const slow: string[] = [];
    for (const seed of ["eyJ", "a1B2", "aB3/", "A".repeat(63) + " ", "%41", "\\n", "4", "a.", "secret aB3 "]) {
      const parts = Math.floor(MAX_PAYLOAD_SCAN_CHARS / per);
      const payload = { args: Object.fromEntries(Array.from({ length: parts }, (_, i) => [`f${i}`, fill(seed, per - 10)])) };
      const t0 = performance.now();
      const r = det.detectSecretInPayload(payload);
      const ms = performance.now() - t0;
      expect(r.ok === false && r.pattern === "payload_too_large_to_scan").toBe(false);
      if (ms > PER_PAYLOAD_MS) slow.push(`${JSON.stringify(seed.slice(0, 8))}: ${ms.toFixed(0)} ms`);
    }
    // Many small strings (per-string overhead), just under the count cap.
    const many = Array.from({ length: MAX_PAYLOAD_SCAN_STRINGS - 10 }, (_, i) => `aB3/${i}`.padEnd(40, "x"));
    const t0 = performance.now();
    det.detectSecretInPayload({ args: { list: many } });
    const ms = performance.now() - t0;
    if (ms > PER_PAYLOAD_MS) slow.push(`many strings: ${ms.toFixed(0)} ms`);
    expect(slow).toEqual([]);
  });

  test("over a payload cap → refused without scanning, no value characters", () => {
    const { MAX_PAYLOAD_SCAN_CHARS, MAX_PAYLOAD_SCAN_STRINGS } = payloadCaps();
    const per = perStringCap();
    const parts = Math.floor(MAX_PAYLOAD_SCAN_CHARS / per) + 1;
    const big = { args: Object.fromEntries(Array.from({ length: parts }, (_, i) => [`f${i}`, fill("Qz7Kp2", per)])) };
    const r1 = det.detectSecretInPayload(big);
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.pattern).toBe("payload_too_large_to_scan");
      expect(r1.redactedPreview).toBe("[redacted]");
      expect(JSON.stringify(r1)).not.toContain("Qz7Kp2");
    }
    const r2 = det.detectSecretInPayload({ list: Array.from({ length: MAX_PAYLOAD_SCAN_STRINGS + 1 }, () => "ok") });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.pattern).toBe("payload_too_large_to_scan");
    // Keys count too (a payload of empty strings under many keys).
    const keys = Object.fromEntries(Array.from({ length: MAX_PAYLOAD_SCAN_STRINGS + 1 }, (_, i) => [`k${i}`, 1]));
    const r3 = det.detectSecretInPayload(keys);
    expect(r3.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("item 2: word boundary for the weak keyword `secret`", () => {
  test("secretary / secrets are not AWS context (only suspected)", () => {
    for (const v of [
      `secretary: ${AWS_EX_SECRET}`,
      `Secretary ${AWS_EX_SECRET}`,
      `secrets: ${AWS_EX_SECRET}`,
      `SECRETS ${AWS_EX_SECRET}`,
      `the secretariat noted ${AWS_EX_SECRET}`,
      `topsecret ${AWS_EX_SECRET}`,
    ]) {
      const r = det.detectSecretInPayload({ args: { message: v } });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.suspected?.[0]?.pattern).toBe("aws_secret_key");
    }
    const r = det.detectSecretInPayload({ cfg: { secretary: AWS_EX_SECRET } });
    expect(r.ok).toBe(true);
  });

  test("secret / Secret / SECRET / client_secret / clientSecret / secretKey still block", () => {
    for (const v of [
      `secret: ${AWS_EX_SECRET}`,
      `Secret ${AWS_EX_SECRET}`,
      `SECRET=${AWS_EX_SECRET}`,
      `client_secret=${AWS_EX_SECRET}`,
      `CLIENT_SECRET=${AWS_EX_SECRET}`,
      `clientSecret: ${AWS_EX_SECRET}`,
      `secretKey: ${AWS_EX_SECRET}`,
      `${AWS_EX_SECRET} is the secret`,
      `secret2: ${AWS_EX_SECRET}`,
      `AWSのシークレットキーは ${AWS_EX_SECRET} です`,
    ]) {
      const r = det.detectSecretInPayload({ args: { message: v } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.pattern).toBe("aws_secret_key");
    }
    for (const path of [{ clientSecret: AWS_EX_SECRET }, { secret: AWS_EX_SECRET }, { secretKey: AWS_EX_SECRET }]) {
      expect(det.detectSecretInPayload({ cfg: path }).ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const FLAG = "P1_CONFIG_CHANGE_REQUEST_ENABLED";
const flagBackup = process.env[FLAG];
const MARK = "Qz7Kp2Vw9Lm4";

function empCred(): ResolvedEmployeeCredential {
  return {
    employeeId: EMP,
    orgId: ORG,
    credentialId: `cred_${EMP}`,
    generation: 1,
    fingerprint: "fixture-hash",
    secretPrefix: "gb_emp_fixture",
    binding: {
      status: "linked",
      employeeId: EMP,
      orgId: ORG,
      credentialGeneration: 1,
      grokBotAgentId: "agent_test",
      grokBotWorkspaceId: null,
      credentialFingerprint: null,
      lastSuccessAt: null,
      lastError: null,
      wakeWebhookUrl: null,
      hasWakeWebhook: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

function adminCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_platform_ops" });
  return {
    orgId: ORG,
    adminAgentId: agent.id,
    grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id,
    generation: agent.credentialGeneration,
    via: "bearer",
    agent,
  };
}

const okDeps: Partial<ConfigChangeDeps> = {
  resolveApprover: async () => ({ ok: true, surface: "slack_dm", channelId: "nc_test" }),
  notify: async () => true,
};

type Extra = Record<string, unknown>;
const PATHS: Array<{ name: string; run: (text: string, extra: Extra, jobId: string) => Promise<{ code: unknown; pattern: unknown; out: unknown }> }> = [
  {
    name: "gateway invoke",
    run: async (text, extra, jobId) => {
      const r = await runGatewayInvoke({
        employeeId: EMP,
        credentialId: null,
        body: { tool: "slack.post", purpose: "weekly report", jobId, args: { channel: "C0ICEBOX", message: text, ...extra } } as never,
      });
      return { code: r.body.code, pattern: r.body.pattern, out: r.body };
    },
  },
  {
    name: "MCP staffpass_invoke",
    run: async (text, extra, jobId) => {
      const r = await callStaffpassMcpTool(
        "staffpass_invoke",
        { tool: "slack.post", purpose: "weekly report", jobId, payload: { channel: "C0ICEBOX", message: text, ...extra } },
        empCred()
      );
      const data = r.structuredContent as Record<string, unknown>;
      return { code: data.code, pattern: data.pattern, out: r };
    },
  },
  {
    name: "admin queue",
    run: async (text, extra, jobId) => {
      const r = (await queueAdminTool({
        cred: adminCred(),
        tool: "employees.issue",
        args: { displayName: "Test AI", roleLabel: text, scopes: ["tools:read"], ...extra },
        summary: "issue",
        jobId,
      })) as unknown as Record<string, unknown>;
      return { code: r.code, pattern: r.pattern, out: r };
    },
  },
  {
    name: "config change request",
    run: async (text, extra, jobId) => {
      process.env[FLAG] = "1";
      const r = (await createConfigChangeRequest(
        {
          orgId: ORG,
          employeeId: EMP,
          credentialId: `cred_${EMP}`,
          args: {
            kind: "instructions",
            jobId,
            requestedBy: { name: "稲盛", slackUserId: "U0INAMORI" },
            reason: text,
            instructions: { mode: "append", text: "週報は月曜に投稿する。" },
            ...extra,
          },
        },
        okDeps
      )) as unknown as Record<string, unknown>;
      return { code: r.code, pattern: r.pattern, out: r };
    },
  },
];

let seq = 0;
const uniqJob = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
let logs: string[] = [];
const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };

beforeEach(() => {
  logs = [];
  for (const k of Object.keys(originals) as Array<keyof typeof originals>) {
    console[k] = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a.slice(0, 2000) : JSON.stringify(a)?.slice(0, 2000))).join(" "));
    };
  }
});
afterEach(() => {
  Object.assign(console, originals);
  if (flagBackup === undefined) delete process.env[FLAG];
  else process.env[FLAG] = flagBackup;
});

function expectNoMark(haystack: string) {
  for (let i = 0; i + 6 <= MARK.length; i++) expect(haystack).not.toContain(MARK.slice(i, i + 6));
}

describe("item 3: the caps through all 4 paths", () => {
  const cases: Array<{ label: string; pattern: string; make: () => { text: string; extra: Extra } }> = [
    {
      label: "one string over the per-string cap",
      pattern: "value_too_long_to_scan",
      make: () => ({ text: fill(MARK, det.MAX_SCAN_LENGTH + 1), extra: {} }),
    },
    {
      label: "strings under the per-string cap but over the payload character cap",
      pattern: "payload_too_large_to_scan",
      make: () => {
        const per = det.MAX_SCAN_LENGTH - 1;
        const parts = Math.floor(payloadCaps().MAX_PAYLOAD_SCAN_CHARS / per) + 1;
        return { text: "週報", extra: { notes: Array.from({ length: parts }, () => fill(MARK, per)) } };
      },
    },
    {
      label: "more strings than the payload string cap",
      pattern: "payload_too_large_to_scan",
      make: () => ({ text: "週報", extra: { notes: Array.from({ length: payloadCaps().MAX_PAYLOAD_SCAN_STRINGS + 1 }, () => MARK) } }),
    },
  ];
  for (const p of PATHS) {
    for (const c of cases) {
      test(`${p.name}: ${c.label} → refused, exactly one audit row, no value characters`, async () => {
        const jobId = uniqJob("cap");
        const { text, extra } = c.make();
        const t0 = performance.now();
        const { code, pattern, out } = await p.run(text, extra, jobId);
        expect(performance.now() - t0).toBeLessThan(PER_PAYLOAD_MS);
        expect(code).toBe("secret_detected_in_payload");
        expect(pattern).toBe(c.pattern);
        const rows = (await listAuditEvents(null, 100000)).filter(
          (e) => e.action === SECRET_DETECTION_BLOCKED && (e.metadata as Record<string, unknown>)?.jobId === jobId
        );
        expect(rows.length).toBe(1);
        expect(rows[0].orgId).toBe(ORG);
        expect((rows[0].metadata as Record<string, unknown>).pattern).toBe(c.pattern);
        expectNoMark(JSON.stringify(out));
        expectNoMark(JSON.stringify(rows[0]));
        expectNoMark(logs.join("\n"));
      });
    }
    test(`${p.name}: a normal-size message is not refused by the caps`, async () => {
      const { code } = await p.run("週報: 今週の進捗です。", {}, uniqJob("cap-ok"));
      expect(code).not.toBe("secret_detected_in_payload");
    });
  }
});
