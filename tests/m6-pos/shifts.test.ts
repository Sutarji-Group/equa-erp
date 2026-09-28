import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { deposits, domainEvents, outlets, shiftStockCounts, shifts, stockBalances } from "@/db/schema";
import { userIdByUsername } from "@/db/seed";
import type { PosReference } from "@/client/m6-pos/contract";
import { newId } from "@/lib/ids";
import { addDays, toBusinessDate } from "@/lib/time";
import { emit } from "@/server/core/events";
import { withTx } from "@/server/core/db";
import * as params from "@/server/core/params";
import { isShiftFullySynced, runLateDepositCheck } from "@/server/modules/m6-pos";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import {
  closeVia,
  expectApplied,
  galonBaru,
  isi,
  notificationsFor,
  openShiftVia,
  owner,
  P,
  posFor,
  PRICE,
  sellVia,
  stockUp,
} from "./helpers";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);

describe("US-M6-02 Buka & tutup shift dengan kas dan stok fisik; setoran outlet", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M6-02 KP-1 buka shift: kas awal tetap PAR-57 dikonfirmasi hitung fisik; stok awal = saldo sistem; satu shift terbuka per outlet (perangkat cadangan → konflik, bukan ditolak)", async () => {
    const pos = await posFor("D04");
    await stockUp(pos, { tutup: 50, tisu: 40, galonKosong: 5 });
    const { shiftId, res } = await openShiftVia(pos, { counted: 200_000 });
    expectApplied(res);
    const [shift] = await t.db.select().from(shifts).where(eq(shifts.id, shiftId));
    expect(shift).toMatchObject({ openingCashFixed: 200_000, openingCashCounted: 200_000, status: "open", syncConflict: false, businessDate: toBusinessDate(new Date()) });
    const opening = await t.db.select().from(shiftStockCounts).where(and(eq(shiftStockCounts.shiftId, shiftId), eq(shiftStockCounts.phase, "opening")));
    const byProduct = new Map(opening.map((o) => [o.productId, o.systemQty]));
    expect(byProduct.get(P.TUTUP)).toBe(50);
    expect(byProduct.get(P.TISU)).toBe(40);
    expect(byProduct.get(P.GALON_KOSONG)).toBe(5);
    // Kas awal tetap per outlet (kolom outlet mengalahkan PAR-57).
    await t.db.update(outlets).set({ fixedOpeningCash: 300_000 }).where(eq(outlets.id, (await posFor("D05")).outletId));
    const p5 = await posFor("D05");
    const s5 = await openShiftVia(p5, { counted: 300_000 });
    expectApplied(s5.res);
    expect((await t.db.select().from(shifts).where(eq(shifts.id, s5.shiftId)))[0]!.openingCashFixed).toBe(300_000);
    // Perangkat cadangan membuka shift offline saat shift lain masih terbuka → disimpan sebagai KONFLIK.
    const spare = await openShiftVia(pos);
    expect(spare.res.status).toBe("conflict");
    expect(spare.res.message).toMatch(/Shift lain masih terbuka/);
    const [conf] = await t.db.select().from(shifts).where(eq(shifts.id, spare.shiftId));
    expect(conf!.syncConflict).toBe(true);
    expect((await notificationsFor(t.db, "pos.shift_conflict", { objectId: spare.shiftId })).length).toBeGreaterThan(0);
    // Pull: perangkat melihat shift terbuka utama (untuk menutup kemarin dulu / melanjutkan di perangkat cadangan).
    const ref = (await pos.hp.pull(pos.op, { keys: "m6.pos" })).data["m6.pos"] as PosReference;
    expect(ref.openShift?.id).toBe(shiftId);
    expect(ref.conflictShifts.map((s) => s.id)).toContain(spare.shiftId);
    expect(ref.settings.fixedOpeningCash).toBe(200_000);
  });

  it("US-M6-02 KP-2 kas berjalan > PAR-02 → peringatan operator & Admin Keuangan; setor sebagian (setor bank + foto slip) mengurangi kas berjalan", async () => {
    const pos = await posFor("D06");
    const { shiftId } = await openShiftVia(pos);
    const today = toBusinessDate(new Date());
    await params.set(owner(), "PAR-02", { amount: 250_000 }, today, "Uji batas kas outlet D06", { outletId: pos.outletId });
    const s1 = await sellVia(pos, shiftId, [galonBaru(2)]);
    expect((s1.res.result as { cashAlert: boolean }).cashAlert).toBe(true);
    const alerts = await notificationsFor(t.db, "outlet_cash.over_limit", { objectId: shiftId });
    const recipients = new Set(alerts.map((a) => a.recipientUserId));
    expect(recipients.has(userIdByUsername("depot06"))).toBe(true);
    expect(recipients.has(userIdByUsername("keuangan1"))).toBe(true);
    expect(recipients.has(userIdByUsername("depot07"))).toBe(false); // operator outlet lain tidak menerima
    // Setor sebagian tanpa foto slip ditolak.
    const noSlip = await pos.send("m6.shift_deposit.partial", { depositId: newId(), shiftId, amount: 50_000 });
    expect(noSlip.status).toBe("rejected");
    const cmdId = newId();
    const up = await pos.hp.upload(pos.op, { bytes: JPEG, kind: "bank_slip", commandId: cmdId });
    const depositId = newId();
    const ok = await pos.send("m6.shift_deposit.partial", { depositId, shiftId, amount: 80_000 }, { id: cmdId, attachmentIds: [up.attachmentId], attachmentHashes: [up.sha256] });
    expectApplied(ok);
    const [dep] = await t.db.select().from(deposits).where(eq(deposits.id, depositId));
    expect(dep).toMatchObject({ isPartial: true, method: "bank_slip", expectedCash: 80_000, sourceType: "depot_shift", shiftId, bankSlipAttachmentId: up.attachmentId });
    const [shift] = await t.db.select().from(shifts).where(eq(shifts.id, shiftId));
    expect(shift!.partialDepositTotal).toBe(80_000);
    expect(shift!.cashLimitAlertAt).toBeNull();
    // Setor sebagian melebihi kas di laci ditolak.
    const up2 = await pos.hp.upload(pos.op, { bytes: JPEG, kind: "bank_slip" });
    const tooBig = await pos.send("m6.shift_deposit.partial", { depositId: newId(), shiftId, amount: 5_000_000 }, { attachmentIds: [up2.attachmentId], attachmentHashes: [up2.sha256] });
    expect(tooBig.status).toBe("rejected");
  });

  it("US-M6-02 KP-3 tutup shift: penjualan per produk, tunai seharusnya, QRIS, void, pemakaian bahan; kas & stok fisik → selisih dihitung sistem; alasan wajib bila ≠ 0 / di luar PAR-58", async () => {
    const pos = await posFor("D07");
    await stockUp(pos, { tutup: 30, tisu: 30, galonKosong: 10 });
    const { shiftId } = await openShiftVia(pos);
    await sellVia(pos, shiftId, [isi(3)]);
    await sellVia(pos, shiftId, [galonBaru(1)]);
    await sellVia(pos, shiftId, [isi(2)], { method: "qris" });
    const v = await sellVia(pos, shiftId, [isi(1)]);
    expectApplied(await pos.send("m6.pos_sale.void", { saleId: v.saleId, reason: "wrong_quantity" }));
    // Seharusnya: tunai 15.000 + 45.000; pemakaian: tutup 3+1+2=6, tisu 3+2=5, galon kosong 1.
    const counted = 200_000 + 15_000 + 45_000;
    const stockExact = [
      { productId: P.TUTUP, physicalQty: 24 },
      { productId: P.TISU, physicalQty: 25 },
      { productId: P.GALON_KOSONG, physicalQty: 9 },
    ];
    // Kas kurang Rp 5.000 tanpa alasan → ditolak.
    const noReason = await closeVia(pos, shiftId, { counted: counted - 5_000, stock: stockExact });
    expect(noReason.status).toBe("rejected");
    expect(noReason.message).toMatch(/alasan selisih kas/i);
    // Stok di luar toleransi PAR-58 (bawaan 0) tanpa alasan → ditolak.
    const stockOff = await closeVia(pos, shiftId, { counted, stock: [{ productId: P.TUTUP, physicalQty: 22 }, ...stockExact.slice(1)] });
    expect(stockOff.status).toBe("rejected");
    expect(stockOff.message).toMatch(/Tutup galon/);
    const res = await closeVia(pos, shiftId, {
      counted: counted - 5_000,
      reason: "Salah kembalian ke pelanggan",
      stock: [{ productId: P.TUTUP, physicalQty: 22, reason: "2 tutup rusak saat dipasang" }, ...stockExact.slice(1)],
    });
    expectApplied(res);
    const [shift] = await t.db.select().from(shifts).where(eq(shifts.id, shiftId));
    expect(shift).toMatchObject({ status: "closed", cashSales: 60_000, qrisSales: 10_000, voidCount: 1, voidAmount: 5_000, expectedCash: counted, cashDifference: -5_000 });
    const summary = shift!.summary as { byProduct: { productId: string; quantity: number }[]; usage: Record<string, number>; stock: { productId: string; difference: number | null }[] };
    expect(summary.byProduct.find((p) => p.productId === P.ISI)?.quantity).toBe(5);
    expect(summary.usage[P.TUTUP]).toBe(6);
    expect(summary.usage[P.TISU]).toBe(5);
    expect(summary.stock.find((s) => s.productId === P.TUTUP)?.difference).toBe(-2);
    // Selisih harian informatif: saldo = saldo − pemakaian seharusnya (fisik tidak mengubah saldo).
    const [bal] = await t.db.select().from(stockBalances).where(and(eq(stockBalances.outletId, pos.outletId), eq(stockBalances.productId, P.TUTUP)));
    expect(bal!.quantity).toBe(24);
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "shift.closed"), eq(domainEvents.objectId, shiftId)));
    const payload = ev!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ cashSales: 60_000, qrisAmount: 10_000, qrisCount: 1, voidCount: 1, cashDiscrepancy: -5_000, depositAmount: 60_000 });
    expect((payload.consumableUsage as { productId: string; expectedUsage: number }[]).find((u) => u.productId === P.GALON_KOSONG)?.expectedUsage).toBe(1);
    // PAR-58 dinaikkan pemilik → selisih kecil tidak lagi wajib alasan.
    const p8 = await posFor("D08");
    await params.set(owner(), "PAR-58", { units_per_material: 2 }, toBusinessDate(new Date()), "Data pilot: toleransi 2 buah", { outletId: p8.outletId });
    await stockUp(p8, { tutup: 10, tisu: 10, galonKosong: 0 });
    const s8 = await openShiftVia(p8);
    await sellVia(p8, s8.shiftId, [isi(1)]);
    expectApplied(
      await closeVia(p8, s8.shiftId, {
        counted: 205_000,
        stock: [
          { productId: P.TUTUP, physicalQty: 7 },
          { productId: P.TISU, physicalQty: 9 },
          { productId: P.GALON_KOSONG, physicalQty: 0 },
        ],
      }),
    );
  });

  it("US-M6-02 KP-4 setelah ditutup shift terkunci: transaksi baru masuk shift berikutnya, void ditolak, koreksi hanya pembalik Admin Keuangan", async () => {
    const pos = await posFor("D09");
    const { shiftId } = await openShiftVia(pos);
    const sale = await sellVia(pos, shiftId, [isi(1)]);
    expectApplied(await closeVia(pos, shiftId, { counted: 205_000 }));
    expect((await closeVia(pos, shiftId, { counted: 205_000 })).status).toBe("rejected");
    const voidAfter = await pos.send("m6.pos_sale.void", { saleId: sale.saleId, reason: "wrong_product" });
    expect(voidAfter.status).toBe("rejected");
    expect(voidAfter.message).toMatch(/pembalik/);
    const next = await openShiftVia(pos);
    expectApplied(next.res);
    const s2 = await sellVia(pos, next.shiftId, [isi(2)]);
    expectApplied(s2.res);
    // Transaksi perangkat lain yang tersinkron ke shift lama tetap dicatat sebagai konflik (lapangan tidak ditimpa).
    const late = await sellVia(pos, shiftId, [isi(1)]);
    expect(late.res.status).toBe("conflict");
    const { reverseSaleAfterClose } = await import("@/server/modules/m6-pos");
    await expect(reverseSaleAfterClose(seededContext("depot09"), { saleId: sale.saleId, reason: "Salah input produk" })).rejects.toThrow();
    const rev = await reverseSaleAfterClose(seededContext("keuangan1"), { saleId: sale.saleId, reason: "Salah input produk kemarin" });
    expect(rev.reversal).toMatchObject({ isReversal: true, total: -PRICE.ISI, reversalOfId: sale.saleId, recordedByOffice: true });
    expect(rev.original.status).toBe("voided");
  });

  it("US-M6-02 KP-5 setoran = tunai seharusnya − kas awal tetap − Σ setor sebagian → baris setoran (Belum disetor → Disetor → Diterima); terlambat > PAR-27 ditandai", async () => {
    const pos = await posFor("D10");
    const { shiftId } = await openShiftVia(pos);
    await sellVia(pos, shiftId, [galonBaru(2)]);
    await sellVia(pos, shiftId, [isi(4)], { method: "qris" });
    const up = await pos.hp.upload(pos.op, { bytes: JPEG, kind: "bank_slip" });
    expectApplied(await pos.send("m6.shift_deposit.partial", { depositId: newId(), shiftId, amount: 50_000 }, { attachmentIds: [up.attachmentId], attachmentHashes: [up.sha256] }));
    const res = await closeVia(pos, shiftId, { counted: 200_000 + 90_000 - 50_000 });
    expectApplied(res);
    const depositId = (res.result as { depositId: string }).depositId;
    const [dep] = await t.db.select().from(deposits).where(eq(deposits.id, depositId));
    expect(dep).toMatchObject({ sourceType: "depot_shift", status: "submitted", isPartial: false, expectedCash: 40_000, shiftId, outletId: pos.outletId });
    let [shift] = await t.db.select().from(shifts).where(eq(shifts.id, shiftId));
    expect(shift).toMatchObject({ depositAmount: 40_000, depositStatus: "not_deposited", depositId });
    expectApplied(await pos.send("m6.shift_deposit.submit", { shiftId, method: "physical" }));
    [shift] = await t.db.select().from(shifts).where(eq(shifts.id, shiftId));
    expect(shift!.depositStatus).toBe("deposited");
    // M4 menerima → status Diterima (handler event deposit.received).
    await withTx(async (tx) => {
      await emit(
        tx,
        "deposit.received",
        { depositId, sourceType: "depot_shift", outletId: pos.outletId, expectedAmount: 40_000, receivedAmount: 40_000, discrepancyAmount: 0, receivedBy: userIdByUsername("keuangan1"), late: false },
        { ctx: seededContext("keuangan1") },
      );
    });
    [shift] = await t.db.select().from(shifts).where(eq(shifts.id, shiftId));
    expect(shift!.depositStatus).toBe("received");
    // Setoran belum diterima > PAR-27 hari → ditandai ke Admin Keuangan.
    const p4 = await posFor("D04");
    const old = await t.db.select().from(shifts).where(and(eq(shifts.outletId, p4.outletId), eq(shifts.status, "open"), eq(shifts.syncConflict, false)));
    expectApplied(await closeVia(p4, old[0]!.id, { counted: 200_000 }));
    const inThreeDays = new Date(Date.now() + 3 * 86_400_000);
    const late = await runLateDepositCheck(inThreeDays);
    expect(late.flagged).toContain(old[0]!.id);
    expect(late.flagged).not.toContain(shiftId);
    expect((await notificationsFor(t.db, "deposit.depot_late", { objectId: old[0]!.id })).length).toBeGreaterThan(0);
  });

  it("US-M6-02 KP-6 operator melihat riwayat shift, selisih, galon & hasil penerimaan setoran MILIKNYA 90 hari terakhir; tidak melihat outlet/operator lain", async () => {
    const pos = await posFor("D10");
    const ref = (await pos.hp.pull(pos.op, { keys: "m6.pos" })).data["m6.pos"] as PosReference;
    expect(ref.history.length).toBeGreaterThan(0);
    const mine = ref.history.find((h) => h.depositStatus === "received");
    expect(mine).toMatchObject({ salesTotal: 110_000, gallonsSold: 6, cashDifference: 0 });
    // Operator lain di perangkat yang sama tidak melihat riwayat operator D10 (hanya miliknya).
    const other = await pos.hp.login("depot04").catch(() => null);
    expect(other).toBeNull(); // depot04 tidak berlingkup outlet D10 → tidak dapat masuk di POS D10
    const p4 = await posFor("D04");
    const ref4 = (await p4.hp.pull(p4.op, { keys: "m6.pos" })).data["m6.pos"] as PosReference;
    expect(ref4.history.every((h) => !ref.history.some((x) => x.shiftId === h.shiftId))).toBe(true);
    expect(ref.history.every((h) => h.businessDate >= addDays(toBusinessDate(new Date()), -89))).toBe(true);
  });

  it("US-M6-02 KP-7 selisih kas ≥ PAR-01 diteruskan ke alur pemilik M4 (penanda di event shift.closed); isShiftFullySynced untuk penerimaan setoran", async () => {
    const pos = await posFor("D05");
    const [open] = await t.db.select().from(shifts).where(and(eq(shifts.outletId, pos.outletId), eq(shifts.status, "open")));
    await sellVia(pos, open!.id, [galonBaru(2)]);
    const res = await closeVia(pos, open!.id, { counted: 300_000 + 90_000 - 60_000, reason: "Uang hilang, sedang ditelusuri" });
    expectApplied(res);
    const [ev] = await t.db.select().from(domainEvents).where(and(eq(domainEvents.type, "shift.closed"), eq(domainEvents.objectId, open!.id)));
    expect(ev!.payload).toMatchObject({ cashDiscrepancy: -60_000, cashDiscrepancyOverThreshold: true, cashDiscrepancyReason: "Uang hilang, sedang ditelusuri" });
    expect(await isShiftFullySynced(t.db, open!.id)).toBe(true);
  });
});
