/**
 * M6 — pembaruan OPTIMISTIS data `m6.pos` di perangkat (hanya peramban): perintah POS yang masih di antrean diterapkan
 * ulang di atas hasil pull terakhir sehingga layar selalu menampilkan keadaan terbaru walau tanpa sinyal
 * (US-M6-06 KP-1/KP-2). Reducer murni — dapat diuji tanpa IndexedDB (`applyPosCommand`).
 */
import { registerOptimistic, type OutboxItem } from "@/client/offline";

import {
  M6_COMMANDS,
  type CloseShiftPayload,
  type ConfirmSupplyPayload,
  type ConsumableReceiptPayload,
  type OpenShiftPayload,
  type PartialDepositPayload,
  type PosReference,
  type PosSaleRef,
  type PosShiftRef,
  type ReceiveTransferPayload,
  type RecordSalePayload,
  type StockCountPayload,
  type VoidSalePayload,
} from "./contract";

type ItemMeta = Pick<OutboxItem, "userId" | "deviceTime" | "businessDate">;

function withShift(data: PosReference, shiftId: string, fn: (s: PosShiftRef) => PosShiftRef): PosReference {
  return {
    ...data,
    openShift: data.openShift && data.openShift.id === shiftId ? fn(data.openShift) : data.openShift,
    conflictShifts: data.conflictShifts.map((s) => (s.id === shiftId ? fn(s) : s)),
  };
}

/** Terapkan satu perintah POS (murni). Perintah yang tidak dikenal dikembalikan apa adanya. */
export function applyPosCommand(data: PosReference, type: string, payload: unknown, item: ItemMeta, gallonSize: (productId: string) => number | null = () => null): PosReference {
  switch (type) {
    case M6_COMMANDS.shiftOpen: {
      const p = payload as OpenShiftPayload;
      if (data.openShift?.id === p.shiftId || data.conflictShifts.some((s) => s.id === p.shiftId)) return data;
      const shift: PosShiftRef = {
        id: p.shiftId,
        businessDate: item.businessDate,
        openedAt: item.deviceTime,
        operatorUserId: item.userId,
        operatorName: null,
        openingCash: data.settings.fixedOpeningCash,
        openingCashCounted: p.openingCashCounted,
        partialDepositTotal: 0,
        cashLimitAlerted: false,
        syncConflict: !!data.openShift,
        status: "open",
        sales: [],
        openingStock: data.materials.map((m) => ({ productId: m.id, systemQty: m.balance })),
        local: true,
      };
      return data.openShift ? { ...data, conflictShifts: [...data.conflictShifts, shift] } : { ...data, openShift: shift };
    }
    case M6_COMMANDS.saleCreate: {
      const p = payload as RecordSalePayload;
      // Tambahan M7: diskon per transaksi & status menunggu persetujuan pemilik.
      const total = p.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0) - (p.discountAmount ?? 0);
      const sale: PosSaleRef = {
        id: p.saleId,
        number: null,
        localNumber: p.localNumber,
        soldAt: item.deviceTime,
        total,
        paymentMethod: p.paymentMethod,
        cashReceived: p.paymentMethod === "cash" ? (p.cashReceived ?? total) : null,
        changeAmount: p.paymentMethod === "cash" ? (p.cashReceived ?? total) - total : null,
        qrisReference: p.qrisReference ?? null,
        status: p.requestApproval ? "pending_approval" : "valid",
        voidReason: null,
        priceMismatch: false,
        isReversal: false,
        reversalReason: null,
        replacesSaleId: p.replacesSaleId ?? null,
        lines: p.lines.map((l) => ({ ...l, lineTotal: l.quantity * l.unitPrice, gallonSizeL: gallonSize(l.productId) })),
        local: true,
      };
      return withShift(data, p.shiftId, (s) => (s.sales.some((x) => x.id === sale.id) ? s : { ...s, sales: [...s.sales, sale] }));
    }
    case M6_COMMANDS.saleVoid: {
      const p = payload as VoidSalePayload;
      const mark = (s: PosShiftRef): PosShiftRef => ({
        ...s,
        sales: s.sales.map((x) =>
          x.id === p.saleId && x.status === "valid"
            ? { ...x, status: x.total > data.settings.voidApprovalAbove ? "void_pending" : "voided", voidReason: p.reason, local: true }
            : x,
        ),
      });
      const hit = [data.openShift, ...data.conflictShifts].find((s) => s?.sales.some((x) => x.id === p.saleId));
      return {
        ...(hit ? withShift(data, hit.id, mark) : data),
        voidsToday: data.voidsToday + (hit ? 1 : 0),
      };
    }
    case M6_COMMANDS.partialDeposit: {
      const p = payload as PartialDepositPayload;
      return withShift(data, p.shiftId, (s) => ({ ...s, partialDepositTotal: s.partialDepositTotal + p.amount, cashLimitAlerted: false }));
    }
    case M6_COMMANDS.shiftClose: {
      const p = payload as CloseShiftPayload;
      const closing = [data.openShift, ...data.conflictShifts].find((s) => s?.id === p.shiftId);
      if (!closing) return data;
      const usage: Record<string, number> = {};
      for (const sale of closing.sales) {
        if (!(sale.status === "valid" || sale.status === "void_pending")) continue;
        for (const l of sale.lines) {
          for (const r of data.recipes) if (r.productId === l.productId) usage[r.materialProductId] = (usage[r.materialProductId] ?? 0) + l.quantity * r.quantity;
        }
      }
      return {
        ...data,
        openShift: data.openShift?.id === p.shiftId ? null : data.openShift,
        conflictShifts: data.conflictShifts.filter((s) => s.id !== p.shiftId),
        lastClosedShift: { id: p.shiftId, businessDate: closing.businessDate, closedAt: item.deviceTime, depositStatus: "not_deposited", depositAmount: null },
        materials: data.materials.map((m) => ({ ...m, balance: m.balance - (usage[m.id] ?? 0) })),
      };
    }
    case M6_COMMANDS.supplyConfirm: {
      const p = payload as ConfirmSupplyPayload;
      if (!data.water) return data;
      return {
        ...data,
        water: { ...data.water, stockL: data.water.stockL + p.receivedVolumeL, pending: data.water.pending.filter((x) => x.id !== p.receiptId) },
      };
    }
    case M6_COMMANDS.supplyOther: {
      const p = payload as { volumeL: number };
      if (!data.water) return data;
      return { ...data, water: { ...data.water, stockL: data.water.stockL + p.volumeL } };
    }
    case M6_COMMANDS.consumableReceipt: {
      const p = payload as ConsumableReceiptPayload;
      return {
        ...data,
        materials: data.materials.map((m) => ({ ...m, balance: m.balance + p.lines.filter((l) => l.productId === m.id).reduce((s, l) => s + l.quantity, 0) })),
      };
    }
    case M6_COMMANDS.transferReceive: {
      const p = payload as ReceiveTransferPayload;
      return { ...data, transfers: data.transfers.filter((t) => t.id !== p.transferId) };
    }
    case M6_COMMANDS.stockCount: {
      const p = payload as StockCountPayload;
      return { ...data, stockCountThisWeek: { id: p.stockCountId, status: "submitted", periodLabel: data.stockCountThisWeek?.periodLabel ?? "", startedAt: item.deviceTime } };
    }
    default:
      return data;
  }
}

let registered = false;
const gallonSizes = new Map<string, number | null>();

/** Ukuran galon per produk dari katalog perangkat (untuk transaksi yang belum terkirim). */
export function setPosGallonSizes(entries: Iterable<[string, number | null]>): void {
  for (const [id, size] of entries) gallonSizes.set(id, size);
}

/** Daftarkan reducer optimistis M6 (sekali per halaman). */
export function registerPosOptimistic(): void {
  if (registered) return;
  registered = true;
  for (const type of Object.values(M6_COMMANDS)) {
    registerOptimistic<PosReference, unknown>(type, {
      refKey: "m6.pos",
      apply: (data, payload, item) => (data ? applyPosCommand(data, type, payload, item, (id) => gallonSizes.get(id) ?? null) : data),
    });
  }
}
