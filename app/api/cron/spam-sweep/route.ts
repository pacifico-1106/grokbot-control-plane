import { runSpamSweep } from "@/lib/spam/sweep-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Daily spam sweep — SPAM_SWEEP_ENABLED (default OFF). See docs/runbooks/spam-sweep.md. */
export async function GET(req: Request) {
  return runSpamSweep(req);
}
