/**
 * M1 — data referensi offline (pull) untuk PWA POS (docs/ARCHITECTURE.md §7; Bab 6.4 butir 4). M1 tidak memiliki aksi
 * lapangan (tidak ada handler perintah sinkron); data master hanya diubah dari web kantor.
 *
 * - `m1.catalog` (Operator depot, Kasir toko): produk aktif tenant outlet perangkat + harga berlaku hari ini
 *   (standar untuk depot; umum & mitra untuk toko; harga khusus outlet didahulukan). Produk nonaktif tidak dikirim
 *   (US-M1-02 KP-6). `undefined` bila tidak ada perubahan sejak `since`.
 * - `m1.store_partners` (Kasir toko): pelanggan bertanda mitra toko (BR-18) untuk harga mitra & tempo toko (M7).
 */
import "server-only";

import { and, eq, gt, isNull, max, or } from "drizzle-orm";

import { customers, outlets, productPrices, products } from "@/db/schema";
import type { PriceKind } from "@/lib/labels";
import { toBusinessDate } from "@/lib/time";
import { DomainError } from "@/server/core/errors";
import { registerPullProvider } from "@/server/core/sync";

import { resolveProductPrice } from "./service/pricing";

export function registerSync(): void {
  registerPullProvider("m1.catalog", {
    roles: ["depot_operator", "store_cashier"],
    fetch: async ({ ctx, device, since, now, tx }) => {
      const outletId = device.outletId ?? ctx.scope.outletIds[0] ?? null;
      if (!outletId) return { outletId: null, products: [] };
      const [outlet] = await tx.select().from(outlets).where(eq(outlets.id, outletId)).limit(1);
      if (!outlet) return { outletId, products: [] };
      if (since) {
        const [p] = await tx.select({ at: max(products.updatedAt) }).from(products).where(eq(products.tenantId, outlet.tenantId));
        const [pp] = await tx
          .select({ at: max(productPrices.updatedAt) })
          .from(productPrices)
          .where(and(eq(productPrices.tenantId, outlet.tenantId), or(isNull(productPrices.outletId), eq(productPrices.outletId, outletId))));
        const [future] = await tx
          .select({ at: max(productPrices.effectiveFrom) })
          .from(productPrices)
          .where(and(eq(productPrices.tenantId, outlet.tenantId), eq(productPrices.status, "active"), gt(productPrices.effectiveFrom, toBusinessDate(since))));
        const last = [p?.at, pp?.at].filter((d): d is Date => d instanceof Date).reduce((a, b) => (a > b ? a : b), new Date(0));
        // Harga yang mulai berlaku setelah pull terakhir juga memicu kirim ulang.
        if (last <= since && !(future?.at && future.at <= toBusinessDate(now))) return undefined;
      }
      const line = outlet.kind === "depot" ? "depot" : "store";
      const kinds: PriceKind[] = line === "depot" ? ["standard"] : ["general", "partner"];
      const rows = await tx
        .select()
        .from(products)
        .where(and(eq(products.tenantId, outlet.tenantId), eq(products.line, line), eq(products.status, "active")))
        .orderBy(products.sortOrder, products.code);
      const date = toBusinessDate(now);
      const list = [];
      for (const p of rows) {
        const prices: Partial<Record<PriceKind, number>> = {};
        for (const kind of kinds) {
          try {
            prices[kind] = (await resolveProductPrice(tx, { productId: p.id, kind, date, tenantId: outlet.tenantId, outletId })).unitPrice;
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
          }
        }
        list.push({ id: p.id, code: p.code, name: p.name, unit: p.unit, posVisible: p.posVisible, sortOrder: p.sortOrder, gallonSizeL: p.gallonSizeL, isConsumable: p.isConsumable, prices });
      }
      return { outletId, businessDate: date, products: list };
    },
  });

  registerPullProvider("m1.store_partners", {
    roles: ["store_cashier"],
    fetch: async ({ ctx, since, tx }) => {
      if (since) {
        const [c] = await tx.select({ at: max(customers.updatedAt) }).from(customers).where(eq(customers.tenantId, ctx.tenantId));
        if (!c?.at || c.at <= since) return undefined;
      }
      const rows = await tx
        .select({ id: customers.id, code: customers.code, name: customers.name, creditStatus: customers.creditStatus, creditLimit: customers.creditLimit, paymentTermDays: customers.paymentTermDays })
        .from(customers)
        .where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.isStorePartner, true), eq(customers.isActive, true)))
        .orderBy(customers.name);
      return { customers: rows };
    },
  });
}
