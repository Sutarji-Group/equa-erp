/**
 * M6 — shift depot/toko & setoran outlet (US-M6-02, US-M6-06 KP-3; BR-08, PAR-02, PAR-57, PAR-58, PTB-23, PTB-40).
 *
 * Semua aksi shift adalah perintah lapangan (offline-first): buka shift, setor sebagian (setor bank + foto slip),
 * tutup shift (kas fisik + stok fisik → selisih dihitung sistem), serah setoran. Shift yang dibuka offline di
 * perangkat cadangan saat shift lain masih terbuka DISIMPAN sebagai konflik (`sync_conflict`), bukan ditolak (7.6.6).
 */
import "server-only";

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { deposits, posSales, shiftStockCounts, shifts, users, employees } from "@/db/schema";
import { formatRupiah, zRupiahNonNegative, zRupiahPositive } from "@/lib/money";
import { addDays, formatJam, toBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import { nextNumber } from "@/server/core/numbering";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";

import {
  loadOutlet,
  loadShift,
  outletPosSettings,
  resolvePosOutlet,
  type FieldWriteMeta,
  type OutletRow,
  type PosSaleRow,
  type ShiftRow,
} from "./common";
import { computeShiftDrawer, computeShiftFigures, type ShiftFigures } from "./figures";
import { consumablesOf, stockBalancesOf } from "./inventory";
import { posKindPolicy } from "./policy";

// =====================================================================================================================
// Buka shift
// =====================================================================================================================

export const openShiftSchema = z
  .object({
    shiftId: z.uuid(),
    outletId: z.uuid().nullable().optional(),
    /** Hasil hitung fisik kas awal (dikonfirmasi operator). */
    openingCashCounted: zRupiahNonNegative,
    /** Wajib (di perangkat) bila hitung fisik ≠ kas awal tetap. */
    openingNote: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

export type OpenShiftResult = { shift: ShiftRow; conflict: string | null };

/** Buka shift (US-M6-02 KP-1). */
export async function openShift(ctx: ActorContext, input: z.output<typeof openShiftSchema>, meta: FieldWriteMeta): Promise<OpenShiftResult> {
  const { tx } = meta;
  const outlet = await resolvePosOutlet(tx, ctx, meta.device, input.outletId);
  const policy = posKindPolicy(outlet.kind);
  await authorize(ctx, policy.permissions.shiftOpen, { tx, objectType: "shift", objectId: input.shiftId });
  const settings = await outletPosSettings(tx, outlet, meta.businessDate);

  // Satu shift terbuka per outlet; shift kemarin yang belum ditutup harus ditutup dulu. Perangkat cadangan yang
  // membuka shift offline saat shift lain masih terbuka → disimpan sebagai KONFLIK (tampil ke Admin Keuangan).
  const existing = await tx
    .select({ id: shifts.id, businessDate: shifts.businessDate, openedAt: shifts.openedAt, deviceId: shifts.deviceId, operator: employees.fullName })
    .from(shifts)
    .leftJoin(users, eq(users.id, shifts.operatorUserId))
    .leftJoin(employees, eq(employees.id, users.employeeId))
    .where(and(eq(shifts.outletId, outlet.id), eq(shifts.status, "open"), eq(shifts.syncConflict, false)))
    .for("update", { of: shifts })
    .limit(1);
  const other = existing[0];
  const conflict = other
    ? `Shift lain masih terbuka di ${outlet.name} (dibuka ${other.operator ?? "operator"} ${other.businessDate} pukul ${formatJam(other.openedAt)}). Shift dari perangkat ini disimpan sebagai konflik untuk ditinjau Admin Keuangan.`
    : null;

  const countedDiff = input.openingCashCounted - settings.fixedOpeningCash;
  const [row] = await tx
    .insert(shifts)
    .values({
      id: input.shiftId,
      tenantId: outlet.tenantId,
      outletId: outlet.id,
      operatorUserId: ctx.userId!,
      businessDate: meta.businessDate,
      status: "open",
      openedAt: meta.deviceTime,
      openingCashFixed: settings.fixedOpeningCash,
      openingCashCounted: input.openingCashCounted,
      syncConflict: !!other,
      syncConflictNote: conflict,
      summary: {
        openingCashDifference: countedDiff,
        openingNote: input.openingNote ?? null,
        ...(other ? { conflictWithShiftId: other.id } : {}),
      },
      createdBy: ctx.userId,
      ...meta.fieldValues,
    })
    .returning();

  // Stok awal bahan = saldo sistem setelah shift sebelumnya (tampil, tidak diketik).
  const materials = await consumablesOf(tx, outlet.tenantId, policy.productLine);
  if (materials.length) {
    const bal = await stockBalancesOf(
      tx,
      outlet.id,
      materials.map((m) => m.id),
    );
    await tx.insert(shiftStockCounts).values(
      materials.map((m) => ({
        tenantId: outlet.tenantId,
        shiftId: row!.id,
        outletId: outlet.id,
        productId: m.id,
        phase: "opening" as const,
        systemQty: bal.get(m.id)?.quantity ?? 0,
      })),
    );
  }

  await auditRecord(tx, {
    ctx,
    objectType: "shift",
    objectId: row!.id,
    action: "open",
    after: {
      outletId: outlet.id,
      openingCashFixed: settings.fixedOpeningCash,
      openingCashCounted: input.openingCashCounted,
      syncConflict: !!other,
    },
    reason: input.openingNote ?? null,
    businessDate: meta.businessDate,
  });
  await emit(
    tx,
    "shift.opened",
    { shiftId: row!.id, outletId: outlet.id, operatorUserId: ctx.userId, openingCash: settings.fixedOpeningCash },
    { ctx, objectType: "shift", objectId: row!.id, businessDate: meta.businessDate },
  );
  if (other) {
    await notify(tx, {
      event: "pos.shift_conflict",
      tenantId: outlet.tenantId,
      title: `Konflik shift di ${outlet.name}`,
      body: conflict,
      objectType: "shift",
      objectId: row!.id,
      link: `/outlet/shift/${row!.id}`,
      now: ctx.now,
    });
  }
  return { shift: row!, conflict };
}

// =====================================================================================================================
// Kas berjalan & peringatan batas (BR-08, PAR-02)
// =====================================================================================================================

/**
 * Periksa kas berjalan shift; bila > PAR-02 dan belum diperingatkan → tandai + notifikasi operator outlet & Admin
 * Keuangan dengan tindakan "setor sebagian". Mengembalikan kas berjalan.
 */
export async function checkCashLimit(tx: Tx, ctx: ActorContext, outlet: OutletRow, shiftId: string, date: BusinessDate): Promise<{ runningCash: number; overLimit: boolean; alerted: boolean }> {
  const shift = (await loadShift(tx, shiftId, { forUpdate: true }))!;
  // Agregat SQL (bukan `computeShiftFigures`): dipanggil per transaksi tunai — lihat `computeShiftDrawer`.
  const figures = { expectedDrawer: await computeShiftDrawer(tx, shift) };
  const settings = await outletPosSettings(tx, outlet, date);
  const over = figures.expectedDrawer > settings.cashLimit;
  if (!over || shift.cashLimitAlertAt || shift.status !== "open") return { runningCash: figures.expectedDrawer, overLimit: over, alerted: false };
  await tx.update(shifts).set({ cashLimitAlertAt: ctx.now, updatedAt: new Date() }).where(eq(shifts.id, shift.id));
  await notify(tx, {
    event: "outlet_cash.over_limit",
    tenantId: outlet.tenantId,
    recipients: { roles: ["depot_operator", "store_cashier", "finance_admin"], scope: { outletId: outlet.id } },
    title: `Kas ${outlet.name} melebihi batas`,
    body: `Kas berjalan ${formatRupiah(figures.expectedDrawer)} > ${formatRupiah(settings.cashLimit)} (PAR-02). Lakukan setor sebagian (setor bank dengan foto slip).`,
    objectType: "shift",
    objectId: shift.id,
    valueAmount: figures.expectedDrawer,
    link: `/outlet/shift/${shift.id}`,
    groupKey: `outlet_cash.over_limit:${shift.id}`,
    now: ctx.now,
  });
  await auditRecord(tx, {
    ctx,
    objectType: "shift",
    objectId: shift.id,
    action: "cash_limit_alert",
    after: { runningCash: figures.expectedDrawer, cashLimit: settings.cashLimit },
    rule: "BR-08",
  });
  return { runningCash: figures.expectedDrawer, overLimit: true, alerted: true };
}

// =====================================================================================================================
// Setor sebagian (setor bank + foto slip) — US-M6-02 KP-2, PTB-23
// =====================================================================================================================

export const partialDepositSchema = z
  .object({
    depositId: z.uuid(),
    shiftId: z.uuid(),
    amount: zRupiahPositive,
    bankAccountId: z.uuid().nullable().optional(),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

export async function recordPartialDeposit(ctx: ActorContext, input: z.output<typeof partialDepositSchema>, meta: FieldWriteMeta) {
  const { tx } = meta;
  const shift = await loadShift(tx, input.shiftId, { forUpdate: true });
  if (!shift) throw new Error("Shift belum tersinkron — kirim ulang nanti.");
  const outlet = await resolvePosOutlet(tx, ctx, meta.device, shift.outletId);
  const policy = posKindPolicy(outlet.kind);
  await authorize(ctx, policy.permissions.shiftDeposit, { tx, objectType: "shift", objectId: shift.id });
  if (shift.status !== "open") throw new DomainError("SHIFT_CLOSED", "Shift sudah ditutup. Setoran akhir dicatat saat tutup shift.");
  const attachmentId = meta.attachmentIds[0];
  if (!attachmentId) throw new DomainError("SLIP_REQUIRED", "Foto slip setor bank wajib dilampirkan.");
  const figures = await computeShiftFigures(tx, shift);
  if (input.amount > figures.expectedDrawer) {
    throw new DomainError(
      "PARTIAL_DEPOSIT_TOO_LARGE",
      `Setor sebagian ${formatRupiah(input.amount)} melebihi kas di laci menurut sistem (${formatRupiah(figures.expectedDrawer)}). Periksa jumlahnya.`,
    );
  }
  const number = await nextNumber(tx, "deposit", meta.businessDate, { tenantId: outlet.tenantId });
  const [dep] = await tx
    .insert(deposits)
    .values({
      id: input.depositId,
      tenantId: outlet.tenantId,
      number,
      sourceType: policy.depositSourceType,
      businessDate: meta.businessDate,
      status: "submitted",
      depositorUserId: ctx.userId,
      depositorEmployeeId: ctx.employeeId,
      outletId: outlet.id,
      shiftId: shift.id,
      method: "bank_slip",
      bankSlipAttachmentId: attachmentId,
      expectedCash: input.amount,
      expectedNet: input.amount,
      submittedAt: meta.deviceTime,
      depositorNote: input.note ?? null,
      isPartial: true,
      summarySnapshot: { kind: "partial", runningCashBefore: figures.expectedDrawer, bankAccountId: input.bankAccountId ?? null },
      createdBy: ctx.userId,
      ...meta.fieldValues,
    })
    .returning();
  await linkAttachment(tx, attachmentId, { type: "deposit", id: dep!.id });
  const newTotal = shift.partialDepositTotal + input.amount;
  // Setelah setor sebagian, peringatan batas kas dapat muncul lagi bila kas kembali melebihi PAR-02.
  await tx.update(shifts).set({ partialDepositTotal: newTotal, cashLimitAlertAt: null, updatedAt: new Date() }).where(eq(shifts.id, shift.id));
  await auditRecord(tx, {
    ctx,
    objectType: "deposit",
    objectId: dep!.id,
    action: "create",
    after: { number, amount: input.amount, isPartial: true, shiftId: shift.id, method: "bank_slip" },
    reason: input.note ?? null,
  });
  await emit(
    tx,
    "deposit.submitted",
    { depositId: dep!.id, sourceType: policy.depositSourceType, sourceUserId: ctx.userId, outletId: outlet.id, expectedAmount: input.amount },
    { ctx, objectType: "deposit", objectId: dep!.id },
  );
  return { deposit: dep!, partialDepositTotal: newTotal };
}

// =====================================================================================================================
// Tutup shift — US-M6-02 KP-3/KP-4/KP-5/KP-7, US-M6-04 KP-3, US-M6-06 KP-3
// =====================================================================================================================

export const closeShiftSchema = z
  .object({
    shiftId: z.uuid(),
    closingCashCounted: zRupiahNonNegative,
    cashDifferenceReason: z.string().trim().max(300).nullable().optional(),
    stock: z
      .array(
        z
          .object({
            productId: z.uuid(),
            physicalQty: z.number().int().min(0).max(1_000_000),
            reason: z.string().trim().max(300).nullable().optional(),
            /** Stok seharusnya menurut perangkat (dasar keputusan alasan di perangkat). */
            deviceExpectedQty: z.number().int().nullable().optional(),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    /** Seluruh ID transaksi shift ini di perangkat (dasar "menunggu sinkron", US-M6-06 KP-3). */
    saleIds: z.array(z.uuid()).max(5000).default([]),
    voidedSaleIds: z.array(z.uuid()).max(5000).default([]),
    /** Kas di laci seharusnya menurut perangkat. */
    deviceExpectedDrawer: z.number().int().nullable().optional(),
  })
  .strict();

export type CloseShiftResult = { shift: ShiftRow; figures: ShiftFigures; depositId: string; conflict: string | null };

export async function closeShift(ctx: ActorContext, input: z.output<typeof closeShiftSchema>, meta: FieldWriteMeta): Promise<CloseShiftResult> {
  const { tx } = meta;
  const shift = await loadShift(tx, input.shiftId, { forUpdate: true });
  if (!shift) throw new Error("Shift belum tersinkron — kirim ulang nanti.");
  const outlet = await resolvePosOutlet(tx, ctx, meta.device, shift.outletId);
  const policy = posKindPolicy(outlet.kind);
  await authorize(ctx, policy.permissions.shiftClose, { tx, objectType: "shift", objectId: shift.id });
  if (shift.status !== "open") throw new DomainError("SHIFT_ALREADY_CLOSED", "Shift ini sudah ditutup.");
  const settings = await outletPosSettings(tx, outlet, meta.businessDate);
  const figures = await computeShiftFigures(tx, shift);
  const conflicts: string[] = [];

  // --- Kas: selisih dihitung sistem; ≠ 0 wajib alasan (P-02 langkah 5).
  const cashDifference = input.closingCashCounted - figures.expectedDrawer;
  let cashReason = input.cashDifferenceReason?.trim() || null;
  if (cashDifference !== 0 && (!cashReason || cashReason.length < 3)) {
    const deviceDiff = input.deviceExpectedDrawer === null || input.deviceExpectedDrawer === undefined ? null : input.closingCashCounted - input.deviceExpectedDrawer;
    if (deviceDiff === 0) {
      // Perangkat tidak melihat selisih (data server lebih lengkap) → tutup tetap sah, ditinjau Admin Keuangan.
      conflicts.push(`Selisih kas menurut server ${formatRupiah(cashDifference)} tidak terlihat di perangkat; Admin Keuangan meninjau.`);
      cashReason = null;
    } else {
      throw new DomainError("CASH_REASON_REQUIRED", `Kas fisik berbeda ${formatRupiah(cashDifference)} dari seharusnya. Isi alasan selisih kas.`);
    }
  }

  // --- Stok fisik bahan utama: selisih informatif (tidak mengubah saldo); di luar PAR-58 wajib alasan.
  const materials = await consumablesOf(tx, outlet.tenantId, policy.productLine);
  const bal = await stockBalancesOf(
    tx,
    outlet.id,
    materials.map((m) => m.id),
  );
  const byProduct = new Map(input.stock.map((s) => [s.productId, s]));
  // US-M6-02 KP-3 / US-M6-04 KP-3: stok fisik SELURUH bahan utama wajib diisi saat tutup shift (bukan hanya di UI).
  // Bahan yang baru ditambahkan master SETELAH shift dibuka mungkin belum ada di perangkat → diterima sebagai konflik.
  const uncounted = materials.filter((m) => !byProduct.has(m.id));
  const unknownToDevice = uncounted.filter((m) => m.createdAt.getTime() > shift.openedAt.getTime());
  const mustCount = uncounted.filter((m) => !unknownToDevice.includes(m));
  if (mustCount.length) {
    throw new DomainError("STOCK_COUNT_REQUIRED", `Isi stok fisik semua bahan utama sebelum tutup shift. Belum diisi: ${mustCount.map((m) => m.name).join(", ")}.`);
  }
  if (unknownToDevice.length) {
    conflicts.push(`Bahan ${unknownToDevice.map((m) => m.name).join(", ")} baru ditambahkan setelah shift dibuka dan belum dihitung; Admin Keuangan meninjau.`);
  }
  const stockRows = materials.map((m) => {
    const expectedUsage = figures.usage.get(m.id) ?? 0;
    const systemQty = (bal.get(m.id)?.quantity ?? 0) - expectedUsage;
    const entry = byProduct.get(m.id);
    const physicalQty = entry ? entry.physicalQty : null;
    const difference = physicalQty === null ? null : physicalQty - systemQty;
    let reason = entry?.reason?.trim() || null;
    if (difference !== null && Math.abs(difference) > settings.stockTolerance && (!reason || reason.length < 3)) {
      const devDiff = entry?.deviceExpectedQty === null || entry?.deviceExpectedQty === undefined ? null : physicalQty! - entry.deviceExpectedQty;
      if (devDiff !== null && Math.abs(devDiff) <= settings.stockTolerance) {
        conflicts.push(`Selisih stok ${m.name} menurut server ${difference} tidak terlihat di perangkat.`);
        reason = null;
      } else {
        throw new DomainError("STOCK_REASON_REQUIRED", `Stok fisik ${m.name} berbeda ${difference} dari seharusnya (toleransi ${settings.stockTolerance}). Isi alasannya.`);
      }
    }
    return { material: m, expectedUsage, systemQty, physicalQty, difference, reason };
  });
  if (stockRows.length) {
    await tx.insert(shiftStockCounts).values(
      stockRows.map((r) => ({
        tenantId: outlet.tenantId,
        shiftId: shift.id,
        outletId: outlet.id,
        productId: r.material.id,
        phase: "closing" as const,
        systemQty: r.systemQty,
        physicalQty: r.physicalQty,
        expectedUsage: r.expectedUsage,
        difference: r.difference,
        reason: r.reason,
      })),
    );
  }

  // --- Pembukuan per jenis outlet (depot: pemakaian bahan, buku air, pasokan otomatis PAR-61).
  const closedAt = meta.deviceTime;
  const extra = (await policy.onShiftClosing?.({ tx, ctx, outlet, shift, figures, closedAt, businessDate: meta.businessDate })) ?? {};

  // --- Setoran akhir shift = tunai seharusnya − kas awal tetap − Σ setor sebagian (M4 menerima).
  const depositNumber = await nextNumber(tx, "deposit", meta.businessDate, { tenantId: outlet.tenantId });
  const threshold = await params.get(tx, "PAR-01", meta.businessDate);
  const overThreshold = Math.abs(cashDifference) >= threshold.amount;
  const [dep] = await tx
    .insert(deposits)
    .values({
      tenantId: outlet.tenantId,
      number: depositNumber,
      sourceType: policy.depositSourceType,
      businessDate: meta.businessDate,
      status: "submitted",
      depositorUserId: ctx.userId,
      depositorEmployeeId: ctx.employeeId,
      outletId: outlet.id,
      shiftId: shift.id,
      method: "physical",
      expectedCash: figures.depositAmount,
      expectedNet: figures.depositAmount,
      submittedAt: closedAt,
      isPartial: false,
      summarySnapshot: {
        kind: "shift_close",
        salesTotal: figures.salesTotal,
        cashSales: figures.cashSales,
        qrisSales: figures.qrisSales,
        openingCash: figures.openingCash,
        partialDepositTotal: figures.partialDepositTotal,
        closingCashCounted: input.closingCashCounted,
        cashDifference,
      },
      createdBy: ctx.userId,
      ...meta.fieldValues,
    })
    .returning({ id: deposits.id });

  const summary = {
    ...(shift.summary ?? {}),
    byProduct: figures.byProduct,
    salesTotal: figures.salesTotal,
    saleCount: figures.saleCount,
    countedCount: figures.countedCount,
    qrisCount: figures.qrisCount,
    voidPendingCount: figures.voidPendingCount,
    voidPendingAmount: figures.voidPendingAmount,
    voidCashAmount: figures.voidCashAmount,
    priceMismatchCount: figures.priceMismatchCount,
    gallonsSold: figures.gallonsSold,
    gallonLitersSold: figures.gallonLitersSold,
    expectedDrawer: figures.expectedDrawer,
    usage: Object.fromEntries(figures.usage),
    stock: stockRows.map((r) => ({ productId: r.material.id, name: r.material.name, expectedUsage: r.expectedUsage, systemQty: r.systemQty, physicalQty: r.physicalQty, difference: r.difference, reason: r.reason })),
    device: { saleIds: input.saleIds, voidedSaleIds: input.voidedSaleIds },
    closeConflicts: conflicts,
    cashDiscrepancyOverThreshold: overThreshold,
    ...extra,
  };
  const [closed] = await tx
    .update(shifts)
    .set({
      status: "closed",
      closedAt,
      cashSales: figures.cashSales,
      qrisSales: figures.qrisSales,
      creditSales: figures.creditSales,
      voidCount: figures.voidCount,
      voidAmount: figures.voidAmount,
      expectedCash: figures.expectedCash,
      closingCashCounted: input.closingCashCounted,
      cashDifference,
      cashDifferenceReason: cashReason,
      depositAmount: figures.depositAmount,
      depositStatus: "not_deposited",
      depositId: dep!.id,
      summary,
      updatedAt: new Date(),
    })
    .where(eq(shifts.id, shift.id))
    .returning();

  await auditRecord(tx, {
    ctx,
    objectType: "shift",
    objectId: shift.id,
    action: "close",
    before: { status: "open" },
    after: {
      status: "closed",
      expectedCash: figures.expectedCash,
      closingCashCounted: input.closingCashCounted,
      cashDifference,
      depositAmount: figures.depositAmount,
      stockDifferences: stockRows.filter((r) => r.difference).map((r) => ({ productId: r.material.id, difference: r.difference })),
    },
    reason: cashReason,
    businessDate: meta.businessDate,
  });
  await emit(
    tx,
    "shift.closed",
    {
      shiftId: shift.id,
      outletId: outlet.id,
      operatorUserId: shift.operatorUserId,
      salesTotal: figures.salesTotal,
      expectedCash: figures.expectedCash,
      countedCash: input.closingCashCounted,
      cashDiscrepancy: cashDifference,
      qrisAmount: figures.qrisSales,
      outletKind: outlet.kind,
      businessDate: shift.businessDate,
      closedAt: closedAt.toISOString(),
      openingCash: figures.openingCash,
      openingCashCounted: shift.openingCashCounted,
      salesByMethod: { cash: figures.cashSales, qris: figures.qrisSales, credit: figures.creditSales },
      cashSales: figures.cashSales,
      qrisCount: figures.qrisCount,
      voidCount: figures.voidCount,
      voidAmount: figures.voidAmount,
      voidPendingCount: figures.voidPendingCount,
      voidPendingAmount: figures.voidPendingAmount,
      partialDepositTotal: figures.partialDepositTotal,
      depositAmount: figures.depositAmount,
      depositId: dep!.id,
      cashDiscrepancyOverThreshold: overThreshold,
      cashDiscrepancyReason: cashReason,
      salesByProduct: figures.byProduct.map((p) => ({ productId: p.productId, quantity: p.quantity, amount: p.amount, gallonLiters: p.gallonLiters })),
      gallonsSold: figures.gallonsSold,
      gallonLitersSold: figures.gallonLitersSold,
      consumableUsage: stockRows.map((r) => ({
        productId: r.material.id,
        expectedUsage: r.expectedUsage,
        systemQty: r.systemQty,
        physicalQty: r.physicalQty,
        difference: r.difference,
        reason: r.reason,
      })),
      consumableUsageValue: typeof extra.consumptionValue === "number" ? extra.consumptionValue : undefined,
      syncConflict: shift.syncConflict,
    },
    { ctx, objectType: "shift", objectId: shift.id, businessDate: shift.businessDate },
  );
  await emit(
    tx,
    "deposit.submitted",
    { depositId: dep!.id, sourceType: policy.depositSourceType, sourceUserId: shift.operatorUserId, outletId: outlet.id, expectedAmount: figures.depositAmount },
    { ctx, objectType: "deposit", objectId: dep!.id },
  );
  return { shift: closed!, figures, depositId: dep!.id, conflict: conflicts.length ? conflicts.join(" ") : null };
}

// =====================================================================================================================
// Tunai tersinkron setelah shift ditutup (US-M4-06 KP-7, Bab 5.3, 7.6.6)
// =====================================================================================================================

/**
 * Transaksi TUNAI yang baru tersinkron setelah shiftnya ditutup (mis. perangkat rusak, 7.6.6): uangnya sudah ada di
 * laci saat hitung tutup, jadi tidak boleh hilang dari kontrol setoran:
 * - setoran shift masih Diajukan (belum diterima M4) → kas seharusnya & setoran shift bertambah (bertanda);
 * - setoran shift sudah diterima/ditutup → dibentuk SETORAN SUSULAN outlet bertanda (kas masuk setoran berikutnya,
 *   Bab 5.3) yang diterima Admin Keuangan lewat M4.
 */
export async function absorbLateCashSale(
  tx: Tx,
  ctx: ActorContext,
  input: { outlet: OutletRow; shift: ShiftRow; sale: PosSaleRow },
): Promise<{ depositId: string; mode: "shift_deposit" | "supplementary"; message: string } | null> {
  const { outlet, shift, sale } = input;
  if (sale.paymentMethod !== "cash" || sale.total <= 0 || sale.status !== "valid") return null;
  const policy = posKindPolicy(outlet.kind);
  const item = { saleId: sale.id, number: sale.number, amount: sale.total, soldAt: sale.soldAt.toISOString() };
  const dep = shift.depositId ? (await tx.select().from(deposits).where(eq(deposits.id, shift.depositId)).for("update").limit(1))[0] : undefined;
  if (dep && dep.status === "submitted") {
    const snap = (dep.summarySnapshot ?? {}) as Record<string, unknown>;
    const lateList = [...((snap.lateCashSales as unknown[]) ?? []), item];
    await tx
      .update(deposits)
      .set({ expectedCash: dep.expectedCash + sale.total, expectedNet: dep.expectedNet + sale.total, summarySnapshot: { ...snap, lateCashSales: lateList }, updatedAt: ctx.now })
      .where(eq(deposits.id, dep.id));
    const expectedCash = (shift.expectedCash ?? 0) + sale.total;
    const cashDifference = shift.closingCashCounted === null ? shift.cashDifference : shift.closingCashCounted - (expectedCash - shift.partialDepositTotal);
    await tx
      .update(shifts)
      .set({
        expectedCash,
        depositAmount: (shift.depositAmount ?? 0) + sale.total,
        cashDifference,
        summary: { ...(shift.summary ?? {}), lateCashSales: lateList },
        updatedAt: ctx.now,
      })
      .where(eq(shifts.id, shift.id));
    await auditRecord(tx, {
      ctx,
      objectType: "deposit",
      objectId: dep.id,
      action: "late_cash_added",
      before: { expectedCash: dep.expectedCash, cashDifference: shift.cashDifference },
      after: { expectedCash: dep.expectedCash + sale.total, cashDifference, sale: item },
      reason: "Transaksi tunai tersinkron setelah shift ditutup",
      rule: "US-M4-06 KP-7",
      businessDate: shift.businessDate,
    });
    const message = `Tunai ${formatRupiah(sale.total)} (transaksi ${sale.number ?? sale.localNumber}) tersinkron setelah shift ditutup — ditambahkan ke setoran shift ${dep.number} (belum diterima Admin Keuangan).`;
    await notifyLateCash(tx, ctx, outlet, dep.id, sale.total, message);
    return { depositId: dep.id, mode: "shift_deposit", message };
  }
  const today = toBusinessDate(ctx.now);
  const number = await nextNumber(tx, "deposit", today, { tenantId: outlet.tenantId });
  const [row] = await tx
    .insert(deposits)
    .values({
      tenantId: outlet.tenantId,
      number,
      sourceType: policy.depositSourceType,
      businessDate: today,
      status: "submitted",
      depositorUserId: sale.operatorUserId,
      outletId: outlet.id,
      shiftId: null,
      method: "physical",
      expectedCash: sale.total,
      expectedNet: sale.total,
      submittedAt: ctx.now,
      submittedLate: true,
      isPartial: false,
      summarySnapshot: { kind: "late_cash_after_close", shiftId: shift.id, shiftDepositId: dep?.id ?? null, lateCashSales: [item] },
      createdBy: ctx.userId,
    })
    .returning({ id: deposits.id, number: deposits.number });
  await auditRecord(tx, {
    ctx,
    objectType: "deposit",
    objectId: row!.id,
    action: "create",
    after: { kind: "late_cash_after_close", shiftId: shift.id, expectedCash: sale.total, sale: item },
    reason: "Transaksi tunai tersinkron setelah setoran shift diterima — setoran susulan",
    rule: "US-M4-06 KP-7, Bab 5.3",
    businessDate: today,
  });
  await emit(
    tx,
    "deposit.submitted",
    { depositId: row!.id, sourceType: policy.depositSourceType, sourceUserId: sale.operatorUserId, outletId: outlet.id, expectedAmount: sale.total },
    { ctx, objectType: "deposit", objectId: row!.id, businessDate: today },
  );
  const message = `Setoran shift sudah diterima; tunai ${formatRupiah(sale.total)} (transaksi ${sale.number ?? sale.localNumber}) dibentuk sebagai setoran susulan ${row!.number}.`;
  await notifyLateCash(tx, ctx, outlet, row!.id, sale.total, message);
  return { depositId: row!.id, mode: "supplementary", message };
}

async function notifyLateCash(tx: Tx, ctx: ActorContext, outlet: OutletRow, depositId: string, amount: number, body: string): Promise<void> {
  await notify(tx, {
    event: "pos.late_cash_after_close",
    tenantId: outlet.tenantId,
    title: `Tunai POS ${outlet.name} tersinkron setelah shift ditutup`,
    body,
    objectType: "deposit",
    objectId: depositId,
    valueAmount: amount,
    link: `/kas/setoran/${depositId}`,
    now: ctx.now,
  });
}

// =====================================================================================================================
// Serah setoran (Belum disetor → Disetor) — US-M6-02 KP-5, PTB-23
// =====================================================================================================================

export const submitShiftDepositSchema = z
  .object({
    shiftId: z.uuid(),
    method: z.enum(["physical", "bank_slip"]),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

export async function submitShiftDeposit(ctx: ActorContext, input: z.output<typeof submitShiftDepositSchema>, meta: FieldWriteMeta) {
  const { tx } = meta;
  const shift = await loadShift(tx, input.shiftId, { forUpdate: true });
  if (!shift) throw new Error("Shift belum tersinkron — kirim ulang nanti.");
  const outlet = await resolvePosOutlet(tx, ctx, meta.device, shift.outletId);
  const policy = posKindPolicy(outlet.kind);
  await authorize(ctx, policy.permissions.shiftDeposit, { tx, objectType: "shift", objectId: shift.id });
  if (shift.status !== "closed" || !shift.depositId) throw new DomainError("SHIFT_NOT_CLOSED", "Tutup shift dulu sebelum menyerahkan setoran.");
  if (shift.depositStatus !== "not_deposited") throw new DomainError("DEPOSIT_ALREADY_SUBMITTED", "Setoran shift ini sudah diserahkan.");
  const attachmentId = meta.attachmentIds[0] ?? null;
  if (input.method === "bank_slip" && !attachmentId) throw new DomainError("SLIP_REQUIRED", "Foto slip setor bank wajib dilampirkan.");
  if (attachmentId) await linkAttachment(tx, attachmentId, { type: "deposit", id: shift.depositId });
  await tx
    .update(deposits)
    .set({ method: input.method, bankSlipAttachmentId: attachmentId, depositorNote: input.note ?? null, updatedAt: new Date() })
    .where(eq(deposits.id, shift.depositId));
  await tx.update(shifts).set({ depositStatus: "deposited", depositedAt: meta.deviceTime, updatedAt: new Date() }).where(eq(shifts.id, shift.id));
  await auditRecord(tx, {
    ctx,
    objectType: "shift",
    objectId: shift.id,
    action: "deposit",
    before: { depositStatus: "not_deposited" },
    after: { depositStatus: "deposited", method: input.method },
    reason: input.note ?? null,
  });
  return { shiftId: shift.id, depositId: shift.depositId };
}

/** Handler `deposit.received` (M4): setoran akhir shift diterima → status setoran shift Diterima. */
export async function markShiftDepositReceived(tx: Tx, depositId: string, receivedAt: Date): Promise<boolean> {
  const [dep] = await tx.select().from(deposits).where(eq(deposits.id, depositId)).limit(1);
  if (!dep || !dep.shiftId || dep.isPartial) return false;
  if (dep.sourceType !== "depot_shift" && dep.sourceType !== "store_shift") return false;
  const res = await tx
    .update(shifts)
    .set({ depositStatus: "received", depositedAt: sql`coalesce(${shifts.depositedAt}, ${receivedAt})`, updatedAt: new Date() })
    .where(and(eq(shifts.id, dep.shiftId), eq(shifts.depositId, dep.id)))
    .returning({ id: shifts.id });
  return res.length > 0;
}

// =====================================================================================================================
// Status sinkron shift (US-M6-06 KP-3) — dipakai M4 sebelum menerima setoran
// =====================================================================================================================

export type ShiftSyncStatus = {
  shiftId: string;
  exists: boolean;
  closed: boolean;
  /** Transaksi yang dilaporkan perangkat saat tutup shift tetapi belum tersinkron. */
  missingSaleIds: string[];
  /** Void yang dilaporkan perangkat tetapi belum tersinkron. */
  missingVoidIds: string[];
  fullySynced: boolean;
};

export async function shiftSyncStatus(tx: Tx, shiftId: string): Promise<ShiftSyncStatus> {
  const shift = await loadShift(tx, shiftId);
  if (!shift) return { shiftId, exists: false, closed: false, missingSaleIds: [], missingVoidIds: [], fullySynced: false };
  if (shift.status !== "closed") return { shiftId, exists: true, closed: false, missingSaleIds: [], missingVoidIds: [], fullySynced: false };
  const device = ((shift.summary ?? {}) as { device?: { saleIds?: string[]; voidedSaleIds?: string[] } }).device ?? {};
  const saleIds = device.saleIds ?? [];
  const voidIds = device.voidedSaleIds ?? [];
  const all = [...new Set([...saleIds, ...voidIds])];
  const rows = all.length
    ? await tx.select({ id: posSales.id, status: posSales.status }).from(posSales).where(inArray(posSales.id, all))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r.status]));
  const missingSaleIds = saleIds.filter((id) => !byId.has(id));
  const missingVoidIds = voidIds.filter((id) => {
    const st = byId.get(id);
    return !st || st === "valid";
  });
  return { shiftId, exists: true, closed: true, missingSaleIds, missingVoidIds, fullySynced: missingSaleIds.length === 0 && missingVoidIds.length === 0 };
}

/**
 * Benar bila shift sudah ditutup DAN seluruh transaksi & void yang tercatat di perangkat saat tutup shift sudah
 * tersinkron (US-M6-06 KP-3). M4 WAJIB memanggilnya sebelum menerima setoran shift.
 */
export async function isShiftFullySynced(tx: Tx, shiftId: string): Promise<boolean> {
  return (await shiftSyncStatus(tx, shiftId)).fullySynced;
}

// =====================================================================================================================
// Konflik shift (kantor) — 7.6.6, Bab 6.4 butir 3
// =====================================================================================================================

const resolveConflictSchema = z.object({
  shiftId: z.uuid(),
  note: z.string().trim().min(5, { error: "Catatan peninjauan wajib diisi (minimal 5 karakter)." }).max(500),
});

/** Admin Keuangan menandai konflik shift sudah ditinjau (data lapangan tidak diubah). */
export async function resolveShiftConflict(ctx: ActorContext, input: z.input<typeof resolveConflictSchema>, opts: { tx?: Tx } = {}): Promise<ShiftRow> {
  await authorize(ctx, "m6.shift_conflict.resolve", { tx: opts.tx });
  const data = parseInput(resolveConflictSchema, input, { note: "Catatan" });
  return runService(ctx, opts, async (tx) => {
    const shift = await loadShift(tx, data.shiftId, { forUpdate: true });
    if (!shift || shift.tenantId !== ctx.tenantId) throw new NotFoundError("Shift tidak ditemukan.");
    const outlet = await loadOutlet(tx, shift.outletId);
    if (outlet.tenantId !== ctx.tenantId) throw new NotFoundError("Shift tidak ditemukan.");
    if (!shift.syncConflict) throw new DomainError("NOT_A_CONFLICT", "Shift ini bukan konflik.");
    if (shift.conflictResolvedAt) throw new DomainError("CONFLICT_RESOLVED", "Konflik shift ini sudah ditinjau.");
    const [row] = await tx
      .update(shifts)
      .set({
        conflictResolvedAt: ctx.now,
        conflictResolvedBy: ctx.userId,
        syncConflictNote: `${shift.syncConflictNote ?? ""}\nDitinjau: ${data.note}`.trim(),
        updatedAt: new Date(),
      })
      .where(eq(shifts.id, shift.id))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "shift",
      objectId: shift.id,
      action: "resolve_conflict",
      before: { conflictResolvedAt: null },
      after: { conflictResolvedAt: ctx.now },
      reason: data.note,
    });
    return row!;
  });
}

// =====================================================================================================================
// Riwayat shift operator (US-M6-02 KP-6)
// =====================================================================================================================

export type OperatorShiftHistoryRow = {
  shiftId: string;
  businessDate: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  salesTotal: number;
  gallonsSold: number;
  cashDifference: number | null;
  cashDifferenceReason: string | null;
  depositAmount: number | null;
  depositStatus: string;
  depositReceivedAmount: number | null;
  depositDiscrepancy: number | null;
  depositNumber: string | null;
  stockDifferences: { name: string; difference: number | null }[];
};

/** Riwayat shift MILIK operator di outlet ini, N hari terakhir (tidak melihat outlet/operator lain). */
export async function operatorShiftHistory(tx: Tx, input: { userId: string; outletId: string; today: BusinessDate; days: number }): Promise<OperatorShiftHistoryRow[]> {
  const from = addDays(input.today, -input.days + 1);
  const rows = await tx
    .select({ shift: shifts, dep: deposits })
    .from(shifts)
    .leftJoin(deposits, eq(deposits.id, shifts.depositId))
    .where(and(eq(shifts.operatorUserId, input.userId), eq(shifts.outletId, input.outletId), gte(shifts.businessDate, from)))
    .orderBy(desc(shifts.openedAt))
    .limit(200);
  return rows.map(({ shift, dep }) => {
    const summary = (shift.summary ?? {}) as { salesTotal?: number; gallonsSold?: number; stock?: { name: string; difference: number | null }[] };
    return {
      shiftId: shift.id,
      businessDate: shift.businessDate,
      status: shift.status,
      openedAt: shift.openedAt.toISOString(),
      closedAt: shift.closedAt?.toISOString() ?? null,
      salesTotal: summary.salesTotal ?? 0,
      gallonsSold: summary.gallonsSold ?? 0,
      cashDifference: shift.cashDifference,
      cashDifferenceReason: shift.cashDifferenceReason,
      depositAmount: shift.depositAmount,
      depositStatus: shift.depositStatus,
      depositReceivedAmount: dep?.receivedAmount ?? null,
      depositDiscrepancy: dep?.discrepancyAmount ?? null,
      depositNumber: dep?.number ?? null,
      stockDifferences: (summary.stock ?? []).map((s) => ({ name: s.name, difference: s.difference })),
    };
  });
}

/** Tanggal bisnis pelaku (pembantu untuk layanan kantor). */
export function officeDate(ctx: ActorContext): BusinessDate {
  return ctxBusinessDate(ctx);
}
