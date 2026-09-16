import { test, expect, mock } from "bun:test";
import type { SessionContext } from "@/lib/auth/session";
let session: SessionContext = { demo:false,userId:"user",email:"viewer@example.com",orgId:"org",member:null };
let reads=0;
mock.module("@/lib/auth/session", () => ({ getSessionContext: async () => session, getCurrentOrgId: async () => session.orgId }));
mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
mock.module("@/lib/data", () => ({
 listApprovals: async (orgId:string) => { reads++;return orgId === "org" ? [{ id:"fixture",orgId:"org",metadata:{adminFulfillment:{oneTimeSecret:"fixture-secret",ok:true},adminMutation:{botTokenCiphertext:"encrypted"}},statusToken:"private-poll",pollPath:"private-path" }] : []; },
 runtimeModeLabel: () => "production",getDemoApprovalsBackend: () => "memory",isDurableDemoApprovalsStore: () => false,
}));
const { GET } = await import("./route");
test("actual list route removes secrets for a tenant session and does not mix organizations",async()=>{
 const response=await GET();expect(response.status).toBe(200);
 const body=await response.json();expect(body.approvals.length).toBe(1);
 expect(body.approvals[0].metadata.adminFulfillment).toEqual({ok:true});
 expect(body.approvals[0].metadata.adminMutation).toEqual({});
 expect(body.approvals[0].statusToken).toBe("");
 session={...session,orgId:"other"};expect((await (await GET()).json()).approvals).toEqual([]);
});
test("unauthenticated request never queries approval data",async()=>{
 session={demo:false,userId:null,email:null,orgId:null,member:null};const before=reads;
 expect((await GET()).status).toBe(401);expect(reads).toBe(before);
});
