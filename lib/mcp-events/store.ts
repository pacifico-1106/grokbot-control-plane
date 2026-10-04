const ni = (..._a: unknown[]): never => { throw new Error("not_implemented"); };
export const __resetMcpEventsStoreForTests = (): void => undefined;
export const getSubscription = ni as (id: string) => Promise<Record<string, any> | null>;
export const upsertSubscription = ni as (row: Record<string, unknown>) => Promise<void>;
