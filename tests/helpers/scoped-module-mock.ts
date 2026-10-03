/**
 * File-scoped module mocks for bun:test.
 *
 * `mock.module()` is process-global and cannot be undone: when several test
 * files run in ONE bun process (`bun test a.test.ts b.test.ts`), a mock from an
 * earlier file replaces the module for every later file. An incomplete mock
 * object also makes later `import { x }` fail with "export not found".
 *
 * `scopedModuleMocks()` keeps the module shape complete (every real export is
 * passed through) and only routes the overridden functions to the fake while
 * the calling test file is running (beforeAll → afterAll). Outside that window
 * the overrides delegate to the real implementation that was captured before
 * mocking, so later files see real behaviour (or their own mocks).
 *
 * Call at the top level of a test file, before importing the code under test.
 */
import { afterAll, beforeAll, mock } from "bun:test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- overrides keep their own typed signatures
type AnyFn = (...args: any[]) => unknown;

export function scopedModuleMocks() {
  let active = false;
  beforeAll(() => {
    active = true;
  });
  afterAll(() => {
    active = false;
  });

  return {
    isActive: () => active,
    /**
     * Mock `specifier` (use the "@/…" alias so every importer resolves the same
     * module). Only function overrides are allowed so they can be scoped.
     */
    async mock(specifier: string, overrides: Record<string, AnyFn>): Promise<void> {
      // Snapshot the current exports BEFORE mocking (bun patches the namespace
      // in place, so a live reference would point at the mock afterwards).
      const real: Record<string, unknown> = { ...(await import(specifier)) };
      const wrapped: Record<string, unknown> = { ...real };
      for (const [name, fake] of Object.entries(overrides)) {
        const original = real[name];
        if (typeof original !== "function") {
          throw new Error(`scopedModuleMocks: ${specifier} has no function export "${name}"`);
        }
        wrapped[name] = (...args: unknown[]) =>
          active ? fake(...args) : (original as AnyFn)(...args);
      }
      mock.module(specifier, () => wrapped);
    },
  };
}
