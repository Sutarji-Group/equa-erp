import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, domainEvents, internalTransferLines, internalTransfers, outlets, reorderItems, stockCounts, stockLedger, tenants } from "@/db/schema";
import { EQUA_TENANT_ID, outletId, productId } from "@/db/seed";
import type { PosReference } from "@/client/m6-pos/contract";
import type { StoreReference } from "@/client/m7-store/contract";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { exportReport } from "@/server/core/export";
import { ForbiddenError } from "@/server/core/errors";
import { getReorderList, runStoreStockCountCheck, stockCountHistory, submitStoreStockCount, transferReport } from "@/server/modules/m7-store";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { posFor } from "../m6-pos/helpers";
import {
  activeSupplier,
  balanceOf,
  expectApplied,
  expectRejected,
  finance,
  GENERAL,
  makeStore,
  notificationsFor,
  openShiftVia,
  owner,
  receiveVia,
  sellVia,
  SP,
  stockUp,
} from "./helpers";

describe("US-M7-03 Stok minimum dan daftar pesan ulang", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M7-03 KP-1 saldo ≤ stok minimum → daftar pesan ulang (saldo, rata-rata jual 30 hari, pemasok terakhir) + notifikasi kasir toko itu", async () => {
    const pos = await makeStore(t.db);
    const sup = await activeSupplier(t.db, "CV Sabun Bersih");
    await stockUp(t.db, pos, [{ productId: SP.SABUN, quantity: 9, unitCost: 20_000 }], sup); // minimum seed = 6
    const shiftId = await openShiftVia(pos);
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.SABUN, quantity: 2, unitPrice: GENERAL.SABUN }])).res);
    let list = await getReorderList(finance(), { outletId: pos.outletId });
    expect(list.rows.some((r) => r.productId === SP.SABUN)).toBe(false);
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.SABUN, quantity: 1, unitPrice: GENERAL.SABUN }])).res);
    list = await getReorderList(finance(), { outletId: pos.outletId });
    const item = list.rows.find((r) => r.productId === SP.SABUN)!;
    expect(item).toMatchObject({ status: "open", balance: 6, balanceAtTrigger: 6, minStock: 6, lastSupplierName: "CV Sabun Bersih", lastUnitCost: 20_000 });
    expect(item.avgDailySales).toBe(0.1);
    const notes = await notificationsFor(t.db, "store.stock_minimum", { recipient: pos.cashier.userId });
    expect(notes).toHaveLength(1);
    // Hanya kasir toko itu yang menerima (berlingkup outlet) — kasir toko lain tidak.
    expect((await notificationsFor(t.db, "store.stock_minimum", { objectId: pos.outletId })).map((n) => n.recipientUserId)).toEqual([pos.cashier.userId]);
    // Penjualan berikutnya tidak menggandakan baris/notifikasi.
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.SABUN, quantity: 1, unitPrice: GENERAL.SABUN }])).res);
    const live = await t.db.select().from(reorderItems).where(and(eq(reorderItems.outletId, pos.outletId), eq(reorderItems.productId, SP.SABUN)));
    expect(live).toHaveLength(1);
    const ref = (await pos.hp.pull(pos.op, { keys: "m7.store" })).data["m7.store"] as StoreReference;
    expect(ref.reorder.find((r) => r.productId === SP.SABUN)).toMatchObject({ balance: 5, lastSupplierName: "CV Sabun Bersih" });
  });

  it("US-M7-03 KP-2 ditandai \"sudah dipesan\" (tanggal, pemasok) dari POS dan hilang otomatis saat nota penerimaan masuk", async () => {
    const pos = await makeStore(t.db);
    const sup = await activeSupplier(t.db, "UD Lampu Terang");
    await stockUp(t.db, pos, [{ productId: SP.UV, quantity: 4, unitCost: 100_000 }], sup); // minimum 3
    const shiftId = await openShiftVia(pos);
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.UV, quantity: 1, unitPrice: GENERAL.UV }])).res);
    const [item] = await t.db.select().from(reorderItems).where(and(eq(reorderItems.outletId, pos.outletId), eq(reorderItems.productId, SP.UV)));
    expect(item!.status).toBe("open");
    expectRejected(await pos.send("m7.reorder.mark_ordered", { itemId: item!.id, supplierId: newId() }));
    expectApplied(await pos.send("m7.reorder.mark_ordered", { itemId: item!.id, supplierId: sup, orderedOn: toBusinessDate(new Date()) }));
    const [ordered] = await t.db.select().from(reorderItems).where(eq(reorderItems.id, item!.id));
    expect(ordered).toMatchObject({ status: "ordered", orderedSupplierId: sup, orderedBy: pos.cashier.userId });
    expect(ordered!.orderedAt).toBeTruthy();
    const rec = await receiveVia(pos, { supplierId: sup, lines: [{ productId: SP.UV, quantity: 5, unitCost: 110_000 }] });
    expectApplied(rec.res);
    const [closed] = await t.db.select().from(reorderItems).where(eq(reorderItems.id, item!.id));
    expect(closed).toMatchObject({ status: "closed", closedByReceiptId: rec.receiptId });
    expect((await getReorderList(finance(), { outletId: pos.outletId })).rows.some((r) => r.productId === SP.UV)).toBe(false);
  });

  it("US-M7-03 KP-3 daftar pesan ulang diekspor Excel/PDF untuk pemesanan ke pemasok", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.DISPENSER, quantity: 2, unitCost: 700_000 }]); // minimum 2 → langsung masuk daftar
    const xlsx = await exportReport(finance(), "m7.reorder", "xlsx", { outletId: pos.outletId });
    expect(xlsx.rowCount).toBeGreaterThanOrEqual(1);
    const pdf = await exportReport(owner(), "m7.reorder", "pdf", { outletId: pos.outletId });
    expect(pdf.contentType).toBe("application/pdf");
    expect(pdf.body.length).toBeGreaterThan(0);
    await expect(exportReport(seededContext("dispatcher1"), "m7.reorder", "xlsx", {})).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("US-M7-05 Stok opname dan penyesuaian", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M7-05 KP-1 hitung buta per barang: saldo sistem tampil setelah jumlah fisik dimasukkan; selisih jumlah & nilai (harga pokok)", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [
      { productId: SP.FILTER, quantity: 10, unitCost: 25_000 },
      { productId: SP.POMPA, quantity: 5, unitCost: 15_000 },
    ]);
    const countId = newId();
    let ref = (await pos.hp.pull(pos.op, { keys: "m7.store" })).data["m7.store"] as StoreReference;
    expect(ref.openStockCount).toBeNull();
    const res = await pos.send("m7.stock_count.count", { stockCountId: countId, lines: [{ productId: SP.FILTER, physicalQty: 8 }] });
    expectApplied(res);
    expect((res.result as { lines: unknown[] }).lines).toEqual([{ productId: SP.FILTER, systemQty: 10, differenceQty: -2, differenceValue: -50_000 }]);
    ref = (await pos.hp.pull(pos.op, { keys: "m7.store" })).data["m7.store"] as StoreReference;
    // Hanya barang yang sudah dihitung yang menampilkan saldo sistem di lembar hitung.
    expect(ref.openStockCount?.lines.map((l) => l.productId)).toEqual([SP.FILTER]);
    const [count] = await t.db.select().from(stockCounts).where(eq(stockCounts.id, countId));
    expect(count).toMatchObject({ kind: "monthly_store", status: "counting", periodLabel: toBusinessDate(new Date()).slice(0, 7), countedBy: pos.cashier.userId });
    // Hitung ulang barang yang sama menimpa baris (masih "Dihitung"); opname kedua di bulan yang sama ditolak.
    expectApplied(await pos.send("m7.stock_count.count", { stockCountId: countId, lines: [{ productId: SP.FILTER, physicalQty: 9 }, { productId: SP.POMPA, physicalQty: 5 }] }));
    expectRejected(await pos.send("m7.stock_count.count", { stockCountId: newId(), lines: [{ productId: SP.POMPA, physicalQty: 5 }] }), /sudah berjalan/);
  });

  it("US-M7-05 KP-2 selisih → usulan penyesuaian beralasan oleh Admin Keuangan bersama kasir → persetujuan pemilik → kartu stok + stock.adjusted (beban selisih L4)", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [
      { productId: SP.SIKAT, quantity: 10, unitCost: 12_000 },
      { productId: SP.TUTUP, quantity: 100, unitCost: 500 },
    ]);
    const countId = newId();
    expectApplied(await pos.send("m7.stock_count.count", { stockCountId: countId, lines: [{ productId: SP.SIKAT, physicalQty: 7 }, { productId: SP.TUTUP, physicalQty: 100 }] }));
    // Kasir penghitung tidak dapat mengajukan sendiri (opname bersama Admin Keuangan).
    await expect(submitStoreStockCount(pos.cashier.ctx, { stockCountId: countId, reasons: [{ productId: SP.SIKAT, reason: "damaged" }] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(submitStoreStockCount(finance(), { stockCountId: countId })).rejects.toThrow(/alasan/);
    await expect(submitStoreStockCount(finance(), { stockCountId: countId, reasons: [{ productId: SP.SIKAT, reason: "other" }] })).rejects.toThrow(/keterangan/);
    const sub = await submitStoreStockCount(finance(), { stockCountId: countId, reasons: [{ productId: SP.SIKAT, reason: "damaged", reasonNote: "Patah" }] });
    expect(sub).toMatchObject({ differences: 1, totalValue: -36_000 });
    expect(sub.approval).toMatchObject({ type: "stock_adjustment", approverRole: "owner" });
    expect(await balanceOf(t.db, pos.outletId, SP.SIKAT)).toBe(10);
    await approvals.decide(owner(), sub.approval!.id, "approve");
    expect(await balanceOf(t.db, pos.outletId, SP.SIKAT)).toBe(7);
    const [adj] = await t.db.select().from(stockLedger).where(and(eq(stockLedger.sourceObjectId, countId), eq(stockLedger.kind, "adjustment")));
    expect(adj).toMatchObject({ quantity: -3, productId: SP.SIKAT });
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "stock.adjusted"), eq(domainEvents.objectId, countId)));
    expect(ev!.payload).toMatchObject({ outletKind: "store", totalValue: -36_000 });
    const [done] = await t.db.select().from(stockCounts).where(eq(stockCounts.id, countId));
    expect(done).toMatchObject({ status: "approved", coCounterUserId: seededFinanceId() });
  });

  it("US-M7-05 KP-2 penyesuaian ditolak pemilik → saldo tidak berubah", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.POMPA, quantity: 5, unitCost: 15_000 }]);
    const countId = newId();
    expectApplied(await pos.send("m7.stock_count.count", { stockCountId: countId, lines: [{ productId: SP.POMPA, physicalQty: 4, reason: "lost" }] }));
    const sub = await submitStoreStockCount(finance(), { stockCountId: countId });
    await approvals.decide(owner(), sub.approval!.id, "reject", "Hitung ulang dulu");
    expect(await balanceOf(t.db, pos.outletId, SP.POMPA)).toBe(5);
    const [row] = await t.db.select().from(stockCounts).where(eq(stockCounts.id, countId));
    expect(row!.status).toBe("rejected");
  });

  it("US-M7-05 KP-3 penjualan tetap boleh selama opname; selisih dihitung dari saldo PADA WAKTU hitung per barang", async () => {
    const pos = await makeStore(t.db);
    const base = Date.now();
    const at = (min: number) => {
      const d = new Date(base - min * 60_000);
      return { deviceTime: d.toISOString(), businessDate: toBusinessDate(d) };
    };
    const sup = await activeSupplier(t.db);
    const rec = await receiveVia(
      pos,
      {
        supplierId: sup,
        lines: [
          { productId: SP.GALON, quantity: 10, unitCost: 30_000 },
          { productId: SP.SABUN, quantity: 10, unitCost: 20_000 },
        ],
        noteDate: at(60).businessDate,
      },
      at(60),
    );
    expectApplied(rec.res);
    const shiftId = await openShiftVia(pos);
    const countId = newId();
    // Galon dihitung (10) sebelum penjualan 2 galon; perangkat mengirim hitungan setelah penjualan tersinkron.
    const countedAt = new Date(base - 20 * 60_000).toISOString();
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.GALON, quantity: 2, unitPrice: GENERAL.GALON }], { cmd: at(10) })).res);
    expectApplied((await sellVia(pos, shiftId, [{ productId: SP.SABUN, quantity: 1, unitPrice: GENERAL.SABUN }], { cmd: at(10) })).res);
    const res = await pos.send("m7.stock_count.count", {
      stockCountId: countId,
      lines: [
        { productId: SP.GALON, physicalQty: 10, countedAt },
        { productId: SP.SABUN, physicalQty: 9 },
      ],
    });
    expectApplied(res);
    const lines = (res.result as { lines: { productId: string; systemQty: number; differenceQty: number }[] }).lines;
    expect(lines.find((l) => l.productId === SP.GALON)).toMatchObject({ systemQty: 10, differenceQty: 0 });
    expect(lines.find((l) => l.productId === SP.SABUN)).toMatchObject({ systemQty: 9, differenceQty: 0 });
    const sub = await submitStoreStockCount(finance(), { stockCountId: countId });
    expect(sub.differences).toBe(0);
    expect(sub.stockCount.status).toBe("approved");
  });

  it("US-M7-05 KP-4 opname bulan lalu belum dilakukan sampai tanggal 5 bulan berikutnya → ditandai ke pemilik (sekali)", async () => {
    const pos = await makeStore(t.db);
    const done = await makeStore(t.db);
    await t.db.insert(stockCounts).values({ tenantId: EQUA_TENANT_ID, outletId: done.outletId, kind: "monthly_store", periodLabel: "2026-10", status: "approved", startedAt: new Date("2026-10-30T03:00:00Z") });
    const day5 = await runStoreStockCountCheck(new Date("2026-11-05T05:00:00Z"), t.db);
    expect(day5.flagged).toBe(0);
    const day6 = await runStoreStockCountCheck(new Date("2026-11-06T01:00:00Z"), t.db);
    expect(day6.flagged).toBeGreaterThan(0);
    const notes = await notificationsFor(t.db, "stock_count.overdue", { objectId: pos.outletId });
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]!.title).toMatch(/2026-10/);
    expect(await notificationsFor(t.db, "stock_count.overdue", { objectId: done.outletId })).toHaveLength(0);
    const again = await runStoreStockCountCheck(new Date("2026-11-07T01:00:00Z"), t.db);
    expect((await notificationsFor(t.db, "stock_count.overdue", { objectId: pos.outletId })).length).toBe(notes.length);
    expect(again.flagged).toBe(0);
  });

  it("US-M7-05 KP-5 riwayat opname & selisih per barang per bulan tersedia (masukan laporan margin)", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.TISU, quantity: 100, unitCost: 200 }]);
    const countId = newId();
    expectApplied(await pos.send("m7.stock_count.count", { stockCountId: countId, lines: [{ productId: SP.TISU, physicalQty: 95, reason: "miscount" }] }));
    const sub = await submitStoreStockCount(finance(), { stockCountId: countId });
    await approvals.decide(owner(), sub.approval!.id, "approve");
    const hist = await stockCountHistory(owner(), { outletId: pos.outletId, productId: SP.TISU });
    expect(hist[0]).toMatchObject({ periodLabel: toBusinessDate(new Date()).slice(0, 7), physicalQty: 95, systemQty: 100, differenceQty: -5, differenceValue: -1_000, reason: "miscount", status: "approved" });
    const x = await exportReport(finance(), "m7.stock_counts", "xlsx", { outletId: pos.outletId });
    expect(x.rowCount).toBe(1);
  });
});

function seededFinanceId() {
  return finance().userId;
}

describe("US-M7-06 Transfer internal bahan ke depot sendiri", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M7-06 KP-1 stok toko berkurang saat dikirim; stok depot bertambah saat operator mengonfirmasi di POS depot; selisih kirim–terima ditandai", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [
      { productId: SP.TUTUP, quantity: 200, unitCost: 500 },
      { productId: SP.TISU, quantity: 200, unitCost: 200 },
    ]);
    const depot = outletId("D06");
    const depotTutupBefore = await balanceOf(t.db, depot, productId("TUTUP"));
    const transferId = newId();
    const res = await pos.send("m7.internal_transfer.create", {
      transferId,
      localNumber: `${pos.outletCode}-TI-0001`,
      deviceSeq: 1,
      toOutletId: depot,
      lines: [
        { productId: SP.TUTUP, quantity: 50 },
        { productId: SP.TISU, quantity: 30 },
      ],
    });
    expectApplied(res);
    expect(await balanceOf(t.db, pos.outletId, SP.TUTUP)).toBe(150);
    expect(await balanceOf(t.db, pos.outletId, SP.TISU)).toBe(170);
    expect(await balanceOf(t.db, depot, productId("TUTUP"))).toBe(depotTutupBefore);
    const [tr] = await t.db.select().from(internalTransfers).where(eq(internalTransfers.id, transferId));
    expect(tr).toMatchObject({ status: "sent", fromOutletId: pos.outletId, toOutletId: depot });
    expect(tr!.number).toMatch(/^TI-\d{2}-\d{5}$/);
    // Operator depot menerima di POS depot (handler M6) — tisu kurang 2 dengan alasan.
    const dpos = await posFor("D06");
    const ref = (await dpos.hp.pull(dpos.op, { keys: "m6.pos" })).data["m6.pos"] as PosReference;
    const incoming = ref.transfers.find((x) => x.id === transferId)!;
    expect(incoming.lines).toHaveLength(2);
    const lines = await t.db.select().from(internalTransferLines).where(eq(internalTransferLines.transferId, transferId));
    const tisuLine = lines.find((l) => l.productId === SP.TISU)!;
    const tutupLine = lines.find((l) => l.productId === SP.TUTUP)!;
    expectApplied(
      await dpos.send("m6.internal_transfer.receive", {
        transferId,
        receiptId: newId(),
        lines: [
          { lineId: tutupLine.id, quantityReceived: 50 },
          { lineId: tisuLine.id, quantityReceived: 28, reason: "2 bungkus basah" },
        ],
      }),
    );
    expect(await balanceOf(t.db, depot, productId("TUTUP"))).toBe(depotTutupBefore + 50);
    const [after] = await t.db.select().from(internalTransfers).where(eq(internalTransfers.id, transferId));
    expect(after).toMatchObject({ status: "received", hasDifference: true });
    expect((await notificationsFor(t.db, "store.transfer_difference", { objectId: transferId })).length).toBeGreaterThan(0);
  });

  it("US-M7-06 KP-2 nilai transfer = harga mitra (PTB-37) tanpa kas/piutang; event transfer terkirim (pendapatan internal L4 & persediaan L3 di M11)", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [{ productId: SP.GALON, quantity: 10, unitCost: 30_000 }]);
    const transferId = newId();
    expectApplied(await pos.send("m7.internal_transfer.create", { transferId, localNumber: `${pos.outletCode}-TI-0002`, deviceSeq: 2, toOutletId: outletId("D07"), lines: [{ productId: SP.GALON, quantity: 4 }] }));
    const [line] = await t.db.select().from(internalTransferLines).where(eq(internalTransferLines.transferId, transferId));
    expect(line).toMatchObject({ unitValue: 35_000, unitCost: 30_000, lineValue: 140_000, toProductId: productId("GALON-KOSONG") });
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "internal_transfer.sent"), eq(domainEvents.objectId, transferId)));
    expect(ev!.payload).toMatchObject({ totalValue: 140_000, totalCost: 120_000, toOutletId: outletId("D07") });
    const [led] = await t.db.select().from(stockLedger).where(and(eq(stockLedger.sourceObjectId, transferId), eq(stockLedger.kind, "transfer_out")));
    expect(led).toMatchObject({ quantity: -4 });
  });

  it("US-M7-06 KP-3 tanpa persetujuan, dilaporkan bulanan per depot; ke outlet mitra/non-depot atau barang tak terpetakan ditolak", async () => {
    const pos = await makeStore(t.db);
    await stockUp(t.db, pos, [
      { productId: SP.TUTUP, quantity: 100, unitCost: 500 },
      { productId: SP.SABUN, quantity: 5, unitCost: 20_000 },
    ]);
    const transferId = newId();
    expectApplied(await pos.send("m7.internal_transfer.create", { transferId, localNumber: `${pos.outletCode}-TI-0003`, deviceSeq: 3, toOutletId: outletId("D08"), lines: [{ productId: SP.TUTUP, quantity: 40 }] }));
    expect(await t.db.select().from(approvalRequests).where(eq(approvalRequests.objectId, transferId))).toHaveLength(0);
    // Outlet mitra (tenant lain) → bukan transfer internal.
    const partnerTenant = newId();
    await t.db.insert(tenants).values({ id: partnerTenant, code: "MTR9", name: "Mitra Uji", kind: "partner" });
    const partnerOutlet = newId();
    await t.db.insert(outlets).values({ id: partnerOutlet, tenantId: partnerTenant, code: "MD9", name: "Depot Mitra", kind: "depot" });
    expectRejected(await pos.send("m7.internal_transfer.create", { transferId: newId(), localNumber: `${pos.outletCode}-TI-0004`, deviceSeq: 4, toOutletId: partnerOutlet, lines: [{ productId: SP.TUTUP, quantity: 1 }] }), /penjualan/);
    expectRejected(await pos.send("m7.internal_transfer.create", { transferId: newId(), localNumber: `${pos.outletCode}-TI-0005`, deviceSeq: 5, toOutletId: outletId("TK1"), lines: [{ productId: SP.TUTUP, quantity: 1 }] }), /depot/);
    expectRejected(await pos.send("m7.internal_transfer.create", { transferId: newId(), localNumber: `${pos.outletCode}-TI-0006`, deviceSeq: 6, toOutletId: outletId("D08"), lines: [{ productId: SP.SABUN, quantity: 1 }] }), /dipetakan/);
    expectRejected(await pos.send("m7.internal_transfer.create", { transferId: newId(), localNumber: `${pos.outletCode}-TI-0007`, deviceSeq: 7, toOutletId: outletId("D08"), lines: [{ productId: SP.TUTUP, quantity: 500 }] }), /tinggal/);
    const month = toBusinessDate(new Date()).slice(0, 7);
    const rep = await transferReport(owner(), { month });
    expect(rep.byDepot.find((d) => d.outletId === outletId("D08"))).toMatchObject({ transfers: 1, totalValue: 40 * 600 });
    const x = await exportReport(finance(), "m7.internal_transfers", "pdf", { month });
    expect(x.contentType).toBe("application/pdf");
  });
});
