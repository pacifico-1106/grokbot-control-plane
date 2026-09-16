declare module "bun:test" {
  type TestCallback = () => unknown | Promise<unknown>;
  type TestFunction = (name: string, callback: TestCallback) => void;
  type Matcher = {
    not: Matcher;
    rejects: Matcher;
    resolves: Matcher;
    toBeUndefined(): void;
    toBeDefined(): void;
    toHaveProperty(key: string): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeGreaterThan(expected: number): void;
    toHaveLength(expected: number): void;
    toMatch(expected: string | RegExp): void;
    toMatchObject(expected: unknown): void;
    toBe(expected: unknown): void;
    toBeCloseTo(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toContain(expected: unknown): void;
    toEqual(expected: unknown): void;
    toThrow(expected?: unknown): void;
  };

  export const afterAll: (callback: TestCallback) => void;
  export const afterEach: (callback: TestCallback) => void;
  export const beforeEach: (callback: TestCallback) => void;
  export const describe: TestFunction;
  export const expect: (actual: unknown) => Matcher;
  export const mock: {
    module(specifier: string, factory: () => unknown): void;
  };
  export const test: TestFunction;
}
