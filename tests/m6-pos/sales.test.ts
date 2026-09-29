import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { domainEvents, posSaleLines, posSales, shifts } from "@/db/schema";
import { deviceId, userIdByUsername } from "@/db/seed";
import { deviceShiftFigures, gridProducts, type CatalogRef, type PosReference } from "@/client/m6-pos/contract";
import { toBusinessDate } from "@/lib/time";
import { hardeningViolationCode } from "@/db/hardening";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { expectApplied, galonBaru, isi, openShiftVia, P, posFor, PRICE, sellVia } from "./helpers";

describe("US-M6-01 Transaksi cepat di POS depot", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M6-01 KP-1 kisi produk tenant ≤ 12 tombol dengan harga master berlaku hari ini (tanpa diskon depot)", async () => {
    const pos = await posFor("D04");
    const pull = await pos.hp.pull(pos.op, { keys: "m1.catalog,m6.pos" });
    const catalog = pull.data["m1.catalog"] as CatalogRef;
    const ref = pull.data["m6.pos"] as PosReference;
    expect(ref.outlet?.code).toBe("D04");
    const grid = gridProducts(catalog, "standard", ref.settings.gridMax);
    expect(ref.settings.gridMax).toBe(12);
    expect(grid.length).toBeGreaterThan(0);
    expect(grid.length).toBeLessThanOrEqual(12);
    expect(grid.find((p) => p.id === P.ISI)?.price).toBe(PRICE.ISI);
    expect(grid.find((p) => p.id === P.GALON_BARU)?.price).toBe(PRICE.GALON_BARU);
    // Galon kosong (bahan, tidak tampil di POS) tidak ada di kisi; hanya produk depot tenant ini.
    expect(grid.some((p) => p.id === P.GALON_KOSONG)).toBe(false);
    // Tidak ada diskon di POS depot (PTB-48): payload berdiskon ditolak skema.
    const { shiftId } = await openShiftVia(pos);
    const bad = await sellVia(pos, shiftId, [isi(1)], { extra: { discountPercent: 10 } });
    expect(bad.res.status).toBe("rejected");
    // US-M6-01 KP-1 / BR-15: harga master dipaksakan server — harga perangkat yang bukan harga master (dalam jendela
    // katalog offline) DITOLAK (operator tidak dapat menjual di bawah harga).
    const odd = await sellVia(pos, shiftId, [isi(1, 4_000)]);
    expect(odd.res.status).toBe("rejected");
    expect(odd.res.message).toMatch(/tidak sesuai harga master/);
    expect(await t.db.select().from(posSales).where(eq(posSales.id, odd.saleId))).toHaveLength(0);
  });

  it("US-M6-01 KP-2 tunai (uang diterima → kembalian; bawaan pas) atau QRIS statis + referensi (tidak menambah kas fisik); cara bayar lain ditolak", async () => {
    const pos = await posFor("D05");
    const { shiftId } = await openShiftVia(pos);
    const exact = await sellVia(pos, shiftId, [isi(2)]);
    expectApplied(exact.res);
    const change = await sellVia(pos, shiftId, [galonBaru(1)], { cashReceived: 50_000 });
    expectApplied(change.res);
    const qris = await sellVia(pos, shiftId, [isi(3)], { method: "qris", qrisReference: "8841" });
    expectApplied(qris.res);
    const rows = await t.db.select().from(posSales).where(eq(posSales.shiftId, shiftId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(exact.saleId)).toMatchObject({ paymentMethod: "cash", cashReceived: 10_000, changeAmount: 0, total: 10_000 });
    expect(byId.get(change.saleId)).toMatchObject({ cashReceived: 50_000, changeAmount: 5_000, total: 45_000 });
    expect(byId.get(qris.saleId)).toMatchObject({ paymentMethod: "qris", qrisReference: "8841", cashReceived: null, total: 15_000 });
    // QRIS tidak menambah kas fisik: kas di laci = kas awal + tunai.
    const ref = (await pos.hp.pull(pos.op, { keys: "m6.pos" })).data["m6.pos"] as PosReference;
    const f = deviceShiftFigures(ref.openShift!, ref.recipes);
    expect(f.expectedDrawer).toBe(200_000 + 10_000 + 45_000);
    expect(f.qrisSales).toBe(15_000);
    // Transfer/tempo tidak tersedia di POS depot Tahap 1; uang kurang ditolak.
    expect((await sellVia(pos, shiftId, [isi(1)], { extra: { paymentMethod: "transfer" } })).res.status).toBe("rejected");
    const short = await sellVia(pos, shiftId, [galonBaru(1)], { cashReceived: 40_000 });
    expect(short.res.status).toBe("rejected");
    expect(short.res.message).toMatch(/kurang dari total/);
  });

  it("US-M6-01 KP-3 transaksi 1–2 baris diproses server < 1 detik (aksi di perangkat lokal; pengukuran 20 transaksi oleh pemilik modul saat UAT)", async () => {
    const pos = await posFor("D06");
    const { shiftId } = await openShiftVia(pos);
    const durations: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const { res } = await sellVia(pos, shiftId, [isi(1), galonBaru(1)]);
      durations.push(performance.now() - start);
      expectApplied(res);
    }
    durations.sort((a, b) => a - b);
    expect(durations[2]!).toBeLessThan(1_000);
  });

  it("US-M6-01 KP-4 nomor transaksi resmi {kodeOutlet}-YYMMDD-NNNN terbentuk tanpa struk; nomor perangkat tetap tersimpan", async () => {
    const pos = await posFor("D07");
    const { shiftId } = await openShiftVia(pos);
    const a = await sellVia(pos, shiftId, [isi(1)]);
    const b = await sellVia(pos, shiftId, [isi(1)], { extra: { receiptPrinted: true } });
    const today = toBusinessDate(new Date());
    const ymd = today.slice(2).replaceAll("-", "");
    expect((a.res.result as { number: string }).number).toBe(`D07-${ymd}-0001`);
    expect((b.res.result as { number: string }).number).toBe(`D07-${ymd}-0002`);
    const [row] = await t.db.select().from(posSales).where(eq(posSales.id, a.saleId));
    expect(row!.localNumber).toBe(a.localNumber);
    expect(row!.receiptPrinted).toBe(false);
  });

  it("US-M6-01 KP-5 transaksi mencatat outlet, shift, operator, waktu perangkat, baris, harga, cara bayar; ID dari perangkat; tidak dapat diubah (hanya void)", async () => {
    const pos = await posFor("D08");
    const { shiftId } = await openShiftVia(pos);
    const deviceTime = new Date(Date.now() - 60_000);
    const { saleId, res } = await sellVia(pos, shiftId, [isi(2), galonBaru(1)], { cmd: { deviceTime } });
    expectApplied(res);
    expect(res.objectId).toBe(saleId);
    const [row] = await t.db.select().from(posSales).where(eq(posSales.id, saleId));
    expect(row).toMatchObject({
      outletId: pos.outletId,
      shiftId,
      operatorUserId: userIdByUsername("depot08"),
      deviceId: deviceId("POS-D08"),
      paymentMethod: "cash",
      total: 2 * PRICE.ISI + PRICE.GALON_BARU,
    });
    expect(row!.soldAt.toISOString()).toBe(deviceTime.toISOString());
    const lines = await t.db.select().from(posSaleLines).where(eq(posSaleLines.posSaleId, saleId));
    expect(lines.map((l) => [l.productId, l.quantity, l.unitPrice, l.gallonSizeL]).sort()).toEqual(
      [
        [P.ISI, 2, PRICE.ISI, 19],
        [P.GALON_BARU, 1, PRICE.GALON_BARU, 19],
      ].sort(),
    );
    // Terkunci: nilai transaksi tidak dapat diubah langsung di basis data (EQ003).
    const err = await t.db.execute(sql`update pos_sales set total = 1 where id = ${saleId}`).catch((e: unknown) => e);
    expect(hardeningViolationCode(err)).toBe("EQ003");
    const events = await t.db.select().from(domainEvents).where(eq(domainEvents.objectId, saleId));
    expect(events.map((e) => e.type)).toContain("pos_sale.recorded");
  });

  it("US-M6-01 KP-6 pelanggan tidak dicatat di POS depot; kolom pelanggan disiapkan kosong", async () => {
    const pos = await posFor("D09");
    const { shiftId } = await openShiftVia(pos);
    const { saleId, res } = await sellVia(pos, shiftId, [isi(1)], { extra: { customerId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" } });
    expectApplied(res);
    const [row] = await t.db.select().from(posSales).where(eq(posSales.id, saleId));
    expect(row!.customerId).toBeNull();
    const ref = (await pos.hp.pull(pos.op, { keys: "m6.pos" })).data["m6.pos"] as PosReference;
    expect(Object.keys(ref.openShift!.sales[0]!)).not.toContain("customerId");
  });

  it("US-M6-01 KP-7 tidak ada penjualan bertanda internal: cara bayar/produk internal ditolak", async () => {
    const pos = await posFor("D10");
    const { shiftId } = await openShiftVia(pos);
    expect((await sellVia(pos, shiftId, [isi(1)], { extra: { paymentMethod: "internal" } })).res.status).toBe("rejected");
    // Produk air truk (lini lain, termasuk transfer internal) tidak dapat dijual di POS depot.
    const internal = await sellVia(pos, shiftId, [{ productId: (await import("@/db/seed")).productId("AIR-TRUK-INT"), quantity: 1, unitPrice: 0 }]);
    expect(internal.res.status).toBe("rejected");
    const [shift] = await t.db.select().from(shifts).where(eq(shifts.id, shiftId));
    expect(shift!.status).toBe("open");
  });
});
