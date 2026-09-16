// Only for the in-process demo simulator. Production uses row locks in the vote RPC.
const locks = new Map<string, Promise<void>>();
export async function withDemoWorkflowLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  locks.set(key, current);
  await previous;
  try { return await work(); }
  finally { release(); if (locks.get(key) === current) locks.delete(key); }
}
