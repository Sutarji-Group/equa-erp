import { timingSafeEqual } from "node:crypto";

import { runDueJobs } from "@/server/core/jobs";
import { e2eCronNow, E2eClockDisabledError } from "@/server/core/e2e-clock";
import { errorResponse } from "@/server/core/errors";
import { serverEnv } from "@/lib/env";

/**
 * Pemicu pekerjaan terjadwal (docs/ARCHITECTURE.md §5 `jobs.ts`). Dipanggil Vercel Cron (harian, cadangan) dan
 * GitHub Actions / Upstash QStash (tiap 5 menit) dengan header `Authorization: Bearer $CRON_SECRET`.
 * `runDueJobs` idempoten per slot (`job_runs`), jadi pemicu ganda aman. Opsional `?only=kunci1,kunci2`.
 * Tambahan S5 QA: `?now=<ISO>` menjalankan job pada waktu tersuntik — HANYA uji E2E lokal (`E2E_CLOCK_OVERRIDE=1` +
 * `ALLOW_DEV_SECRETS=1`, bukan deploy Vercel; lihat `src/server/core/e2e-clock.ts`); selain itu ditolak 400.
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
    const url = new URL(request.url);
    const only = url.searchParams.get("only");
    let now: Date;
    try {
      now = e2eCronNow(url.searchParams.get("now")) ?? new Date();
    } catch (error) {
      if (error instanceof E2eClockDisabledError) return Response.json({ ok: false, message: error.message }, { status: 400 });
      throw error;
    }
    const ran = await runDueJobs(now, { only: only ? only.split(",").map((s) => s.trim()).filter(Boolean) : undefined });
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
