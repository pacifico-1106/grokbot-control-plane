import { getSuperAdminAccess } from "@/lib/admin/access";
import { handleNoticesCollection, refuseAiPublish } from "@/lib/operator-notices/admin-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Super-admin browser session only. AI credentials → 403 ai_cannot_publish. */
export async function GET(req: Request) {
  const refused = refuseAiPublish(req);
  if (refused) return refused;
  return handleNoticesCollection("GET", req, await getSuperAdminAccess());
}

export async function POST(req: Request) {
  const refused = refuseAiPublish(req);
  if (refused) return refused;
  return handleNoticesCollection("POST", req, await getSuperAdminAccess());
}
