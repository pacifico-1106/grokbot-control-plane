import { getSuperAdminAccess } from "@/lib/admin/access";
import { handleNoticePublish, refuseAiPublish } from "@/lib/operator-notices/admin-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Super-admin browser session only. AI credentials → 403 ai_cannot_publish. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const refused = refuseAiPublish(req);
  if (refused) return refused;
  const { id } = await ctx.params;
  return handleNoticePublish(req, await getSuperAdminAccess(), id);
}
