/**
 * M10 — jadwal retensi otomatis (US-M10-06 KP-3; PAR-29, PAR-52; PTB-33; BR-31).
 *
 * Job harian `m10.retention.daily` (02.30 WIB, di luar jam layanan):
 * - log akses lebih tua dari PAR-29 `access_log_years` → dihapus lewat `withRetentionPurge` (satu-satunya jalur hapus
 *   yang diizinkan trigger pengerasan);
 * - foto/berkas bukti (bukti kirim, meter, nota, slip, tanda tangan) lebih tua dari PAR-29 `photo_years` → ditandai
 *   arsip (`archived_at`), TETAP dapat dibuka dari rit/jurnal terkait;
 * - posisi GPS mentah lebih tua dari PAR-52 bulan → dihapus lewat M12 `purgeExpiredPositions` (ringkasan rit/hari
 *   dipastikan dulu, US-M12-01 KP-6).
 * Data akuntansi & transaksi (≥ PAR-29 `accounting_years`) serta jejak audit TIDAK PERNAH dihapus.
 */
import "server-only";

import { and, inArray, isNull, lt } from "drizzle-orm";

import { accessLogs, attachments } from "@/db/schema";
import { withRetentionPurge } from "@/db/hardening";
import { toBusinessDate, wibToUtc } from "@/lib/time";
import { query as auditQuery, record as auditRecord } from "@/server/core/audit";
import { EQUA_TENANT_ID, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import * as params from "@/server/core/params";
import { authorize } from "@/server/core/rbac";

/** Jenis lampiran foto/bukti yang diarsipkan setelah PAR-29 `photo_years`. */
export const ARCHIVABLE_ATTACHMENT_KINDS = [
  "delivery_photo",
  "signature",
  "meter_photo",
  "receipt_note",
  "transfer_proof",
  "deposit_slip",
  "expense_receipt",
  "purchase_note",
  "photo",
] as const;

export type RetentionPolicy = { accessLogYears: number; photoYears: number; accountingYears: number; gpsMonths: number };

export type RetentionResult = {
  policy: RetentionPolicy;
  cutoffs: { accessLogs: string; photos: string; gps: string };
  accessLogsPurged: number;
  photosArchived: number;
  gpsPurged: number;
};

function yearsAgo(date: string, years: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${y - years}-${String(m).padStart(2, "0")}-${String(Math.min(d, 28)).padStart(2, "0")}`;
}

function monthsAgo(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, 28)).padStart(2, "0")}`;
}

/** Kebijakan retensi yang berlaku (untuk tampilan halaman Data pribadi). */
export async function retentionPolicy(db: Tx, date: string): Promise<RetentionPolicy> {
  const p29 = await params.get(db, "PAR-29", date);
  const p52 = await params.get(db, "PAR-52", date);
  return { accessLogYears: p29.access_log_years, photoYears: p29.photo_years, accountingYears: p29.accounting_years, gpsMonths: p52.months };
}

/** Jalankan retensi (job harian). */
export async function runRetention(now: Date = new Date(), db?: Db): Promise<RetentionResult> {
  const database = db ?? getDb();
  const today = toBusinessDate(now);
  const policy = await retentionPolicy(database, today);
  const cutoffs = {
    accessLogs: yearsAgo(today, policy.accessLogYears),
    photos: yearsAgo(today, policy.photoYears),
    gps: monthsAgo(today, policy.gpsMonths),
  };
  const accessCut = wibToUtc(cutoffs.accessLogs);
  const photoCut = wibToUtc(cutoffs.photos);

  const accessLogsPurged = await withRetentionPurge(database, async (tx) => {
    const rows = await tx.delete(accessLogs).where(lt(accessLogs.occurredAt, accessCut)).returning({ id: accessLogs.id });
    return rows.length;
  });
  // US-M12-01 KP-6, PTB-33 (S5B): posisi GPS mentah dihapus lewat jalur M12 yang MEMASTIKAN ringkasan rit/hari dulu —
  // job M10 berjalan sebelum M12 pada tick yang sama (registri), jadi M10 tidak boleh menghapus tanpa ringkasan.
  // Impor dinamis: M12 mengimpor M10 (insiden perangkat) — hindari siklus saat modul dimuat.
  const { purgeExpiredPositions } = await import("@/server/modules/m12-fleet");
  const gpsPurged = (await purgeExpiredPositions(now, database)).purged;
  const photosArchived = await withTx(
    async (tx) => {
      const rows = await tx
        .update(attachments)
        .set({ archivedAt: now, updatedAt: now })
        .where(and(isNull(attachments.archivedAt), lt(attachments.createdAt, photoCut), inArray(attachments.kind, [...ARCHIVABLE_ATTACHMENT_KINDS])))
        .returning({ id: attachments.id });
      const result = { policy, cutoffs, accessLogsPurged, photosArchived: rows.length, gpsPurged };
      await auditRecord(tx, { ctx: systemContext({ tenantId: EQUA_TENANT_ID, now }), objectType: "retention_run", objectId: today, action: "create", after: result, rule: "PAR-29, PAR-52" });
      return rows.length;
    },
    { db: database },
  );
  return { policy, cutoffs, accessLogsPurged, photosArchived, gpsPurged };
}

/** Riwayat jalannya retensi (dari jejak audit) — untuk halaman Data pribadi. */
export async function retentionOverview(ctx: ActorContext) {
  await authorize(ctx, "m10.personal_data.read");
  const db = getDb();
  const policy = await retentionPolicy(db, toBusinessDate(ctx.now));
  const runs = await auditQuery(db, { objectType: "retention_run", limit: 10 });
  return { policy, runs: runs.map((r) => ({ date: r.objectId, at: r.serverTime, result: r.after as Partial<RetentionResult> | null })) };
}
