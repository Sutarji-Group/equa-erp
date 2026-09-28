/**
 * Next.js instrumentation (dipanggil sekali saat server Node mulai): isi registri modul (laporan, handler sinkron &
 * event, job, label audit, objek keuangan) lebih awal agar instance "dingin" tidak menampilkan katalog kosong.
 *
 * Catatan: bundel instrumentation dapat memiliki instans modul terpisah dari bundel route, jadi ini hanya
 * pemanasan — jaminannya tetap `ensureBootstrapped()` di setiap pembaca registri (getOfficeSession, listReports,
 * getReport, queryForActor, describeAudit, listJobs, listSyncHandlerTypes, listPullProviders, emit, approvals, …).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { ensureBootstrapped } = await import("@/server/core/bootstrap");
    ensureBootstrapped();
  } catch (error) {
    console.warn("[equa] pemanasan registri saat server mulai dilewati (akan dilakukan saat permintaan pertama):", error);
  }
}
