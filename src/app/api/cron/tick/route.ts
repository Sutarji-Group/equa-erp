import { serverEnv } from "@/lib/env";

/**
 * Pemicu pekerjaan terjadwal (docs/ARCHITECTURE.md §5 `jobs.ts`). Dipanggil Vercel Cron (harian, cadangan) dan
 * GitHub Actions (tiap 5 menit) dengan header `Authorization: Bearer $CRON_SECRET`.
 * PLACEHOLDER Sprint 0 (F1): platform inti mengganti isi handler dengan `runDueJobs()` yang idempoten.
 */
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${serverEnv().CRON_SECRET}`) {
    return Response.json({ ok: false, message: "Tidak diizinkan." }, { status: 401 });
  }
  return Response.json({ ok: true, ran: [] });
}
