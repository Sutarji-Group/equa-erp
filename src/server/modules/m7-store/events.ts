/**
 * M7 — handler event domain toko (terisolasi savepoint; galat → insiden, sumber tetap commit).
 *
 * | Event                         | Handler                          | Efek                                                            |
 * |-------------------------------|----------------------------------|-----------------------------------------------------------------|
 * | `internal_transfer.received`  | `m7-store:transfer_difference`   | Selisih kirim–terima (dikonfirmasi operator depot, M6) → notifikasi Admin Keuangan (US-M7-06 KP-1). |
 *
 * Event yang DIPANCARKAN M7: `purchase_receipt.recorded`, `purchase_receipt.corrected`, `supplier_payment.recorded`,
 * `internal_transfer.sent`, `store_return.recorded`; `pos_sale.recorded`/`.voided`, `shift.*`, `stock.adjusted` toko
 * dipancarkan kerangka POS M6 (dengan field tambahan toko dari kait kebijakan).
 */
import "server-only";

import { on } from "@/server/core/events";

import { notifyTransferDifference } from "./service/transfers";

export function registerEvents(): void {
  on("internal_transfer.received", (event, tx) => notifyTransferDifference(tx, event.payload, event.occurredAt), { name: "m7-store:transfer_difference" });
}
