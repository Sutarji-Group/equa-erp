import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { approvalRequests, depotRecipes, domainEvents, internalTransferLines, internalTransfers, stockBalances, stockCounts, stockLedger } from "@/db/schema";
import { EQUA_TENANT_ID, outletId, productId } from "@/db/seed";
import { deviceShiftFigures, expectedClosingStock, stockReasonRequired, type PosReference } from "@/client/m6-pos/contract";
import { newId } from "@/lib/ids";
import { toBusinessDate } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { runStockCountCheck, stockCardReport, usageVsSalesReport } from "@/server/modules/m6-pos";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { closeVia, expectApplied, finance, galonBaru, isi, notificationsFor, openShiftVia, owner, P, posFor, sellVia, stockUp } from "./helpers";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

async function balance(db: ReturnType<typeof useTestDb>["db"], outlet: string, product: string) {
  const [b] = await db.select().from(stockBalances).where(and(eq(stockBalances.outletId, outlet), eq(stockBalances.productId, product)));
  return b?.quantity ?? 0;
}

describe("US-M6-04 Stok bahan habis pakai dan opname mingguan", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M6-04 KP-1 kartu stok per bahan per outlet: masuk (transfer internal toko / pemasok bernota), keluar (pemakaian seharusnya), penyesuaian; saldo berjalan", async () => {
    const pos = await posFor("D04");
    // Pemasok lain dengan nota + foto.
    const cmdId = newId();
    const up = await pos.hp.upload(pos.op, { bytes: JPEG, kind: "supplier_note", commandId: cmdId });
    const rec = await pos.send(
      "m6.consumable_receipt.create",
      { receiptId: newId(), source: "supplier", supplierName: "Toko Plastik Sinar", supplierNoteNumber: "N-0091", lines: [{ productId: P.TUTUP, quantity: 100, unitCost: 700 }] },
      { id: cmdId, attachmentIds: [up.attachmentId], attachmentHashes: [up.sha256] },
    );
    expectApplied(rec);
    // Transfer internal dari toko EQUA (dibuat M7): Dikirim → Diterima di POS depot, selisih kirim–terima ditandai.
    const transferId = newId();
    await t.db.insert(internalTransfers).values({
      id: transferId,
      tenantId: EQUA_TENANT_ID,
      number: "TI-26-90001",
      fromOutletId: outletId("TK1"),
      toOutletId: pos.outletId,
      status: "sent",
      businessDate: toBusinessDate(new Date()),
      sentAt: new Date(),
      totalValue: 50 * 300 + 30 * 600,
    });
    const lineTisu = newId();
    const lineTutup = newId();
    await t.db.insert(internalTransferLines).values([
      { id: lineTisu, tenantId: EQUA_TENANT_ID, transferId, productId: productId("TK-TISU"), quantitySent: 50, unitValue: 300, lineValue: 15_000 },
      { id: lineTutup, tenantId: EQUA_TENANT_ID, transferId, productId: productId("TK-TUTUP"), quantitySent: 30, unitValue: 600, lineValue: 18_000 },
    ]);
    const ref = (await pos.hp.pull(pos.op, { keys: "m6.pos" })).data["m6.pos"] as PosReference;
    expect(ref.transfers.find((x) => x.id === transferId)?.lines).toHaveLength(2);
    const noReason = await pos.send("m6.internal_transfer.receive", { transferId, receiptId: newId(), lines: [{ lineId: lineTisu, quantityReceived: 48 }] });
    expect(noReason.status).toBe("rejected");
    const recv = await pos.send("m6.internal_transfer.receive", {
      transferId,
      receiptId: newId(),
      lines: [
        { lineId: lineTisu, quantityReceived: 48, reason: "2 bungkus basah" },
        { lineId: lineTutup, quantityReceived: 30 },
      ],
    });
    expectApplied(recv);
    const [tr] = await t.db.select().from(internalTransfers).where(eq(internalTransfers.id, transferId));
    expect(tr).toMatchObject({ status: "received", hasDifference: true });
    expect((await pos.send("m6.internal_transfer.receive", { transferId, receiptId: newId(), lines: [{ lineId: lineTutup, quantityReceived: 30 }] })).status).toBe("rejected");
    expect(await balance(t.db, pos.outletId, P.TUTUP)).toBe(130);
    expect(await balance(t.db, pos.outletId, P.TISU)).toBe(48);
    // Keluar: pemakaian seharusnya saat tutup shift.
    const { shiftId } = await openShiftVia(pos);
    await sellVia(pos, shiftId, [isi(10)]);
    expectApplied(await closeVia(pos, shiftId, { counted: 250_000, stock: [{ productId: P.TUTUP, physicalQty: 120 }, { productId: P.TISU, physicalQty: 38 }, { productId: P.GALON_KOSONG, physicalQty: 0 }] }));
    const card = await stockCardReport(finance(), { outletId: pos.outletId, productId: P.TUTUP, from: toBusinessDate(new Date()), to: toBusinessDate(new Date()) });
    expect(card.rows.map((r) => [r.kind, r.quantity, r.balanceAfter])).toEqual([
      ["receipt", 100, 100],
      ["transfer_in", 30, 130],
      ["consumption", -10, 120],
    ]);
    const [recEv] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "internal_transfer.received"), eq(domainEvents.objectId, transferId)));
    expect(recEv!.payload).toMatchObject({ hasDiscrepancy: true, totalValue: 48 * 300 + 30 * 600 });
  });

  it("US-M6-04 KP-2 pemakaian seharusnya dari resep per produk yang ditetapkan per tenant (1 isi ulang = 1 tutup + 1 tisu; 1 galon baru = 1 galon kosong + 1 tutup)", async () => {
    const pos = await posFor("D05");
    await stockUp(pos, { tutup: 50, tisu: 50, galonKosong: 10 });
    const { shiftId } = await openShiftVia(pos);
    await sellVia(pos, shiftId, [isi(4), galonBaru(2)]);
    const ref = (await pos.hp.pull(pos.op, { keys: "m6.pos" })).data["m6.pos"] as PosReference;
    const f = deviceShiftFigures(ref.openShift!, ref.recipes);
    expect(f.usage).toMatchObject({ [P.TUTUP]: 6, [P.TISU]: 4, [P.GALON_KOSONG]: 2 });
    expect(expectedClosingStock(ref.materials, f.usage)).toMatchObject({ [P.TUTUP]: 44, [P.TISU]: 46, [P.GALON_KOSONG]: 8 });
    // Resep diubah pemilik (berlaku hari ini): isi ulang kini 2 tisu.
    await t.db.insert(depotRecipes).values({ tenantId: EQUA_TENANT_ID, productId: P.ISI, materialProductId: P.TISU, quantity: 2, effectiveFrom: toBusinessDate(new Date()) });
    await sellVia(pos, shiftId, [isi(1)]);
    expectApplied(await closeVia(pos, shiftId, { counted: 200_000 + 20_000 + 90_000 + 5_000, stock: [{ productId: P.TUTUP, physicalQty: 43 }, { productId: P.TISU, physicalQty: 40 }, { productId: P.GALON_KOSONG, physicalQty: 8 }] }));
    expect(await balance(t.db, pos.outletId, P.TISU)).toBe(50 - 10); // 5 isi ulang × 2 tisu (resep berlaku hari ini)
  });

  it("US-M6-04 KP-3 stok fisik tutup shift dicatat; selisih harian hanya informasi (saldo tidak berubah); di luar PAR-58 wajib alasan", async () => {
    const pos = await posFor("D06");
    await stockUp(pos, { tutup: 20, tisu: 20, galonKosong: 5 });
    const { shiftId } = await openShiftVia(pos);
    await sellVia(pos, shiftId, [isi(2)]); // resep berlaku (diubah uji KP-2): 1 tutup + 2 tisu per isi ulang
    expect(stockReasonRequired(-3, 0)).toBe(true);
    expect(stockReasonRequired(-1, 2)).toBe(false);
    const rejected = await closeVia(pos, shiftId, { counted: 210_000, stock: [{ productId: P.TUTUP, physicalQty: 15 }, { productId: P.TISU, physicalQty: 18 }, { productId: P.GALON_KOSONG, physicalQty: 5 }] });
    expect(rejected.status).toBe("rejected");
    expectApplied(
      await closeVia(pos, shiftId, { counted: 210_000, stock: [{ productId: P.TUTUP, physicalQty: 15, reason: "Tutup jatuh ke got" }, { productId: P.TISU, physicalQty: 16 }, { productId: P.GALON_KOSONG, physicalQty: 5 }] }),
    );
    expect(await balance(t.db, pos.outletId, P.TUTUP)).toBe(18); // 20 − 2 pemakaian; fisik 15 tidak mengubah saldo
  });

  it("US-M6-04 KP-4 opname mingguan → usulan penyesuaian beralasan → persetujuan pemilik (tenggat 3 hari) → saldo + stock.adjusted; belum opname minggu ini → Admin Keuangan", async () => {
    const pos = await posFor("D07");
    await stockUp(pos, { tutup: 40, tisu: 40, galonKosong: 6 });
    const noReason = await pos.send("m6.stock_count.submit", { stockCountId: newId(), lines: [{ productId: P.TUTUP, physicalQty: 35 }] });
    expect(noReason.status).toBe("rejected");
    const countId = newId();
    const res = await pos.send("m6.stock_count.submit", {
      stockCountId: countId,
      lines: [
        { productId: P.TUTUP, physicalQty: 35, reason: "lost" },
        { productId: P.TISU, physicalQty: 42, reason: "miscount" },
        { productId: P.GALON_KOSONG, physicalQty: 6 },
      ],
    });
    expectApplied(res);
    const [count] = await t.db.select().from(stockCounts).where(eq(stockCounts.id, countId));
    expect(count).toMatchObject({ status: "submitted", kind: "weekly_depot" });
    const [appr] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, count!.approvalRequestId!));
    expect(appr!.type).toBe("stock_adjustment");
    expect(Math.round((appr!.deadlineAt!.getTime() - appr!.createdAt.getTime()) / 86_400_000)).toBe(3);
    expect(await balance(t.db, pos.outletId, P.TUTUP)).toBe(40); // belum disetujui → saldo tetap
    await approvals.decide(owner(), appr!.id, "approve");
    expect(await balance(t.db, pos.outletId, P.TUTUP)).toBe(35);
    expect(await balance(t.db, pos.outletId, P.TISU)).toBe(42);
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "stock.adjusted"), eq(domainEvents.objectId, countId)));
    expect((ev!.payload as { lines: unknown[] }).lines).toHaveLength(2);
    // Ditolak → saldo tidak berubah.
    const c2 = newId();
    expectApplied(await pos.send("m6.stock_count.submit", { stockCountId: c2, lines: [{ productId: P.TUTUP, physicalQty: 30, reason: "damaged" }] }));
    const [count2] = await t.db.select().from(stockCounts).where(eq(stockCounts.id, c2));
    await approvals.decide(owner(), count2!.approvalRequestId!, "reject", "Hitung ulang bersama Admin Keuangan");
    expect(await balance(t.db, pos.outletId, P.TUTUP)).toBe(35);
    expect((await t.db.select().from(stockCounts).where(eq(stockCounts.id, c2)))[0]!.status).toBe("rejected");
    // Job mingguan: depot tanpa opname minggu ini ditandai ke Admin Keuangan.
    const check = await runStockCountCheck(new Date());
    expect(check.flagged).toContain(outletId("D08"));
    expect(check.flagged).not.toContain(pos.outletId);
    expect((await notificationsFor(t.db, "stock_count.overdue", { objectId: outletId("D08") })).length).toBeGreaterThan(0);
  });

  it("US-M6-04 KP-5 penerimaan bahan dicatat operator saat tiba (jumlah, sumber, foto nota pemasok luar); tanpa pencatatan stok tidak bertambah", async () => {
    const pos = await posFor("D08");
    const before = await balance(t.db, pos.outletId, P.GALON_KOSONG);
    const noPhoto = await pos.send("m6.consumable_receipt.create", { receiptId: newId(), source: "supplier", supplierName: "CV Galon", supplierNoteNumber: "G-1", lines: [{ productId: P.GALON_KOSONG, quantity: 10, unitCost: 30_000 }] });
    expect(noPhoto.status).toBe("rejected");
    expect(noPhoto.message).toMatch(/Foto nota/);
    expect(await balance(t.db, pos.outletId, P.GALON_KOSONG)).toBe(before);
    const notConsumable = await pos.send("m6.consumable_receipt.create", { receiptId: newId(), source: "other", lines: [{ productId: P.ISI, quantity: 10 }] });
    expect(notConsumable.status).toBe("rejected");
    await stockUp(pos, { tutup: 0, tisu: 0, galonKosong: 10 });
    expect(await balance(t.db, pos.outletId, P.GALON_KOSONG)).toBe(before + 10);
  });

  it("US-M6-04 KP-6 laporan pemakaian vs penjualan per outlet per minggu/bulan dengan rasio bahan per galon", async () => {
    const today = toBusinessDate(new Date());
    const rows = await usageVsSalesReport(owner(), { from: today, to: today, outletId: outletId("D05"), granularity: "month" });
    const tutup = rows.find((r) => r.productId === P.TUTUP)!;
    expect(tutup.gallonsSold).toBe(7);
    expect(tutup.expectedUsage).toBe(7);
    expect(tutup.ratioPerGallon).toBe(1);
    const weekly = await usageVsSalesReport(owner(), { from: today, to: today, granularity: "week" });
    expect(weekly.some((r) => r.period.includes("-W"))).toBe(true);
    const ledger = await t.db.select().from(stockLedger).where(eq(stockLedger.outletId, outletId("D05"))).orderBy(asc(stockLedger.occurredAt));
    expect(ledger.some((l) => l.kind === "consumption")).toBe(true);
  });
});
