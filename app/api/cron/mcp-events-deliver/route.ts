import { NextResponse } from "next/server";
export async function GET() { return NextResponse.json({ error: "not_implemented" }, { status: 501 }); }
