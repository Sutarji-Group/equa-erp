/**
 * M3 — pengeluaran rit (US-M3-08, S; FR-M3-08, PTB-20): BBM/tol/parkir/lainnya, jumlah, foto nota WAJIB, terkait rit
 * atau hari & truk, sumber dana kas di tangan / uang pribadi. Status "menunggu verifikasi" sampai Admin Keuangan
 * menerima nota saat penerimaan setoran (M4 memancarkan `expense.verified`). Event `trip.expense_recorded` →
 * M11 (jurnal BBM per truk & tanggal) dan M12 (biaya per rit bersama jarak GPS).
 */
import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { tripExpenses } from "@/db/schema";
import { toBusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { DomainError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { linkAttachment } from "@/server/core/storage";

import { expenseSchema } from "../schemas";
import { actingTruckId, assertActingOnTruck, attachmentsOfKind, ensureRunningDeposit, fieldValues, loadTrip, type M3WriteMeta } from "./common";

export type TripExpenseRow = typeof tripExpenses.$inferSelect;

export async function recordExpense(ctx: ActorContext, input: unknown, meta: M3WriteMeta): Promise<{ expense: TripExpenseRow; duplicate: boolean }> {
  const data = parseInput(expenseSchema, input, { kind: "Jenis", amount: "Jumlah", fundingSource: "Sumber dana" });
  const tx = meta.tx;
  const existing = await tx.select().from(tripExpenses).where(eq(tripExpenses.id, data.expenseId)).limit(1);
  if (existing[0]) return { expense: existing[0], duplicate: true };
  const trip = data.tripId ? await loadTrip(tx, data.tripId) : null;
  const truckId = trip?.truckId ?? (await actingTruckId(tx, ctx, meta.businessDate));
  if (!truckId) throw new DomainError("TRUCK_REQUIRED", "Pengeluaran harus terkait truk. Pilih rit atau hubungi Dispatcher.");
  await assertActingOnTruck(tx, ctx, "m3.trip_expense.create", truckId, meta.businessDate, meta);
  const receipt = attachmentsOfKind(meta, "receipt_note")[0] ?? null;
  if (!receipt && !meta.office) throw new DomainError("RECEIPT_PHOTO_REQUIRED", "Foto nota wajib. Ambil foto nota BBM/tol/parkir lalu simpan lagi.");
  const { deposit } = await ensureRunningDeposit(tx, ctx, { tenantId: trip?.tenantId ?? ctx.tenantId, userId: ctx.userId!, date: meta.businessDate, truckId, today: toBusinessDate(ctx.now) });
  const [expense] = await tx
    .insert(tripExpenses)
    .values({
      id: data.expenseId,
      tenantId: trip?.tenantId ?? ctx.tenantId,
      tripId: trip?.id ?? null,
      truckId,
      driverUserId: ctx.userId,
      businessDate: meta.businessDate,
      kind: data.kind,
      amount: data.amount,
      receiptAttachmentId: receipt?.id ?? null,
      fundingSource: data.fundingSource,
      status: "pending_verification",
      depositId: deposit.id,
      note: data.note ?? null,
      createdBy: ctx.userId,
      ...fieldValues(meta),
    })
    .returning();
  if (receipt) await linkAttachment(tx, receipt.id, { type: "trip_expense", id: expense!.id });
  await auditRecord(tx, {
    ctx,
    objectType: "trip_expense",
    objectId: expense!.id,
    action: "create",
    after: { kind: data.kind, amount: data.amount, fundingSource: data.fundingSource, tripId: trip?.id ?? null, truckId, status: "pending_verification" },
    rule: "US-M3-08",
    businessDate: meta.businessDate,
  });
  await emit(
    tx,
    "trip.expense_recorded",
    {
      tripExpenseId: expense!.id,
      tripId: trip?.id ?? null,
      truckId,
      kind: data.kind,
      amount: data.amount,
      fundingSource: data.fundingSource,
      driverUserId: ctx.userId,
      businessDate: meta.businessDate,
      receiptAttachmentId: receipt?.id ?? null,
      depositId: deposit.id,
      note: data.note ?? null,
      lateSync: meta.lateSync,
    },
    { ctx, businessDate: meta.businessDate, objectType: "trip_expense", objectId: expense!.id },
  );
  return { expense: expense!, duplicate: false };
}

/** Pengeluaran rit hidup (bukan baris pembalik & belum dibalik) pengguna pada tanggal. */
export async function expensesOf(tx: Tx, userId: string, date: string): Promise<TripExpenseRow[]> {
  const rows = await tx
    .select()
    .from(tripExpenses)
    .where(and(eq(tripExpenses.driverUserId, userId), eq(tripExpenses.businessDate, date), isNull(tripExpenses.reversalOfId)));
  if (rows.length === 0) return rows;
  const reversed = await tx
    .select({ id: tripExpenses.reversalOfId })
    .from(tripExpenses)
    .where(inArray(tripExpenses.reversalOfId, rows.map((r) => r.id)));
  const gone = new Set(reversed.map((r) => r.id));
  return rows.filter((r) => !gone.has(r.id));
}
