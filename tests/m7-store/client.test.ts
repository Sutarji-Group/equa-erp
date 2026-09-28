import { describe, expect, it } from "vitest";

import { applyPosCommand } from "@/client/m6-pos/optimistic";
import type { PosReference } from "@/client/m6-pos/contract";
import { applyStoreCommand } from "@/client/m7-store/optimistic";
import {
  deviceCreditCheck,
  discountFromPercent,
  discountNeedsApproval,
  receiptText,
  searchStoreProducts,
  sellable,
  storePriceKind,
  waLink,
  type StoreCustomerRef,
  type StoreProductRef,
  type StoreReference,
} from "@/client/m7-store/contract";

const products: StoreProductRef[] = [
  { id: "a", code: "TK-TUTUP", name: "Tutup galon", unit: "pcs", category: null, barcode: "899001", minStock: 500, status: "active", balance: 800, prices: { general: 800, partner: 600 } },
  { id: "b", code: "TK-TISU", name: "Tisu segel galon", unit: "pcs", category: null, barcode: null, minStock: 500, status: "active", balance: 0, prices: { general: 400, partner: 300 } },
  { id: "c", code: "TK-GAYUNG", name: "Gayung plastik", unit: "pcs", category: null, barcode: null, minStock: 5, status: "pending_approval", balance: 3, prices: {} },
  { id: "d", code: "TK-SABUN", name: "Sabun cuci galon 1 L", unit: "botol", category: null, barcode: null, minStock: 6, status: "active", balance: 10, prices: { general: 30_000 } },
];

const partner: StoreCustomerRef = { id: "p", code: "PLG-0001", name: "Depot Tirta", waPhone: "081234567890", isStorePartner: true, creditStatus: "credit", creditLimit: 3_000_000, paymentTermDays: 14, exposure: 2_000_000 };

describe("US-M7-01 aturan POS toko di perangkat (cermin server)", () => {
  it("US-M7-01 KP-2 pencarian barang nama/kode/barcode (pindai barcode = kode persis), hanya barang aktif", () => {
    expect(searchStoreProducts(products, "899001").map((p) => p.id)).toEqual(["a"]);
    expect(searchStoreProducts(products, "tk-tisu").map((p) => p.id)).toEqual(["b"]);
    expect(searchStoreProducts(products, "galon").map((p) => p.id)).toEqual(["a", "b", "d"]);
    expect(searchStoreProducts(products, "tutup galon").map((p) => p.id)).toEqual(["a"]);
    expect(searchStoreProducts(products, "gayung")).toHaveLength(0);
  });

  it("US-M7-01 KP-1 jenis harga dari penanda mitra toko (kasir tidak memilih harga)", () => {
    expect(storePriceKind(partner)).toBe("partner");
    expect(storePriceKind({ isStorePartner: false })).toBe("general");
    expect(storePriceKind(null)).toBe("general");
  });

  it("US-M7-01 KP-3 diskon > PAR-14 perlu persetujuan (perbandingan bulat sama dengan server)", () => {
    expect(discountNeedsApproval(7_500, 150_000, 5)).toBe(false);
    expect(discountNeedsApproval(7_501, 150_000, 5)).toBe(true);
    expect(discountFromPercent(150_000, 10)).toBe(15_000);
  });

  it("US-M7-01 KP-4 barang stok 0, belum disetujui, atau tanpa harga tidak dapat dijual", () => {
    expect(sellable(products[0]!, "partner").ok).toBe(true);
    expect(sellable(products[1]!, "general").reason).toMatch(/Stok 0/);
    expect(sellable(products[2]!, "general").reason).toMatch(/persetujuan/);
    expect(sellable(products[3]!, "partner").reason).toMatch(/Harga/);
  });

  it("US-M7-01 KP-6 struk WA menyebut nomor faktur tempo (setelah terbit) dan tautan wa.me", () => {
    const text = receiptText({
      companyName: "EQUA",
      outletName: "Toko EQUA Cianjur",
      number: "TK1-260928-0007",
      soldAt: "28 Sep 2026 10.00",
      customerName: "Depot Tirta",
      lines: [{ name: "Tutup galon", quantity: 100, unitPrice: 600, lineTotal: 60_000 }],
      subtotal: 60_000,
      discountAmount: 3_000,
      total: 57_000,
      method: "credit",
      invoiceNumber: "F-26-000123",
      invoiceDueDate: "2026-10-12",
    });
    expect(text).toMatch(/Faktur: F-26-000123/);
    expect(text).toMatch(/Diskon -Rp 3\.000/);
    expect(waLink("081234567890", text)).toMatch(/^https:\/\/wa\.me\/6281234567890\?text=/);
    expect(waLink(null, text)).toBeNull();
  });
});

describe("US-M7-04 tempo di perangkat (PTB-42)", () => {
  it("US-M7-04 KP-4 pra-periksa tempo memakai eksposur sinkron terakhir + tempo yang masih di antrean", () => {
    expect(deviceCreditCheck(partner, 500_000)).toMatchObject({ ok: true, remaining: 500_000 });
    expect(deviceCreditCheck(partner, 500_000, 600_000)).toMatchObject({ ok: false, reason: "over_limit", canRequestApproval: true });
    expect(deviceCreditCheck({ ...partner, creditStatus: "on_hold" }, 1)).toMatchObject({ ok: false, reason: "on_hold" });
    expect(deviceCreditCheck({ ...partner, creditStatus: "cash" }, 1)).toMatchObject({ ok: false, reason: "cash_customer" });
    expect(deviceCreditCheck({ ...partner, isStorePartner: false }, 1)).toMatchObject({ ok: false, reason: "not_partner", canRequestApproval: false });
    expect(deviceCreditCheck(null, 1)).toMatchObject({ ok: false, reason: "customer_required" });
  });
});

describe("Optimistis POS toko (offline)", () => {
  const baseRef: StoreReference = {
    version: 1,
    generatedAt: new Date().toISOString(),
    businessDate: "2026-09-28",
    outletId: "o",
    rules: { discountMaxPercent: 5, creditOfflineAfterMinutes: 5, averageSalesDays: 30 },
    customers: [partner],
    products,
    suppliers: [],
    depots: [],
    reorder: [],
    openStockCount: null,
    monthCountDone: false,
    recentSales: [],
    recentReceipts: [],
    recentTransfers: [],
    proposals: [],
  };
  const item = { userId: "u", deviceTime: new Date().toISOString(), businessDate: "2026-09-28" };

  it("US-M7-01 KP-4 penjualan di antrean mengurangi saldo barang di perangkat; nota menambah; transfer mengurangi", () => {
    let ref = applyStoreCommand(baseRef, "m6.pos_sale.create", { saleId: "s1", shiftId: "sh", localNumber: "X", deviceSeq: 1, lines: [{ productId: "a", quantity: 100, unitPrice: 600 }], paymentMethod: "credit", customerId: "p" }, item);
    expect(ref.products.find((p) => p.id === "a")?.balance).toBe(700);
    expect(ref.recentSales[0]).toMatchObject({ id: "s1", status: "valid", paymentMethod: "credit", customerName: "Depot Tirta" });
    ref = applyStoreCommand(ref, "m7.purchase_receipt.create", { receiptId: "r1", localNumber: "N", deviceSeq: 1, supplierId: "x", isSubstitute: false, lines: [{ productId: "b", quantity: 50, unitCost: 200 }], totalAmount: 10_000 }, item);
    expect(ref.products.find((p) => p.id === "b")?.balance).toBe(50);
    // Nota pengganti tidak menambah stok (belum diterima Admin Keuangan).
    ref = applyStoreCommand(ref, "m7.purchase_receipt.create", { receiptId: "r2", localNumber: "N2", deviceSeq: 2, supplierId: "x", isSubstitute: true, lines: [{ productId: "b", quantity: 5, unitCost: 200 }], totalAmount: 1_000 }, item);
    expect(ref.products.find((p) => p.id === "b")?.balance).toBe(50);
    ref = applyStoreCommand(ref, "m7.internal_transfer.create", { transferId: "t1", localNumber: "T", deviceSeq: 1, toOutletId: "d", lines: [{ productId: "b", quantity: 20 }] }, item);
    expect(ref.products.find((p) => p.id === "b")?.balance).toBe(30);
    // Diskon di atas batas: tercatat menunggu persetujuan di kerangka M6 (tidak dihitung) dan stok tidak berkurang.
    const pos = { openShift: { id: "sh", sales: [] as unknown[] } } as unknown as PosReference;
    const next = applyPosCommand({ ...pos, conflictShifts: [], settings: { voidApprovalAbove: 100_000 } } as unknown as PosReference, "m6.pos_sale.create", { saleId: "s2", shiftId: "sh", localNumber: "Y", deviceSeq: 2, lines: [{ productId: "a", quantity: 1, unitPrice: 800 }], paymentMethod: "cash", discountAmount: 100, discountReason: "x", requestApproval: true }, item);
    expect(next.openShift!.sales[0]).toMatchObject({ status: "pending_approval", total: 700 });
    ref = applyStoreCommand(ref, "m6.pos_sale.create", { saleId: "s2", shiftId: "sh", localNumber: "Y", deviceSeq: 2, lines: [{ productId: "a", quantity: 1, unitPrice: 800 }], paymentMethod: "cash", requestApproval: true }, item);
    expect(ref.products.find((p) => p.id === "a")?.balance).toBe(700);
  });
});
