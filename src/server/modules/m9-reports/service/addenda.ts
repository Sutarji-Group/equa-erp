/**
 * M9 — catatan tambahan (addenda) H+0 yang sudah terbit (US-M9-01 KP-6, Bab 5.3, 7.9.7).
 *
 * Angka H+0 yang sudah terbit TIDAK pernah berubah. Peristiwa yang memengaruhi tanggal yang H+0-nya sudah terbit dicatat
 * sebagai addendum bertanda pada TANGGAL ASALNYA (`business_date`), dengan tanggal pencatatan (`recorded_on`):
 * - `late_sync`   — transaksi lapangan terlambat sinkron (rit Selesai/Gagal, transaksi POS, pelunasan) setelah terbit;
 * - `late_deposit`— setoran tertunda (PTB-21) diterima setelah terbit;
 * - `correction`  — koreksi lewat pembalik (void setelah tutup, pembalik pembayaran rit/pelunasan, nota kredit, retur
 *                   toko, penghapusan piutang, koreksi rit) — tampil pada tanggal koreksi dengan rujukan hari asal.
 * Idempoten per (ringkasan, jenis, objek).
 */
import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { customerPayments, dailySummaries, dailySummaryAddenda, invoices, posSales, tripPayments, trips } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, toBusinessDate, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { systemContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import type { DomainEvent, DomainEventType } from "@/server/core/events";

export type AddendumKind = "late_sync" | "correction" | "late_deposit";

export type AddendumInput = {
  tenantId: string;
  /** Tanggal asal yang terdampak. */
  businessDate: BusinessDate;
  kind: AddendumKind;
  objectType: string;
  objectId: string;
  description: string;
  delta: Record<string, unknown>;
  /** Waktu peristiwa (addendum hanya bila SESUDAH H+0 terbit). */
  occurredAt: Date;
  /** Tanggal pencatatan (koreksi: tanggal koreksi). */
  recordedOn?: BusinessDate | null;
};

/** Catat addendum bila H+0 tanggal asal sudah terbit sebelum peristiwa. Mengembalikan `true` bila tercatat baru. */
export async function recordAddendum(tx: Tx, input: AddendumInput): Promise<boolean> {
  const [summary] = await tx
    .select({ id: dailySummaries.id, publishedAt: dailySummaries.publishedAt, status: dailySummaries.status })
    .from(dailySummaries)
    .where(and(eq(dailySummaries.tenantId, input.tenantId), eq(dailySummaries.businessDate, input.businessDate)))
    .limit(1);
  if (!summary || summary.status === "running" || !summary.publishedAt) return false;
  if (input.occurredAt.getTime() < summary.publishedAt.getTime()) return false;
  const dup = await tx
    .select({ id: dailySummaryAddenda.id })
    .from(dailySummaryAddenda)
    .where(
      and(
        eq(dailySummaryAddenda.dailySummaryId, summary.id),
        eq(dailySummaryAddenda.kind, input.kind),
        eq(dailySummaryAddenda.objectType, input.objectType),
        eq(dailySummaryAddenda.objectId, input.objectId),
      ),
    )
    .limit(1);
  if (dup[0]) return false;
  const recordedOn = input.recordedOn ?? toBusinessDate(input.occurredAt);
  const [row] = await tx
    .insert(dailySummaryAddenda)
    .values({
      dailySummaryId: summary.id,
      businessDate: input.businessDate,
      kind: input.kind,
      objectType: input.objectType,
      objectId: input.objectId,
      description: input.description,
      delta: input.delta,
      recordedOn,
    })
    .returning({ id: dailySummaryAddenda.id });
  await auditRecord(tx, {
    ctx: systemContext({ tenantId: input.tenantId, now: input.occurredAt }),
    objectType: "daily_summary",
    objectId: summary.id,
    action: "addendum",
    after: { addendumId: row!.id, kind: input.kind, objectType: input.objectType, objectId: input.objectId, recordedOn, delta: input.delta },
    rule: "US-M9-01 KP-6, Bab 5.3",
    businessDate: input.businessDate,
  });
  return true;
}

const lineOfOutletKind = (kind: string | null | undefined) => (kind === "store" ? "L4" : "L3");

function eventDate(event: DomainEvent, payloadDate?: string | null): BusinessDate {
  return payloadDate ?? event.businessDate ?? toBusinessDate(event.occurredAt);
}

/** Peta event → addendum (dipanggil handler `m9-reports:addenda`). */
export async function addendumFromEvent(event: DomainEvent, tx: Tx): Promise<boolean> {
  const tenantId = event.tenantId;
  if (!tenantId) return false;
  const at = event.occurredAt;
  const type = event.type as DomainEventType;
  switch (type) {
    case "trip.completed": {
      const p = event.payload as DomainEvent<"trip.completed">["payload"];
      const date = eventDate(event, p.businessDate);
      const what = p.isInternal ? "Rit internal pasokan depot" : "Rit";
      return recordAddendum(tx, {
        tenantId,
        businessDate: date,
        kind: "late_sync",
        objectType: "trip",
        objectId: p.tripId,
        description: `${what} ${p.tripNumber ?? ""} Selesai ${p.lateSync ? "terlambat sinkron" : "tercatat setelah H+0 terbit"} — ${formatRupiah(p.price)}.`.replace(/\s+/g, " "),
        delta: p.isInternal ? { internal: { truckToDepot: p.price, trips: 1 } } : { revenue: { L2: p.price }, trips: { completed: 1 } },
        occurredAt: at,
      });
    }
    case "trip.failed": {
      const p = event.payload as DomainEvent<"trip.failed">["payload"];
      return recordAddendum(tx, {
        tenantId,
        businessDate: eventDate(event, p.businessDate),
        kind: "late_sync",
        objectType: "trip",
        objectId: p.tripId,
        description: `Rit ${p.tripNumber ?? ""} Gagal (${label("trip_fail_reason", p.reason)}) ${p.lateSync ? "terlambat sinkron" : "tercatat setelah H+0 terbit"}.`.replace(/\s+/g, " "),
        delta: { trips: { failed: 1 } },
        occurredAt: at,
      });
    }
    case "pos_sale.recorded": {
      const p = event.payload as DomainEvent<"pos_sale.recorded">["payload"];
      const line = lineOfOutletKind(p.outletKind);
      return recordAddendum(tx, {
        tenantId,
        businessDate: eventDate(event, p.businessDate),
        kind: "late_sync",
        objectType: "pos_sale",
        objectId: p.posSaleId,
        description: `Transaksi ${line === "L4" ? "toko" : "depot"} ${p.number ?? ""} ${formatRupiah(p.total)} tersinkron setelah H+0 terbit.`.replace(/\s+/g, " "),
        delta: { revenue: { [line]: p.total } },
        occurredAt: at,
      });
    }
    case "pos_sale.voided": {
      const p = event.payload as DomainEvent<"pos_sale.voided">["payload"];
      if (!p.afterClose && !p.reversalId) return false;
      const [sale] = await tx.select({ businessDate: posSales.businessDate, number: posSales.number }).from(posSales).where(eq(posSales.id, p.posSaleId)).limit(1);
      if (!sale) return false;
      const line = lineOfOutletKind(p.outletKind);
      const recordedOn = eventDate(event, p.businessDate);
      return recordAddendum(tx, {
        tenantId,
        businessDate: sale.businessDate,
        kind: "correction",
        objectType: "pos_sale",
        objectId: p.posSaleId,
        description: `Void setelah tutup shift atas transaksi ${sale.number ?? ""} (${formatRupiah(p.total)}) — pembalik dicatat ${formatTanggal(recordedOn)}.`.replace(/\s+/g, " "),
        delta: { revenue: { [line]: -p.total } },
        occurredAt: at,
        recordedOn,
      });
    }
    case "collection.recorded": {
      const p = event.payload as DomainEvent<"collection.recorded">["payload"];
      if (p.method === "internal") return false;
      return recordAddendum(tx, {
        tenantId,
        businessDate: eventDate(event, p.businessDate),
        kind: p.lateSync ? "late_sync" : "correction",
        objectType: "customer_payment",
        objectId: p.customerPaymentId,
        description: `Pelunasan ${formatRupiah(p.amount)} ${p.lateSync ? "terlambat sinkron" : "dicatat setelah H+0 terbit"}.`,
        delta: { receivables: { paid: p.amount - (p.advanceAmount ?? 0) } },
        occurredAt: at,
      });
    }
    case "deposit.received": {
      const p = event.payload as DomainEvent<"deposit.received">["payload"];
      if (!p.businessDate) return false;
      return recordAddendum(tx, {
        tenantId,
        businessDate: p.businessDate,
        kind: "late_deposit",
        objectType: "deposit",
        objectId: p.depositId,
        description: `Setoran ${p.depositNumber ?? ""} ${label("deposit_source_type", p.sourceType)} diterima setelah H+0 terbit: ${formatRupiah(p.receivedAmount)} (selisih ${formatRupiah(p.discrepancyAmount, { signed: true })}).`.replace(/\s+/g, " "),
        delta: { cash: { received: p.receivedAmount, discrepancy: p.discrepancyAmount } },
        occurredAt: at,
        recordedOn: toBusinessDate(at),
      });
    }
    case "trip_payment.reversed": {
      const p = event.payload as DomainEvent<"trip_payment.reversed">["payload"];
      const [tp] = await tx.select({ businessDate: tripPayments.businessDate }).from(tripPayments).where(eq(tripPayments.id, p.tripPaymentId)).limit(1);
      if (!tp) return false;
      return recordAddendum(tx, {
        tenantId,
        businessDate: tp.businessDate,
        kind: "correction",
        objectType: "trip_payment",
        objectId: p.tripPaymentId,
        description: `Pembayaran rit dibalik (${formatRupiah(p.amount)}): ${p.reason}`,
        delta: { cash: { expected: p.method === "cash" ? -p.amount : 0 } },
        occurredAt: at,
        recordedOn: eventDate(event),
      });
    }
    case "payment.reversed": {
      const p = event.payload as DomainEvent<"payment.reversed">["payload"];
      const [cp] = await tx.select({ businessDate: customerPayments.businessDate }).from(customerPayments).where(eq(customerPayments.id, p.customerPaymentId)).limit(1);
      if (!cp) return false;
      return recordAddendum(tx, {
        tenantId,
        businessDate: cp.businessDate,
        kind: "correction",
        objectType: "customer_payment",
        objectId: p.customerPaymentId,
        description: `Pelunasan dibalik (${formatRupiah(p.amount)}): ${p.reason}`,
        delta: { receivables: { paid: -p.amount } },
        occurredAt: at,
        recordedOn: eventDate(event, p.businessDate),
      });
    }
    case "credit_note.issued": {
      const p = event.payload as DomainEvent<"credit_note.issued">["payload"];
      if (!p.invoiceId || p.purpose === "underpayment_conversion" || p.purpose === "pending_transfer_resolved") return false;
      const [inv] = await tx.select({ issueDate: invoices.issueDate, number: invoices.number }).from(invoices).where(eq(invoices.id, p.invoiceId)).limit(1);
      if (!inv) return false;
      return recordAddendum(tx, {
        tenantId,
        businessDate: inv.issueDate,
        kind: "correction",
        objectType: "credit_note",
        objectId: p.creditNoteId,
        description: `Nota kredit ${p.number ?? ""} atas faktur ${inv.number} (${formatRupiah(p.amount)}): ${p.reason}`.replace(/\s+/g, " "),
        delta: { receivables: { balance: -p.amount } },
        occurredAt: at,
        recordedOn: eventDate(event),
      });
    }
    case "invoice.written_off": {
      const p = event.payload as DomainEvent<"invoice.written_off">["payload"];
      const [inv] = await tx.select({ issueDate: invoices.issueDate, number: invoices.number }).from(invoices).where(eq(invoices.id, p.invoiceId)).limit(1);
      if (!inv) return false;
      return recordAddendum(tx, {
        tenantId,
        businessDate: inv.issueDate,
        kind: "correction",
        objectType: "invoice",
        objectId: p.invoiceId,
        description: `Faktur ${inv.number} dihapusbukukan (${formatRupiah(p.amount)}): ${p.reason}`,
        delta: { receivables: { balance: -p.amount } },
        occurredAt: at,
        recordedOn: eventDate(event),
      });
    }
    case "trip.corrected": {
      const p = event.payload as DomainEvent<"trip.corrected">["payload"];
      const [t] = await tx.select({ date: trips.completionBusinessDate, number: trips.number }).from(trips).where(eq(trips.id, p.tripId)).limit(1);
      if (!t?.date) return false;
      return recordAddendum(tx, {
        tenantId,
        businessDate: t.date,
        kind: "correction",
        objectType: "trip",
        objectId: `${p.tripId}:${event.id}`,
        description: `Koreksi rit ${t.number} (${formatRupiah(p.priceDelta, { signed: true })}): ${p.reason}`,
        delta: { revenue: { L2: p.priceDelta } },
        occurredAt: at,
        recordedOn: eventDate(event),
      });
    }
    case "store_return.recorded": {
      const p = event.payload as DomainEvent<"store_return.recorded">["payload"];
      const [sale] = await tx.select({ businessDate: posSales.businessDate }).from(posSales).where(eq(posSales.id, p.posSaleId)).limit(1);
      if (!sale) return false;
      return recordAddendum(tx, {
        tenantId,
        businessDate: sale.businessDate,
        kind: "correction",
        objectType: "store_return",
        objectId: p.storeReturnId,
        description: `Retur toko atas transaksi ${p.posSaleNumber ?? ""} (${formatRupiah(p.amount)}): ${p.reason}`.replace(/\s+/g, " "),
        delta: { revenue: { L4: -p.amount } },
        occurredAt: at,
        recordedOn: p.businessDate,
      });
    }
    default:
      return false;
  }
}

/** Tipe event yang dapat menambah addendum H+0. */
export const ADDENDUM_EVENT_TYPES = [
  "trip.completed",
  "trip.failed",
  "pos_sale.recorded",
  "pos_sale.voided",
  "collection.recorded",
  "deposit.received",
  "trip_payment.reversed",
  "payment.reversed",
  "credit_note.issued",
  "invoice.written_off",
  "trip.corrected",
  "store_return.recorded",
] as const satisfies readonly DomainEventType[];

/** Jumlah addenda per tanggal (untuk daftar riwayat). */
export async function addendaCount(tx: Tx, summaryId: string): Promise<number> {
  const rows = await tx.select({ n: sql<string>`count(*)` }).from(dailySummaryAddenda).where(eq(dailySummaryAddenda.dailySummaryId, summaryId));
  return Number(rows[0]?.n ?? 0);
}
