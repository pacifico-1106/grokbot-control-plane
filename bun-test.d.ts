declare module "bun:test" {
  type TestCallback = () => unknown | Promise<unknown>;
  type TestFunction = (name: string, callback: TestCallback) => void;
  type Matcher = {
    not: Matcher;
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

  export const afterEach: (callback: TestCallback) => void;
  export const beforeEach: (callback: TestCallback) => void;
  export const describe: TestFunction;
  export const expect: (actual: unknown) => Matcher;
  export const mock: {
    module(specifier: string, factory: () => unknown): void;
  };
  export const test: TestFunction;
}
