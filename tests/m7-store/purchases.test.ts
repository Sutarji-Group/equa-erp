import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, dataSignoffs, domainEvents, productPrices, products, purchaseReceiptLines, purchaseReceipts, stockBalances, stockLedger, suppliers } from "@/db/schema";
import { hardeningViolationCode } from "@/db/hardening";
import { EQUA_TENANT_ID } from "@/db/seed";
import type { CatalogRef } from "@/client/m6-pos/contract";
import { newId } from "@/lib/ids";
import { addDays, toBusinessDate } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { put } from "@/server/core/storage";
import { resolveProductPrice, priceHistory } from "@/server/modules/m1-master";
import {
  acceptSubstituteNote,
  correctPurchaseReceipt,
  listPayables,
  prepareOpeningStock,
  recordOpeningPayable,
  recordSupplierPayment,
  reverseSupplierPayment,
  runPayableReminders,
  signOpeningStock,
  stockCard,
} from "@/server/modules/m7-store";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import {
  accountant,
  activeSupplier,
  balanceOf,
  expectApplied,
  expectRejected,
  finance,
  GENERAL,
  JPEG,
  makeStore,
  notificationsFor,
  openShiftVia,
  owner,
  receiveVia,
  sellVia,
  SP,
  stockUp,
} from "./helpers";

const today = () => toBusinessDate(new Date());

async function receiptRow(db: ReturnType<typeof useTestDb>["db"], id: string) {
  const [row] = await db.select().from(purchaseReceipts).where(eq(purchaseReceipts.id, id));
  return row!;
}

describe("US-M7-02 Penerimaan barang dari pemasok dan kartu stok", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M7-02 KP-1 penerimaan wajib nota pemasok (pemasok aktif, nomor & tanggal, foto, baris jumlah + harga beli, total); tanpa nota ditolak", async () => {
    const pos = await makeStore(t.db);
    const sup = await activeSupplier(t.db, "CV Sinar Plastik");
    const lines = [
      { productId: SP.TUTUP, quantity: 500, unitCost: 450 },
      { productId: SP.TISU, quantity: 300, unitCost: 200 },
    ];
    expectRejected((await receiveVia(pos, { supplierId: sup, lines, noteNumber: null })).res, /nota pemasok/);
    expectRejected((await receiveVia(pos, { supplierId: sup, lines, noteDate: null })).res, /nota pemasok/);
    expectRejected((await receiveVia(pos, { supplierId: sup, lines, photo: false })).res, /foto/);
    expectRejected((await receiveVia(pos, { supplierId: sup, lines, total: 999 })).res, /tidak sama/);
    const pending = newId();
    await t.db.insert(suppliers).values({ id: pending, tenantId: EQUA_TENANT_ID, name: "Pemasok Belum Disetujui", status: "pending_approval" });
    expectRejected((await receiveVia(pos, { supplierId: pending, lines })).res, /belum disetujui/);

    const ok = await receiveVia(pos, { supplierId: sup, lines, noteNumber: "SP-0091" });
    expectApplied(ok.res);
    const r = await receiptRow(t.db, ok.receiptId);
    expect(r).toMatchObject({ status: "received", supplierNoteNumber: "SP-0091", totalAmount: 500 * 450 + 300 * 200, isSubstituteNote: false });
    expect(r.number).toMatch(/^NB-\d{2}-\d{6}$/);
    expect(r.noteAttachmentId).toBeTruthy();
    expect(await t.db.select().from(purchaseReceiptLines).where(eq(purchaseReceiptLines.receiptId, r.id))).toHaveLength(2);
    expect(await balanceOf(t.db, pos.outletId, SP.TUTUP)).toBe(500);
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "purchase_receipt.recorded"), eq(domainEvents.objectId, r.id)));
    expect(ev!.payload).toMatchObject({ supplierId: sup, total: r.totalAmount, paymentMode: "credit", isOpeningPayable: false });
  });

  it("US-M7-02 KP-1 nota pengganti (foto barang + keterangan): barang tidak masuk stok & tidak dapat dijual sampai Admin Keuangan menerimanya sebagai nota", async () => {
    const pos = await makeStore(t.db);
    const sup = await activeSupplier(t.db, "Pak Ujang (pengrajin)");
    const lines = [{ productId: SP.SIKAT, quantity: 10, unitCost: 12_000 }];
    expectRejected((await receiveVia(pos, { supplierId: sup, lines, substitute: true, noteNumber: null, noteDate: null, notes: null })).res, /keterangan/);
    const sub = await receiveVia(pos, { supplierId: sup, lines, substitute: true, noteNumber: null, noteDate: null, notes: "Pengrajin tidak punya nota" });
    expectApplied(sub.res);
    expect(await receiptRow(t.db, sub.receiptId)).toMatchObject({ status: "pending_acceptance", isSubstituteNote: true });
    expect(await balanceOf(t.db, pos.outletId, SP.SIKAT)).toBe(0);
    expect((await notificationsFor(t.db, "store.substitute_note_pending", { objectId: sub.receiptId })).length).toBeGreaterThan(0);
    const shiftId = await openShiftVia(pos);
    expectRejected((await sellVia(pos, shiftId, [{ productId: SP.SIKAT, quantity: 1, unitPrice: GENERAL.SIKAT }])).res, /Stok/);
    // Kasir tidak dapat menerima nota pengganti; Admin Keuangan menerimanya → stok masuk + event.
    await expect(acceptSubstituteNote(pos.cashier.ctx, { receiptId: sub.receiptId })).rejects.toThrow();
    await acceptSubstituteNote(finance(), { receiptId: sub.receiptId, note: "Diterima sebagai nota" });
    expect(await receiptRow(t.db, sub.receiptId)).toMatchObject({ status: "received" });
    expect(await balanceOf(t.db, pos.outletId, SP.SIKAT)).toBe(10);
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "purchase_receipt.recorded"), eq(domainEvents.objectId, sub.receiptId)));
    expect(ev!.payload).toMatchObject({ fromSubstituteNote: true });
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.SIKAT, quantity: 1, unitPrice: GENERAL.SIKAT }])).res);
  });

  it("US-M7-02 KP-2 barang baru dari kasir berlaku setelah disetujui Admin Keuangan; perubahan harga jual lewat persetujuan, tanggal berlaku, riwayat (BR-15)", async () => {
    const pos = await makeStore(t.db);
    const productId = newId();
    expectApplied(
      await pos.send("m7.store_product.propose", { productId, code: "tk-gayung", name: "Gayung plastik", unit: "pcs", category: "peralatan", generalPrice: 15_000, partnerPrice: 13_000, minStock: 5 }),
    );
    const [p] = await t.db.select().from(products).where(eq(products.id, productId));
    expect(p).toMatchObject({ code: "TK-GAYUNG", status: "pending_approval", line: "store", minStock: 5 });
    const [appr] = await t.db.select().from(approvalRequests).where(and(eq(approvalRequests.objectId, productId), eq(approvalRequests.type, "store_product")));
    expect(appr).toMatchObject({ approverRole: "finance_admin", status: "submitted" });
    // Belum disetujui → tidak ada di katalog POS.
    let catalog = (await pos.hp.pull(pos.op, { keys: "m1.catalog" })).data["m1.catalog"] as CatalogRef;
    expect(catalog.products.some((x) => x.id === productId)).toBe(false);
    // Kode ganda ditolak.
    expectRejected(await pos.send("m7.store_product.propose", { productId: newId(), code: "TK-GAYUNG", name: "Gayung lain", unit: "pcs", generalPrice: 1_000, partnerPrice: 900 }), /sudah dipakai/);
    // Pemilik bukan penyetuju jenis ini; Admin Keuangan menyetujui.
    await expect(approvals.decide(owner(), appr!.id, "approve")).rejects.toThrow(/Admin Keuangan/);
    await approvals.decide(finance(), appr!.id, "approve");
    const [active] = await t.db.select().from(products).where(eq(products.id, productId));
    expect(active!.status).toBe("active");
    expect((await resolveProductPrice(t.db, { productId, kind: "general", date: today(), tenantId: EQUA_TENANT_ID })).unitPrice).toBe(15_000);
    expect((await resolveProductPrice(t.db, { productId, kind: "partner", date: today(), tenantId: EQUA_TENANT_ID })).unitPrice).toBe(13_000);
    catalog = (await pos.hp.pull(pos.op, { keys: "m1.catalog" })).data["m1.catalog"] as CatalogRef;
    expect(catalog.products.find((x) => x.id === productId)?.prices).toEqual({ general: 15_000, partner: 13_000 });

    // Perubahan harga jual: tanggal berlaku wajib ≥ hari ini; berlaku setelah disetujui; riwayat tersimpan.
    expectRejected(await pos.send("m7.store_price.propose", { priceId: newId(), productId, kind: "general", price: 17_000, effectiveFrom: addDays(today(), -1), reason: "Harga pemasok naik" }), /sebelum hari ini/);
    const priceId = newId();
    expectApplied(await pos.send("m7.store_price.propose", { priceId, productId, kind: "general", price: 17_000, effectiveFrom: today(), reason: "Harga pemasok naik" }));
    expect((await resolveProductPrice(t.db, { productId, kind: "general", date: today(), tenantId: EQUA_TENANT_ID })).unitPrice).toBe(15_000);
    const [pAppr] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.objectId, priceId));
    await approvals.decide(finance(), pAppr!.id, "approve");
    expect((await resolveProductPrice(t.db, { productId, kind: "general", date: today(), tenantId: EQUA_TENANT_ID })).unitPrice).toBe(17_000);
    // Ditolak → harga lama tetap.
    const rejId = newId();
    expectApplied(await pos.send("m7.store_price.propose", { priceId: rejId, productId, kind: "partner", price: 10_000, effectiveFrom: today(), reason: "Promo" }));
    const [rAppr] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.objectId, rejId));
    await approvals.decide(finance(), rAppr!.id, "reject", "Margin terlalu kecil");
    expect((await resolveProductPrice(t.db, { productId, kind: "partner", date: today(), tenantId: EQUA_TENANT_ID })).unitPrice).toBe(13_000);
    const history = await priceHistory(t.db, EQUA_TENANT_ID, { productId });
    // Harga lama bertanggal berlaku sama digantikan (dibatalkan, tetap di riwayat), usulan ditolak tetap tercatat.
    expect(history.map((h) => h.status).sort()).toEqual(["active", "active", "cancelled", "rejected"]);
    const rows = await t.db.select().from(productPrices).where(eq(productPrices.productId, productId));
    expect(rows.find((r) => r.id === priceId)?.approvedBy).toBeTruthy();
  });

  it("US-M7-02 KP-3 kartu stok per barang: masuk nota, keluar penjualan, saldo berjalan & harga pokok rata-rata bergerak diperbarui setiap penerimaan (PTB-38)", async () => {
    const pos = await makeStore(t.db);
    const sup = await activeSupplier(t.db);
    await stockUp(t.db, pos, [{ productId: SP.FILTER, quantity: 10, unitCost: 20_000 }], sup);
    await stockUp(t.db, pos, [{ productId: SP.FILTER, quantity: 10, unitCost: 30_000 }], sup);
    const [bal] = await t.db.select().from(stockBalances).where(and(eq(stockBalances.outletId, pos.outletId), eq(stockBalances.productId, SP.FILTER)));
    expect(bal).toMatchObject({ quantity: 20, avgCost: 25_000, totalValue: 500_000 });
    const shiftId = await openShiftVia(pos);
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.FILTER, quantity: 4, unitPrice: GENERAL.FILTER }])).res);
    const card = await stockCard(t.db, { outletId: pos.outletId, productId: SP.FILTER, from: addDays(today(), -1), to: today() });
    expect(card.rows.map((r) => [r.kind, r.quantity, r.balanceAfter, r.avgCostAfter])).toEqual([
      ["receipt", 10, 10, 20_000],
      ["receipt", 10, 20, 25_000],
      ["sale", -4, 16, 25_000],
    ]);
    // Harga beli berbeda tidak mengubah harga jual (BR-15).
    expect((await resolveProductPrice(t.db, { productId: SP.FILTER, kind: "general", date: today(), tenantId: EQUA_TENANT_ID })).unitPrice).toBe(GENERAL.FILTER);
  });

  it("US-M7-02 KP-4 nota belum dibayar membentuk utang pemasok dengan jatuh tempo (nota / tempo pemasok / PAR-67)", async () => {
    const pos = await makeStore(t.db);
    const supDefault = await activeSupplier(t.db, "Pemasok Tanpa Tempo");
    const sup14 = await activeSupplier(t.db, "Pemasok Tempo 14", 14);
    const noteDate = addDays(today(), -2);
    const a = await receiveVia(pos, { supplierId: supDefault, lines: [{ productId: SP.TISU, quantity: 100, unitCost: 200 }], noteDate });
    const b = await receiveVia(pos, { supplierId: sup14, lines: [{ productId: SP.TISU, quantity: 100, unitCost: 200 }], noteDate });
    const c = await receiveVia(pos, { supplierId: sup14, lines: [{ productId: SP.TISU, quantity: 100, unitCost: 200 }], noteDate, dueDate: addDays(today(), 5) });
    for (const r of [a, b, c]) expectApplied(r.res);
    expect((await receiptRow(t.db, a.receiptId)).dueDate).toBe(addDays(noteDate, 30));
    expect((await receiptRow(t.db, b.receiptId)).dueDate).toBe(addDays(noteDate, 14));
    expect((await receiptRow(t.db, c.receiptId)).dueDate).toBe(addDays(today(), 5));
    const list = await listPayables(finance());
    const ids = list.rows.map((r) => r.receiptId);
    expect(ids).toEqual(expect.arrayContaining([a.receiptId, b.receiptId, c.receiptId]));
    expect(list.rows.find((r) => r.receiptId === a.receiptId)).toMatchObject({ outstanding: 20_000, paid: 0 });
  });

  it("US-M7-02 KP-5 stok awal cut-over dari opname bertanda tangan pemilik dengan harga beli terakhir sebagai harga pokok awal", async () => {
    const pos = await makeStore(t.db);
    const prep = await prepareOpeningStock(finance(), {
      outletId: pos.outletId,
      lines: [
        { productId: SP.POMPA, quantity: 12, unitCost: 18_000 },
        { productId: SP.SABUN, quantity: 6, unitCost: 21_000 },
      ],
      notes: "Opname fisik 30 Sep",
    });
    expect(prep.totalValue).toBe(12 * 18_000 + 6 * 21_000);
    const [signoff] = await t.db.select().from(dataSignoffs).where(eq(dataSignoffs.id, prep.signoff.id));
    expect(signoff).toMatchObject({ group: "stock_opening", status: "draft" });
    expect(await balanceOf(t.db, pos.outletId, SP.POMPA)).toBe(0);
    // Admin Keuangan tidak dapat menandatangani sendiri; pemilik menandatangani.
    await expect(signOpeningStock(finance(), { stockCountId: prep.stockCount.id })).rejects.toThrow();
    await signOpeningStock(owner(), { stockCountId: prep.stockCount.id, note: "Sesuai lembar opname" });
    const [bal] = await t.db.select().from(stockBalances).where(and(eq(stockBalances.outletId, pos.outletId), eq(stockBalances.productId, SP.POMPA)));
    expect(bal).toMatchObject({ quantity: 12, avgCost: 18_000 });
    const [led] = await t.db.select().from(stockLedger).where(and(eq(stockLedger.outletId, pos.outletId), eq(stockLedger.productId, SP.SABUN)));
    expect(led).toMatchObject({ kind: "opening", quantity: 6, unitCost: 21_000 });
    const [signed] = await t.db.select().from(dataSignoffs).where(eq(dataSignoffs.id, prep.signoff.id));
    expect(signed!.status).toBe("signed");
    await expect(prepareOpeningStock(finance(), { outletId: pos.outletId, lines: [{ productId: SP.POMPA, quantity: 1, unitCost: 1 }] })).rejects.toThrow(/kartu stok/);
  });

  it("US-M7-02 KP-6 penerimaan tidak dapat dihapus/diinput ganda; koreksi lewat nota retur pemasok/pembalik beralasan (> PAR-21 persetujuan pemilik)", async () => {
    const pos = await makeStore(t.db);
    const sup = await activeSupplier(t.db, "UD Makmur");
    const r = await receiveVia(pos, { supplierId: sup, lines: [{ productId: SP.UV, quantity: 10, unitCost: 100_000 }, { productId: SP.TUTUP, quantity: 100, unitCost: 500 }], noteNumber: "MK-77" });
    expectApplied(r.res);
    // Nota yang sama tidak dapat diinput dua kali.
    expectRejected((await receiveVia(pos, { supplierId: sup, lines: [{ productId: SP.TUTUP, quantity: 1, unitCost: 500 }], noteNumber: "MK-77" })).res, /sudah tercatat/);
    // Tanpa hapus (DB menolak).
    let code: string | undefined;
    try {
      await t.db.delete(purchaseReceipts).where(eq(purchaseReceipts.id, r.receiptId));
    } catch (error) {
      code = hardeningViolationCode(error);
    }
    expect(code).toBe("EQ001");
    // Kasir tidak berwenang mengoreksi.
    await expect(correctPurchaseReceipt(pos.cashier.ctx, { receiptId: r.receiptId, kind: "return", lines: [{ productId: SP.TUTUP, quantity: 10 }], reason: "Tutup cacat" })).rejects.toThrow();
    // Retur kecil (≤ PAR-21) langsung: stok & utang berkurang, event koreksi.
    const small = await correctPurchaseReceipt(finance(), { receiptId: r.receiptId, kind: "return", lines: [{ productId: SP.TUTUP, quantity: 10 }], reason: "Tutup cacat produksi" });
    expect(small.status).toBe("applied");
    expect(small.correction).toMatchObject({ reversalOfId: r.receiptId, totalAmount: -5_000 });
    expect(await balanceOf(t.db, pos.outletId, SP.TUTUP)).toBe(90);
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "purchase_receipt.corrected"), eq(domainEvents.objectId, r.receiptId)));
    expect(ev!.payload).toMatchObject({ kind: "return", amountDelta: -5_000 });
    // Pembalik penuh sisa nota (> PAR-21) → persetujuan pemilik.
    const big = await correctPurchaseReceipt(finance(), { receiptId: r.receiptId, kind: "reversal", reason: "Nota salah input pemasok" });
    expect(big.status).toBe("pending_approval");
    expect(await balanceOf(t.db, pos.outletId, SP.UV)).toBe(10);
    await approvals.decide(owner(), big.approval!.id, "approve");
    expect(await receiptRow(t.db, r.receiptId)).toMatchObject({ status: "reversed" });
    expect(await balanceOf(t.db, pos.outletId, SP.UV)).toBe(0);
    expect(await balanceOf(t.db, pos.outletId, SP.TUTUP)).toBe(0);
    const payables = await listPayables(finance());
    expect(payables.rows.some((x) => x.receiptId === r.receiptId)).toBe(false);
  });
});

describe("US-M7-08 Utang pemasok dan jadwal pembayaran", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M7-08 KP-1 utang per nota dengan jatuh tempo; daftar per pemasok & umur; pengingat jatuh tempo ke Admin Keuangan", async () => {
    const pos = await makeStore(t.db);
    const sup = await activeSupplier(t.db, "CV Umur Utang", 7);
    const old = await receiveVia(pos, { supplierId: sup, lines: [{ productId: SP.TISU, quantity: 100, unitCost: 250 }], noteDate: addDays(today(), -20) });
    const soon = await receiveVia(pos, { supplierId: sup, lines: [{ productId: SP.TISU, quantity: 100, unitCost: 250 }], noteDate: addDays(today(), -5) });
    const later = await receiveVia(pos, { supplierId: sup, lines: [{ productId: SP.TISU, quantity: 100, unitCost: 250 }], noteDate: today(), dueDate: addDays(today(), 30) });
    for (const r of [old, soon, later]) expectApplied(r.res);
    const list = await listPayables(finance(), { supplierId: sup });
    const byId = new Map(list.rows.map((r) => [r.receiptId, r]));
    expect(byId.get(old.receiptId)).toMatchObject({ bucket: "d8_30", daysOverdue: 13 });
    expect(byId.get(soon.receiptId)).toMatchObject({ bucket: "not_due", dueDate: addDays(today(), 2) });
    expect(byId.get(later.receiptId)).toMatchObject({ bucket: "not_due" });
    expect(list.bySupplier.find((s) => s.supplierId === sup)).toMatchObject({ total: 75_000, d8_30: 25_000, not_due: 50_000 });
    // Akuntan dapat melihat (baca-saja).
    expect((await listPayables(accountant(), { supplierId: sup })).rows).toHaveLength(3);
    // Pengingat: nota lewat tempo & jatuh tempo ≤ 3 hari (bukan yang 30 hari lagi) — sekali per hari.
    const run = await runPayableReminders(new Date(), t.db);
    expect(run.notified).toBeGreaterThan(0);
    const notes = await notificationsFor(t.db, "supplier_payable.due");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]!.body).toMatch(/CV Umur Utang/);
    const again = await runPayableReminders(new Date(), t.db);
    expect(again.notified).toBe(0);
  });

  it("US-M7-08 KP-2 pembayaran kas kantor/transfer dialokasikan ke nota (sebagian/penuh); bukti wajib untuk transfer; pembalik beralasan", async () => {
    const pos = await makeStore(t.db);
    const sup = await activeSupplier(t.db, "PT Bayar Bertahap");
    const n1 = await receiveVia(pos, { supplierId: sup, lines: [{ productId: SP.SABUN, quantity: 10, unitCost: 20_000 }], noteDate: addDays(today(), -10) });
    const n2 = await receiveVia(pos, { supplierId: sup, lines: [{ productId: SP.SABUN, quantity: 5, unitCost: 20_000 }], noteDate: addDays(today(), -3) });
    expectApplied(n1.res);
    expectApplied(n2.res);
    await expect(recordSupplierPayment(finance(), { supplierId: sup, amount: 100_000, method: "transfer" })).rejects.toThrow(/Bukti transfer/);
    await expect(recordSupplierPayment(pos.cashier.ctx, { supplierId: sup, amount: 100_000, method: "cash" })).rejects.toThrow();
    // Sebagian (kas kantor) → alokasi otomatis ke nota jatuh tempo paling awal.
    const p1 = await recordSupplierPayment(finance(), { supplierId: sup, amount: 150_000, method: "cash", notes: "Bayar sebagian" });
    expect(p1.allocations).toEqual([{ purchaseReceiptId: n1.receiptId, amount: 150_000 }]);
    expect(await receiptRow(t.db, n1.receiptId)).toMatchObject({ paymentStatus: "partial", paidAmount: 150_000 });
    // Transfer + bukti, alokasi manual.
    const proof = await put(t.db, finance(), { blob: JPEG, contentType: "image/jpeg", kind: "transfer_proof" });
    await expect(
      recordSupplierPayment(finance(), { supplierId: sup, amount: 60_000, method: "transfer", proofAttachmentId: proof.id, allocations: [{ purchaseReceiptId: n1.receiptId, amount: 60_000 }] }),
    ).rejects.toThrow(/melebihi sisa/);
    const p2 = await recordSupplierPayment(finance(), {
      supplierId: sup,
      amount: 150_000,
      method: "transfer",
      proofAttachmentId: proof.id,
      allocations: [
        { purchaseReceiptId: n1.receiptId, amount: 50_000 },
        { purchaseReceiptId: n2.receiptId, amount: 100_000 },
      ],
    });
    expect(await receiptRow(t.db, n1.receiptId)).toMatchObject({ paymentStatus: "paid", paidAmount: 200_000 });
    expect(await receiptRow(t.db, n2.receiptId)).toMatchObject({ paymentStatus: "paid" });
    await expect(recordSupplierPayment(finance(), { supplierId: sup, amount: 1_000, method: "cash" })).rejects.toThrow(/melebihi total utang/);
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "supplier_payment.recorded"), eq(domainEvents.objectId, p2.payment.id)));
    expect(ev!.payload).toMatchObject({ supplierId: sup, amount: 150_000, method: "transfer" });
    // Pembalik ≤ PAR-21 langsung: nota kembali berutang.
    const rev = await reverseSupplierPayment(finance(), { paymentId: p1.payment.id, reason: "Salah pemasok dibayar" });
    expect(rev.status).toBe("reversed");
    expect(await receiptRow(t.db, n1.receiptId)).toMatchObject({ paymentStatus: "partial", paidAmount: 50_000 });
    await expect(reverseSupplierPayment(finance(), { paymentId: p1.payment.id, reason: "Ulang lagi" })).rejects.toThrow(/sudah dibalik/);
  });

  it("US-M7-08 KP-3 saldo awal utang pemasok cut-over dari nota (tanpa stok) + terintegrasi ke M11 lewat event utang", async () => {
    const sup = await activeSupplier(t.db, "Pemasok Lama");
    const row = await recordOpeningPayable(finance(), { supplierId: sup, supplierNoteNumber: "LAMA-01", supplierNoteDate: addDays(today(), -40), amount: 1_250_000 });
    expect(row).toMatchObject({ isOpeningPayable: true, totalAmount: 1_250_000, dueDate: addDays(today(), -10) });
    await expect(recordOpeningPayable(finance(), { supplierId: sup, supplierNoteNumber: "LAMA-01", supplierNoteDate: today(), amount: 1 })).rejects.toThrow(/sudah tercatat/);
    await expect(recordOpeningPayable(accountant(), { supplierId: sup, supplierNoteNumber: "LAMA-02", supplierNoteDate: today(), amount: 1 })).rejects.toThrow();
    const list = await listPayables(finance(), { supplierId: sup });
    expect(list.rows[0]).toMatchObject({ isOpeningPayable: true, outstanding: 1_250_000, daysOverdue: 10 });
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "purchase_receipt.recorded"), eq(domainEvents.objectId, row.id)));
    expect(ev!.payload).toMatchObject({ isOpeningPayable: true, total: 1_250_000, paymentMode: "credit" });
    expect(await t.db.select().from(stockLedger).where(eq(stockLedger.sourceObjectId, row.id))).toHaveLength(0);
  });
});
