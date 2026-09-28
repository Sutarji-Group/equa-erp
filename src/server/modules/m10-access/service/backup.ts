/**
 * M10 — status pencadangan & uji pemulihan (US-M10-06 KP-4; NFR-13 M; NFR-14 S).
 *
 * Pencadangan harian & salinan bulanan dijalankan tim IT di luar produk; produk mencatat hasilnya (admin sistem) dan
 * menampilkan status cadangan terakhir kepada admin sistem & pemilik, termasuk hasil uji pemulihan (RPO/RTO) dengan
 * penanda bila cadangan harian terlalu lama atau uji pemulihan < 2×/tahun (parameter `backup.policy`). Kegagalan
 * cadangan diberitahukan (`backup.failed`).
 */
import "server-only";

import { and, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";

import { backupStatusLogs } from "@/db/schema";
import { enumValues } from "@/lib/labels";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";

import { userNames } from "./shared";

export type BackupRow = typeof backupStatusLogs.$inferSelect;

export const backupRecordSchema = z
  .object({
    kind: z.enum(enumValues("backup_kind"), { error: "Pilih jenis: harian, bulanan, atau uji pemulihan." }),
    status: z.enum(enumValues("backup_status"), { error: "Pilih hasil: berhasil atau gagal." }),
    startedAt: z.date({ error: "Waktu mulai wajib diisi." }),
    finishedAt: z.date().nullable().optional(),
    sizeBytes: z.number().int().min(0).nullable().optional(),
    location: z.string().trim().max(300).nullable().optional(),
    rpoMinutes: z.number().int().min(0).nullable().optional(),
    rtoMinutes: z.number().int().min(0).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => !v.finishedAt || v.finishedAt >= v.startedAt, { error: "Waktu selesai tidak boleh sebelum waktu mulai.", path: ["finishedAt"] })
  .refine((v) => v.kind !== "restore_test" || (v.rpoMinutes != null && v.rtoMinutes != null), {
    error: "Uji pemulihan wajib mencatat RPO dan RTO tercapai (menit).",
    path: ["rpoMinutes"],
  });

/** Catat hasil cadangan / uji pemulihan (admin sistem). Gagal → pemberitahuan ke tim IT & pemilik. */
export async function recordBackupStatus(ctx: ActorContext, input: z.input<typeof backupRecordSchema>, opts: { tx?: Tx } = {}): Promise<BackupRow> {
  await authorize(ctx, "m10.backup_status.create", { tx: opts.tx, objectType: "backup_status_log" });
  const data = parseInput(backupRecordSchema, input, { startedAt: "Waktu mulai", finishedAt: "Waktu selesai", rpoMinutes: "RPO", rtoMinutes: "RTO" });
  if (data.startedAt.getTime() > ctx.now.getTime() + 5 * 60_000) throw ValidationError.field("startedAt", "Waktu mulai tidak boleh di masa depan.");
  return runService(ctx, opts, async (tx) => {
    const [row] = await tx
      .insert(backupStatusLogs)
      .values({
        kind: data.kind,
        status: data.status,
        startedAt: data.startedAt,
        finishedAt: data.finishedAt ?? null,
        sizeBytes: data.sizeBytes ?? null,
        location: data.location ?? null,
        rpoMinutes: data.rpoMinutes ?? null,
        rtoMinutes: data.rtoMinutes ?? null,
        notes: data.notes ?? null,
        recordedBy: ctx.userId,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "backup_status_log", objectId: row!.id, action: "create", after: { kind: data.kind, status: data.status, rpoMinutes: data.rpoMinutes ?? null, rtoMinutes: data.rtoMinutes ?? null } });
    if (data.status === "failed") {
      await notify(tx, {
        event: "backup.failed",
        tenantId: ctx.tenantId,
        title: `${data.kind === "restore_test" ? "Uji pemulihan" : "Pencadangan"} gagal`,
        body: data.notes ?? "Ulangi dan catat hasilnya.",
        objectType: "backup_status_log",
        objectId: row!.id,
        link: "/akses/data-pribadi#cadangan",
        now: ctx.now,
      });
    }
    return row!;
  });
}

export type BackupOverview = {
  lastDaily: BackupRow | null;
  lastMonthly: BackupRow | null;
  lastRestoreTest: BackupRow | null;
  restoreTestsLast12Months: number;
  policy: { daily_max_age_hours: number; restore_tests_per_year: number };
  flags: { dailyStale: boolean; restoreTestsBelowTarget: boolean; lastDailyFailed: boolean };
  history: (BackupRow & { recordedByName: string | null })[];
};

/** Status cadangan terakhir & uji pemulihan (admin sistem, pemilik). */
export async function backupOverview(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<BackupOverview> {
  await authorize(ctx, "m10.backup_status.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const policy = await params.get(tx, "backup.policy", ctxBusinessDate(ctx));
  const latest = async (kind: BackupRow["kind"]) => (await tx.select().from(backupStatusLogs).where(eq(backupStatusLogs.kind, kind)).orderBy(desc(backupStatusLogs.startedAt)).limit(1))[0] ?? null;
  const lastDaily = await latest("daily");
  const lastMonthly = await latest("monthly");
  const lastRestoreTest = await latest("restore_test");
  const since = new Date(ctx.now.getTime() - 365 * 86_400_000);
  const tests = await tx
    .select({ id: backupStatusLogs.id })
    .from(backupStatusLogs)
    .where(and(eq(backupStatusLogs.kind, "restore_test"), eq(backupStatusLogs.status, "success"), gte(backupStatusLogs.startedAt, since)));
  const lastGoodDaily = (await tx
    .select()
    .from(backupStatusLogs)
    .where(and(eq(backupStatusLogs.kind, "daily"), eq(backupStatusLogs.status, "success")))
    .orderBy(desc(backupStatusLogs.startedAt))
    .limit(1))[0];
  const history = await tx.select().from(backupStatusLogs).orderBy(desc(backupStatusLogs.startedAt)).limit(30);
  const names = await userNames(tx, history.map((h) => h.recordedBy));
  return {
    lastDaily,
    lastMonthly,
    lastRestoreTest,
    restoreTestsLast12Months: tests.length,
    policy,
    flags: {
      dailyStale: !lastGoodDaily || ctx.now.getTime() - lastGoodDaily.startedAt.getTime() > policy.daily_max_age_hours * 3_600_000,
      restoreTestsBelowTarget: tests.length < policy.restore_tests_per_year,
      lastDailyFailed: lastDaily?.status === "failed",
    },
    history: history.map((h) => ({ ...h, recordedByName: h.recordedBy ? (names.get(h.recordedBy) ?? null) : null })),
  };
}
