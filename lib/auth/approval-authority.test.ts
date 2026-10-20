import { test, expect, mock } from "bun:test";
let agent: Record<string,unknown> | null={id:"agent",status:"linked",credential_fingerprint:"fixture-hash",credential_generation:2,grok_bot_agent_id:"bot"};
mock.module("@/lib/supabase",()=>({createSupabaseAdminClient:()=>({from:()=>{const filters:Record<string,unknown>={};const query={select:()=>query,eq:(k:string,v:unknown)=>{filters[k]=v;return query;},maybeSingle:async()=>({data:filters.org_id==="org"&&filters.id==="agent"?agent:null,error:null})};return query;}})}));
const { isApprovalAuthorityCurrent } = await import("./approval-authority");
const approval={orgId:"org",employeeId:"",credentialId:"",purpose:"admin.policy",metadata:{auditClass:"admin",adminRequester:{kind:"admin_agent",actorId:"agent",grokBotAgentId:"bot",credentialGeneration:2}}};
const legacy={...approval,metadata:{auditClass:"admin",adminRequester:{kind:"admin_agent",actorId:"agent",grokBotAgentId:"bot"}}};
test("worker admin authority requires current tenant, requester, generation and active binding",async()=>{
 expect(await isApprovalAuthorityCurrent(approval)).toBe(true);
 expect(await isApprovalAuthorityCurrent({...approval,orgId:"other"})).toBe(false);
 for (const patch of [{status:"revoked"},{status:"needs_reauth"},{credential_generation:3},{grok_bot_agent_id:"rebound"},{credential_fingerprint:null}]) {
  const original=agent;agent={...agent,...patch};expect(await isApprovalAuthorityCurrent(approval)).toBe(false);agent=original;
 }
 agent=null;expect(await isApprovalAuthorityCurrent(approval)).toBe(false);
});
test("legacy admin tickets without credentialGeneration are refused after reissue",async()=>{
 agent={id:"agent",status:"linked",credential_fingerprint:"fixture-hash",credential_generation:1,grok_bot_agent_id:"bot"};
 expect(await isApprovalAuthorityCurrent(legacy)).toBe(true);
 agent={...agent,credential_generation:2};
 expect(await isApprovalAuthorityCurrent(legacy)).toBe(false);
});
test("legacy admin tickets without credentialGeneration are refused when a reissue audit exists",async()=>{
 const { isLegacyAdminRequesterStillValid } = await import("./approval-authority");
 expect(isLegacyAdminRequesterStillValid({ credentialGeneration: undefined, currentGeneration: 1, hasReissueAudit: false })).toBe(true);
 expect(isLegacyAdminRequesterStillValid({ credentialGeneration: undefined, currentGeneration: 1, hasReissueAudit: true })).toBe(false);
 expect(isLegacyAdminRequesterStillValid({ credentialGeneration: undefined, currentGeneration: 2, hasReissueAudit: false })).toBe(false);
 expect(isLegacyAdminRequesterStillValid({ credentialGeneration: 2, currentGeneration: 2, hasReissueAudit: true })).toBe(true);
});
