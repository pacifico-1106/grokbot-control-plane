import { NextResponse } from "next/server";

/**
 * JSON with an explicit UTF-8 charset. On Node (Vercel) NextResponse.json sets
 * a bare `application/json`, and some browsers then show Japanese text garbled
 * (八坂さん 2026-10-12). Same as NextResponse.json otherwise; a caller-supplied
 * content-type is replaced.
 */
export const JSON_UTF8_CONTENT_TYPE = "application/json; charset=utf-8";

export function jsonUtf8<T>(body: T, init?: ResponseInit): NextResponse<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", JSON_UTF8_CONTENT_TYPE);
  return NextResponse.json(body, { ...init, headers });
}
