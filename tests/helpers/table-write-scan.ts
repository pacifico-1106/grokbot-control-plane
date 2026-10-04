/**
 * Source-level scanner for Supabase table access (test-only helper).
 *
 * Classifies every `.from("<table>")` / `.rpc(` call site by the client it is
 * made on, so tests can prove that user-session clients (anon key + cookie /
 * browser session, i.e. PostgREST under RLS as `authenticated`) never write
 * tenant tables, and pin the service-role write inventory.
 *
 * STUB (fail-first commit): returns nothing. Implemented in the next commit.
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

export function scanTableAccess(_files: SourceFile[]): TableAccessSite[] {
  return [];
}

/** `"use client"` modules that import a Supabase client module. */
export function clientComponentsImportingSupabase(_files: SourceFile[]): string[] {
  return [];
}
