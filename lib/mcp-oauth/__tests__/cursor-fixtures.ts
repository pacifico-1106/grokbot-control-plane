/** Near-misses of cursor://anysphere.cursor-mcp/oauth/callback (shared by policy / authorize / DCR tests). */
export const CURSOR_DESKTOP_NEAR_MISSES = [
  "cursor://anysphere.cursor-mcp/oauth/callback/", // trailing slash
  "cursor://anysphere.cursor-mcp/oauth/callbackx",
  "cursor://anysphere.cursor-mcp/oauth/other", // different path
  "cursor://anysphere.cursor-mcp/oauth/callback/extra",
  "cursor://anysphere.cursor-mcp/oauth/callback?x=1", // query
  "cursor://anysphere.cursor-mcp/oauth/callback?",
  "cursor://anysphere.cursor-mcp/oauth/callback#f",
  "cursor://evil",
  "cursor://evil/oauth/callback",
  "cursor://anysphere.cursor-mcp.evil/oauth/callback", // different host
  "cursor://evil.anysphere.cursor-mcp/oauth/callback",
  "cursor://anysphere.cursor-mcp:8080/oauth/callback",
  "cursor://user@anysphere.cursor-mcp/oauth/callback",
  "cursor://anysphere.cursor-mcp/oauth/%63allback",
  "cursor://anysphere.cursor-mcp/oauth/./callback",
  "cursor://anysphere.cursor-mcp//oauth/callback",
  "cursor:anysphere.cursor-mcp/oauth/callback",
  "cursor:///oauth/callback",
  "CURSOR://anysphere.cursor-mcp/oauth/callback", // scheme case
  "Cursor://anysphere.cursor-mcp/oauth/callback",
  "cursor://ANYSPHERE.cursor-mcp/oauth/callback", // host case
  "cursor://Anysphere.Cursor-Mcp/oauth/callback",
  "cursor://anysphere.cursor-mcp/OAuth/Callback", // path case
  " cursor://anysphere.cursor-mcp/oauth/callback",
  "cursor://anysphere.cursor-mcp/oauth/callback ",
  "cursor-mcp://anysphere.cursor-mcp/oauth/callback", // other custom schemes
  "vscode://anysphere.cursor-mcp/oauth/callback",
  "anysphere://anysphere.cursor-mcp/oauth/callback",
  "javascript:alert(1)",
  "javascript://anysphere.cursor-mcp/oauth/callback",
  "data:text/html,<script>alert(1)</script>",
  "data://anysphere.cursor-mcp/oauth/callback",
  "file:///etc/passwd",
  "file://anysphere.cursor-mcp/oauth/callback",
  "ftp://anysphere.cursor-mcp/oauth/callback",
  "ws://localhost:8787/callback",
];
