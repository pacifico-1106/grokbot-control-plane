import { afterAll, expect, mock } from "bun:test";
import * as https from "node:https";
import * as dns from "node:dns/promises";
// Accidental fetch cannot use real services, even if application code catches it.
let attempted = 0;
globalThis.fetch = (() => {
  attempted++;
  throw new Error("network_forbidden_in_local_tests");
}) as typeof fetch;
const forbidden = () => { attempted++; throw new Error("network_forbidden_in_local_tests"); };
mock.module("node:https", () => ({ ...https, request: forbidden, get: forbidden }));
mock.module("node:dns/promises", () => ({ ...dns, lookup: forbidden }));
afterAll(() => { expect(attempted).toBe(0); });

// Server-only is a build boundary; fixture tests run server modules deliberately.
mock.module("server-only", () => ({}));
