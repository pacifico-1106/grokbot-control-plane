/* eslint-disable @typescript-eslint/no-explicit-any */
const ni = (..._a: unknown[]): never => { throw new Error("not_implemented"); };
export const __setMcpEventsTransportForTests = (_t: unknown): void => undefined;
export const __setMcpEventsClockForTests = (_c: unknown): void => undefined;
export const __flushMcpEventsBackgroundForTests = async (): Promise<void> => undefined;
export const handleEventsList = ni as (...a: any[]) => Promise<any>;
export const handleEventsSubscribe = ni as (...a: any[]) => Promise<any>;
export const handleEventsUnsubscribe = ni as (...a: any[]) => Promise<any>;
export const emitApprovalEvent = ni as (...a: any[]) => Promise<any>;
export const deliverDueEvents = ni as (...a: any[]) => Promise<any>;
export const recordTriggeredAction = ni as (...a: any[]) => Promise<any>;
export const listSubscriptionLedger = ni as (...a: any[]) => Promise<any[]>;
