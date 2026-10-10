import { expect, test } from "bun:test";
import { isLoopbackRedirect, isRedirectAllowedForClient, matchesRedirectAllowlist } from "../redirect-policy";

const GOOD = [
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://chatgpt.com/connector/oauth/abc123",
  "https://chatgpt.com/connector/oauth/A-b_9",
  "https://chatgpt.com/connector/oauth/" + "x".repeat(128),
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "http://localhost:1/callback",
  "http://localhost:8080/callback",
  "http://localhost:65535/callback",
  "http://127.0.0.1:33418/callback",
  "http://127.0.0.1:9/callback",
  "http://localhost:54545/callback",
  "http://127.0.0.1:65535/callback",
  "https://chatgpt.com/connector/oauth/z",
  "https://chatgpt.com/connector/oauth/0",
  "http://localhost:3000/callback",
  "http://127.0.0.1:3000/callback",
  "http://localhost:49152/callback",
  "https://chatgpt.com/connector/oauth/cb_1-2",
  "http://127.0.0.1:1234/callback",
];

const BAD = [
  "https://chatgpt.com.evil.com/connector_platform_oauth_redirect",
  "https://evil.com/connector_platform_oauth_redirect",
  "https://chatgpt.com/connector_platform_oauth_redirect/",
  "https://chatgpt.com/connector_platform_oauth_redirect?x=1",
  "https://chatgpt.com/connector_platform_oauth_redirect#f",
  "https://CHATGPT.com/connector_platform_oauth_redirect",
  "https://chatgpt.com:443/connector_platform_oauth_redirect",
  "https://user@chatgpt.com/connector_platform_oauth_redirect",
  "https://evil.com@chatgpt.com/connector_platform_oauth_redirect",
  "https://chatgpt.com\\@evil.com/connector_platform_oauth_redirect",
  "https://chatgpt.com/connector/oauth/" + "x".repeat(129),
  "https://chatgpt.com/connector/oauth/a/b",
  "https://chatgpt.com/connector/oauth/a.b",
  "https://chatgpt.com/connector/oauth/",
  "https://chatgpt.com/connector/oauth/%2e%2e",
  "https://chatgpt.com/connector/oauth/../../evil",
  "https://claude.ai/api/mcp/auth_callback/../x",
  "https://claude.ai/api/mcp/Auth_Callback",
  "https://claude.ai/api/mcp/auth_callback%2F",
  "http://claude.ai/api/mcp/auth_callback",
  "http://localhost/callback",
  "http://localhost:0/callback",
  "http://localhost:99999/callback",
  "http://localhost:8080/callback/",
  "http://localhost:8080/cb",
  "http://localhost.evil.com:8080/callback",
  "http://127.0.0.2:8080/callback",
  "http://[::1]:8080/callback",
  "https://localhost:8080/callback",
  "javascript:alert(1)",
  "data:text/html,x",
  " https://claude.ai/api/mcp/auth_callback",
  "https://claude.ai/api/mcp/auth_callback ",
  "",
  "//claude.ai/api/mcp/auth_callback",
  "https://claude.ai./api/mcp/auth_callback",
];

test("allowlist accepts the documented redirect URIs", () => {
  for (const u of GOOD) expect([u, matchesRedirectAllowlist(u)]).toEqual([u, true]);
});

test("allowlist rejects lookalikes, encodings, userinfo, query, fragment, case, ports", () => {
  expect(BAD.length).toBeGreaterThanOrEqual(30);
  for (const u of BAD) expect([u, matchesRedirectAllowlist(u)]).toEqual([u, false]);
});

test("client registration must also list the redirect (loopback ignores port only)", () => {
  expect(isRedirectAllowedForClient("https://claude.ai/api/mcp/auth_callback", ["https://claude.ai/api/mcp/auth_callback"])).toBe(true);
  expect(isRedirectAllowedForClient("https://claude.ai/api/mcp/auth_callback", ["https://chatgpt.com/connector_platform_oauth_redirect"])).toBe(false);
  expect(isRedirectAllowedForClient("http://localhost:5555/callback", ["http://localhost:1234/callback"])).toBe(true);
  expect(isRedirectAllowedForClient("http://127.0.0.1:5555/callback", ["http://localhost:1234/callback"])).toBe(false);
  expect(isRedirectAllowedForClient("https://evil.com/cb", ["https://evil.com/cb"])).toBe(false);
});

test("env override replaces the allowlist", () => {
  const saved = process.env.MCP_OAUTH_REDIRECT_ALLOWLIST;
  process.env.MCP_OAUTH_REDIRECT_ALLOWLIST = "https://claude.ai/api/mcp/auth_callback";
  try {
    expect(matchesRedirectAllowlist("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(matchesRedirectAllowlist("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.MCP_OAUTH_REDIRECT_ALLOWLIST;
    else process.env.MCP_OAUTH_REDIRECT_ALLOWLIST = saved;
  }
});

test("loopback detection", () => {
  expect(isLoopbackRedirect("http://localhost:8080/callback")).toBe(true);
  expect(isLoopbackRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(false);
});

// ---- Cursor web callback (木村 2026-10-10, #312 point 3): exact match only ----
const CURSOR_WEB = "https://www.cursor.com/agents/mcp/oauth/callback";

test("Cursor web callback is allowlisted by default, as one exact string (no pattern)", async () => {
  expect(matchesRedirectAllowlist(CURSOR_WEB)).toBe(true);
  const { DEFAULT_REDIRECT_ALLOWLIST } = await import("../config");
  expect(DEFAULT_REDIRECT_ALLOWLIST.filter((p) => p.includes("cursor"))).toEqual([CURSOR_WEB]);
  expect(isRedirectAllowedForClient(CURSOR_WEB, [CURSOR_WEB])).toBe(true);
  expect(isLoopbackRedirect(CURSOR_WEB)).toBe(false);
});

const CURSOR_NEAR_MISSES = [
  // the five near-misses 木村 named
  "https://www.cursor.com/agents/mcp/oauth/callback/extra", // extra path
  "https://www.cursor.com/agents/mcp/oauth/callback?x=1", // query
  "http://www.cursor.com/agents/mcp/oauth/callback", // http scheme
  "https://cursor.com/agents/mcp/oauth/callback", // without www
  "https://www.cursor.com/agents/mcp/oauth/callback/", // trailing slash
  // more prefix / lookalike / encoding variants
  "https://www.cursor.com/agents/mcp/oauth/callbackx",
  "https://www.cursor.com/agents/mcp/oauth/callback#f",
  "https://www.cursor.com/agents/mcp/oauth/callback?",
  "https://www.cursor.com/agents/mcp/oauth",
  "https://www.cursor.com/agents/mcp/oauth/",
  "https://www.cursor.com/agents/mcp/oauth/callback/../callback",
  "https://www.cursor.com/agents/mcp/oauth/callback%2F",
  "https://www.cursor.com/agents/mcp/oauth/Callback",
  "https://WWW.cursor.com/agents/mcp/oauth/callback",
  "https://www.cursor.com:443/agents/mcp/oauth/callback",
  "https://www.cursor.com:8443/agents/mcp/oauth/callback",
  "https://user@www.cursor.com/agents/mcp/oauth/callback",
  "https://evil.www.cursor.com/agents/mcp/oauth/callback",
  "https://www.cursor.com.evil.com/agents/mcp/oauth/callback",
  "https://www.cursor.sh/agents/mcp/oauth/callback",
  "https://www.cursor.com./agents/mcp/oauth/callback",
  "https://www.cursor.com/agents/mcp/oauth/callback ",
  "https://www.cursor.com/other/agents/mcp/oauth/callback",
];

test("Cursor web callback near-misses are refused (path, query, scheme, host, slash, encodings)", () => {
  for (const u of CURSOR_NEAR_MISSES) expect([u, matchesRedirectAllowlist(u)]).toEqual([u, false]);
  // and registering a near-miss does not make it acceptable
  for (const u of CURSOR_NEAR_MISSES) expect([u, isRedirectAllowedForClient(u, [u])]).toEqual([u, false]);
  // exact registered value does not stretch to a near-miss
  for (const u of CURSOR_NEAR_MISSES) expect([u, isRedirectAllowedForClient(u, [CURSOR_WEB])]).toEqual([u, false]);
});

test("env override still replaces the defaults (Cursor web only if listed)", () => {
  const saved = process.env.MCP_OAUTH_REDIRECT_ALLOWLIST;
  process.env.MCP_OAUTH_REDIRECT_ALLOWLIST = "https://claude.ai/api/mcp/auth_callback";
  try {
    expect(matchesRedirectAllowlist(CURSOR_WEB)).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.MCP_OAUTH_REDIRECT_ALLOWLIST;
    else process.env.MCP_OAUTH_REDIRECT_ALLOWLIST = saved;
  }
});
