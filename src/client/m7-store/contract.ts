/**
 * M7 — KONTRAK data offline POS toko (isomorfik, tanpa API peramban): bentuk data pull `m7.store`, payload perintah
 * sinkron `m7.*`, dan aturan di perangkat yang mencerminkan layanan server (harga mitra/umum, diskon PAR-14, tempo
 * mitra, pencarian barang). Server hanya mengimpor TIPE dari berkas ini.
 *
 * Penjualan, shift, void & setoran toko memakai perintah kerangka POS M6 (`m6.*`, lihat `src/client/m6-pos`).
 */

// =====================================================================================================================
// Data referensi `m7.store`
// =====================================================================================================================

export type StoreCustomerRef = {
  id: string;
  code: string | null;
  name: string;
  waPhone: string | null;
  isStorePartner: boolean;
  creditStatus: "cash" | "credit" | "credit_migrated" | "on_hold" | string;
  creditLimit: number;
  paymentTermDays: number;
  /** Eksposur lintas lini saat sinkron terakhir (tanpa transaksi baru; PTB-42). */
  exposure: number;
};

export type StoreProductRef = {
  id: string;
  code: string;
  name: string;
  unit: string;
  category: string | null;
  barcode: string | null;
  minStock: number | null;
  status: "active" | "pending_approval" | "inactive" | string;
  balance: number;
  prices: Partial<Record<"general" | "partner", number>>;
};

export type StoreSupplierRef = { id: string; code: string | null; name: string; status: string; paymentTermDays: number | null };

export type StoreReorderRef = {
  id: string;
  productId: string;
  name: string;
  unit: string;
  minStock: number | null;
  balance: number;
  avgDailySales: number;
  lastSupplierId: string | null;
  lastSupplierName: string | null;
  status: "open" | "ordered" | "closed" | string;
  orderedAt: string | null;
  orderedSupplierName: string | null;
};

export type StoreCountLineRef = { productId: string; physicalQty: number; systemQty: number; differenceQty: number; reason: string | null };

export type StoreStockCountRef = { id: string; periodLabel: string; status: string; startedAt: string; lines: StoreCountLineRef[] };

export type StoreSaleRef = {
  id: string;
  number: string | null;
  localNumber: string;
  soldAt: string;
  customerId: string | null;
  customerName: string | null;
  paymentMethod: string;
  subtotal: number;
  discountAmount: number;
  total: number;
  status: string;
  creditOffline: boolean;
  invoiceNumber: string | null;
  invoiceDueDate: string | null;
};

export type StoreReceiptRef = {
  id: string;
  number: string | null;
  localNumber: string | null;
  supplierName: string;
  supplierNoteNumber: string | null;
  businessDate: string;
  status: string;
  isSubstituteNote: boolean;
  total: number;
};

export type StoreTransferRef = { id: string; number: string | null; localNumber: string | null; toOutletName: string; status: string; totalValue: number; hasDifference: boolean; sentAt: string };

export type StoreProposalRef = { id: string; type: string; label: string; status: string; createdAt: string; decisionReason: string | null };

export type StoreReference = {
  version: 1;
  generatedAt: string;
  businessDate: string;
  outletId: string;
  rules: { discountMaxPercent: number; creditOfflineAfterMinutes: number; averageSalesDays: number };
  customers: StoreCustomerRef[];
  products: StoreProductRef[];
  suppliers: StoreSupplierRef[];
  depots: { id: string; code: string; name: string }[];
  reorder: StoreReorderRef[];
  openStockCount: StoreStockCountRef | null;
  monthCountDone: boolean;
  recentSales: StoreSaleRef[];
  recentReceipts: StoreReceiptRef[];
  recentTransfers: StoreTransferRef[];
  proposals: StoreProposalRef[];
};

// =====================================================================================================================
// Payload perintah sinkron M7
// =====================================================================================================================

export const M7_COMMANDS = {
  purchaseReceipt: "m7.purchase_receipt.create",
  proposeProduct: "m7.store_product.propose",
  proposePrice: "m7.store_price.propose",
  proposeSupplier: "m7.supplier.create",
  reorderMarkOrdered: "m7.reorder.mark_ordered",
  stockCount: "m7.stock_count.count",
  internalTransfer: "m7.internal_transfer.create",
} as const;

export type PurchaseReceiptPayload = {
  receiptId: string;
  localNumber: string;
  deviceSeq: number;
  supplierId: string;
  isSubstitute: boolean;
  supplierNoteNumber?: string | null;
  supplierNoteDate?: string | null;
  dueDate?: string | null;
  lines: { productId: string; quantity: number; unitCost: number }[];
  totalAmount: number;
  notes?: string | null;
};

export type ProposeProductPayload = {
  productId: string;
  code: string;
  name: string;
  unit: string;
  category?: string | null;
  generalPrice: number;
  partnerPrice: number;
  minStock?: number | null;
  barcode?: string | null;
  notes?: string | null;
};

export type ProposePricePayload = { priceId: string; productId: string; kind: "general" | "partner"; price: number; effectiveFrom: string; reason: string };

export type ProposeSupplierPayload = {
  supplierId: string;
  name: string;
  code?: string | null;
  contactName?: string | null;
  phone?: string | null;
  address?: string | null;
  paymentTermDays?: number | null;
  notes?: string | null;
};

export type MarkOrderedPayload = { itemId: string; supplierId: string; orderedOn?: string | null };

export type StockCountPayload = {
  stockCountId: string;
  lines: { productId: string; physicalQty: number; countedAt?: string | null; reason?: "damaged" | "lost" | "miscount" | "other" | null; reasonNote?: string | null }[];
  notes?: string | null;
};

export type InternalTransferPayload = { transferId: string; localNumber: string; deviceSeq: number; toOutletId: string; lines: { productId: string; quantity: number }[]; notes?: string | null };

// =====================================================================================================================
// Aturan di perangkat (cermin server)
// =====================================================================================================================

/** BR-18: mitra toko → harga mitra; selain itu (termasuk "Umum") harga umum. */
export function storePriceKind(customer: Pick<StoreCustomerRef, "isStorePartner"> | null | undefined): "general" | "partner" {
  return customer?.isStorePartner ? "partner" : "general";
}

/** Diskon melampaui PAR-14 → perlu persetujuan pemilik (perbandingan bilangan bulat, sama dengan server). */
export function discountNeedsApproval(discountAmount: number, subtotal: number, maxPercent: number): boolean {
  return discountAmount * 100 > subtotal * maxPercent;
}

/** Rupiah diskon dari persen (dibulatkan ke rupiah). */
export function discountFromPercent(subtotal: number, percent: number): number {
  return Math.round((subtotal * percent) / 100);
}

export type DeviceCreditCheck =
  | { ok: true; remaining: number }
  | { ok: false; reason: "customer_required" | "not_partner" | "cash_customer" | "on_hold" | "over_limit"; canRequestApproval: boolean; message: string };

/**
 * Pra-periksa tempo di perangkat dengan eksposur sinkron terakhir + tempo toko yang masih di antrean (US-M7-04, PTB-42).
 * Server tetap memutuskan (daring) atau menandai untuk tinjauan Admin Keuangan (offline).
 */
export function deviceCreditCheck(customer: StoreCustomerRef | null | undefined, amount: number, queuedCredit = 0): DeviceCreditCheck {
  if (!customer) return { ok: false, reason: "customer_required", canRequestApproval: false, message: "Pilih pelanggan mitra toko untuk tempo." };
  if (!customer.isStorePartner) return { ok: false, reason: "not_partner", canRequestApproval: false, message: `${customer.name} bukan mitra toko — tempo tidak tersedia.` };
  if (customer.creditStatus === "cash") return { ok: false, reason: "cash_customer", canRequestApproval: true, message: `Status kredit ${customer.name} Tunai — tempo perlu persetujuan pemilik.` };
  if (customer.creditStatus === "on_hold") return { ok: false, reason: "on_hold", canRequestApproval: true, message: `${customer.name} Ditahan (piutang lewat tempo) — tempo perlu persetujuan pemilik.` };
  const exposure = customer.exposure + queuedCredit + amount;
  if (exposure > customer.creditLimit) {
    return { ok: false, reason: "over_limit", canRequestApproval: true, message: `Eksposur ${exposure.toLocaleString("id-ID")} melampaui batas ${customer.creditLimit.toLocaleString("id-ID")} — tempo perlu persetujuan pemilik.` };
  }
  return { ok: true, remaining: customer.creditLimit - exposure };
}

/** Pencarian barang: kode/barcode persis didahulukan, lalu nama/kode memuat kata kunci (US-M7-01 KP-2). */
export function searchStoreProducts(products: readonly StoreProductRef[], query: string, limit = 30): StoreProductRef[] {
  const q = query.trim().toLowerCase();
  const active = products.filter((p) => p.status === "active");
  if (!q) return active.slice(0, limit);
  const exact = active.filter((p) => p.code.toLowerCase() === q || (p.barcode ?? "").toLowerCase() === q);
  const words = q.split(/\s+/).filter(Boolean);
  const partial = active.filter((p) => !exact.includes(p) && words.every((w) => p.name.toLowerCase().includes(w) || p.code.toLowerCase().includes(w)));
  return [...exact, ...partial].slice(0, limit);
}

/** Barang dapat dijual: aktif, berharga untuk jenis harga, stok > 0 (BR-28). */
export function sellable(p: StoreProductRef, kind: "general" | "partner"): { ok: boolean; reason: string | null } {
  if (p.status !== "active") return { ok: false, reason: "Menunggu persetujuan Admin Keuangan" };
  if (typeof p.prices[kind] !== "number") return { ok: false, reason: "Harga belum ditetapkan" };
  if (p.balance <= 0) return { ok: false, reason: "Stok 0 — catat nota penerimaan dulu" };
  return { ok: true, reason: null };
}

/** Label status transaksi toko di perangkat. */
export function storeSaleStatusText(status: string): string {
  switch (status) {
    case "valid":
      return "Sah";
    case "pending_approval":
      return "Menunggu persetujuan pemilik";
    case "rejected":
      return "Ditolak";
    case "voided":
      return "Di-void";
    case "void_pending":
      return "Void menunggu persetujuan";
    default:
      return status;
  }
}

/** Teks struk untuk WA (tautan wa.me; PTB-29). */
export function receiptText(input: {
  companyName: string;
  outletName: string;
  number: string;
  soldAt: string;
  customerName: string | null;
  lines: { name: string; quantity: number; unitPrice: number; lineTotal: number }[];
  subtotal: number;
  discountAmount: number;
  total: number;
  method: string;
  invoiceNumber?: string | null;
  invoiceDueDate?: string | null;
}): string {
  const rp = (n: number) => `Rp ${n.toLocaleString("id-ID")}`;
  const out = [`*${input.companyName}* — ${input.outletName}`, `No. ${input.number}`, input.soldAt];
  if (input.customerName) out.push(`Pelanggan: ${input.customerName}`);
  out.push("");
  for (const l of input.lines) out.push(`${l.name} × ${l.quantity} = ${rp(l.lineTotal)}`);
  if (input.discountAmount > 0) out.push(`Subtotal ${rp(input.subtotal)}`, `Diskon -${rp(input.discountAmount)}`);
  out.push(`*Total ${rp(input.total)}*`, `Cara bayar: ${input.method === "credit" ? "Tempo" : input.method === "qris" ? "QRIS" : "Tunai"}`);
  if (input.method === "credit") out.push(input.invoiceNumber ? `Faktur: ${input.invoiceNumber}${input.invoiceDueDate ? ` (jatuh tempo ${input.invoiceDueDate})` : ""}` : "Faktur: terbit setelah data terkirim");
  out.push("", "Terima kasih");
  return out.join("\n");
}

/** Normalisasi nomor WA Indonesia untuk tautan wa.me (08… → 628…). */
export function waLink(phone: string | null | undefined, text: string): string | null {
  const digits = (phone ?? "").replace(/[^0-9]/g, "");
  if (digits.length < 9) return null;
  const n = digits.startsWith("0") ? `62${digits.slice(1)}` : digits.startsWith("62") ? digits : `62${digits}`;
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}
