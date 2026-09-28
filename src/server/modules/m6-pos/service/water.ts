/**
 * M6 — pasokan air depot & neraca air outlet (US-M6-05; BR-33, K20, PTB-01, PAR-59, PAR-61, A9).
 *
 * - Rit internal Selesai (event `trip.completed` dari M3, `isInternal` + `destinationOutletId`) → penerimaan
 *   "Tiba" di POS outlet tujuan (`water_supply_receipts`, idempoten per rit).
 * - Operator mengonfirmasi (bawaan volume sopir) atau memasukkan volume berbeda + alasan (Selisih → Dispatcher/M8).
 * - Belum dikonfirmasi sampai tutup shift berikutnya → diterima sesuai catatan sopir, "tanpa konfirmasi operator",
 *   dilaporkan ke Admin Keuangan.
 * - Stok air outlet (L) = stok awal + diterima − galon terjual × ukuran galon; kapasitas simpan ditandai.
 * - Neraca air mingguan/bulanan: galon terjual melebihi air tersedia > PAR-59 → notifikasi pemilik.
 */
import "server-only";

import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import { z } from "zod";

import { outlets, shifts, waterSupplyReceipts } from "@/db/schema";
import { addDays, firstDayOfMonth, lastDayOfMonth, toBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { systemContext, type ActorContext } from "@/server/core/context";
import { withTx, type Db, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError } from "@/server/core/errors";
import { emit, type DomainEvent } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize } from "@/server/core/rbac";
import { resolveInternalTransferPrice } from "@/server/modules/m1-master";

import { isoWeekRange, openShiftOf, resolvePosOutlet, type FieldWriteMeta, type OutletRow, type ShiftRow } from "./common";
import { computeShiftFigures } from "./figures";
import { postWaterMovement, waterBalance, waterPeriodBalance, type WaterPeriodBalance } from "./inventory";

export type WaterSupplyRow = typeof waterSupplyReceipts.$inferSelect;

// ---------------------------------------------------------------------------------------------------------------------
// Tiba (dari M3)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Handler `trip.completed` (M3): rit internal ke depot → pasokan "Tiba" di POS outlet tujuan. Harapan payload:
 * `isInternal = true`, `destinationOutletId` (outlet depot tujuan, tenant sama), `volumeL` (volume diserahkan sopir),
 * `completedAt`. Idempoten per rit (indeks unik `water_supply_receipts_trip_uq`).
 */
export async function recordSupplyArrival(tx: Tx, event: DomainEvent<"trip.completed">): Promise<WaterSupplyRow | null> {
  const p = event.payload;
  if (!p.isInternal || !p.destinationOutletId) return null;
  const rows = await tx.select().from(outlets).where(eq(outlets.id, p.destinationOutletId)).limit(1);
  const outlet = rows[0];
  if (!outlet || outlet.kind !== "depot") return null;
  if (event.tenantId && outlet.tenantId !== event.tenantId) return null; // NFR-30
  const existing = await tx.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.tripId, p.tripId)).limit(1);
  if (existing[0]) return existing[0];
  const completedAt = new Date(p.completedAt);
  const businessDate = event.businessDate ?? toBusinessDate(completedAt);
  const [row] = await tx
    .insert(waterSupplyReceipts)
    .values({
      tenantId: outlet.tenantId,
      outletId: outlet.id,
      source: "equa_truck",
      tripId: p.tripId,
      status: "arrived",
      deliveredVolumeL: p.volumeL,
      businessDate,
      createdAt: completedAt,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  const ctx = systemContext({ tenantId: outlet.tenantId, now: completedAt });
  await auditRecord(tx, {
    ctx,
    objectType: "water_supply_receipt",
    objectId: row.id,
    action: "create",
    after: { status: "arrived", tripId: p.tripId, deliveredVolumeL: p.volumeL, outletId: outlet.id },
    rule: "US-M6-05 KP-1",
    businessDate,
  });
  return row;
}

// ---------------------------------------------------------------------------------------------------------------------
// Nilai transfer internal (BR-33, K20)
// ---------------------------------------------------------------------------------------------------------------------

/** Nilai transfer internal = harga rit internal (tarif zona + BBM) × volume diterima / volume standar rit (PAR-15). */
export async function transferValueFor(tx: Tx, outlet: OutletRow, receivedL: number, date: BusinessDate): Promise<number> {
  if (receivedL <= 0) return 0;
  try {
    const price = await resolveInternalTransferPrice(tx, { depotOutletId: outlet.id, date });
    const std = await params.get(tx, "PAR-15", date);
    return Math.round((price.unitPrice * receivedL) / Math.max(1, std.liters));
  } catch (error) {
    if (error instanceof DomainError) return 0;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Konfirmasi operator (sinkron)
// ---------------------------------------------------------------------------------------------------------------------

export const confirmSupplySchema = z
  .object({
    receiptId: z.uuid(),
    receivedVolumeL: z.number().int().min(0).max(100_000),
    reason: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

export type ConfirmSupplyResult = { receipt: WaterSupplyRow; conflict: string | null; overCapacity: boolean; waterStockL: number };

export async function confirmWaterSupply(ctx: ActorContext, input: z.output<typeof confirmSupplySchema>, meta: FieldWriteMeta): Promise<ConfirmSupplyResult> {
  const { tx } = meta;
  await authorize(ctx, "m6.water_supply.confirm", { tx, objectType: "water_supply_receipt", objectId: input.receiptId });
  const [receipt] = await tx.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.id, input.receiptId)).for("update").limit(1);
  if (!receipt || receipt.tenantId !== ctx.tenantId) throw new NotFoundError("Pasokan air tidak ditemukan.");
  const outlet = await resolvePosOutlet(tx, ctx, meta.device, receipt.outletId);
  if (receipt.outletId !== outlet.id) throw new NotFoundError("Pasokan air tidak ditemukan untuk outlet ini.");
  if (receipt.status === "confirmed" || receipt.status === "discrepancy") {
    throw new DomainError("SUPPLY_ALREADY_CONFIRMED", "Pasokan ini sudah dikonfirmasi.");
  }
  const delivered = receipt.deliveredVolumeL ?? input.receivedVolumeL;
  const diff = input.receivedVolumeL - delivered;
  const reason = input.reason?.trim() || null;
  if (diff !== 0 && (!reason || reason.length < 3)) {
    throw new DomainError("SUPPLY_REASON_REQUIRED", "Volume diterima berbeda dari catatan sopir — isi alasannya (mis. tangki bocor, meteran berbeda).");
  }
  const shift = await openShiftOf(tx, outlet.id);
  const status = diff === 0 ? ("confirmed" as const) : ("discrepancy" as const);
  let conflict: string | null = null;
  // Sudah diterima otomatis (PAR-61) sebelum konfirmasi perangkat tersinkron: data lapangan tetap dicatat, selisih
  // terhadap catatan sopir dibukukan sebagai penyesuaian (lapangan tidak ditimpa, Bab 6.4 butir 3).
  const autoAccepted = receipt.status === "auto_accepted";
  const [updated] = await tx
    .update(waterSupplyReceipts)
    .set({
      status,
      receivedVolumeL: input.receivedVolumeL,
      differenceL: diff,
      differenceReason: reason,
      confirmedAt: meta.deviceTime,
      confirmedBy: ctx.userId,
      shiftId: shift?.id ?? receipt.shiftId,
      ...meta.fieldValues,
      updatedAt: new Date(),
    })
    .where(eq(waterSupplyReceipts.id, receipt.id))
    .returning();
  if (autoAccepted) {
    conflict = "Pasokan sudah diterima otomatis sesuai catatan sopir sebelum konfirmasi ini tersinkron; selisihnya dibukukan sebagai penyesuaian.";
    if (diff !== 0) {
      await postWaterMovement(tx, {
        tenantId: outlet.tenantId,
        outletId: outlet.id,
        kind: "adjustment",
        volumeL: diff,
        businessDate: meta.businessDate,
        occurredAt: meta.deviceTime,
        source: { type: "water_supply_confirmation", id: receipt.id },
      });
    }
  } else {
    await postWaterMovement(tx, {
      tenantId: outlet.tenantId,
      outletId: outlet.id,
      kind: "supply_in",
      volumeL: input.receivedVolumeL,
      businessDate: meta.businessDate,
      occurredAt: meta.deviceTime,
      source: { type: "water_supply_receipt", id: receipt.id },
    });
  }
  await auditRecord(tx, {
    ctx,
    objectType: "water_supply_receipt",
    objectId: receipt.id,
    action: "confirm",
    before: { status: receipt.status, receivedVolumeL: receipt.receivedVolumeL },
    after: { status, receivedVolumeL: input.receivedVolumeL, differenceL: diff },
    reason,
  });
  const transferValue = await transferValueFor(tx, outlet, input.receivedVolumeL, meta.businessDate);
  await emit(
    tx,
    "water_supply.confirmed",
    {
      waterSupplyReceiptId: receipt.id,
      tripId: receipt.tripId,
      outletId: outlet.id,
      volumeSentL: delivered,
      volumeReceivedL: input.receivedVolumeL,
      transferValue,
      confirmedByOperator: true,
      source: "equa_truck",
      differenceL: diff,
      differenceReason: reason,
      autoAccepted: false,
      shiftId: shift?.id ?? null,
    },
    { ctx, objectType: "water_supply_receipt", objectId: receipt.id },
  );
  if (diff !== 0) {
    await notify(tx, {
      event: "water_supply.discrepancy",
      tenantId: outlet.tenantId,
      title: `Selisih pasokan air ${outlet.name}: ${diff > 0 ? "+" : ""}${diff} L`,
      body: `Sopir mencatat ${delivered} L, operator menerima ${input.receivedVolumeL} L. Alasan: ${reason}`,
      objectType: "water_supply_receipt",
      objectId: receipt.id,
      valueText: `${diff} L`,
      link: `/outlet/${outlet.id}?tab=air`,
      now: ctx.now,
    });
  }
  const stock = await waterStockNow(tx, outlet.id);
  return { receipt: updated!, conflict, overCapacity: outlet.storageCapacityL !== null && stock > outlet.storageCapacityL, waterStockL: stock };
}

// ---------------------------------------------------------------------------------------------------------------------
// Pasokan dari sumber lain (darurat) — US-M6-05 KP-6
// ---------------------------------------------------------------------------------------------------------------------

export const otherSupplySchema = z
  .object({
    receiptId: z.uuid(),
    volumeL: z.number().int().min(1).max(100_000),
    reason: z.string().trim().min(3, { error: "Alasan pasokan dari sumber lain wajib diisi." }).max(300),
    sourceNote: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

export async function recordOtherSupply(ctx: ActorContext, input: z.output<typeof otherSupplySchema>, meta: FieldWriteMeta): Promise<WaterSupplyRow> {
  const { tx } = meta;
  await authorize(ctx, "m6.water_supply.confirm", { tx });
  const outlet = await resolvePosOutlet(tx, ctx, meta.device);
  if (outlet.kind !== "depot") throw new DomainError("DEPOT_ONLY", "Pasokan air hanya untuk depot.");
  const shift = await openShiftOf(tx, outlet.id);
  const reason = input.sourceNote ? `${input.reason} (sumber: ${input.sourceNote})` : input.reason;
  const [row] = await tx
    .insert(waterSupplyReceipts)
    .values({
      id: input.receiptId,
      tenantId: outlet.tenantId,
      outletId: outlet.id,
      source: "other",
      status: "confirmed",
      deliveredVolumeL: null,
      receivedVolumeL: input.volumeL,
      differenceL: 0,
      confirmedAt: meta.deviceTime,
      confirmedBy: ctx.userId,
      shiftId: shift?.id ?? null,
      otherSourceReason: reason,
      businessDate: meta.businessDate,
      createdBy: ctx.userId,
      ...meta.fieldValues,
    })
    .returning();
  await postWaterMovement(tx, {
    tenantId: outlet.tenantId,
    outletId: outlet.id,
    kind: "supply_in",
    volumeL: input.volumeL,
    businessDate: meta.businessDate,
    occurredAt: meta.deviceTime,
    source: { type: "water_supply_receipt", id: row!.id },
  });
  await auditRecord(tx, {
    ctx,
    objectType: "water_supply_receipt",
    objectId: row!.id,
    action: "create",
    after: { source: "other", volumeL: input.volumeL },
    reason,
  });
  await emit(
    tx,
    "water_supply.confirmed",
    {
      waterSupplyReceiptId: row!.id,
      tripId: null,
      outletId: outlet.id,
      volumeSentL: 0,
      volumeReceivedL: input.volumeL,
      transferValue: 0,
      confirmedByOperator: true,
      source: "other",
      differenceL: 0,
      differenceReason: reason,
      autoAccepted: false,
      shiftId: shift?.id ?? null,
    },
    { ctx, objectType: "water_supply_receipt", objectId: row!.id },
  );
  return row!;
}

// ---------------------------------------------------------------------------------------------------------------------
// Diterima otomatis di tutup shift berikutnya (PAR-61)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Tutup shift: pasokan "Tiba" yang sudah menunggu SEBELUM shift ini dibuka (operator punya satu shift penuh untuk
 * mengonfirmasi) → diterima sesuai catatan sopir, penanda "tanpa konfirmasi operator", lapor Admin Keuangan.
 */
export async function autoAcceptPendingSupplies(
  tx: Tx,
  input: { outlet: OutletRow; shift: ShiftRow; closedAt: Date; businessDate: BusinessDate },
): Promise<string[]> {
  const rule = await params.get(tx, "PAR-61", input.businessDate);
  if (rule.rule !== "until_next_shift_close") return [];
  const pending = await tx
    .select()
    .from(waterSupplyReceipts)
    .where(
      and(
        eq(waterSupplyReceipts.outletId, input.outlet.id),
        eq(waterSupplyReceipts.status, "arrived"),
        lt(waterSupplyReceipts.createdAt, input.shift.openedAt),
        isNull(waterSupplyReceipts.reversedAt),
      ),
    )
    .orderBy(asc(waterSupplyReceipts.createdAt))
    .for("update");
  const ctx = systemContext({ tenantId: input.outlet.tenantId, now: input.closedAt });
  const ids: string[] = [];
  for (const r of pending) {
    const vol = r.deliveredVolumeL ?? 0;
    await tx
      .update(waterSupplyReceipts)
      .set({ status: "auto_accepted", receivedVolumeL: vol, differenceL: 0, autoAcceptedAt: input.closedAt, shiftId: input.shift.id, updatedAt: new Date() })
      .where(eq(waterSupplyReceipts.id, r.id));
    await postWaterMovement(tx, {
      tenantId: r.tenantId,
      outletId: r.outletId,
      kind: "supply_in",
      volumeL: vol,
      businessDate: input.businessDate,
      occurredAt: input.closedAt,
      source: { type: "water_supply_receipt", id: r.id },
    });
    await auditRecord(tx, {
      ctx,
      objectType: "water_supply_receipt",
      objectId: r.id,
      action: "auto_accept",
      before: { status: "arrived" },
      after: { status: "auto_accepted", receivedVolumeL: vol },
      rule: "PAR-61",
      businessDate: input.businessDate,
    });
    await emit(
      tx,
      "water_supply.confirmed",
      {
        waterSupplyReceiptId: r.id,
        tripId: r.tripId,
        outletId: r.outletId,
        volumeSentL: vol,
        volumeReceivedL: vol,
        transferValue: await transferValueFor(tx, input.outlet, vol, input.businessDate),
        confirmedByOperator: false,
        source: "equa_truck",
        differenceL: 0,
        autoAccepted: true,
        shiftId: input.shift.id,
      },
      { ctx, objectType: "water_supply_receipt", objectId: r.id, businessDate: input.businessDate },
    );
    await notify(tx, {
      event: "water_supply.unconfirmed",
      tenantId: r.tenantId,
      title: `Pasokan air ${input.outlet.name} diterima tanpa konfirmasi operator`,
      body: `${vol} L sesuai catatan sopir; tidak dikonfirmasi sampai tutup shift berikutnya (PAR-61).`,
      objectType: "water_supply_receipt",
      objectId: r.id,
      valueText: `${vol} L`,
      link: `/outlet/${input.outlet.id}?tab=air`,
      now: input.closedAt,
    });
    ids.push(r.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------------------------------------------------
// Stok air & neraca
// ---------------------------------------------------------------------------------------------------------------------

/** Stok air outlet sekarang (L) = buku air − liter galon terjual pada shift terbuka (belum dibukukan). */
export async function waterStockNow(tx: Tx, outletId: string): Promise<number> {
  const ledger = await waterBalance(tx, outletId);
  const open = await tx
    .select()
    .from(shifts)
    .where(and(eq(shifts.outletId, outletId), eq(shifts.status, "open")));
  let unposted = 0;
  for (const s of open) unposted += (await computeShiftFigures(tx, s)).gallonLitersSold;
  return ledger - unposted;
}

export type WaterBalanceCheck = WaterPeriodBalance & { outletName: string; tolerancePct: number; exceeded: boolean };

/** Neraca air semua depot aktif tenant untuk periode; `exceeded` bila kelebihan > PAR-59 (lingkup outlet). */
export async function waterBalancesFor(tx: Tx, tenantId: string, from: BusinessDate, to: BusinessDate, outletIds?: string[]): Promise<WaterBalanceCheck[]> {
  const rows = await tx
    .select()
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, tenantId),
        eq(outlets.kind, "depot"),
        eq(outlets.isActive, true),
        ...(outletIds?.length ? [inArray(outlets.id, outletIds)] : []),
      ),
    )
    .orderBy(asc(outlets.code));
  const out: WaterBalanceCheck[] = [];
  for (const o of rows) {
    const bal = await waterPeriodBalance(tx, o.id, from, to);
    const tol = await params.get(tx, "PAR-59", to, { tenantId, outletId: o.id });
    out.push({ ...bal, outletName: o.name, tolerancePct: tol.percent, exceeded: bal.excessPct > tol.percent });
  }
  return out;
}

/** Job neraca air: minggu lalu (Senin) atau bulan lalu (tanggal 1) → notifikasi pemilik bila melebihi PAR-59. */
export async function runWaterBalanceCheck(now: Date, period: "week" | "month", db?: Db): Promise<{ checked: number; flagged: string[] }> {
  const today = toBusinessDate(now);
  const range =
    period === "week"
      ? isoWeekRange(addDays(today, -7))
      : (() => {
          const prev = addDays(firstDayOfMonth(today), -1);
          return { from: firstDayOfMonth(prev), to: lastDayOfMonth(prev) };
        })();
  return withTx(
    async (tx) => {
      const tenants = await tx.selectDistinct({ tenantId: outlets.tenantId }).from(outlets).where(eq(outlets.kind, "depot"));
      let checked = 0;
      const flagged: string[] = [];
      for (const { tenantId } of tenants) {
        for (const b of await waterBalancesFor(tx, tenantId, range.from, range.to)) {
          checked++;
          if (!b.exceeded) continue;
          flagged.push(b.outletId);
          await notify(tx, {
            event: "outlet.water_balance_exceeded",
            tenantId,
            title: `Neraca air ${b.outletName} ${period === "week" ? "minggu" : "bulan"} lalu melebihi toleransi`,
            body: `Galon terjual ${b.soldL.toLocaleString("id-ID")} L vs air tersedia ${b.availableL.toLocaleString("id-ID")} L (kelebihan ${b.excessPct}% > ${b.tolerancePct}%). Periksa pasokan/pencatatan outlet.`,
            objectType: "outlet",
            objectId: b.outletId,
            valueText: `${b.excessPct}%`,
            link: `/outlet/laporan?tab=air&dari=${range.from}&sampai=${range.to}`,
            groupKey: `water_balance:${b.outletId}:${range.from}:${range.to}`,
            now,
          });
        }
      }
      return { checked, flagged };
    },
    db ? { db } : {},
  );
}
