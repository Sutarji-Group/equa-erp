/**
 * M6 — KONTRAK data offline POS (isomorfik, tanpa API peramban): bentuk data referensi pull `m6.pos`, payload
 * perintah sinkron `m6.*`, dan perhitungan "seharusnya" di perangkat yang mencerminkan layanan server
 * (src/server/modules/m6-pos/service/figures.ts). Server hanya mengimpor TIPE dari berkas ini.
 */

// =====================================================================================================================
// Data referensi `m6.pos`
// =====================================================================================================================

export type PosSaleStatus = "valid" | "void_pending" | "voided" | "rejected" | "pending_approval";

export type PosSaleRef = {
  id: string;
  number: string | null;
  localNumber: string;
  soldAt: string;
  total: number;
  paymentMethod: "cash" | "qris" | string;
  cashReceived: number | null;
  changeAmount: number | null;
  qrisReference: string | null;
  status: PosSaleStatus;
  voidReason: string | null;
  priceMismatch: boolean;
  isReversal: boolean;
  reversalReason: string | null;
  replacesSaleId: string | null;
  lines: { productId: string; quantity: number; unitPrice: number; lineTotal: number; gallonSizeL: number | null }[];
  /** Status lokal (optimistis) — belum terkirim ke server. */
  local?: boolean;
};

export type PosShiftRef = {
  id: string;
  businessDate: string;
  openedAt: string;
  operatorUserId: string;
  operatorName: string | null;
  openingCash: number;
  openingCashCounted: number | null;
  partialDepositTotal: number;
  cashLimitAlerted: boolean;
  syncConflict: boolean;
  status: "open" | "closed";
  sales: PosSaleRef[];
  /** Saldo bahan saat shift dibuka (stok awal, tampil tidak diketik). */
  openingStock: { productId: string; systemQty: number }[];
  local?: boolean;
};

export type PosMaterialRef = { id: string; code: string; name: string; unit: string; balance: number };

export type PosWaterSupplyRef = {
  id: string;
  tripId: string | null;
  tripNumber: string | null;
  deliveredVolumeL: number | null;
  arrivedAt: string;
  businessDate: string;
  status: string;
};

export type PosTransferRef = {
  id: string;
  number: string | null;
  localNumber: string | null;
  sentAt: string;
  fromOutletName: string;
  lines: { lineId: string; productName: string; quantitySent: number; unit: string }[];
};

export type PosHistoryRef = {
  shiftId: string;
  businessDate: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  salesTotal: number;
  gallonsSold: number;
  cashDifference: number | null;
  cashDifferenceReason: string | null;
  depositAmount: number | null;
  depositStatus: string;
  depositReceivedAmount: number | null;
  depositDiscrepancy: number | null;
  depositNumber: string | null;
  stockDifferences: { name: string; difference: number | null }[];
};

export type PosSettingsRef = {
  fixedOpeningCash: number;
  cashLimit: number;
  voidApprovalAbove: number;
  voidDailyCount: number;
  stockTolerance: number;
  gridMax: number;
  maxSaleLines: number;
  maxQuantityPerLine: number;
  qrisEnabled: boolean;
  printerEnabled: boolean;
};

export type PosReference = {
  version: 1;
  generatedAt: string;
  businessDate: string;
  outlet: { id: string; code: string; name: string; kind: "depot" | "store"; tenantId: string; storageCapacityL: number | null } | null;
  companyName: string;
  settings: PosSettingsRef;
  openShift: PosShiftRef | null;
  /** Shift terbuka lain (konflik perangkat cadangan) di outlet ini. */
  conflictShifts: PosShiftRef[];
  lastClosedShift: { id: string; businessDate: string; closedAt: string | null; depositStatus: string; depositAmount: number | null } | null;
  materials: PosMaterialRef[];
  recipes: { productId: string; materialProductId: string; quantity: number }[];
  water: { stockL: number; capacityL: number | null; overCapacity: boolean; pending: PosWaterSupplyRef[] } | null;
  transfers: PosTransferRef[];
  stockCountThisWeek: { id: string; status: string; periodLabel: string; startedAt: string } | null;
  history: PosHistoryRef[];
  /** Void menunggu persetujuan/hari ini untuk ambang PAR-03 di perangkat. */
  voidsToday: number;
};

/** Data katalog M1 (`m1.catalog`) yang dipakai POS. */
export type CatalogRef = {
  outletId: string | null;
  businessDate?: string;
  products: {
    id: string;
    code: string;
    name: string;
    unit: string;
    posVisible: boolean;
    sortOrder: number;
    gallonSizeL: number | null;
    isConsumable: boolean;
    prices: Partial<Record<"standard" | "general" | "partner", number>>;
  }[];
};

// =====================================================================================================================
// Payload perintah sinkron
// =====================================================================================================================

export type OpenShiftPayload = { shiftId: string; outletId?: string | null; openingCashCounted: number; openingNote?: string | null };
export type SaleLinePayload = { productId: string; quantity: number; unitPrice: number };
export type RecordSalePayload = {
  saleId: string;
  shiftId: string;
  outletId?: string | null;
  localNumber: string;
  deviceSeq: number;
  lines: SaleLinePayload[];
  /** `credit` = tempo mitra (toko M7). */
  paymentMethod: "cash" | "qris" | "credit";
  cashReceived?: number | null;
  qrisReference?: string | null;
  receiptPrinted?: boolean;
  replacesSaleId?: string | null;
  // --- Tambahan M7 (toko) ---
  customerId?: string | null;
  discountAmount?: number;
  discountReason?: string | null;
  /** Perangkat tahu transaksi ini perlu persetujuan pemilik (diskon > PAR-14 / tempo di luar kontrol kredit). */
  requestApproval?: boolean;
  creditOffline?: boolean;
};
export type VoidSalePayload = { saleId: string; reason: "wrong_product" | "wrong_quantity" | "customer_cancelled" | "wrong_payment_method" | "other"; note?: string | null };
export type CloseShiftPayload = {
  shiftId: string;
  closingCashCounted: number;
  cashDifferenceReason?: string | null;
  stock: { productId: string; physicalQty: number; reason?: string | null; deviceExpectedQty?: number | null }[];
  saleIds: string[];
  voidedSaleIds: string[];
  deviceExpectedDrawer?: number | null;
};
export type PartialDepositPayload = { depositId: string; shiftId: string; amount: number; note?: string | null };
export type SubmitDepositPayload = { shiftId: string; method: "physical" | "bank_slip"; note?: string | null };
export type ConfirmSupplyPayload = { receiptId: string; receivedVolumeL: number; reason?: string | null };
export type OtherSupplyPayload = { receiptId: string; volumeL: number; reason: string; sourceNote?: string | null };
export type ConsumableReceiptPayload = {
  receiptId: string;
  source: "supplier" | "other";
  supplierName?: string | null;
  supplierNoteNumber?: string | null;
  lines: { productId: string; quantity: number; unitCost?: number | null }[];
  notes?: string | null;
};
export type ReceiveTransferPayload = { transferId: string; receiptId: string; lines: { lineId: string; quantityReceived: number; reason?: string | null }[]; notes?: string | null };
export type StockCountPayload = {
  stockCountId: string;
  lines: { productId: string; physicalQty: number; reason?: "damaged" | "lost" | "miscount" | "other" | null; reasonNote?: string | null }[];
  notes?: string | null;
};

/** Jenis perintah sinkron M6. */
export const M6_COMMANDS = {
  shiftOpen: "m6.shift.open",
  shiftClose: "m6.shift.close",
  saleCreate: "m6.pos_sale.create",
  saleVoid: "m6.pos_sale.void",
  partialDeposit: "m6.shift_deposit.partial",
  submitDeposit: "m6.shift_deposit.submit",
  supplyConfirm: "m6.water_supply.confirm",
  supplyOther: "m6.water_supply.record_other",
  consumableReceipt: "m6.consumable_receipt.create",
  transferReceive: "m6.internal_transfer.receive",
  stockCount: "m6.stock_count.submit",
} as const;

// =====================================================================================================================
// Perhitungan di perangkat (cermin server)
// =====================================================================================================================

/** Transaksi dihitung sebagai penjualan (sah + menunggu persetujuan void, PTB-43). */
export function saleCounts(s: Pick<PosSaleRef, "status" | "isReversal" | "reversalReason">): boolean {
  return s.isReversal || s.status === "valid" || s.status === "void_pending" || (s.status === "voided" && !!s.reversalReason);
}

export type DeviceShiftFigures = {
  salesTotal: number;
  cashSales: number;
  qrisSales: number;
  qrisCount: number;
  voidCount: number;
  voidAmount: number;
  voidPendingCount: number;
  expectedCash: number;
  expectedDrawer: number;
  depositAmount: number;
  gallonsSold: number;
  byProduct: { productId: string; quantity: number; amount: number }[];
  usage: Record<string, number>;
};

/** Angka shift di perangkat: tunai seharusnya, kas di laci, setoran, pemakaian bahan dari resep. */
export function deviceShiftFigures(shift: Pick<PosShiftRef, "openingCash" | "partialDepositTotal" | "sales">, recipes: PosReference["recipes"]): DeviceShiftFigures {
  const counted = shift.sales.filter(saleCounts);
  const f: DeviceShiftFigures = {
    salesTotal: 0,
    cashSales: 0,
    qrisSales: 0,
    qrisCount: 0,
    voidCount: 0,
    voidAmount: 0,
    voidPendingCount: 0,
    expectedCash: 0,
    expectedDrawer: 0,
    depositAmount: 0,
    gallonsSold: 0,
    byProduct: [],
    usage: {},
  };
  for (const s of shift.sales) {
    if (!s.isReversal && s.status === "voided" && !s.reversalReason) {
      f.voidCount++;
      f.voidAmount += s.total;
    }
    if (s.status === "void_pending") f.voidPendingCount++;
  }
  const agg = new Map<string, { productId: string; quantity: number; amount: number }>();
  for (const s of counted) {
    f.salesTotal += s.total;
    if (s.paymentMethod === "cash") f.cashSales += s.total;
    if (s.paymentMethod === "qris") {
      f.qrisSales += s.total;
      f.qrisCount++;
    }
    for (const l of s.lines) {
      const cur = agg.get(l.productId) ?? { productId: l.productId, quantity: 0, amount: 0 };
      cur.quantity += l.quantity;
      cur.amount += l.lineTotal;
      agg.set(l.productId, cur);
      if (l.gallonSizeL) f.gallonsSold += l.quantity;
      for (const r of recipes) {
        if (r.productId === l.productId) f.usage[r.materialProductId] = (f.usage[r.materialProductId] ?? 0) + l.quantity * r.quantity;
      }
    }
  }
  f.byProduct = [...agg.values()];
  f.expectedCash = shift.openingCash + f.cashSales;
  f.expectedDrawer = f.expectedCash - shift.partialDepositTotal;
  f.depositAmount = f.expectedCash - shift.openingCash - shift.partialDepositTotal;
  return f;
}

/** Stok seharusnya saat tutup shift per bahan = saldo sistem − pemakaian shift. */
export function expectedClosingStock(materials: readonly PosMaterialRef[], usage: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of materials) out[m.id] = m.balance - (usage[m.id] ?? 0);
  return out;
}

/** Void perlu persetujuan pemilik (> PAR-04)? */
export function voidNeedsApproval(total: number, settings: Pick<PosSettingsRef, "voidApprovalAbove">): boolean {
  return total > settings.voidApprovalAbove;
}

/** Selisih di luar toleransi PAR-58 → alasan wajib. */
export function stockReasonRequired(difference: number, tolerance: number): boolean {
  return Math.abs(difference) > tolerance;
}

/** Produk kisi POS: tampil di POS, berharga, urut, maksimal N tombol (US-M6-01 KP-1). */
export function gridProducts(catalog: CatalogRef | undefined, priceKind: "standard" | "general" | "partner", max: number) {
  return (catalog?.products ?? [])
    .filter((p) => p.posVisible && typeof p.prices[priceKind] === "number")
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
    .slice(0, max)
    .map((p) => ({ id: p.id, name: p.name, price: p.prices[priceKind]!, unitLabel: p.unit, gallonSizeL: p.gallonSizeL }));
}

/** Teks status per transaksi di perangkat (US-M6-06 KP-2). */
export function saleStatusText(s: Pick<PosSaleRef, "status" | "local">): string {
  const base =
    s.status === "voided"
      ? "Di-void"
      : s.status === "void_pending"
        ? "Void menunggu persetujuan"
        : s.status === "valid"
          ? "Sah"
          : s.status === "pending_approval"
            ? "Menunggu persetujuan pemilik"
            : s.status === "rejected"
              ? "Ditolak"
              : s.status;
  return s.local ? `${base} · tersimpan di perangkat` : `${base} · terkirim`;
}
