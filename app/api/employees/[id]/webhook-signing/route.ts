// fail-first stub (D9) — replaced by the implementation commit
import { NextResponse } from "next/server";
export async function GET(_req: Request, _ctx: { params: Promise<{ id: string }> }) { return NextResponse.json({ error: "not_implemented" }, { status: 501 }); }
export async function POST(_req: Request, _ctx: { params: Promise<{ id: string }> }) { return NextResponse.json({ error: "not_implemented" }, { status: 501 }); }
