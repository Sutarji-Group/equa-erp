/**
 * M7 — pembaruan OPTIMISTIS data `m7.store` di perangkat (hanya peramban): perintah toko yang masih di antrean
 * diterapkan ulang di atas pull terakhir — saldo barang (jual, nota, transfer), transaksi hari ini, nota & transfer
 * terbaru, lembar opname, usulan. Reducer murni `applyStoreCommand` (diuji tanpa IndexedDB).
 */
import { registerOptimistic, type OutboxItem } from "@/client/offline";

import type { RecordSalePayload } from "@/client/m6-pos/contract";

import {
  M7_COMMANDS,
  type InternalTransferPayload,
  type MarkOrderedPayload,
  type ProposePricePayload,
  type ProposeProductPayload,
  type ProposeSupplierPayload,
  type PurchaseReceiptPayload,
  type StockCountPayload,
  type StoreReference,
} from "./contract";

type ItemMeta = Pick<OutboxItem, "userId" | "deviceTime" | "businessDate">;

function adjustBalances(data: StoreReference, deltas: { productId: string; quantity: number }[]): StoreReference {
  const by = new Map<string, number>();
  for (const d of deltas) by.set(d.productId, (by.get(d.productId) ?? 0) + d.quantity);
  return { ...data, products: data.products.map((p) => (by.has(p.id) ? { ...p, balance: p.balance + by.get(p.id)! } : p)) };
}

/** Terapkan satu perintah toko (murni). Perintah lain dikembalikan apa adanya. */
export function applyStoreCommand(data: StoreReference, type: string, payload: unknown, item: ItemMeta): StoreReference {
  switch (type) {
    case "m6.pos_sale.create": {
      const p = payload as RecordSalePayload;
      if (data.recentSales.some((s) => s.id === p.saleId)) return data;
      const subtotal = p.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
      const pending = !!p.requestApproval;
      const next = pending ? data : adjustBalances(data, p.lines.map((l) => ({ productId: l.productId, quantity: -l.quantity })));
      const customer = p.customerId ? data.customers.find((c) => c.id === p.customerId) : null;
      return {
        ...next,
        recentSales: [
          {
            id: p.saleId,
            number: null,
            localNumber: p.localNumber,
            soldAt: item.deviceTime,
            customerId: p.customerId ?? null,
            customerName: customer?.name ?? null,
            paymentMethod: p.paymentMethod,
            subtotal,
            discountAmount: p.discountAmount ?? 0,
            total: subtotal - (p.discountAmount ?? 0),
            status: pending ? "pending_approval" : "valid",
            creditOffline: !!p.creditOffline,
            invoiceNumber: null,
            invoiceDueDate: null,
          },
          ...next.recentSales,
        ],
      };
    }
    case M7_COMMANDS.purchaseReceipt: {
      const p = payload as PurchaseReceiptPayload;
      if (data.recentReceipts.some((r) => r.id === p.receiptId)) return data;
      const next = p.isSubstitute ? data : adjustBalances(data, p.lines);
      const sup = data.suppliers.find((s) => s.id === p.supplierId);
      return {
        ...next,
        reorder: p.isSubstitute ? next.reorder : next.reorder.filter((r) => !p.lines.some((l) => l.productId === r.productId)),
        recentReceipts: [
          {
            id: p.receiptId,
            number: null,
            localNumber: p.localNumber,
            supplierName: sup?.name ?? "Pemasok",
            supplierNoteNumber: p.supplierNoteNumber ?? null,
            businessDate: item.businessDate,
            status: p.isSubstitute ? "pending_acceptance" : "received",
            isSubstituteNote: p.isSubstitute,
            total: p.totalAmount,
          },
          ...next.recentReceipts,
        ],
      };
    }
    case M7_COMMANDS.internalTransfer: {
      const p = payload as InternalTransferPayload;
      if (data.recentTransfers.some((t) => t.id === p.transferId)) return data;
      const next = adjustBalances(data, p.lines.map((l) => ({ productId: l.productId, quantity: -l.quantity })));
      const depot = data.depots.find((d) => d.id === p.toOutletId);
      const value = p.lines.reduce((s, l) => s + l.quantity * (data.products.find((x) => x.id === l.productId)?.prices.partner ?? 0), 0);
      return {
        ...next,
        recentTransfers: [
          { id: p.transferId, number: null, localNumber: p.localNumber, toOutletName: depot?.name ?? "Depot", status: "sent", totalValue: value, hasDifference: false, sentAt: item.deviceTime },
          ...next.recentTransfers,
        ],
      };
    }
    case M7_COMMANDS.stockCount: {
      const p = payload as StockCountPayload;
      const current = data.openStockCount?.id === p.stockCountId ? data.openStockCount : { id: p.stockCountId, periodLabel: item.businessDate.slice(0, 7), status: "counting", startedAt: item.deviceTime, lines: [] };
      const lines = [...current.lines];
      for (const l of p.lines) {
        const systemQty = data.products.find((x) => x.id === l.productId)?.balance ?? 0;
        const row = { productId: l.productId, physicalQty: l.physicalQty, systemQty, differenceQty: l.physicalQty - systemQty, reason: l.reason ?? null };
        const idx = lines.findIndex((x) => x.productId === l.productId);
        if (idx >= 0) lines[idx] = row;
        else lines.push(row);
      }
      return { ...data, openStockCount: { ...current, lines } };
    }
    case M7_COMMANDS.reorderMarkOrdered: {
      const p = payload as MarkOrderedPayload;
      const sup = data.suppliers.find((s) => s.id === p.supplierId);
      return { ...data, reorder: data.reorder.map((r) => (r.id === p.itemId ? { ...r, status: "ordered", orderedAt: item.deviceTime, orderedSupplierName: sup?.name ?? null } : r)) };
    }
    case M7_COMMANDS.proposeSupplier: {
      const p = payload as ProposeSupplierPayload;
      if (data.suppliers.some((s) => s.id === p.supplierId)) return data;
      return {
        ...data,
        suppliers: [...data.suppliers, { id: p.supplierId, code: p.code ?? null, name: p.name, status: "pending_approval", paymentTermDays: p.paymentTermDays ?? null }],
        proposals: [{ id: p.supplierId, type: "supplier", label: `Pemasok baru: ${p.name}`, status: "submitted", createdAt: item.deviceTime, decisionReason: null }, ...data.proposals],
      };
    }
    case M7_COMMANDS.proposeProduct: {
      const p = payload as ProposeProductPayload;
      if (data.products.some((x) => x.id === p.productId)) return data;
      return {
        ...data,
        products: [
          ...data.products,
          { id: p.productId, code: p.code.toUpperCase(), name: p.name, unit: p.unit, category: p.category ?? null, barcode: p.barcode ?? null, minStock: p.minStock ?? null, status: "pending_approval", balance: 0, prices: {} },
        ],
        proposals: [{ id: p.productId, type: "store_product", label: `Barang baru: ${p.name}`, status: "submitted", createdAt: item.deviceTime, decisionReason: null }, ...data.proposals],
      };
    }
    case M7_COMMANDS.proposePrice: {
      const p = payload as ProposePricePayload;
      if (data.proposals.some((x) => x.id === p.priceId)) return data;
      const name = data.products.find((x) => x.id === p.productId)?.name ?? "barang";
      return {
        ...data,
        proposals: [{ id: p.priceId, type: "store_product", label: `Harga ${p.kind === "partner" ? "mitra" : "umum"} ${name}`, status: "submitted", createdAt: item.deviceTime, decisionReason: null }, ...data.proposals],
      };
    }
    default:
      return data;
  }
}

let registered = false;

/** Daftarkan reducer optimistis M7 (sekali per halaman). */
export function registerStoreOptimistic(): void {
  if (registered) return;
  registered = true;
  for (const type of ["m6.pos_sale.create", ...Object.values(M7_COMMANDS)]) {
    registerOptimistic<StoreReference, unknown>(type, {
      refKey: "m7.store",
      apply: (data, payload, item) => (data ? applyStoreCommand(data, type, payload, item) : data),
    });
  }
}
