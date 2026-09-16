import { test, expect } from "bun:test";
import { setOrgInternalAudienceRule, getOrgInternalAudienceRule, clearDemoRule } from "./internal-audience-rule";
test("partial rule patch preserves omitted fields, empty lists clear, malformed policy does not mutate",async()=>{
 clearDemoRule();
 await setOrgInternalAudienceRule("org",{emailDomains:["EXAMPLE.COM"],slackTeamIds:["TABC123"],autoSlackTeamInternal:true},"fixture");
 await setOrgInternalAudienceRule("org",{emailDomains:[]},"fixture");
 const before=await getOrgInternalAudienceRule("org");
 expect(before.emailDomains).toEqual([]);expect(before.slackTeamIds).toEqual(["TABC123"]);expect(before.autoSlackTeamInternal).toBe(true);
 for (const invalid of [{emailDomains:["*"]},{slackTeamIds:["bad"]},{autoSlackTeamInternal:"true"},{emailDomains:[null]}]) {
  await expect(setOrgInternalAudienceRule("org",invalid as Parameters<typeof setOrgInternalAudienceRule>[1],"fixture")).rejects.toThrow();
  expect(await getOrgInternalAudienceRule("org")).toEqual(before);
 }
});
