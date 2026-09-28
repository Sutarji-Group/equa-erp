import { timingSafeEqual } from "node:crypto";

import { runDueJobs } from "@/server/core/jobs";
import { errorResponse } from "@/server/core/errors";
import { serverEnv } from "@/lib/env";

/**
 * Pemicu pekerjaan terjadwal (docs/ARCHITECTURE.md §5 `jobs.ts`). Dipanggil Vercel Cron (harian, cadangan) dan
 * GitHub Actions / Upstash QStash (tiap 5 menit) dengan header `Authorization: Bearer $CRON_SECRET`.
 * `runDueJobs` idempoten per slot (`job_runs`), jadi pemicu ganda aman. Opsional `?only=kunci1,kunci2`.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${serverEnv().CRON_SECRET}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ ok: false, message: "Tidak diizinkan." }, { status: 401 });
  }
  try {
    const only = new URL(request.url).searchParams.get("only");
    const ran = await runDueJobs(new Date(), { only: only ? only.split(",").map((s) => s.trim()).filter(Boolean) : undefined });
    return Response.json({ ok: ran.every((r) => r.status !== "failed"), ran });
  } catch (error) {
    return errorResponse(error);
  }
}

export function GET(request: Request) {
  return handle(request);
}

export function POST(request: Request) {
  return handle(request);
}
