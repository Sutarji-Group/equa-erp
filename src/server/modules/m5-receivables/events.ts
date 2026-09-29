/**
 * M5 — handler event domain Piutang (terisolasi savepoint bawaan: galat M5 tidak menggagalkan perintah lapangan M3 /
 * transaksi POS — dicatat sebagai insiden; semua handler IDEMPOTEN sehingga aman diputar ulang).
 *
 * | Event                    | Handler                                   | Efek                                                                  |
 * |--------------------------|-------------------------------------------|-----------------------------------------------------------------------|
 * | `trip.completed`         | `m5-receivables:trip_receivable`          | Tempo → faktur kirim per rit (PTB-24) / belum ditagih (tagihan bulanan); kurang bayar → faktur H+0 (PTB-18). |
 * | `trip.payment_recorded`  | `m5-receivables:trip_payment_receivable`  | Sama (idempoten per rit & jenis) — sumber utama bila `trip.completed` tidak membawa cara bayar. |
 * | `collection.recorded`    | `m5-receivables:apply_collection`         | Alokasi pelunasan (sopir/kasir/kantor) diterapkan ke faktur; kelebihan → uang muka; lepas Ditahan bila lunas. |
 * | `shift.closed`           | `m5-receivables:store_shift_invoices`     | Tempo toko shift itu → faktur per transaksi + `pos_sales.invoice_id` (US-M7-04 KP-3). |
 * | `pos_sale.recorded`      | `m5-receivables:store_credit_invoice`     | Tempo toko tersinkron SETELAH shift ditutup → faktur langsung.          |
 * | `pos_sale.voided`        | `m5-receivables:store_void_credit`        | Void tempo yang sudah difakturkan → nota kredit.                       |
 * | `store_return.recorded`  | `m5-receivables:store_return_credit`      | Retur tempo setelah shift (PTB-46) → nota kredit; kelebihan → uang muka. |
 * | `transfer.not_found`     | `m5-receivables:transfer_not_found`       | Piutang sementara "transfer belum diterima" (US-M4-04 KP-4).            |
 * | `transfer.matched`       | `m5-receivables:transfer_matched`         | Penanda dihapus; piutang sementara ditutup nota kredit reklasifikasi.   |
 * | `cash_day.closed`        | `m5-receivables:hold_after_cash_close`    | Evaluasi umur & Ditahan setelah tutup kas (US-M5-03 KP-1).             |
 * | `trip.corrected`         | `m5-receivables:trip_corrected`           | (S5, B-34) Koreksi harga rit: +Δ faktur koreksi/belum ditagih; −Δ nota kredit `trip_correction` / uang muka. |
 * | `trip_payment.reversed`  | `m5-receivables:trip_payment_reversed`    | (S5, B-34) Pembayaran tunai/transfer rit dibalik → faktur koreksi sebesar uang yang dibalik. |
 */
import "server-only";

import { toBusinessDate } from "@/lib/time";

import { EQUA_TENANT_ID, systemContext, type ActorContext } from "@/server/core/context";
import { on, type DomainEvent } from "@/server/core/events";

import { evaluateCreditHolds } from "./service/credit-hold";
import { onCollectionRecorded } from "./service/payments";
import {
  creditFromPosVoid,
  creditFromStoreReturn,
  invoiceFromPosSale,
  invoiceShiftCreditSales,
  onTransferMatched,
  onTransferNotFound,
  onTripCompleted,
  onTripPaymentRecorded,
} from "./service/sources";
import { onTripCorrected, onTripPaymentReversed } from "./service/trip-corrections";

function systemFor(event: DomainEvent): ActorContext {
  return systemContext({ tenantId: event.tenantId ?? EQUA_TENANT_ID, now: event.occurredAt });
}

export function registerEvents(): void {
  on("trip.completed", async (event, tx) => void (await onTripCompleted(tx, systemFor(event), event)), { name: "m5-receivables:trip_receivable" });
  on("trip.payment_recorded", async (event, tx) => void (await onTripPaymentRecorded(tx, systemFor(event), event)), { name: "m5-receivables:trip_payment_receivable" });
  on("collection.recorded", async (event, tx) => void (await onCollectionRecorded(tx, systemFor(event), event)), { name: "m5-receivables:apply_collection" });
  on("pos_sale.recorded", async (event, tx) => void (await invoiceFromPosSale(tx, systemFor(event), event)), { name: "m5-receivables:store_credit_invoice" });
  on("shift.closed", async (event, tx) => void (await invoiceShiftCreditSales(tx, systemFor(event), event.payload.shiftId)), { name: "m5-receivables:store_shift_invoices" });
  on("pos_sale.voided", async (event, tx) => void (await creditFromPosVoid(tx, systemFor(event), event)), { name: "m5-receivables:store_void_credit" });
  on("store_return.recorded", async (event, tx) => void (await creditFromStoreReturn(tx, systemFor(event), event)), { name: "m5-receivables:store_return_credit" });
  on("transfer.not_found", async (event, tx) => void (await onTransferNotFound(tx, systemFor(event), event)), { name: "m5-receivables:transfer_not_found" });
  on("transfer.matched", async (event, tx) => void (await onTransferMatched(tx, systemFor(event), event)), { name: "m5-receivables:transfer_matched" });
  on(
    "cash_day.closed",
    async (event, tx) => {
      const ctx = systemFor(event);
      const date = event.businessDate ?? toBusinessDate(event.occurredAt);
      await evaluateCreditHolds(tx, { ...ctx, businessDate: date }, ctx.tenantId, date);
    },
    { name: "m5-receivables:hold_after_cash_close" },
  );
  // Tambahan S5 (B-34): koreksi rit/pembayaran oleh Admin Keuangan (M3) sampai ke piutang.
  on("trip.corrected", async (event, tx) => void (await onTripCorrected(tx, systemFor(event), event)), { name: "m5-receivables:trip_corrected" });
  on("trip_payment.reversed", async (event, tx) => void (await onTripPaymentReversed(tx, systemFor(event), event)), { name: "m5-receivables:trip_payment_reversed" });
}
