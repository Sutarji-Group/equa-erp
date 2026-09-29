/**
 * P3 — perintah sinkron lapangan & penyedia pull (outbox offline, docs/ARCHITECTURE.md §7).
 *
 * - `p3.quality_checklist.submit` (operator depot mitra, izin `p3.quality_checklist.create`): daftar periksa mutu
 *   harian saat buka shift (US-P3-05 KP-1, Tahap 3). Idempoten per perintah; outlet-hari yang sudah terisi → konflik.
 * - Pull `p3.partner_pos` (operator depot): status mode baca-saja tenant, penghentian pasokan, butir & status daftar
 *   periksa hari ini (tampil di POS mitra).
 * - Pull `p3.store_partner_orders` (kasir toko EQUA): pesanan spare part portal yang menunggu dicatat sebagai penjualan
 *   harga mitra (US-P3-03 KP-3).
 */
import "server-only";

import { eq, inArray } from "drizzle-orm";

import { customers, tenants } from "@/db/schema";
import { toBusinessDate } from "@/lib/time";
import { registerPullProvider, registerSyncHandler } from "@/server/core/sync";

import { portalEnabled } from "./service/common";
import { pendingSparePartOrders } from "./service/portal-orders";
import { qualityChecklistSchema, submitQualityChecklistFromField, todayChecklistStatus } from "./service/quality";
import { activeSupplySuspension } from "./service/sanctions";

export function registerSync(): void {
  registerSyncHandler("p3.quality_checklist.submit", {
    permission: "p3.quality_checklist.create",
    schema: qualityChecklistSchema,
    labels: { items: "Butir daftar periksa" },
    description: "Daftar periksa mutu harian outlet mitra (US-P3-05 KP-1)",
    handle: (ctx, payload, meta) => submitQualityChecklistFromField(ctx, payload, meta),
  });

  registerPullProvider("p3.partner_pos", {
    roles: ["depot_operator"],
    fetch: async ({ tx, device, now }) => {
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, device.tenantId)).limit(1);
      if (!tenant || tenant.kind !== "partner") return null;
      const date = toBusinessDate(now);
      const phase3 = await portalEnabled(tx, tenant.id);
      const suspension = phase3 ? await activeSupplySuspension(tx, tenant.id, date) : null;
      return {
        date,
        readOnly: tenant.readOnly,
        phase3,
        supplySuspended: !!suspension,
        checklist: phase3 && device.outletId ? await todayChecklistStatus(tx, device.outletId, date) : null,
      };
    },
  });

  registerPullProvider("p3.store_partner_orders", {
    roles: ["store_cashier"],
    fetch: async ({ tx }) => {
      const rows = await pendingSparePartOrders(tx);
      const names = rows.length ? await tx.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, [...new Set(rows.map((r) => r.customerId))])) : [];
      return {
        orders: rows.map((r) => ({
          id: r.id,
          customerId: r.customerId,
          customerName: names.find((n) => n.id === r.customerId)?.name ?? "-",
          items: r.items,
          pickup: r.pickup,
          paymentMethod: r.paymentMethod,
          estimatedAmount: r.estimatedAmount,
          submittedAt: r.submittedAt.toISOString(),
        })),
      };
    },
  });
}
