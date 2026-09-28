import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, customers, deposits, domainEvents, invoices, posSaleLines, posSales, products, shifts, stockLedger } from "@/db/schema";
import { customerId, EQUA_TENANT_ID } from "@/db/seed";
import { deviceShiftFigures, type PosReference } from "@/client/m6-pos/contract";
import type { StoreReference } from "@/client/m7-store/contract";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { withNow } from "@/server/core/context";
import { discountReport, recordStoreReturn, storeCreditExposure, storeShiftsBlockingCashClose } from "@/server/modules/m7-store";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import {
  balanceOf,
  closeVia,
  expectApplied,
  expectRejected,
  finance,
  GENERAL,
  makeStore,
  notificationsFor,
  openShiftVia,
  owner,
  PARTNER,
  sellVia,
  SP,
  stockUp,
} from "./helpers";

const PARTNER_TEMPO = customerId("PLG-0001"); // mitra toko, status Tempo
const PARTNER_CASH = customerId("PLG-0002"); // mitra toko, status Tunai
const PARTNER_HOLD = customerId("PLG-0003"); // mitra toko (diubah Ditahan di uji)
const NON_PARTNER = customerId("PLG-0004"); // bukan mitra toko

async function saleRow(db: ReturnType<typeof useTestDb>["db"], id: string) {
  const [row] = await db.select().from(posSales).where(eq(posSales.id, id));
  return row!;
}

describe("US-M7-01 POS toko dengan harga mitra dan umum", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M7-01 KP-1 mitra toko otomatis harga mitra, lainnya/umum harga umum; harga perangkat berbeda ditandai (kasir tidak memilih harga)", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.GALON, quantity: 10, unitCost: 30_000 }]);
    const shiftId = await openShiftVia(pos);
    const umum = await sellVia(pos, shiftId, [{ productId: SP.GALON, quantity: 1, unitPrice: GENERAL.GALON }]);
    expectApplied(umum.res);
    const mitra = await sellVia(pos, shiftId, [{ productId: SP.GALON, quantity: 1, unitPrice: PARTNER.GALON }], { customerId: PARTNER_TEMPO });
    expectApplied(mitra.res);
    const nonMitra = await sellVia(pos, shiftId, [{ productId: SP.GALON, quantity: 1, unitPrice: PARTNER.GALON }], { customerId: NON_PARTNER });
    expectApplied(nonMitra.res);
    const mitraHargaUmum = await sellVia(pos, shiftId, [{ productId: SP.GALON, quantity: 1, unitPrice: GENERAL.GALON }], { customerId: PARTNER_TEMPO });
    expectApplied(mitraHargaUmum.res);

    expect(await saleRow(t.db, umum.saleId)).toMatchObject({ priceKind: "general", priceMismatch: false, customerId: null, total: GENERAL.GALON });
    expect(await saleRow(t.db, mitra.saleId)).toMatchObject({ priceKind: "partner", priceMismatch: false, customerId: PARTNER_TEMPO });
    // Bukan mitra: harga umum berlaku — harga mitra dari perangkat ditandai (BR-18).
    expect(await saleRow(t.db, nonMitra.saleId)).toMatchObject({ priceKind: "general", priceMismatch: true });
    expect(await saleRow(t.db, mitraHargaUmum.saleId)).toMatchObject({ priceKind: "partner", priceMismatch: true });
    // Data POS memuat harga umum & mitra + penanda mitra pelanggan → perangkat memilih jenis harga, bukan kasir.
    const ref = (await pos.hp.pull(pos.op, { keys: "m7.store" })).data["m7.store"] as StoreReference;
    const galon = ref.products.find((p) => p.id === SP.GALON)!;
    expect(galon.prices).toEqual({ general: GENERAL.GALON, partner: PARTNER.GALON });
    expect(ref.customers.find((c) => c.id === PARTNER_TEMPO)?.isStorePartner).toBe(true);
    expect(ref.customers.some((c) => c.id === NON_PARTNER)).toBe(false);
  });

  it("US-M7-01 KP-2 barang dicari nama/kode/barcode (data POS), jumlah & total otomatis; tunai, QRIS statis, atau tempo mitra — cara bayar lain ditolak", async () => {
    const pos = await makeStore(t.db);
    await t.db.update(products).set({ barcode: "8991234567890" }).where(eq(products.id, SP.SABUN));
    await stockUp(t.db, pos, [
      { productId: SP.SABUN, quantity: 10, unitCost: 20_000 },
      { productId: SP.TUTUP, quantity: 200, unitCost: 500 },
    ]);
    const ref = (await pos.hp.pull(pos.op, { keys: "m7.store" })).data["m7.store"] as StoreReference;
    const sabun = ref.products.find((p) => p.id === SP.SABUN)!;
    expect(sabun).toMatchObject({ code: "TK-SABUN", barcode: "8991234567890", balance: 10, unit: "botol" });
    const shiftId = await openShiftVia(pos);
    const cash = await sellVia(pos, shiftId, [
      { productId: SP.SABUN, quantity: 2, unitPrice: GENERAL.SABUN },
      { productId: SP.TUTUP, quantity: 50, unitPrice: GENERAL.TUTUP },
    ], { cashReceived: 100_000 });
    expectApplied(cash.res);
    expect(await saleRow(t.db, cash.saleId)).toMatchObject({ subtotal: 100_000, total: 100_000, changeAmount: 0, paymentMethod: "cash" });
    const qris = await sellVia(pos, shiftId, [{ productId: SP.SABUN, quantity: 1, unitPrice: GENERAL.SABUN }], { method: "qris" });
    expectApplied(qris.res);
    const credit = await sellVia(pos, shiftId, [{ productId: SP.SABUN, quantity: 1, unitPrice: PARTNER.SABUN }], { method: "credit", customerId: PARTNER_TEMPO });
    expectApplied(credit.res);
    expect(await saleRow(t.db, credit.saleId)).toMatchObject({ paymentMethod: "credit", cashReceived: null, total: PARTNER.SABUN });
    const transfer = await pos.send("m6.pos_sale.create", { saleId: newId(), shiftId, localNumber: "TX-X-000001", deviceSeq: 99, lines: [{ productId: SP.SABUN, quantity: 1, unitPrice: GENERAL.SABUN }], paymentMethod: "transfer" });
    expectRejected(transfer);
  });

  it("US-M7-01 KP-3 diskon ≤ PAR-14 dengan alasan langsung sah; di atasnya menunggu persetujuan pemilik (tidak dihitung, stok tetap) → disetujui/ditolak/tutup shift; tercatat & dilaporkan bulanan", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.UV, quantity: 10, unitCost: 100_000 }]);
    const shiftId = await openShiftVia(pos);
    const line = [{ productId: SP.UV, quantity: 1, unitPrice: GENERAL.UV }];
    // Tanpa alasan → ditolak.
    expectRejected((await sellVia(pos, shiftId, line, { discountAmount: 5_000 })).res, /alasan/i);
    // 5% (7.500 dari 150.000) → sah langsung.
    const ok = await sellVia(pos, shiftId, line, { discountAmount: 7_500, discountReason: "Pelanggan tetap" });
    expectApplied(ok.res);
    expect(await saleRow(t.db, ok.saleId)).toMatchObject({ status: "valid", subtotal: 150_000, discountAmount: 7_500, discountPercent: 5, total: 142_500, discountReason: "Pelanggan tetap" });
    expect(await balanceOf(t.db, pos.outletId, SP.UV)).toBe(9);

    // 10% → menunggu persetujuan pemilik; stok & kas tidak berubah.
    const big = await sellVia(pos, shiftId, line, { discountAmount: 15_000, discountReason: "Barang pajangan", requestApproval: true });
    expectApplied(big.res);
    const pending = await saleRow(t.db, big.saleId);
    expect(pending).toMatchObject({ status: "pending_approval", total: 135_000 });
    expect(pending.discountApprovalId).toBeTruthy();
    expect(await balanceOf(t.db, pos.outletId, SP.UV)).toBe(9);
    const events = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "pos_sale.recorded"), eq(domainEvents.objectId, big.saleId)));
    expect(events).toHaveLength(0);
    const ref = (await pos.hp.pull(pos.op, { keys: "m6.pos" })).data["m6.pos"] as PosReference;
    const f = deviceShiftFigures(ref.openShift!, ref.recipes);
    expect(f.cashSales).toBe(142_500);
    const [appr] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, pending.discountApprovalId!));
    expect(appr).toMatchObject({ type: "store_discount", approverRole: "owner", status: "submitted" });
    expect(appr!.deadlineAt).toBeTruthy();
    // Kasir tidak dapat memutuskan permintaannya sendiri.
    await expect(approvals.decide(pos.cashier.ctx, appr!.id, "approve")).rejects.toThrow();
    // Pemilik menyetujui → sah, stok berkurang, event terbit dengan diskon.
    await approvals.decide(owner(), appr!.id, "approve");
    expect(await saleRow(t.db, big.saleId)).toMatchObject({ status: "valid" });
    expect(await balanceOf(t.db, pos.outletId, SP.UV)).toBe(8);
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "pos_sale.recorded"), eq(domainEvents.objectId, big.saleId)));
    expect(ev!.payload).toMatchObject({ discount: 15_000, total: 135_000, discountReason: "Barang pajangan", approvalIds: [appr!.id] });

    // Ditolak pemilik → Ditolak (tidak dihitung).
    const rej = await sellVia(pos, shiftId, line, { discountAmount: 30_000, discountReason: "Rusak kemasan", requestApproval: true });
    expectApplied(rej.res);
    await approvals.decide(owner(), (await saleRow(t.db, rej.saleId)).discountApprovalId!, "reject", "Diskon terlalu besar");
    expect(await saleRow(t.db, rej.saleId)).toMatchObject({ status: "rejected" });
    expect(await balanceOf(t.db, pos.outletId, SP.UV)).toBe(8);

    // Belum diputuskan saat tutup shift → dianggap ditolak di akhir shift.
    const late = await sellVia(pos, shiftId, line, { discountAmount: 20_000, discountReason: "Nego", requestApproval: true });
    expectApplied(late.res);
    const lateAppr = (await saleRow(t.db, late.saleId)).discountApprovalId!;
    const close = await closeVia(pos, shiftId, 200_000 + 142_500 + 135_000);
    expectApplied(close);
    expect(await saleRow(t.db, late.saleId)).toMatchObject({ status: "rejected" });
    const [lateRow] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, lateAppr));
    expect(lateRow!.status).toBe("cancelled");

    // Laporan diskon bulanan: per transaksi + total diskon berlaku.
    const report = await discountReport(finance(), { outletId: pos.outletId });
    expect(report.rows.map((r) => r.saleId).sort()).toEqual([ok.saleId, big.saleId, rej.saleId, late.saleId].sort());
    expect(report.totals.amount).toBe(7_500 + 15_000);
  });

  it("US-M7-01 KP-3 persetujuan diskon lewat tenggat (akhir hari shift) dianggap ditolak", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.UV, quantity: 2, unitCost: 100_000 }]);
    const shiftId = await openShiftVia(pos);
    const s = await sellVia(pos, shiftId, [{ productId: SP.UV, quantity: 1, unitPrice: GENERAL.UV }], { discountAmount: 40_000, discountReason: "Uji tenggat", requestApproval: true });
    expectApplied(s.res);
    const [appr] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, (await saleRow(t.db, s.saleId)).discountApprovalId!));
    await approvals.expireDue(new Date(appr!.deadlineAt!.getTime() + 60_000));
    expect(await saleRow(t.db, s.saleId)).toMatchObject({ status: "rejected" });
    expect(await balanceOf(t.db, pos.outletId, SP.UV)).toBe(2);
  });

  it("US-M7-01 KP-4 stok berkurang saat transaksi tersimpan (kartu stok + HPP per baris); stok 0 / kurang dan barang belum disetujui tidak dapat dijual (BR-28)", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.POMPA, quantity: 3, unitCost: 15_000 }]);
    const shiftId = await openShiftVia(pos);
    const s = await sellVia(pos, shiftId, [{ productId: SP.POMPA, quantity: 2, unitPrice: GENERAL.POMPA }]);
    expectApplied(s.res);
    expect(await balanceOf(t.db, pos.outletId, SP.POMPA)).toBe(1);
    const [led] = await t.db.select().from(stockLedger).where(and(eq(stockLedger.sourceObjectId, s.saleId), eq(stockLedger.kind, "sale")));
    expect(led).toMatchObject({ quantity: -2, unitCost: 15_000, balanceAfter: 1 });
    const [line] = await t.db.select().from(posSaleLines).where(eq(posSaleLines.posSaleId, s.saleId));
    expect(line!.unitCost).toBe(15_000);
    expectRejected((await sellVia(pos, shiftId, [{ productId: SP.POMPA, quantity: 2, unitPrice: GENERAL.POMPA }])).res, /tinggal 1/);
    expectRejected((await sellVia(pos, shiftId, [{ productId: SP.SIKAT, quantity: 1, unitPrice: GENERAL.SIKAT }])).res, /Stok .* 0/);
    // Barang baru usulan kasir (belum disetujui) tidak dapat dijual.
    const newProduct = newId();
    expectApplied(await pos.send("m7.store_product.propose", { productId: newProduct, code: "TK-UJI-01", name: "Gayung uji", unit: "pcs", generalPrice: 10_000, partnerPrice: 9_000, minStock: 2 }));
    expectRejected((await sellVia(pos, shiftId, [{ productId: newProduct, quantity: 1, unitPrice: 10_000 }])).res, /persetujuan/);
  });

  it("US-M7-01 KP-5 void seperti M6 mengembalikan stok; retur setelah shift ditutup dicatat Admin Keuangan → stok kembali + event untuk nota kredit M5; > PAR-21 perlu persetujuan", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [
      { productId: SP.FILTER, quantity: 10, unitCost: 25_000 },
      { productId: SP.DISPENSER, quantity: 2, unitCost: 700_000 },
    ]);
    const shiftId = await openShiftVia(pos);
    const s1 = await sellVia(pos, shiftId, [{ productId: SP.FILTER, quantity: 2, unitPrice: GENERAL.FILTER }]);
    expectApplied(s1.res);
    expect(await balanceOf(t.db, pos.outletId, SP.FILTER)).toBe(8);
    // Retur hari yang sama = void (≤ PAR-04 langsung).
    expectApplied(await pos.send("m6.pos_sale.void", { saleId: s1.saleId, reason: "customer_cancelled" }));
    expect(await saleRow(t.db, s1.saleId)).toMatchObject({ status: "voided" });
    expect(await balanceOf(t.db, pos.outletId, SP.FILTER)).toBe(10);
    const s2 = await sellVia(pos, shiftId, [{ productId: SP.FILTER, quantity: 3, unitPrice: PARTNER.FILTER }], { customerId: PARTNER_TEMPO, method: "credit" });
    expectApplied(s2.res);
    const s3 = await sellVia(pos, shiftId, [{ productId: SP.DISPENSER, quantity: 1, unitPrice: GENERAL.DISPENSER }]);
    expectApplied(s3.res);
    // Shift masih terbuka → retur lewat void di POS.
    await expect(recordStoreReturn(finance(), { saleId: s2.saleId, lines: [{ productId: SP.FILTER, quantity: 1 }], reason: "Filter bocor" })).rejects.toThrow(/void/);
    expectApplied(await closeVia(pos, shiftId, 200_000 + GENERAL.DISPENSER));
    const res = await recordStoreReturn(finance(), { saleId: s2.saleId, lines: [{ productId: SP.FILTER, quantity: 1 }], reason: "Filter bocor" });
    expect(res.status).toBe("applied");
    expect(await balanceOf(t.db, pos.outletId, SP.FILTER)).toBe(8);
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "store_return.recorded"), eq(domainEvents.objectId, s2.saleId)));
    expect(ev!.payload).toMatchObject({ method: "credit", customerId: PARTNER_TEMPO, amount: PARTNER.FILTER, cogs: 25_000 });
    // Retur melebihi yang terjual ditolak.
    await expect(recordStoreReturn(finance(), { saleId: s2.saleId, lines: [{ productId: SP.FILTER, quantity: 3 }], reason: "Uji lebih" })).rejects.toThrow(/sisa/);
    // > PAR-21 (500.000) → persetujuan pemilik (correction) sebelum stok kembali.
    const big = await recordStoreReturn(finance(), { saleId: s3.saleId, lines: [{ productId: SP.DISPENSER, quantity: 1 }], reason: "Dispenser rusak" });
    expect(big.status).toBe("pending_approval");
    expect(await balanceOf(t.db, pos.outletId, SP.DISPENSER)).toBe(1);
    await approvals.decide(owner(), big.approval!.id, "approve");
    expect(await balanceOf(t.db, pos.outletId, SP.DISPENSER)).toBe(2);
  });

  it("US-M7-01 KP-6 struk: tempo menyebut nomor faktur M5 setelah terbit (data POS), payload event memuat tempo pelanggan untuk faktur", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.SIKAT, quantity: 5, unitCost: 10_000 }]);
    const shiftId = await openShiftVia(pos);
    const s = await sellVia(pos, shiftId, [{ productId: SP.SIKAT, quantity: 2, unitPrice: PARTNER.SIKAT }], { customerId: PARTNER_TEMPO, method: "credit" });
    expectApplied(s.res);
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "pos_sale.recorded"), eq(domainEvents.objectId, s.saleId)));
    const [cust] = await t.db.select().from(customers).where(eq(customers.id, PARTNER_TEMPO));
    expect(ev!.payload).toMatchObject({ method: "credit", customerId: PARTNER_TEMPO, paymentTermDays: cust!.paymentTermDays, outletKind: "store", priceKind: "partner" });
    let ref = (await pos.hp.pull(pos.op, { keys: "m7.store" })).data["m7.store"] as StoreReference;
    expect(ref.recentSales.find((x) => x.id === s.saleId)).toMatchObject({ invoiceNumber: null, customerName: cust!.name, total: 2 * PARTNER.SIKAT });
    // M5 menerbitkan faktur per transaksi (disimulasikan) → struk ulang menyebut nomor faktur.
    const today = toBusinessDate(new Date());
    await t.db.insert(invoices).values({
      tenantId: EQUA_TENANT_ID,
      number: `F-UJI-${s.saleId.slice(-6)}`,
      kind: "store_sale",
      customerId: PARTNER_TEMPO,
      posSaleId: s.saleId,
      issueDate: today,
      dueDate: today,
      amount: 2 * PARTNER.SIKAT,
      outstandingAmount: 2 * PARTNER.SIKAT,
    });
    ref = (await pos.hp.pull(pos.op, { keys: "m7.store" })).data["m7.store"] as StoreReference;
    expect(ref.recentSales.find((x) => x.id === s.saleId)?.invoiceNumber).toBe(`F-UJI-${s.saleId.slice(-6)}`);
  });
});

describe("US-M7-04 Penjualan tempo untuk mitra terdaftar", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M7-04 KP-1 tempo hanya mitra toko berstatus Tempo; bukan mitra ditolak; Tunai/Ditahan ditolak berketerangan dengan pilihan persetujuan pemilik", async () => {
    await t.db.update(customers).set({ creditStatus: "on_hold" }).where(eq(customers.id, PARTNER_HOLD));
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.TISU, quantity: 500, unitCost: 200 }]);
    const shiftId = await openShiftVia(pos);
    const line = [{ productId: SP.TISU, quantity: 10, unitPrice: PARTNER.TISU }];
    expectRejected((await sellVia(pos, shiftId, [{ productId: SP.TISU, quantity: 10, unitPrice: GENERAL.TISU }], { method: "credit" })).res, /Pilih pelanggan mitra/);
    expectRejected((await sellVia(pos, shiftId, [{ productId: SP.TISU, quantity: 10, unitPrice: GENERAL.TISU }], { method: "credit", customerId: NON_PARTNER })).res, /bukan mitra toko/);
    expectRejected((await sellVia(pos, shiftId, line, { method: "credit", customerId: PARTNER_CASH })).res, /Tunai.*persetujuan pemilik/);
    expectRejected((await sellVia(pos, shiftId, line, { method: "credit", customerId: PARTNER_HOLD })).res, /Ditahan.*persetujuan pemilik/);
    // Bukan mitra tidak dapat diajukan.
    expectRejected((await sellVia(pos, shiftId, [{ productId: SP.TISU, quantity: 1, unitPrice: GENERAL.TISU }], { method: "credit", customerId: NON_PARTNER, requestApproval: true })).res);
    // Ajukan persetujuan pemilik → menunggu; disetujui → sah.
    const req = await sellVia(pos, shiftId, line, { method: "credit", customerId: PARTNER_HOLD, requestApproval: true });
    expectApplied(req.res);
    expect(await saleRow(t.db, req.saleId)).toMatchObject({ status: "pending_approval" });
    const [appr] = await t.db.select().from(approvalRequests).where(and(eq(approvalRequests.objectId, req.saleId), eq(approvalRequests.type, "store_credit_sale")));
    expect(appr).toMatchObject({ approverRole: "owner", status: "submitted" });
    await approvals.decide(owner(), appr!.id, "approve");
    expect(await saleRow(t.db, req.saleId)).toMatchObject({ status: "valid", paymentMethod: "credit" });
    const ok = await sellVia(pos, shiftId, line, { method: "credit", customerId: PARTNER_TEMPO });
    expectApplied(ok.res);
  });

  it("US-M7-04 KP-2 satu batas kredit lintas lini: piutang semua lini + tempo toko belum difakturkan + transaksi ini; melebihi batas ditolak berangka", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.DISPENSER, quantity: 5, unitCost: 700_000 }]);
    // Piutang air truk (lini lain) 500.000 + batas diatur relatif terhadap eksposur saat ini.
    const today = toBusinessDate(new Date());
    await t.db.insert(invoices).values({ tenantId: EQUA_TENANT_ID, number: `F-UJI-TRK-${newId().slice(-6)}`, kind: "delivery", customerId: PARTNER_TEMPO, issueDate: today, dueDate: today, amount: 500_000, outstandingAmount: 500_000 });
    const base = await storeCreditExposure(t.db, PARTNER_TEMPO, 0);
    expect(base.openInvoices).toBeGreaterThanOrEqual(500_000);
    await t.db.update(customers).set({ creditLimit: base.exposure + 2 * PARTNER.DISPENSER, creditStatus: "credit" }).where(eq(customers.id, PARTNER_TEMPO));
    const shiftId = await openShiftVia(pos);
    const first = await sellVia(pos, shiftId, [{ productId: SP.DISPENSER, quantity: 2, unitPrice: PARTNER.DISPENSER }], { method: "credit", customerId: PARTNER_TEMPO });
    expectApplied(first.res);
    // Tempo toko belum difakturkan ikut eksposur → transaksi berikut melampaui batas.
    const after = await storeCreditExposure(t.db, PARTNER_TEMPO, 0);
    expect(after.uninvoicedStoreCredit).toBeGreaterThanOrEqual(2 * PARTNER.DISPENSER);
    const over = await sellVia(pos, shiftId, [{ productId: SP.DISPENSER, quantity: 1, unitPrice: PARTNER.DISPENSER }], { method: "credit", customerId: PARTNER_TEMPO });
    expectRejected(over.res, /melampaui batas kredit/);
    expect(over.res.message).toMatch(/tempo toko belum difakturkan/);
  });

  it("US-M7-04 KP-3 transaksi tempo membentuk data faktur per transaksi di M5 (event pos_sale.recorded metode tempo + tempo pelanggan)", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.TUTUP, quantity: 1000, unitCost: 400 }]);
    await t.db.update(customers).set({ creditLimit: 100_000_000, creditStatus: "credit" }).where(eq(customers.id, PARTNER_TEMPO));
    const shiftId = await openShiftVia(pos);
    const s = await sellVia(pos, shiftId, [{ productId: SP.TUTUP, quantity: 100, unitPrice: PARTNER.TUTUP }], { method: "credit", customerId: PARTNER_TEMPO });
    expectApplied(s.res);
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "pos_sale.recorded"), eq(domainEvents.objectId, s.saleId)));
    expect(ev!.payload).toMatchObject({ method: "credit", total: 100 * PARTNER.TUTUP, customerId: PARTNER_TEMPO, outletKind: "store" });
    expect((ev!.payload as { paymentTermDays: number }).paymentTermDays).toBeGreaterThan(0);
    expect((ev!.payload as { cogs: number }).cogs).toBe(100 * 400);
  });

  it("US-M7-04 KP-4 offline: tempo dengan eksposur sinkron terakhir diterima & ditandai tinjauan Admin Keuangan (PTB-42)", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.GALON, quantity: 20, unitCost: 30_000 }]);
    const shiftId = await openShiftVia(pos);
    // Batas habis menurut server, tetapi perangkat offline (data sinkron terakhir masih cukup).
    const base = await storeCreditExposure(t.db, PARTNER_TEMPO, 0);
    await t.db.update(customers).set({ creditLimit: base.exposure, creditStatus: "credit" }).where(eq(customers.id, PARTNER_TEMPO));
    const online = await sellVia(pos, shiftId, [{ productId: SP.GALON, quantity: 1, unitPrice: PARTNER.GALON }], { method: "credit", customerId: PARTNER_TEMPO });
    expectRejected(online.res);
    const offline = await sellVia(pos, shiftId, [{ productId: SP.GALON, quantity: 1, unitPrice: PARTNER.GALON }], { method: "credit", customerId: PARTNER_TEMPO, creditOffline: true });
    expect(offline.res.status).toBe("conflict");
    expect(await saleRow(t.db, offline.saleId)).toMatchObject({ status: "valid", creditOffline: true });
    expect((await notificationsFor(t.db, "store.credit_offline_review", { objectId: offline.saleId })).length).toBeGreaterThan(0);
    // Tersinkron terlambat (> m7.store_rules.credit_offline_after_minutes) juga dianggap offline.
    const devTime = new Date(Date.now() - 20 * 60_000);
    const late = await sellVia(pos, shiftId, [{ productId: SP.GALON, quantity: 1, unitPrice: PARTNER.GALON }], {
      method: "credit",
      customerId: PARTNER_TEMPO,
      cmd: { deviceTime: devTime.toISOString(), businessDate: toBusinessDate(devTime) },
    });
    expect(["applied", "conflict"]).toContain(late.res.status);
    expect(await saleRow(t.db, late.saleId)).toMatchObject({ creditOffline: true });
  });
});

describe("US-M7-09 Kas toko harian dan setoran", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M7-09 KP-1 shift toko seperti M6: kas awal tetap, kas fisik, selisih wajib alasan, setoran toko terbentuk & hasil penerimaan tampil", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.SABUN, quantity: 10, unitCost: 20_000 }]);
    const shiftId = await openShiftVia(pos);
    const [sh] = await t.db.select().from(shifts).where(eq(shifts.id, shiftId));
    expect(sh!.openingCashFixed).toBe(200_000);
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.SABUN, quantity: 2, unitPrice: GENERAL.SABUN }])).res);
    expectRejected(await closeVia(pos, shiftId, 255_000), /alasan/);
    expectApplied(await closeVia(pos, shiftId, 255_000, "Kembalian kurang"));
    const [closed] = await t.db.select().from(shifts).where(eq(shifts.id, shiftId));
    expect(closed).toMatchObject({ status: "closed", cashDifference: -5_000, cashDifferenceReason: "Kembalian kurang", depositAmount: 60_000, depositStatus: "not_deposited" });
    const ref = (await pos.hp.pull(pos.op, { keys: "m6.pos" })).data["m6.pos"] as PosReference;
    expect(ref.history.find((h) => h.shiftId === shiftId)).toMatchObject({ depositAmount: 60_000, cashDifference: -5_000 });
    const deps = await t.db.select().from(deposits).where(eq(deposits.shiftId, shiftId));
    expect(deps[0]).toMatchObject({ sourceType: "store_shift", expectedCash: 60_000 });
  });

  it("US-M7-09 KP-2 penjualan tempo & QRIS tidak masuk kas fisik (tercatat terpisah untuk M5/M4)", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.GALON, quantity: 10, unitCost: 30_000 }]);
    await t.db.update(customers).set({ creditLimit: 100_000_000, creditStatus: "credit" }).where(eq(customers.id, PARTNER_TEMPO));
    const shiftId = await openShiftVia(pos);
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.GALON, quantity: 1, unitPrice: GENERAL.GALON }])).res);
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.GALON, quantity: 1, unitPrice: GENERAL.GALON }], { method: "qris" })).res);
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.GALON, quantity: 1, unitPrice: PARTNER.GALON }], { method: "credit", customerId: PARTNER_TEMPO })).res);
    expectApplied(await closeVia(pos, shiftId, 200_000 + GENERAL.GALON));
    const [closed] = await t.db.select().from(shifts).where(eq(shifts.id, shiftId));
    expect(closed).toMatchObject({ cashSales: GENERAL.GALON, qrisSales: GENERAL.GALON, creditSales: PARTNER.GALON, cashDifference: 0, depositAmount: GENERAL.GALON });
  });

  it("US-M7-09 KP-3 tutup kas Admin Keuangan mensyaratkan shift toko ditutup (daftar penghalang untuk M4)", async () => {
    const pos = await makeStore(t.db);
    const shiftId = await openShiftVia(pos);
    const today = toBusinessDate(new Date());
    const blocking = await storeShiftsBlockingCashClose(t.db, EQUA_TENANT_ID, today);
    expect(blocking.map((b) => b.shiftId)).toContain(shiftId);
    expectApplied(await closeVia(pos, shiftId, 200_000));
    const after = await storeShiftsBlockingCashClose(t.db, EQUA_TENANT_ID, today);
    expect(after.map((b) => b.shiftId)).not.toContain(shiftId);
    // Waktu kantor (pelaku FA) tidak memengaruhi — fungsi murni per tanggal bisnis.
    expect(withNow(finance(), new Date()).roles).toContain("finance_admin");
  });
});
