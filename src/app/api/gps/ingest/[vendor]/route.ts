import { timingSafeEqual } from "node:crypto";

import { serverEnv } from "@/lib/env";
import { errorResponse } from "@/server/core/errors";
import { getGpsVendorAdapter, ingestGpsFixes } from "@/server/modules/m12-fleet";

/**
 * Penghubung vendor GPS (NFR-21, US-M12-01): `GET|POST /api/gps/ingest/<vendor>` — `generic-json` (JSON: satu posisi,
 * larik, atau `{ positions: [...] }`) atau `osmand` (protokol OsmAnd/Traccar: `?id=&lat=&lon=&timestamp=&speed=…`).
 * Autentikasi: `Authorization: Bearer $GPS_INGEST_TOKEN` atau `?token=` (perangkat OsmAnd tidak dapat mengirim header).
 * Idempoten (unik truk + sumber + waktu perangkat) — vendor boleh mengirim ulang. Tanpa sesi pengguna (pelaku Sistem).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function tokenOf(request: Request, url: URL): string {
  const header = request.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return url.searchParams.get("token") ?? "";
}

function authorized(token: string): boolean {
  const expected = Buffer.from(serverEnv().GPS_INGEST_TOKEN);
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const text = await request.text();
  if (!text.trim()) return null;
  if (type.includes("application/x-www-form-urlencoded")) return new URLSearchParams(text);
  if (type.includes("json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw Object.assign(new Error("Isi permintaan bukan JSON yang valid."), { status: 400 });
    }
  }
  return text;
}

async function handle(request: Request, ctx: RouteContext<"/api/gps/ingest/[vendor]">): Promise<Response> {
  const url = new URL(request.url);
  if (!authorized(tokenOf(request, url))) {
    return Response.json({ ok: false, message: "Token penghubung GPS tidak valid." }, { status: 401 });
  }
  const { vendor } = await ctx.params;
  const adapter = getGpsVendorAdapter(decodeURIComponent(vendor));
  if (!adapter) return Response.json({ ok: false, message: `Penghubung vendor "${vendor}" tidak dikenal.` }, { status: 404 });
  try {
    let body: unknown;
    try {
      body = await readBody(request);
    } catch (error) {
      return Response.json({ ok: false, message: error instanceof Error ? error.message : "Isi permintaan tidak valid." }, { status: 400 });
    }
    const parsed = adapter.parse({ method: request.method, contentType: request.headers.get("content-type") ?? "", query: url.searchParams, body });
    if (parsed.fixes.length === 0 && parsed.errors.length === 0) {
      return Response.json({ ok: false, message: "Tidak ada posisi dalam permintaan." }, { status: 400 });
    }
    const result = await ingestGpsFixes(parsed.fixes, { vendor: adapter.key, parseErrors: parsed.errors });
    const status = result.accepted + result.duplicates > 0 ? 200 : 422;
    return Response.json({ ok: status === 200, ...result }, { status });
  } catch (error) {
    return errorResponse(error);
  }
}

export function GET(request: Request, ctx: RouteContext<"/api/gps/ingest/[vendor]">) {
  return handle(request, ctx);
}

export function POST(request: Request, ctx: RouteContext<"/api/gps/ingest/[vendor]">) {
  return handle(request, ctx);
}
