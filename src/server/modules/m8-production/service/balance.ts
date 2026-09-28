/**
 * M8 — neraca air harian per sumber & susut (US-M8-04; BR-26, PTB-41) + utilisasi harian tersimpan (US-M8-05).
 *
 * Neraca = produksi − Σ pengisian bersih (pelanggan + pasokan depot, US-M8-04 KP-1) = susut (liter & % produksi).
 * Dihitung otomatis setelah pembacaan malam (atau pembacaan pagi berikutnya yang menutup hari itu, 7.8.6), dan dihitung
 * ulang bila data terlambat sinkron/koreksi mengubah angkanya. Status (7.8.3): Terbentuk → Susut normal / Susut di atas
 * ambang (PAR-18, BR-26 → tugas investigasi operator + laporan pemilik) → Investigasi (penjelasan dikirim) → Selesai
 * (pemilik menerima). Susut negatif → anomali pencatatan, wajib verifikasi Admin Keuangan (KP-5).
 */
import "server-only";

import { and, desc, eq, gte, inArray, isNotNull, lt, lte } from "drizzle-orm";
import { z } from "zod";

import { dailyProductions, meterReadings, waterBalances } from "@/db/schema";
import { enumValues } from "@/lib/labels";
import { addDays, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { linkAttachment } from "@/server/core/storage";
import { notify } from "@/server/core/notifications";
import { assertSourceScope, authorize, runService, sod } from "@/server/core/rbac";

import { M8_ATTACHMENT_KINDS } from "@/client/m8-production/contract";

import { attachmentOfKind, liter, loadSource, m8Rules, notifyOnce, pct2, resolveOperatorSource, type M8FieldMeta, type WaterSourceRow } from "./common";
import { fillTotalsOf } from "./fill-totals";
import { computeDailyProduction, productionOf, type DailyProductionRow } from "./production";
import { checkUtilizationStreak } from "./utilization";

export type WaterBalanceRow = typeof waterBalances.$inferSelect;
type BalanceStatus = WaterBalanceRow["status"];

/** Status yang ditentukan otomatis dari angka (belum ada tindakan manusia). */
const AUTO_STATUSES: readonly BalanceStatus[] = ["formed", "normal", "over_threshold", "negative_anomaly"];

async function averageLossPct(tx: Tx, sourceId: string, date: BusinessDate, days: number): Promise<number | null> {
  const rows = await tx
    .select({ lossPct: waterBalances.lossPct })
    .from(waterBalances)
    .where(
      and(
        eq(waterBalances.waterSourceId, sourceId),
        gte(waterBalances.businessDate, addDays(date, -days)),
        lt(waterBalances.businessDate, date),
        eq(waterBalances.isIncomplete, false),
        isNotNull(waterBalances.lossPct),
      ),
    );
  const vals = rows.map((r) => r.lossPct).filter((v): v is number => v !== null);
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

export type ComputeBalanceResult = { balance: WaterBalanceRow; created: boolean; changed: boolean; statusChanged: boolean };

/**
 * Hitung (ulang) neraca air satu sumber satu tanggal. Produksi dibaca dari `daily_productions` (hitung dulu dengan
 * `computeDailyProduction`). Idempoten; memancarkan `water_balance.computed` bila baris baru atau angka/status berubah.
 */
export async function computeWaterBalance(tx: Tx, ctx: ActorContext, sourceId: string, date: BusinessDate, production?: DailyProductionRow | null): Promise<ComputeBalanceResult> {
  const source = await loadSource(tx, sourceId);
  const rules = await m8Rules(tx, date, source.tenantId);
  const prod = production === undefined ? await productionOf(tx, sourceId, date) : production;
  const fills = await fillTotalsOf(tx, sourceId, date);
  const producedL = prod && prod.status !== "incomplete" ? prod.producedL : null;
  const isIncomplete = producedL === null;
  const lossL = producedL === null ? null : producedL - fills.totalL;
  const lossPct = producedL === null || lossL === null ? null : producedL > 0 ? pct2(lossL, producedL) : lossL === 0 ? 0 : null;
  const utilizationPct = pct2(fills.totalL, source.dailyCapacityL);
  const avgLoss7dPct = await averageLossPct(tx, sourceId, date, rules.lossAverageDays);

  const [before] = await tx
    .select()
    .from(waterBalances)
    .where(and(eq(waterBalances.waterSourceId, sourceId), eq(waterBalances.businessDate, date)))
    .limit(1);
  let status: BalanceStatus = before?.status ?? "formed";
  if (!before || AUTO_STATUSES.includes(before.status)) {
    if (isIncomplete || lossL === null) status = "formed";
    else if (lossL < 0) status = before?.verifiedAt ? "done" : "negative_anomaly";
    else if (lossPct !== null && lossPct > rules.lossMaxPct) status = "over_threshold";
    else status = "normal";
  }
  const values = {
    producedL,
    filledCustomerL: fills.customerL,
    filledDepotL: fills.depotL,
    filledTotalL: fills.totalL,
    returnedL: fills.returnedL,
    lossL,
    lossPct,
    avgLoss7dPct,
    utilizationPct,
    isIncomplete,
    status,
    computedAt: ctx.now,
  };
  let row: WaterBalanceRow;
  if (before) {
    [row] = (await tx.update(waterBalances).set(values).where(eq(waterBalances.id, before.id)).returning()) as [WaterBalanceRow];
  } else {
    [row] = (await tx
      .insert(waterBalances)
      .values({ tenantId: source.tenantId, waterSourceId: sourceId, businessDate: date, ...values })
      .returning()) as [WaterBalanceRow];
  }
  const statusChanged = !before || before.status !== row.status;
  const changed =
    !before ||
    statusChanged ||
    before.producedL !== row.producedL ||
    before.filledTotalL !== row.filledTotalL ||
    before.lossL !== row.lossL ||
    before.isIncomplete !== row.isIncomplete ||
    before.returnedL !== row.returnedL;
  if (changed) {
    await auditRecord(tx, {
      ctx,
      objectType: "water_balance",
      objectId: row.id,
      action: before ? "recompute" : "create",
      before: before
        ? { status: before.status, producedL: before.producedL, filledTotalL: before.filledTotalL, lossL: before.lossL, lossPct: before.lossPct }
        : undefined,
      after: { status: row.status, producedL: row.producedL, filledTotalL: row.filledTotalL, lossL: row.lossL, lossPct: row.lossPct, isIncomplete: row.isIncomplete },
      rule: "US-M8-04",
      businessDate: date,
    });
    await emit(
      tx,
      "water_balance.computed",
      {
        waterBalanceId: row.id,
        waterSourceId: sourceId,
        productionL: row.producedL ?? 0,
        fillsL: row.filledTotalL,
        lossL: row.lossL ?? 0,
        lossPct: row.lossPct ?? 0,
        overThreshold: row.lossPct !== null && row.lossPct > rules.lossMaxPct,
        businessDate: date,
        status: row.status,
        isIncomplete: row.isIncomplete,
        productionStatus: prod?.status ?? null,
        filledCustomerL: row.filledCustomerL,
        filledDepotL: row.filledDepotL,
        returnedL: row.returnedL ?? 0,
        negative: row.lossL !== null && row.lossL < 0,
        utilizationPct: row.utilizationPct,
        utilizationHigh: row.utilizationPct !== null && row.utilizationPct > rules.utilizationHighPct,
        avgLoss7dPct: row.avgLoss7dPct,
        recomputed: !!before,
      },
      { ctx, tenantId: source.tenantId, objectType: "water_balance", objectId: row.id, businessDate: date },
    );
  }
  if (statusChanged) await notifyStatus(tx, ctx, source, row, rules.lossMaxPct);
  if (changed) await checkUtilizationStreak(tx, ctx, source, date);
  return { balance: row, created: !before, changed, statusChanged };
}

async function notifyStatus(tx: Tx, ctx: ActorContext, source: WaterSourceRow, row: WaterBalanceRow, maxPct: number): Promise<void> {
  const link = `/produksi/neraca-air/rincian?sumber=${source.id}&tanggal=${row.businessDate}`;
  if (row.status === "over_threshold") {
    // BR-26: tugas investigasi ke operator sumber + laporan ke pemilik (H+0).
    await notifyOnce(tx, {
      event: "water.loss_over_threshold",
      tenantId: source.tenantId,
      groupKey: `water_loss_over:${row.id}`,
      recipients: { roles: ["owner", "production_operator"], scope: { sourceId: source.id } },
      title: `Susut air ${source.name} ${row.businessDate}: ${row.lossPct}% (di atas ${maxPct}%)`,
      body: `Produksi ${liter(row.producedL)}, pengisian ${liter(row.filledTotalL)}, susut ${liter(row.lossL)}. Operator mengisi investigasi (alasan + foto) dari aplikasi produksi.`,
      objectType: "water_balance",
      objectId: row.id,
      valueText: `${row.lossPct}%`,
      link,
      now: ctx.now,
    });
  }
  if (row.status === "negative_anomaly") {
    await notifyOnce(tx, {
      event: "production.missing_or_negative",
      tenantId: source.tenantId,
      groupKey: `water_loss_negative:${row.id}`,
      title: `Susut negatif ${source.name} ${row.businessDate}: pengisian melebihi produksi`,
      body: `Produksi ${liter(row.producedL)}, pengisian ${liter(row.filledTotalL)} (selisih ${liter(row.lossL)}). Anomali pencatatan (meter atau pengisian ganda) — wajib verifikasi Admin Keuangan.`,
      objectType: "water_balance",
      objectId: row.id,
      valueText: liter(row.lossL),
      link,
      now: ctx.now,
    });
  }
}

/**
 * Hitung ulang produksi (dan neraca bila sudah ada / produksi sudah tidak "belum lengkap" / `createBalance`) untuk satu
 * sumber & tanggal. Dipanggil setiap perubahan data yang memengaruhi hari itu (pembacaan, pengisian, koreksi, rit gagal).
 */
export async function refreshSourceDay(
  tx: Tx,
  ctx: ActorContext,
  sourceId: string,
  date: BusinessDate,
  opts: { createBalance?: boolean; skipProduction?: boolean } = {},
): Promise<{ production: DailyProductionRow | null; balance: WaterBalanceRow | null }> {
  const production = opts.skipProduction ? await productionOf(tx, sourceId, date) : (await computeDailyProduction(tx, ctx, sourceId, date)).production;
  const existing = await tx
    .select({ id: waterBalances.id })
    .from(waterBalances)
    .where(and(eq(waterBalances.waterSourceId, sourceId), eq(waterBalances.businessDate, date)))
    .limit(1);
  if (!existing[0] && !opts.createBalance && (!production || production.status === "incomplete")) return { production, balance: null };
  const res = await computeWaterBalance(tx, ctx, sourceId, date, production);
  return { production, balance: res.balance };
}

/** Hari yang perlu dihitung ulang setelah pembacaan (tanggal, fase) — hanya sampai hari ini dan yang punya data. */
export async function refreshAfterReading(tx: Tx, ctx: ActorContext, sourceId: string, date: BusinessDate, phase: "morning" | "evening"): Promise<void> {
  const today = ctxBusinessDate(ctx);
  const dates = phase === "morning" ? [addDays(date, -1), date] : [date, addDays(date, 1)];
  for (const d of dates) {
    if (d > today) continue;
    if (d !== date) {
      const hasData =
        (await productionOf(tx, sourceId, d)) ||
        (await tx.select({ id: meterReadings.id }).from(meterReadings).where(and(eq(meterReadings.waterSourceId, sourceId), eq(meterReadings.businessDate, d))).limit(1))[0];
      if (!hasData) continue;
    }
    await refreshSourceDay(tx, ctx, sourceId, d);
  }
}

/** Neraca tersimpan satu sumber satu hari. */
export async function balanceOf(tx: Tx, sourceId: string, date: BusinessDate): Promise<WaterBalanceRow | null> {
  const rows = await tx.select().from(waterBalances).where(and(eq(waterBalances.waterSourceId, sourceId), eq(waterBalances.businessDate, date))).limit(1);
  return rows[0] ?? null;
}

async function loadBalance(tx: Tx, ctx: ActorContext, id: string): Promise<WaterBalanceRow> {
  const rows = await tx.select().from(waterBalances).where(eq(waterBalances.id, id)).for("update").limit(1);
  const row = rows[0];
  if (!row || row.tenantId !== ctx.tenantId) throw new NotFoundError("Neraca air tidak ditemukan.");
  return row;
}

// =====================================================================================================================
// Investigasi susut (operator, lapangan) → keputusan pemilik (US-M8-04 KP-2)
// =====================================================================================================================

export const lossInvestigationSchema = z
  .object({
    waterBalanceId: z.uuid({ error: "Neraca air tidak valid." }),
    reason: z.enum(enumValues("loss_reason"), { error: "Pilih alasan susut dari daftar." }),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export type LossInvestigationResult = { balance: WaterBalanceRow; duplicate: boolean; conflict: string | null };

/**
 * Operator mengisi investigasi susut (alasan dari daftar + foto; "Lainnya" wajib keterangan) untuk neraca di atas ambang
 * sumbernya → status Investigasi, pemilik diberi tahu untuk menerima penjelasan.
 */
export async function submitLossInvestigation(ctx: ActorContext, input: z.output<typeof lossInvestigationSchema>, meta: M8FieldMeta): Promise<LossInvestigationResult> {
  const { tx } = meta;
  await authorize(ctx, "m8.loss_investigation.create", { tx, objectType: "water_balance", objectId: input.waterBalanceId });
  const source = await resolveOperatorSource(tx, ctx, meta.device);
  const bal = await loadBalance(tx, ctx, input.waterBalanceId);
  if (bal.waterSourceId !== source.id) throw new NotFoundError("Neraca air ini bukan milik sumber air Anda.");
  const note = input.note?.trim() || null;
  if (input.reason === "other" && (!note || note.length < 3)) {
    throw new DomainError("LOSS_NOTE_REQUIRED", "Alasan \"Lainnya\" wajib diberi keterangan singkat.");
  }
  const photo = attachmentOfKind(meta, M8_ATTACHMENT_KINDS.investigationPhoto);
  if (!photo) throw new DomainError("LOSS_PHOTO_REQUIRED", "Foto bukti investigasi susut wajib diambil dari kamera aplikasi.");
  if (bal.status === "done") {
    throw new DomainError("LOSS_ALREADY_DONE", "Neraca ini sudah Selesai (penjelasan diterima pemilik); investigasi tidak diubah.");
  }
  if (bal.status !== "over_threshold" && bal.status !== "investigating") {
    throw new DomainError("LOSS_NOT_OVER", "Susut hari ini tidak di atas ambang; investigasi tidak diperlukan.");
  }
  const conflict = bal.status === "investigating" && bal.investigatedBy && bal.investigatedBy !== ctx.userId
    ? "Penjelasan susut sudah dikirim operator lain; penjelasan ini menggantikannya dan tampil ke pemilik."
    : null;
  const [row] = await tx
    .update(waterBalances)
    .set({
      status: "investigating",
      investigationReason: input.reason,
      investigationNote: note,
      investigationPhotoId: photo.id,
      investigatedBy: ctx.userId,
      investigatedAt: meta.deviceTime,
    })
    .where(eq(waterBalances.id, bal.id))
    .returning();
  await linkAttachment(tx, photo.id, { type: "water_balance", id: bal.id });
  await auditRecord(tx, {
    ctx,
    objectType: "water_balance",
    objectId: bal.id,
    action: "investigate",
    before: { status: bal.status, investigationReason: bal.investigationReason },
    after: { status: "investigating", investigationReason: input.reason, investigationNote: note },
    reason: note,
    rule: "BR-26",
    businessDate: bal.businessDate,
  });
  await notify(tx, {
    event: "water.loss_explained",
    tenantId: bal.tenantId,
    title: `Penjelasan susut ${source.name} ${bal.businessDate} menunggu keputusan`,
    body: `Susut ${liter(bal.lossL)} (${bal.lossPct}%). Alasan operator: ${input.reason === "other" ? note : input.reason}.`,
    objectType: "water_balance",
    objectId: bal.id,
    valueText: `${bal.lossPct}%`,
    link: `/produksi/neraca-air/rincian?sumber=${source.id}&tanggal=${bal.businessDate}`,
    now: ctx.now,
  });
  return { balance: row!, duplicate: false, conflict };
}

const reviewSchema = z
  .object({
    waterBalanceId: z.uuid(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

/** Pemilik menerima penjelasan susut → Selesai (US-M8-04 KP-2). */
export async function acceptLossInvestigation(ctx: ActorContext, input: z.input<typeof reviewSchema>, opts: { tx?: Tx } = {}): Promise<WaterBalanceRow> {
  await authorize(ctx, "m8.loss_investigation.accept", { tx: opts.tx, objectType: "water_balance", objectId: input.waterBalanceId });
  const data = parseInput(reviewSchema, input, { note: "Catatan" });
  return runService(ctx, opts, async (tx) => {
    const bal = await loadBalance(tx, ctx, data.waterBalanceId);
    if (bal.status !== "investigating") throw new DomainError("LOSS_NOT_EXPLAINED", "Belum ada penjelasan susut dari operator untuk diterima.");
    sod.assertNotSelf(bal.investigatedBy, ctx.userId, "penjelasan susut", { objectType: "water_balance", objectId: bal.id });
    const note = data.note?.trim() || null;
    const [row] = await tx
      .update(waterBalances)
      .set({ status: "done", acceptedBy: ctx.userId, acceptedAt: ctx.now, reviewNote: note })
      .where(eq(waterBalances.id, bal.id))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "water_balance",
      objectId: bal.id,
      action: "accept",
      before: { status: bal.status },
      after: { status: "done" },
      reason: note,
      rule: "US-M8-04 KP-2",
      businessDate: bal.businessDate,
    });
    return row!;
  });
}

const returnSchema = z
  .object({
    waterBalanceId: z.uuid(),
    note: z.string().trim().min(5, { error: "Tulis apa yang perlu dilengkapi operator (minimal 5 huruf)." }).max(500),
  })
  .strict();

/** Pemilik mengembalikan penjelasan (belum cukup) → kembali "Susut di atas ambang", operator diberi tahu. */
export async function returnLossInvestigation(ctx: ActorContext, input: z.input<typeof returnSchema>, opts: { tx?: Tx } = {}): Promise<WaterBalanceRow> {
  await authorize(ctx, "m8.loss_investigation.accept", { tx: opts.tx, objectType: "water_balance", objectId: input.waterBalanceId });
  const data = parseInput(returnSchema, input, { note: "Catatan" });
  return runService(ctx, opts, async (tx) => {
    const bal = await loadBalance(tx, ctx, data.waterBalanceId);
    if (bal.status !== "investigating") throw new DomainError("LOSS_NOT_EXPLAINED", "Belum ada penjelasan susut dari operator untuk dikembalikan.");
    const source = await loadSource(tx, bal.waterSourceId);
    const [row] = await tx.update(waterBalances).set({ status: "over_threshold", reviewNote: data.note }).where(eq(waterBalances.id, bal.id)).returning();
    await auditRecord(tx, {
      ctx,
      objectType: "water_balance",
      objectId: bal.id,
      action: "return",
      before: { status: bal.status },
      after: { status: "over_threshold" },
      reason: data.note,
      rule: "US-M8-04 KP-2",
      businessDate: bal.businessDate,
    });
    await notify(tx, {
      event: "water.loss_explanation_returned",
      tenantId: bal.tenantId,
      recipients: { roles: ["production_operator"], scope: { sourceId: source.id } },
      title: `Penjelasan susut ${bal.businessDate} dikembalikan pemilik`,
      body: data.note,
      objectType: "water_balance",
      objectId: bal.id,
      now: ctx.now,
    });
    return row!;
  });
}

const verifySchema = z
  .object({
    waterBalanceId: z.uuid(),
    note: z.string().trim().min(5, { error: "Tulis hasil verifikasi (minimal 5 huruf), mis. pengisian ganda sudah dibalik." }).max(500),
  })
  .strict();

/** Admin Keuangan memverifikasi susut negatif (anomali pencatatan) → Selesai (US-M8-04 KP-5). */
export async function verifyNegativeBalance(ctx: ActorContext, input: z.input<typeof verifySchema>, opts: { tx?: Tx } = {}): Promise<WaterBalanceRow> {
  await authorize(ctx, "m8.water_balance.verify", { tx: opts.tx, objectType: "water_balance", objectId: input.waterBalanceId });
  const data = parseInput(verifySchema, input, { note: "Hasil verifikasi" });
  return runService(ctx, opts, async (tx) => {
    const bal = await loadBalance(tx, ctx, data.waterBalanceId);
    await assertSourceScope(tx, ctx, bal.waterSourceId);
    if (bal.status !== "negative_anomaly") throw new DomainError("BALANCE_NOT_NEGATIVE", "Neraca ini bukan susut negatif yang menunggu verifikasi.");
    const [row] = await tx
      .update(waterBalances)
      .set({ status: "done", verifiedBy: ctx.userId, verifiedAt: ctx.now, verificationNote: data.note })
      .where(eq(waterBalances.id, bal.id))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "water_balance",
      objectId: bal.id,
      action: "verify",
      before: { status: bal.status },
      after: { status: "done" },
      reason: data.note,
      rule: "US-M8-04 KP-5",
      businessDate: bal.businessDate,
    });
    return row!;
  });
}

/** Neraca yang menunggu tindakan (daftar kerja kantor): di atas ambang, investigasi, susut negatif. */
export async function balancesNeedingAction(tx: Tx, tenantId: string, sourceIds?: readonly string[]): Promise<WaterBalanceRow[]> {
  return tx
    .select()
    .from(waterBalances)
    .where(
      and(
        eq(waterBalances.tenantId, tenantId),
        inArray(waterBalances.status, ["over_threshold", "investigating", "negative_anomaly"]),
        ...(sourceIds?.length ? [inArray(waterBalances.waterSourceId, [...sourceIds])] : []),
      ),
    )
    .orderBy(desc(waterBalances.businessDate));
}

/** Neraca rentang tanggal (urut tanggal turun). */
export async function balancesInRange(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate, sourceId?: string | null): Promise<WaterBalanceRow[]> {
  return tx
    .select()
    .from(waterBalances)
    .where(
      and(
        eq(waterBalances.tenantId, tenantId),
        gte(waterBalances.businessDate, from),
        lte(waterBalances.businessDate, to),
        ...(sourceId ? [eq(waterBalances.waterSourceId, sourceId)] : []),
      ),
    )
    .orderBy(desc(waterBalances.businessDate));
}

/** Produksi rentang tanggal. */
export async function productionsInRange(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate, sourceId?: string | null): Promise<DailyProductionRow[]> {
  return tx
    .select()
    .from(dailyProductions)
    .where(
      and(
        eq(dailyProductions.tenantId, tenantId),
        gte(dailyProductions.businessDate, from),
        lte(dailyProductions.businessDate, to),
        ...(sourceId ? [eq(dailyProductions.waterSourceId, sourceId)] : []),
      ),
    )
    .orderBy(desc(dailyProductions.businessDate));
}
