/**
 * Seed demo M10 (Pengguna, Hak Akses & Jejak Audit) — idempoten (ID deterministik + ON CONFLICT DO NOTHING; pembaruan
 * kesehatan perangkat hanya bila belum pernah terhubung). Mengisi layar "Perangkat & sinkron", insiden, helpdesk,
 * status cadangan, dan tinjauan hak akses kuartal lalu. Karyawan tanpa akun berasal dari master M1 (seed M1/impor).
 * Tidak membuat permintaan persetujuan / tanda tangan akun awal (dibiarkan untuk demo alur UI).
 */
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { DbOrTx } from "../client";
import { accessReviews, backupStatusLogs, devices, incidents, supportTickets } from "../schema";
import { seedId } from "./ids";
import { deviceId, EQUA_TENANT_ID, userIdByUsername } from "./org";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function previousQuarter(now: Date): string {
  const wib = new Date(now.getTime() + 7 * HOUR);
  const q = Math.floor(wib.getUTCMonth() / 3) + 1;
  return q === 1 ? `${wib.getUTCFullYear() - 1}-Q4` : `${wib.getUTCFullYear()}-Q${q - 1}`;
}

export async function seedDemoM10Access(tx: DbOrTx, now: Date = new Date()): Promise<{ inserted: number }> {
  let inserted = 0;

  // Laporan kendala lapangan (helpdesk; tenggat PAR-87 = 1 minggu).
  const tickets = await tx
    .insert(supportTickets)
    .values([
      {
        id: seedId("m10:ticket:1"),
        tenantId: EQUA_TENANT_ID,
        category: "app_issue",
        reporterUserId: userIdByUsername("sopir1"),
        deviceId: deviceId("HP-T1"),
        subject: "Foto bukti kirim lama terkirim",
        description: "Di daerah Cibeber foto bukti kirim tertahan di ponsel hampir satu jam sebelum terkirim.",
        appVersion: "0.1.0",
        syncStatus: { queue: 2, lastSyncMinutes: 48 },
        status: "received",
        dueAt: new Date(now.getTime() + 6 * DAY),
        createdAt: new Date(now.getTime() - DAY),
        updatedAt: new Date(now.getTime() - DAY),
      },
      {
        id: seedId("m10:ticket:2"),
        tenantId: EQUA_TENANT_ID,
        category: "feedback",
        reporterUserId: userIdByUsername("depot01"),
        deviceId: deviceId("POS-D01"),
        subject: "Tombol galon isi ulang dibuat lebih besar",
        description: "Saat ramai sering salah tekan antara galon isi ulang dan galon baru.",
        appVersion: "0.1.0",
        status: "answered",
        answer: "Terima kasih. Ukuran tombol diperbesar pada rilis 0.2.0 minggu depan.",
        answeredBy: userIdByUsername("admin1"),
        answeredAt: new Date(now.getTime() - 2 * DAY),
        dueAt: new Date(now.getTime() + 2 * DAY),
        createdAt: new Date(now.getTime() - 5 * DAY),
        updatedAt: new Date(now.getTime() - 2 * DAY),
      },
    ])
    .onConflictDoNothing()
    .returning({ id: supportTickets.id });
  inserted += tickets.length;

  // Insiden yang sudah pulih (waktu tanggap & pulih tercatat, NFR-31).
  const detected = new Date(now.getTime() - 2 * DAY);
  const inc = await tx
    .insert(incidents)
    .values({
      id: seedId("m10:incident:1"),
      tenantId: EQUA_TENANT_ID,
      kind: "mass_sync_failure",
      severity: "critical",
      status: "resolved",
      title: "Sinkron gagal massal: 5 perangkat tidak sinkron > 30 menit",
      description: "Perangkat: HP-T2, HP-T3, HP-T5, POS-D02, POS-D04. Periksa layanan sinkron & jaringan.",
      objectType: "monitor",
      objectId: "mass_sync_failure",
      detectedAt: detected,
      acknowledgedAt: new Date(detected.getTime() + 12 * MIN),
      acknowledgedBy: userIdByUsername("admin1"),
      resolvedAt: new Date(detected.getTime() + 95 * MIN),
      resolvedBy: userIdByUsername("admin1"),
      resolution: "Sertifikat penyimpanan berkas kedaluwarsa; diperbarui dan antrean terkirim ulang tanpa kehilangan data.",
    })
    .onConflictDoNothing()
    .returning({ id: incidents.id });
  inserted += inc.length;

  // Status cadangan & uji pemulihan (NFR-13/14).
  const backups = await tx
    .insert(backupStatusLogs)
    .values([
      {
        id: seedId("m10:backup:daily"),
        kind: "daily",
        status: "success",
        startedAt: new Date(now.getTime() - 20 * HOUR),
        finishedAt: new Date(now.getTime() - 20 * HOUR + 6 * MIN),
        sizeBytes: 48_000_000,
        location: "Neon PITR (Singapura)",
        recordedBy: userIdByUsername("admin1"),
      },
      {
        id: seedId("m10:backup:monthly"),
        kind: "monthly",
        status: "success",
        startedAt: new Date(now.getTime() - 20 * DAY),
        finishedAt: new Date(now.getTime() - 20 * DAY + 14 * MIN),
        sizeBytes: 51_000_000,
        location: "Arsip bulanan akuntansi (Vercel Blob)",
        recordedBy: userIdByUsername("admin1"),
      },
      {
        id: seedId("m10:backup:restore"),
        kind: "restore_test",
        status: "success",
        startedAt: new Date(now.getTime() - 90 * DAY),
        finishedAt: new Date(now.getTime() - 90 * DAY + 2 * HOUR),
        rpoMinutes: 40,
        rtoMinutes: 120,
        notes: "Uji pemulihan semester 1: pemulihan ke basis data cabang, verifikasi saldo kas & piutang cocok.",
        recordedBy: userIdByUsername("admin2"),
      },
    ])
    .onConflictDoNothing()
    .returning({ id: backupStatusLogs.id });
  inserted += backups.length;

  // Tinjauan hak akses kuartal lalu (sudah ditinjau pemilik).
  const quarter = previousQuarter(now);
  const review = await tx
    .insert(accessReviews)
    .values({
      id: seedId(`m10:access_review:${quarter}`),
      tenantId: EQUA_TENANT_ID,
      quarter,
      snapshot: { takenAt: new Date(now.getTime() - 30 * DAY).toISOString(), inactiveDays: 60, count: 43, items: [] },
      flagged: { count: 0, users: [] },
      status: "reviewed",
      reviewedBy: userIdByUsername("pemilik"),
      reviewedAt: new Date(now.getTime() - 30 * DAY),
      notes: "Semua akun sesuai jabatan; tidak ada multi-peran.",
    })
    .onConflictDoNothing()
    .returning({ id: accessReviews.id });
  inserted += review.length;

  // Laporan kesehatan perangkat contoh (hanya perangkat yang belum pernah terhubung).
  const health: { code: string; appVersion: string; batteryPct: number; syncAgoMin: number; queue: number; user: string }[] = [
    { code: "HP-T2", appVersion: "0.1.0", batteryPct: 76, syncAgoMin: 3, queue: 0, user: "sopir2" },
    { code: "HP-T4", appVersion: "0.0.9", batteryPct: 22, syncAgoMin: 50, queue: 3, user: "sopir4" },
    { code: "POS-D01", appVersion: "0.1.0", batteryPct: 90, syncAgoMin: 8, queue: 1, user: "depot01" },
  ];
  for (const h of health) {
    await tx
      .update(devices)
      .set({
        appVersion: h.appVersion,
        batteryPct: h.batteryPct,
        lastSyncAt: new Date(now.getTime() - h.syncAgoMin * MIN),
        lastSeenAt: new Date(now.getTime() - h.syncAgoMin * MIN),
        reportedQueueCount: h.queue,
        lastUserId: userIdByUsername(h.user),
      })
      .where(and(inArray(devices.id, [deviceId(h.code)]), isNull(devices.lastSeenAt), eq(devices.tenantId, EQUA_TENANT_ID)));
  }
  return { inserted };
}
