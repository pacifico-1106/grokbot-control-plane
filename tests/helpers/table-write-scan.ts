/**
 * Source-level scanner for Supabase table access (test-only helper).
 *
 * Classifies every `.from("<table>")` / `.rpc("<fn>")` call site by the client
 * it is made on, so tests can prove that user-session clients (anon key +
 * cookie / browser session, i.e. PostgREST under RLS as `authenticated`) never
 * write tenant tables, and pin the service-role write inventory.
 *
 * Fail-closed: a client whose origin cannot be resolved in the same file is
 * `unknown` (never `service_role`).
 */

export type ClientKind = "service_role" | "user_session" | "unknown";

export type TableAccessSite = {
  file: string;
  line: number;
  /** Table name for `.from(...)`, function name for `.rpc(...)`. */
  table: string;
  op: "insert" | "update" | "upsert" | "delete" | "select" | "rpc";
  /** Identifier the call is made on (e.g. `admin`, `supabase`). */
  client: string;
  clientKind: ClientKind;
  /** Top-level keys of the object literal passed to insert/update/upsert; ["<dynamic>"] if not a literal. */
  columns: string[];
};

export type SourceFile = { path: string; text: string };

export const WRITE_OPS = new Set(["insert", "update", "upsert", "delete"]);

const SERVICE_FACTORIES = /\bcreateSupabaseAdminClient\s*\(/;
const SESSION_FACTORIES =
  /\b(createSupabaseBrowserClient|createSupabaseServerClient|createRouteSupabase|createServerClient|createBrowserClient)\s*\(|NEXT_PUBLIC_SUPABASE_ANON_KEY/;

function classifyExpression(expr: string): ClientKind {
  if (SESSION_FACTORIES.test(expr)) return "user_session";
  if (SERVICE_FACTORIES.test(expr)) return "service_role";
  return "unknown";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Nearest preceding binding of `ident` before `at`: declaration → its initializer; typed parameter → unknown. */
function classifyIdentifier(text: string, ident: string, at: number): ClientKind {
  const before = text.slice(0, at);
  const id = escapeRe(ident);
  let best: { index: number; kind: ClientKind } | null = null;
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${id}\\b\\s*(?::[^=;]+)?=\\s*([^;]+)`, "g");
  let m: RegExpExecArray | null;
  while ((m = decl.exec(before))) {
    if (!best || m.index > best.index) best = { index: m.index, kind: classifyExpression(m[1]) };
  }
  const param = new RegExp(`[(,{]\\s*${id}\\s*\\??\\s*:`, "g");
  while ((m = param.exec(before))) {
    if (!best || m.index > best.index) best = { index: m.index, kind: "unknown" };
  }
  return best?.kind ?? "unknown";
}

/** Resolve the receiver of `.from` / `.rpc` that ends right before `end`. */
function receiver(text: string, end: number): { client: string; kind: (at: number) => ClientKind } | null {
  let i = end - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (text[i] === "!") i--;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (text[i] === ")") {
    // direct call: factory()!.from(...)
    let depth = 0;
    for (; i >= 0; i--) {
      if (text[i] === ")") depth++;
      else if (text[i] === "(" && --depth === 0) break;
    }
    const name = /([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(0, i));
    if (!name) return null;
    const call = `${name[1]}()`;
    return { client: call, kind: () => classifyExpression(call) };
  }
  const ident = /([A-Za-z_$][\w$]*)$/.exec(text.slice(0, i + 1));
  if (!ident) return null;
  const client = ident[1];
  if (/^(Array|Buffer|Object|Uint8Array|String)$/.test(client)) return null;
  return { client, kind: (at) => classifyIdentifier(text, client, at) };
}

/** Index just past the balanced bracket expression starting at `start` (an opening `{`/`(`/`[`). */
function balancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : open === "(" ? ")" : "]";
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return text.length;
}

/** Top-level keys of an object literal (`{ a, b: 1, "c": x }`); spreads make it dynamic. */
function objectKeys(literal: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let segment = "";
  const flush = () => {
    const s = segment.trim();
    segment = "";
    if (!s) return;
    if (s.startsWith("...")) {
      keys.push("<dynamic>");
      return;
    }
    const k = /^["']?([A-Za-z_$][\w$]*)["']?\s*(?::|$)/.exec(s);
    keys.push(k ? k[1] : "<dynamic>");
  };
  for (let i = 1; i < literal.length - 1; i++) {
    const c = literal[i];
    if (quote) {
      if (c === "\\") {
        segment += c + literal[++i];
        continue;
      }
      if (c === quote) quote = null;
      segment += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    if ("{([".includes(c)) depth++;
    if ("})]".includes(c)) depth--;
    if (c === "," && depth === 0) flush();
    else segment += c;
  }
  flush();
  return [...new Set(keys)];
}

function payloadColumns(text: string, argStart: number): string[] {
  let i = argStart;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== "{") return ["<dynamic>"];
  return objectKeys(text.slice(i, balancedEnd(text, i)));
}

function stringConstants(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*["'`]([\w.]+)["'`]\s*(?:as const\s*)?;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.set(m[1], m[2]);
  return out;
}

export function scanTableAccess(files: SourceFile[]): TableAccessSite[] {
  const out: TableAccessSite[] = [];
  for (const file of files) {
    const text = file.text;
    const consts = stringConstants(text);
    const re = /\.\s*(from|rpc)\s*\(\s*(?:["'`]([\w.]+)["'`]|([A-Za-z_$][\w$]*)\s*[,)])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const name = m[2] ?? consts.get(m[3] ?? "");
      if (!name) continue;
      const recv = receiver(text, m.index);
      if (!recv) continue;
      const line = text.slice(0, m.index).split("\n").length;
      const base = { file: file.path, line, table: name, client: recv.client, clientKind: recv.kind(m.index) };
      if (m[1] === "rpc") {
        out.push({ ...base, op: "rpc", columns: [] });
        continue;
      }
      const after = m.index + m[0].length;
      const chain = text.slice(after, after + 2000).split(/;\s*(?:\n|$)/)[0];
      const opMatch = /\.\s*(insert|update|upsert|delete|select)\s*\(/.exec(chain);
      const op = (opMatch?.[1] ?? "select") as TableAccessSite["op"];
      const columns =
        op === "insert" || op === "update" || op === "upsert"
          ? payloadColumns(text, after + opMatch!.index + opMatch![0].length)
          : [];
      out.push({ ...base, op, columns });
    }
  }
  return out;
}

const USE_CLIENT = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use client["']/;
const SUPABASE_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](@supabase\/[^"']+|[^"']*\/supabase|[^"']*\/route-supabase)["']/;

/** `"use client"` modules that import a Supabase client module. */
export function clientComponentsImportingSupabase(files: SourceFile[]): string[] {
  return files
    .filter((f) => USE_CLIENT.test(f.text) && SUPABASE_IMPORT.test(f.text))
    .map((f) => f.path)
    .sort();
}
