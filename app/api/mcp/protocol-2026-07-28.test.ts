/**
 * D1 (2026-10-05): /api/mcp and /api/mcp/admin speak MCP 2026-07-28 (dual-era).
 * Backward-compatibility matrix with representative client payloads, plus
 * server/discover, header validation, CORS, server cards and docs.
 *
 * The client payloads below are representative of each client family's
 * initialize / per-request shape (protocol version, capabilities, clientInfo);
 * they are not captured production traffic.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { DEMO_ORG } = await import("@/lib/demo-data");
const { rotateCredential } = await import("@/lib/data");
const { fingerprintSecret } = await import("@/lib/bindings");
const { DEMO_ADMIN_SECRET, resetDemoAdminAgent } = await import("@/lib/data/admin-agents");
const { listStaffpassMcpTools } = await import("@/lib/mcp/tools");
const { ADMIN_MCP_TOOLS } = await import("@/lib/mcp/admin-tools");
const employeeRoute = await import("@/app/api/mcp/route");
const adminRoute = await import("@/app/api/mcp/admin/route");

const SUPPORTED = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const EMP_TOKEN = "gb_emp_d1_protocol_2026_07_28_test_0123456789";
const EMP_TOOL_NAMES = listStaffpassMcpTools().map((t) => t.name);
const ADMIN_TOOL_NAMES = ADMIN_MCP_TOOLS.map((t) => t.name);
const ORIGINAL_ENV = {
  strict: process.env.MCP_STRICT_REQUEST_HEADERS,
  log: process.env.MCP_UNAUTH_INIT_LOG_ENABLED,
};

beforeAll(async () => {
  await rotateCredential("emp_sales", DEMO_ORG.id, fingerprintSecret(EMP_TOKEN));
  resetDemoAdminAgent({ grokBotAgentId: "agent_admin_demo", status: "linked" });
});
afterEach(() => {
  for (const [k, env] of [["strict", "MCP_STRICT_REQUEST_HEADERS"], ["log", "MCP_UNAUTH_INIT_LOG_ENABLED"]] as const) {
    const v = ORIGINAL_ENV[k];
    if (v === undefined) delete process.env[env];
    else process.env[env] = v;
  }
});

type Surface = "employee" | "admin";
const POSTS = { employee: employeeRoute.POST, admin: adminRoute.POST };
const URLS = { employee: "https://staffpass.test/api/mcp", admin: "https://staffpass.test/api/mcp/admin" };
const AUTH = {
  employee: { authorization: `Bearer ${EMP_TOKEN}` },
  admin: { authorization: `Bearer ${DEMO_ADMIN_SECRET}` },
};

let nextId = 1;
async function rpc(
  surface: Surface,
  method: string,
  params: Record<string, unknown> | undefined,
  headers: Record<string, string> = {}
) {
  const id = nextId++;
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (!method.startsWith("notifications/")) body.id = id;
  if (params !== undefined) body.params = params;
  const res = await POSTS[surface](
    new Request(URLS[surface], {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    })
  );
  const text = await res.text();
  return { res, id, json: text ? (JSON.parse(text) as Record<string, any>) : null };
}

const modernMeta = (clientInfo = { name: "chatgpt-style-client", version: "2026.10" }) => ({
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": clientInfo,
  "io.modelcontextprotocol/clientCapabilities": {},
  "openai/locale": "ja-JP",
  "openai/userAgent": "ChatGPT/1.2026.10 (Work)",
});
const modernHeaders = (method: string, name?: string) => ({
  "MCP-Protocol-Version": "2026-07-28",
  "Mcp-Method": method,
  ...(name ? { "Mcp-Name": name } : {}),
});

/** Legacy initialize-era client profiles (representative payloads). */
const LEGACY_CLIENTS: Array<{
  label: string;
  init: Record<string, unknown>;
  initHeaders: Record<string, string>;
  /** MCP-Protocol-Version the client sends after initialize (absent for pre-2025-06-18 clients). */
  followUpHeader: string | null;
  expectVersion: string;
}> = [
  {
    label: "Cursor",
    init: {
      protocolVersion: "2025-06-18",
      capabilities: { tools: true, prompts: false, resources: true, logging: false, elicitation: {}, roots: { listChanged: false } },
      clientInfo: { name: "cursor-vscode", version: "1.0.0" },
    },
    initHeaders: { "user-agent": "Cursor/1.7.0" },
    followUpHeader: "2025-06-18",
    expectVersion: "2025-06-18",
  },
  {
    label: "Grok Bot (remote MCP connector)",
    init: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "grok-bot-mcp-connector", version: "1.0" },
    },
    initHeaders: { "user-agent": "GrokBot-MCP/1.0" },
    followUpHeader: null,
    expectVersion: "2025-03-26",
  },
  {
    label: "Claude Desktop / claude.ai connector",
    init: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-ai", version: "0.1.0" },
    },
    initHeaders: { "user-agent": "Claude-User/1.0" },
    followUpHeader: "2025-06-18",
    expectVersion: "2025-06-18",
  },
  {
    label: "Claude Code",
    init: {
      protocolVersion: "2025-11-25",
      capabilities: { roots: {}, elicitation: {} },
      clientInfo: { name: "claude-code", version: "2.0.14" },
    },
    initHeaders: { "user-agent": "claude-code/2.0.14" },
    followUpHeader: "2025-11-25",
    expectVersion: "2025-11-25",
  },
  {
    label: "no version header (2024-11-05 client, e.g. older SDK / curl)",
    init: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "curl", version: "0.0.1" },
    },
    initHeaders: {},
    followUpHeader: null,
    expectVersion: "2024-11-05",
  },
];

describe.each(["employee", "admin"] as const)("%s MCP — legacy (initialize-era) clients", (surface) => {
  test.each(LEGACY_CLIENTS.map((c) => [c.label, c] as const))(
    "%s: initialize answers a valid, legacy-shaped result; tools/list still works",
    async (_label, client) => {
      const init = await rpc(surface, "initialize", client.init, { ...AUTH[surface], ...client.initHeaders });
      expect(init.res.status).toBe(200);
      expect(init.json!.id).toBe(init.id);
      const result = init.json!.result;
      // Exactly the pre-D1 key set (no resultType / _meta / cache hints on legacy).
      expect(Object.keys(result).sort()).toEqual(["capabilities", "instructions", "protocolVersion", "serverInfo"]);
      expect(result.protocolVersion).toBe(client.expectVersion);
      expect(result.capabilities).toEqual({ tools: { listChanged: true } });
      expect(result.serverInfo.name).toBe(surface === "employee" ? "staffpass" : "staffpass-admin");
      expect(typeof result.instructions).toBe("string");

      const initialized = await rpc(surface, "notifications/initialized", undefined, AUTH[surface]);
      expect(initialized.res.status).toBe(202);

      const followUp = { ...AUTH[surface], ...(client.followUpHeader ? { "MCP-Protocol-Version": client.followUpHeader } : {}) };
      const list = await rpc(surface, "tools/list", {}, followUp);
      expect(list.res.status).toBe(200);
      expect(Object.keys(list.json!.result)).toEqual(["tools"]);
      expect(list.json!.result.tools.map((t: { name: string }) => t.name)).toEqual(
        surface === "employee" ? EMP_TOOL_NAMES : ADMIN_TOOL_NAMES
      );

      const ping = await rpc(surface, "ping", {}, followUp);
      expect(ping.json!.result).toEqual({});
    }
  );

  test("initialize without protocolVersion still answers 2024-11-05 (unchanged)", async () => {
    const init = await rpc(surface, "initialize", { capabilities: {} });
    expect(init.json!.result.protocolVersion).toBe("2024-11-05");
  });

  test("initialize asking for 2026-07-28 or an unknown version → latest initialize-era version 2025-11-25", async () => {
    for (const v of ["2026-07-28", "2099-01-01"]) {
      const init = await rpc(surface, "initialize", {
        protocolVersion: v,
        capabilities: {},
        clientInfo: { name: "dual-era-client", version: "1" },
      }, { "MCP-Protocol-Version": v });
      expect(init.res.status).toBe(200);
      expect(init.json!.result.protocolVersion).toBe("2025-11-25");
    }
  });

  test("legacy unknown method stays HTTP 200 + -32601 (unchanged)", async () => {
    const r = await rpc(surface, "resources/list", {}, AUTH[surface]);
    expect(r.res.status).toBe(200);
    expect(r.json!.error.code).toBe(-32601);
  });

  test("legacy request with an unknown MCP-Protocol-Version header is still served (flag OFF)", async () => {
    const list = await rpc(surface, "tools/list", {}, { ...AUTH[surface], "MCP-Protocol-Version": "2099-01-01" });
    expect(list.res.status).toBe(200);
    expect(list.json!.result.tools.length).toBeGreaterThan(0);
  });
});

describe.each(["employee", "admin"] as const)("%s MCP — ChatGPT-style 2026-07-28 (modern) client", (surface) => {
  test("server/discover → supportedVersions + the same capabilities/instructions as initialize", async () => {
    const discover = await rpc(surface, "server/discover", { _meta: modernMeta() }, modernHeaders("server/discover"));
    expect(discover.res.status).toBe(200);
    const d = discover.json!.result;
    expect(d.resultType).toBe("complete");
    expect(d.supportedVersions).toEqual(SUPPORTED);
    expect(d._meta["io.modelcontextprotocol/serverInfo"].name).toBe(surface === "employee" ? "staffpass" : "staffpass-admin");
    expect(d.ttlMs).toBe(300000);
    expect(d.cacheScope).toBe("public");

    const init = await rpc(surface, "initialize", { protocolVersion: "2025-11-25", capabilities: {} });
    expect(d.capabilities).toEqual(init.json!.result.capabilities);
    expect(d.instructions).toBe(init.json!.result.instructions);
    expect(d._meta["io.modelcontextprotocol/serverInfo"]).toEqual(init.json!.result.serverInfo);
    // No unknown _meta is reflected back.
    expect(JSON.stringify(d)).not.toContain("openai/");
  });

  test("server/discover needs no credential and also answers a bare probe (no headers, no _meta)", async () => {
    const bare = await rpc(surface, "server/discover", {});
    expect(bare.res.status).toBe(200);
    expect(bare.json!.result.supportedVersions).toEqual(SUPPORTED);
  });

  test("tools/list (modern) → same tools + resultType, serverInfo, cache hints", async () => {
    const list = await rpc(surface, "tools/list", { _meta: modernMeta() }, { ...AUTH[surface], ...modernHeaders("tools/list") });
    expect(list.res.status).toBe(200);
    const r = list.json!.result;
    expect(r.resultType).toBe("complete");
    expect(r.tools.map((t: { name: string }) => t.name)).toEqual(surface === "employee" ? EMP_TOOL_NAMES : ADMIN_TOOL_NAMES);
    expect(r.ttlMs).toBe(300000);
    expect(r.cacheScope).toBe("private");
    expect(r._meta["io.modelcontextprotocol/serverInfo"].name).toBe(surface === "employee" ? "staffpass" : "staffpass-admin");
    expect(JSON.stringify(r)).not.toContain("openai/");
  });

  test("modern unknown method → HTTP 404 + -32601 (spec)", async () => {
    const r = await rpc(surface, "resources/list", { _meta: modernMeta() }, { ...AUTH[surface], ...modernHeaders("resources/list") });
    expect(r.res.status).toBe(404);
    expect(r.json!.error.code).toBe(-32601);
  });

  test("modern unsupported version → HTTP 400 + -32022 listing supported versions", async () => {
    const meta = { ...modernMeta(), "io.modelcontextprotocol/protocolVersion": "2027-01-01" };
    const r = await rpc(surface, "tools/list", { _meta: meta }, { ...AUTH[surface], "MCP-Protocol-Version": "2027-01-01", "Mcp-Method": "tools/list" });
    expect(r.res.status).toBe(400);
    expect(r.json!.error).toEqual({
      code: -32022,
      message: "Unsupported protocol version",
      data: { supported: SUPPORTED, requested: "2027-01-01" },
    });
    expect(r.json!.id).toBe(r.id);
  });

  test("header ≠ body → HTTP 400 + -32020 HeaderMismatch (version, method)", async () => {
    const v = await rpc(surface, "tools/list", { _meta: modernMeta() }, { ...AUTH[surface], "MCP-Protocol-Version": "2025-06-18", "Mcp-Method": "tools/list" });
    expect([v.res.status, v.json!.error.code]).toEqual([400, -32020]);
    const m = await rpc(surface, "tools/list", { _meta: modernMeta() }, { ...AUTH[surface], ...modernHeaders("tools/call") });
    expect([m.res.status, m.json!.error.code]).toEqual([400, -32020]);
  });

  test("oversized _meta → HTTP 400 + -32602, nothing reflected", async () => {
    const r = await rpc(surface, "tools/list", { _meta: { ...modernMeta(), junk: "y".repeat(20000) } }, { ...AUTH[surface], ...modernHeaders("tools/list") });
    expect([r.res.status, r.json!.error.code]).toEqual([400, -32602]);
    expect(JSON.stringify(r.json)).not.toContain("yyyy");
  });

  test("strict flag ON: modern request missing Mcp-Method → 400 -32020; OFF: served", async () => {
    const headers = { ...AUTH[surface], "MCP-Protocol-Version": "2026-07-28" };
    const off = await rpc(surface, "tools/list", { _meta: modernMeta() }, headers);
    expect(off.res.status).toBe(200);
    process.env.MCP_STRICT_REQUEST_HEADERS = "true";
    const on = await rpc(surface, "tools/list", { _meta: modernMeta() }, headers);
    expect([on.res.status, on.json!.error.code]).toEqual([400, -32020]);
  });

  test("dual-era fallback: initialize with 2026-07-28 gets a valid legacy answer, then legacy tools/list works", async () => {
    const init = await rpc(surface, "initialize", {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "chatgpt-style-client", version: "2026.10" },
    }, AUTH[surface]);
    expect(init.json!.result.protocolVersion).toBe("2025-11-25");
    const list = await rpc(surface, "tools/list", {}, { ...AUTH[surface], "MCP-Protocol-Version": "2025-11-25" });
    expect(list.res.status).toBe(200);
  });
});

describe("employee MCP — modern tools/call", () => {
  test("staffpass_whoami (modern, Mcp-Name plain and base64) = legacy result + resultType/serverInfo", async () => {
    const legacy = await rpc("employee", "tools/call", { name: "staffpass_whoami", arguments: {} }, AUTH.employee);
    expect(legacy.res.status).toBe(200);
    expect(legacy.json!.result.resultType).toBeUndefined();

    for (const name of ["staffpass_whoami", `=?base64?${Buffer.from("staffpass_whoami").toString("base64")}?=`]) {
      const modern = await rpc(
        "employee",
        "tools/call",
        { name: "staffpass_whoami", arguments: {}, _meta: modernMeta() },
        { ...AUTH.employee, ...modernHeaders("tools/call", name) }
      );
      expect(modern.res.status).toBe(200);
      const { resultType, _meta, ...rest } = modern.json!.result;
      expect(resultType).toBe("complete");
      expect(_meta["io.modelcontextprotocol/serverInfo"].name).toBe("staffpass");
      expect(rest).toEqual(legacy.json!.result);
    }
  });

  test("Mcp-Name ≠ params.name → 400 -32020 before the tool runs", async () => {
    const r = await rpc(
      "employee",
      "tools/call",
      { name: "staffpass_invoke", arguments: {}, _meta: modernMeta() },
      { ...AUTH.employee, ...modernHeaders("tools/call", "staffpass_whoami") }
    );
    expect([r.res.status, r.json!.error.code]).toEqual([400, -32020]);
  });
});

describe("auth behaviour is unchanged", () => {
  test("employee: missing badge → 401 -32001 missing_credential (legacy and modern identical, no WWW-Authenticate)", async () => {
    const legacy = await rpc("employee", "tools/list", {});
    const modern = await rpc("employee", "tools/list", { _meta: modernMeta() }, modernHeaders("tools/list"));
    for (const r of [legacy, modern]) {
      expect(r.res.status).toBe(401);
      expect(r.json!.error.code).toBe(-32001);
      expect(r.json!.error.data).toEqual({ code: "missing_credential" });
      expect(r.res.headers.get("www-authenticate")).toBeNull();
    }
    expect(modern.json!.error).toEqual(legacy.json!.error);
  });

  test("employee: unknown badge → 401 invalid_credential", async () => {
    const r = await rpc("employee", "tools/list", { _meta: modernMeta() }, { authorization: "Bearer gb_emp_unknown_secret_value_0000", ...modernHeaders("tools/list") });
    expect(r.res.status).toBe(401);
    expect(r.json!.error.data.code).toBe("invalid_credential");
  });

  test("admin: employee badge rejected (fail-closed), legacy and modern", async () => {
    for (const headers of [{}, modernHeaders("tools/list")]) {
      const r = await rpc("admin", "tools/list", Object.keys(headers).length ? { _meta: modernMeta() } : {}, { authorization: `Bearer ${EMP_TOKEN}`, ...headers });
      expect(r.res.status).toBe(401);
      expect(r.json!.error.data.code).toBe("employee_badge_rejected");
    }
  });

  test("initialize and server/discover stay unauthenticated; unauth initialize log still fires once, discover never logs", async () => {
    process.env.MCP_UNAUTH_INIT_LOG_ENABLED = "true";
    const calls: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => void calls.push(String(args[0]));
    try {
      const init = await rpc("employee", "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "claude-ai", version: "0.1.0" },
      }, { "user-agent": "Claude-User/1.0" });
      expect(init.res.status).toBe(200);
      await rpc("employee", "server/discover", { _meta: modernMeta() }, modernHeaders("server/discover"));
    } finally {
      console.info = originalInfo;
    }
    const hits = calls.filter((c) => c.includes("mcp.unauth_initialize"));
    expect(hits.length).toBe(1);
    expect(JSON.parse(hits[0]).protocolVersion).toBe("2025-06-18");
  });
});

describe("CORS and GET server cards", () => {
  test.each(["employee", "admin"] as const)("%s OPTIONS allows the 2026-07-28 headers; Mcp-Session-Id gone", async (surface) => {
    const route = surface === "employee" ? employeeRoute : adminRoute;
    const res = await route.OPTIONS();
    expect(res.status).toBe(204);
    const allow = (res.headers.get("access-control-allow-headers") || "").split(",").map((s) => s.trim());
    for (const h of ["Authorization", "Content-Type", "Accept", "MCP-Protocol-Version", "Mcp-Method", "Mcp-Name"]) {
      expect(allow).toContain(h);
    }
    expect(allow).toContain(surface === "employee" ? "x-staffpass-credential" : "x-staffpass-admin-credential");
    expect(allow.map((h) => h.toLowerCase())).not.toContain("mcp-session-id");
    expect(res.headers.get("access-control-expose-headers")).toBeNull();
  });

  test.each(["employee", "admin"] as const)("%s GET card advertises 2026-07-28 + supportedProtocolVersions", async (surface) => {
    const route = surface === "employee" ? employeeRoute : adminRoute;
    const card = await (await route.GET()).json();
    expect(card.protocolVersion).toBe("2026-07-28");
    expect(card.supportedProtocolVersions).toEqual(SUPPORTED);
  });
});

describe("static server cards and docs (D10)", () => {
  const root = resolve(import.meta.dir, "../../..");
  test.each(["server-card.json", "admin-server-card.json"])("public/.well-known/mcp/%s lists supportedProtocolVersions", (file) => {
    const card = JSON.parse(readFileSync(resolve(root, "public/.well-known/mcp", file), "utf8"));
    expect(card.transport.supportedProtocolVersions).toEqual(SUPPORTED);
  });

  test("docs/mcp.md: 2026-07-28 examples (server/discover, headers, _meta) and no 2024-11-05 initialize example", () => {
    const md = readFileSync(resolve(root, "docs/mcp.md"), "utf8");
    expect(md).toContain("server/discover");
    expect(md).toContain("MCP-Protocol-Version: 2026-07-28");
    expect(md).toContain("Mcp-Method: tools/call");
    expect(md).toContain("Mcp-Name: staffpass_whoami");
    expect(md).toContain('"io.modelcontextprotocol/protocolVersion": "2026-07-28"');
    expect(md).not.toContain('"protocolVersion": "2024-11-05"');
    expect(md).not.toMatch(/Mcp-Session-Id/i);
  });
});
