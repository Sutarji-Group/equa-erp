/**
 * M4 — logika handler event domain (didaftarkan di `../events.ts`) dan job kecil. Setiap handler memakai
 * `systemContext` tenant event dan idempoten (indeks unik per objek sumber / mutasi kas).
 */
import "server-only";

import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";

import { customerPayments, deposits, notifications, suppliers, supplierPayments, tenants, tripPayments, trips } from "@/db/schema";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, toBusinessDate } from "@/lib/time";

import { systemContext } from "@/server/core/context";
import { withTx, type Db, type Tx } from "@/server/core/db";
import type { DomainEvent } from "@/server/core/events";
import { notify, type NotifyInput } from "@/server/core/notifications";

import { cashRules, userNames } from "./common";
import { applySupplierPaymentToOfficeCash } from "./office-cash";
import { cancelTransferForSource, recordIncomingTransfer, recordSlipDepositTransfer } from "./transfers";

/** Kas & setoran mitra (tenant partner) dikelola mitra sendiri — tidak masuk M4 EQUA (US-M6-07 KP-3). */
async function isOwnerTenant(tx: Tx, tenantId: string | null): Promise<boolean> {
  if (!tenantId) return false;
  const row = (await tx.select({ kind: tenants.kind }).from(tenants).where(eq(tenants.id, tenantId)).limit(1))[0];
  return row?.kind === "owner";
}

function eventDate(event: DomainEvent, fallback?: string | null): string {
  return fallback ?? event.businessDate ?? toBusinessDate(event.occurredAt);
}

/** `trip.payment_recorded` (transfer) → transfer masuk "pembayaran rit". */
export async function onTripPaymentRecorded(event: DomainEvent<"trip.payment_recorded">, tx: Tx): Promise<void> {
  const p = event.payload;
  if (p.method !== "transfer" || !(await isOwnerTenant(tx, event.tenantId))) return;
  const amount = p.receivedAmount ?? p.amount;
  if (!amount || amount <= 0) return;
  const date = eventDate(event, p.businessDate);
  const { transfer } = await recordIncomingTransfer(tx, {
    tenantId: event.tenantId!,
    sourceKind: "trip_payment",
    sourceObjectType: "trip_payment",
    sourceObjectId: p.tripPaymentId,
    amount,
    transferDate: date,
    businessDate: date,
    customerId: p.customerId,
    proofAttachmentId: p.transferProofAttachmentId ?? null,
    bankAccountId: p.bankAccountId ?? null,
    reference: p.tripNumber ?? null,
    sourceUserId: p.driverUserId,
    truckId: p.truckId ?? null,
    createdBy: event.actorUserId,
  });
  await tx.update(tripPayments).set({ incomingTransferId: transfer.id }).where(and(eq(tripPayments.id, p.tripPaymentId), isNull(tripPayments.incomingTransferId)));
}

/** `collection.recorded` (transfer) → transfer masuk pelunasan (sopir / kantor / mitra toko). */
export async function onCollectionRecorded(event: DomainEvent<"collection.recorded">, tx: Tx): Promise<void> {
  const p = event.payload;
  if (p.method !== "transfer" || p.channel === "digital" || p.incomingTransferId || !(await isOwnerTenant(tx, event.tenantId))) return;
  if (!p.amount || p.amount <= 0) return;
  const date = eventDate(event, p.businessDate);
  const kind = p.channel === "driver" ? "collection" : p.channel === "store" ? "store_collection" : "office_payment";
  const truckId = p.tripId ? ((await tx.select({ truckId: trips.truckId }).from(trips).where(eq(trips.id, p.tripId)).limit(1))[0]?.truckId ?? null) : null;
  const { transfer } = await recordIncomingTransfer(tx, {
    tenantId: event.tenantId!,
    sourceKind: kind,
    sourceObjectType: "customer_payment",
    sourceObjectId: p.customerPaymentId,
    amount: p.amount,
    transferDate: date,
    businessDate: date,
    customerId: p.customerId,
    outletId: p.outletId ?? null,
    proofAttachmentId: p.proofAttachmentId ?? null,
    bankAccountId: p.bankAccountId ?? null,
    sourceUserId: p.driverUserId ?? event.actorUserId,
    truckId,
    createdBy: event.actorUserId,
  });
  await tx.update(customerPayments).set({ incomingTransferId: transfer.id }).where(and(eq(customerPayments.id, p.customerPaymentId), isNull(customerPayments.incomingTransferId)));
}

/** `shift.closed` → QRIS per shift (PTB-04) sebagai transfer masuk untuk dicocokkan. */
export async function onShiftClosed(event: DomainEvent<"shift.closed">, tx: Tx): Promise<void> {
  const p = event.payload;
  if (!p.qrisAmount || p.qrisAmount <= 0 || p.syncConflict || !(await isOwnerTenant(tx, event.tenantId))) return;
  const date = eventDate(event, p.businessDate);
  await recordIncomingTransfer(tx, {
    tenantId: event.tenantId!,
    sourceKind: "qris_shift",
    sourceObjectType: "shift",
    sourceObjectId: p.shiftId,
    amount: p.qrisAmount,
    transferDate: date,
    businessDate: date,
    outletId: p.outletId,
    shiftId: p.shiftId,
    reference: `QRIS shift ${formatTanggal(date, { weekday: false })}${p.qrisCount ? ` (${p.qrisCount} transaksi)` : ""}`,
    sourceUserId: p.operatorUserId,
    createdBy: event.actorUserId,
  });
}

/** `pos_sale.recorded` QRIS yang tersinkron setelah shift-nya ditutup → transfer per transaksi (tidak ikut QRIS shift). */
export async function onPosSaleRecorded(event: DomainEvent<"pos_sale.recorded">, tx: Tx): Promise<void> {
  const p = event.payload;
  if (p.method !== "qris" || !p.afterShiftClosed || p.total <= 0 || !(await isOwnerTenant(tx, event.tenantId))) return;
  const date = eventDate(event, p.businessDate);
  await recordIncomingTransfer(tx, {
    tenantId: event.tenantId!,
    sourceKind: "qris_shift",
    sourceObjectType: "pos_sale",
    sourceObjectId: p.posSaleId,
    amount: p.total,
    transferDate: date,
    businessDate: date,
    customerId: p.customerId ?? null,
    outletId: p.outletId,
    reference: p.number ?? p.qrisReference ?? null,
    notes: "QRIS tersinkron setelah shift ditutup",
    createdBy: event.actorUserId,
  });
}

/** `deposit.submitted` setor bank dengan slip (sopir PTB-23 / setor sebagian outlet) → transfer untuk dicocokkan. */
export async function onDepositSubmitted(event: DomainEvent<"deposit.submitted">, tx: Tx): Promise<void> {
  if (!(await isOwnerTenant(tx, event.tenantId))) return;
  await recordSlipDepositTransfer(tx, event.payload.depositId);
}

/** `digital_payment.succeeded` (Tahap 2) → transfer masuk pembayaran digital. */
export async function onDigitalPayment(event: DomainEvent<"digital_payment.succeeded">, tx: Tx): Promise<void> {
  const p = event.payload;
  if (!(await isOwnerTenant(tx, event.tenantId)) || p.amount <= 0) return;
  const date = eventDate(event);
  await recordIncomingTransfer(tx, {
    tenantId: event.tenantId!,
    sourceKind: "digital_payment",
    sourceObjectType: "payment_intent",
    sourceObjectId: p.paymentIntentId,
    amount: p.amount,
    transferDate: date,
    businessDate: date,
    customerId: p.customerId,
    reference: p.method,
    createdBy: event.actorUserId,
  });
}

/** Pembalik pembayaran rit transfer / pelunasan → transfer yang belum cocok Dibatalkan. */
export async function onTripPaymentReversed(event: DomainEvent<"trip_payment.reversed">, tx: Tx): Promise<void> {
  const p = event.payload;
  if (p.method !== "transfer" || !event.tenantId) return;
  await cancelTransferForSource(tx, systemContext({ tenantId: event.tenantId, now: event.occurredAt }), "trip_payment", p.tripPaymentId, p.reason);
}

export async function onPaymentReversed(event: DomainEvent<"payment.reversed">, tx: Tx): Promise<void> {
  if (!event.tenantId) return;
  await cancelTransferForSource(tx, systemContext({ tenantId: event.tenantId, now: event.occurredAt }), "customer_payment", event.payload.customerPaymentId, event.payload.reason);
}

/** `supplier_payment.recorded` tunai → kas kantor keluar (B-21). */
export async function onSupplierPayment(event: DomainEvent<"supplier_payment.recorded">, tx: Tx): Promise<void> {
  const p = event.payload;
  if (p.method !== "cash" || !(await isOwnerTenant(tx, event.tenantId))) return;
  const supplier = (await tx.select({ name: suppliers.name }).from(suppliers).where(eq(suppliers.id, p.supplierId)).limit(1))[0];
  const row = (await tx.select({ businessDate: supplierPayments.businessDate }).from(supplierPayments).where(eq(supplierPayments.id, p.supplierPaymentId)).limit(1))[0];
  await applySupplierPaymentToOfficeCash(tx, systemContext({ tenantId: event.tenantId!, now: event.occurredAt }), {
    supplierPaymentId: p.supplierPaymentId,
    amount: p.amount,
    method: p.method,
    businessDate: p.businessDate ?? row?.businessDate ?? eventDate(event),
    reversalOfId: p.reversalOfId ?? null,
    supplierName: supplier?.name ?? null,
  });
}

// =====================================================================================================================
// Job kecil
// =====================================================================================================================

/** Notifikasi sekali per `groupKey` (job berulang tiap 5 menit tidak menggandakan). */
export async function notifyOnce(tx: Tx, groupKey: string, input: Omit<NotifyInput, "groupKey">): Promise<boolean> {
  const exists = await tx.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.groupKey, groupKey), eq(notifications.event, input.event))).limit(1);
  if (exists[0]) return false;
  await notify(tx, { ...input, groupKey });
  return true;
}

/**
 * US-M4-01 KP-4 / PAR-44: setoran sopir belum Diajukan > N jam setelah rit terakhir Selesai → notifikasi Admin
 * Keuangan `deposit.not_submitted` (sekali per setoran).
 */
export async function runDriverNotSubmittedCheck(now: Date = new Date(), opts: { db?: Db } = {}): Promise<{ notified: number }> {
  return withTx(
    async (tx) => {
      const today = toBusinessDate(now);
      const running = await tx
        .select()
        .from(deposits)
        .where(and(eq(deposits.sourceType, "driver"), eq(deposits.status, "running"), lte(deposits.businessDate, today), gt(deposits.expectedCash, -1)));
      let notified = 0;
      const byTenant = new Map<string, number>();
      for (const d of running) {
        if (!d.depositorUserId || !(await isOwnerTenant(tx, d.tenantId))) continue;
        let hours = byTenant.get(d.tenantId);
        if (hours === undefined) {
          hours = (await cashRules(tx, today, d.tenantId)).driverSubmitHours;
          byTenant.set(d.tenantId, hours);
        }
        const done = await tx
          .select({ completedAt: trips.completedAt })
          .from(trips)
          .where(and(eq(trips.driverUserId, d.depositorUserId), eq(trips.status, "completed"), eq(trips.completionBusinessDate, d.businessDate)));
        const last = done.map((t) => t.completedAt?.getTime() ?? 0).sort((a, b) => b - a)[0];
        if (!last || now.getTime() - last <= hours * 3_600_000) continue;
        const active = await tx.select({ id: trips.id }).from(trips).where(and(eq(trips.driverUserId, d.depositorUserId), inArray(trips.status, ["departed", "arrived"]))).limit(1);
        if (active[0]) continue;
        const name = (await userNames(tx, [d.depositorUserId])).get(d.depositorUserId)?.name ?? "Sopir";
        const sent = await notifyOnce(tx, `deposit.not_submitted:${d.id}`, {
          event: "deposit.not_submitted",
          tenantId: d.tenantId,
          title: `${name} belum setor ${formatTanggal(d.businessDate, { weekday: false })}`,
          body: `Rit terakhir Selesai lebih dari ${hours} jam lalu; kas sistem ${formatRupiah(d.expectedCash)}. Ingatkan sopir menekan "Setor".`,
          objectType: "deposit",
          objectId: d.id,
          link: "/kas",
          now,
        });
        if (sent) notified++;
      }
      return { notified };
    },
    { db: opts.db },
  );
}
