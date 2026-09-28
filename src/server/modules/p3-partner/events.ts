/**
 * P3 — handler event domain Kemitraan (didaftarkan di `registerEvents()`, bukan top-level).
 *
 * RL-7 (aktif):
 * - `order.created` → `p3-partner:water_order_sla` — pesanan air pelanggan mitra: `orders.sla_due_at` = dibuat + PAR-76.
 * - `trip.completed` → `p3-partner:supply_arrival` — rit pelanggan mitra Selesai → pasokan "Tiba" di POS outlet mitra.
 * - `water_supply.confirmed` → `p3-partner:supply_difference` — selisih kirim–terima pasokan mitra → Dispatcher EQUA.
 *
 * Tahap 3 (flag `phase3.partner_portal`; handler selalu terdaftar, memeriksa flag sendiri):
 * - `order.created` → `p3-partner:supply_suspension` (isolate: false) — pesanan air mitra yang sedang dikenai
 *   penghentian pasokan sementara DITOLAK (transaksi M2 rollback dengan pesan alasan & syarat pemulihan, US-P3-07 KP-1).
 * - `shift.opened` → `p3-partner:read_only_tenant` (isolate: false) — tenant mitra mode baca-saja (US-P3-02 KP-4) tidak
 *   dapat membuka shift baru.
 * - `pos_sale.recorded` → `p3-partner:spare_part_order` — penjualan toko harga mitra untuk pelanggan mitra
 *   mengonfirmasi pesanan spare part portal (US-P3-03 KP-3).
 * - `credit_status.changed` → `p3-partner:credit_hold_trigger` — Ditahan pelanggan mitra dinaikkan ke pemicu sanksi.
 * - `quality_test` hasil uji tidak lulus berturut dicatat modul mutu (bukan event).
 */
import "server-only";

import { on } from "@/server/core/events";

import { confirmSparePartOrderFromSale, rejectOrderWhenSupplySuspended, rejectShiftWhenReadOnly, triggerOnCreditHold } from "./service/phase3-hooks";
import { flagPartnerSupplyDifference, markPartnerOrderSla, recordPartnerSupplyArrival } from "./service/supply";

export function registerEvents(): void {
  on("order.created", async (event, tx) => void (await markPartnerOrderSla(tx, event)), { name: "p3-partner:water_order_sla" });
  on("trip.completed", async (event, tx) => void (await recordPartnerSupplyArrival(tx, event)), { name: "p3-partner:supply_arrival" });
  on("water_supply.confirmed", async (event, tx) => void (await flagPartnerSupplyDifference(tx, event)), { name: "p3-partner:supply_difference" });
  // Tahap 3 — wajib atomik dengan sumbernya (menolak pesanan/shift), sehingga tidak diisolasi savepoint.
  on("order.created", async (event, tx) => void (await rejectOrderWhenSupplySuspended(tx, event)), { name: "p3-partner:supply_suspension", isolate: false });
  on("shift.opened", async (event, tx) => void (await rejectShiftWhenReadOnly(tx, event)), { name: "p3-partner:read_only_tenant", isolate: false });
  on("pos_sale.recorded", async (event, tx) => void (await confirmSparePartOrderFromSale(tx, event)), { name: "p3-partner:spare_part_order" });
  on("credit_status.changed", async (event, tx) => void (await triggerOnCreditHold(tx, event)), { name: "p3-partner:credit_hold_trigger" });
}
