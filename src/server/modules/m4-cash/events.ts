/**
 * M4 — handler event domain (terisolasi savepoint; galat → insiden, transaksi sumber tetap commit).
 *
 * Transfer masuk tercatat (US-M4-04 KP-1), satu per objek sumber:
 * - `trip.payment_recorded` (transfer) → `m4-cash:transfer_trip_payment`
 * - `collection.recorded` (transfer; sopir/kantor/mitra toko) → `m4-cash:transfer_collection`
 * - `shift.closed` (QRIS per shift depot & toko, PTB-04) → `m4-cash:transfer_qris_shift`
 * - `pos_sale.recorded` (QRIS tersinkron setelah shift ditutup) → `m4-cash:transfer_qris_late`
 * - `deposit.submitted` (setor bank dengan slip sopir/outlet, PTB-23) → `m4-cash:transfer_bank_slip`
 * - `digital_payment.succeeded` (Tahap 2) → `m4-cash:transfer_digital`
 * - `trip_payment.reversed` / `payment.reversed` → transfer yang belum cocok Dibatalkan
 * Kas kantor: `supplier_payment.recorded` tunai (M7) → mutasi kas kantor (B-21) → `m4-cash:supplier_payment_cash`.
 *
 * Event yang dipancarkan M4: `deposit.received`, `deposit.closed`, `expense.verified`, `discrepancy.formed`,
 * `discrepancy.decided`, `discrepancy.reopened`, `transfer.matched`, `transfer.not_found`, `bank_deposit.recorded`,
 * `bank_deposit.reversed`, `office_cash.moved`, `petty_cash.recorded`, `cash_day.closed`, `restitution.recorded`,
 * `restitution.settled`, `restitution.settlement_reversed` (docs/dev/modules/m4-cash.md §2).
 */
import "server-only";

import { on } from "@/server/core/events";

import {
  onCollectionRecorded,
  onDepositSubmitted,
  onDigitalPayment,
  onPaymentReversed,
  onPosSaleRecorded,
  onShiftClosed,
  onSupplierPayment,
  onTripPaymentRecorded,
  onTripPaymentReversed,
} from "./service/events-logic";

export function registerEvents(): void {
  on("trip.payment_recorded", onTripPaymentRecorded, { name: "m4-cash:transfer_trip_payment" });
  on("collection.recorded", onCollectionRecorded, { name: "m4-cash:transfer_collection" });
  on("shift.closed", onShiftClosed, { name: "m4-cash:transfer_qris_shift" });
  on("pos_sale.recorded", onPosSaleRecorded, { name: "m4-cash:transfer_qris_late" });
  on("deposit.submitted", onDepositSubmitted, { name: "m4-cash:transfer_bank_slip" });
  on("digital_payment.succeeded", onDigitalPayment, { name: "m4-cash:transfer_digital" });
  on("trip_payment.reversed", onTripPaymentReversed, { name: "m4-cash:transfer_cancel_trip_payment" });
  on("payment.reversed", onPaymentReversed, { name: "m4-cash:transfer_cancel_collection" });
  on("supplier_payment.recorded", onSupplierPayment, { name: "m4-cash:supplier_payment_cash" });
}
