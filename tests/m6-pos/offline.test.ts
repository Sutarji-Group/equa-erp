import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { devices, posSales, productPrices, shifts, stockCounts, waterSupplyReceipts } from "@/db/schema";
import { deviceId, EQUA_TENANT_ID, SEED_DEMO_PIN } from "@/db/seed";
import { saleStatusText, type CatalogRef, type PosReference } from "@/client/m6-pos/contract";
import { verifyPinOffline } from "@/client/offline/crypto";
import { newId } from "@/lib/ids";
import { addDays, toBusinessDate } from "@/lib/time";
import { isShiftFullySynced, shiftSyncStatus } from "@/server/modules/m6-pos";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { fieldDevice } from "../helpers/field";
import { closeVia, expectApplied, galonBaru, isi, localNumber, openShiftVia, P, posFor, PRICE, sellVia, stockUp } from "./helpers";

describe("US-M6-06 Bekerja tanpa sinyal", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M6-06 KP-1 transaksi, void, buka/tutup shift, penerimaan pasokan & opname berjalan tanpa sinyal satu hari penuh; katalog, harga, resep & stok diunduh saat login", async () => {
    const hp = await fieldDevice("POS-D04");
    const yesterday = addDays(toBusinessDate(new Date()), -1);
    const at = (hhmm: string) => new Date(`${yesterday}T${hhmm}:00+07:00`);
    // Login PIN kemarin pagi saat masih ada sinyal: data referensi diunduh.
    const op = await hp.login("depot04", { now: at("05:30") });
    const pull = await hp.pull(op, { keys: "m1.catalog,m6.pos" });
    const catalog = pull.data["m1.catalog"] as CatalogRef;
    const ref = pull.data["m6.pos"] as PosReference;
    expect(catalog.products.some((p) => p.id === P.ISI && p.prices.standard === PRICE.ISI)).toBe(true);
    expect(ref.recipes.some((r) => r.productId === P.ISI && r.materialProductId === P.TUTUP)).toBe(true);
    expect(ref.materials.map((m) => m.id)).toEqual(expect.arrayContaining([P.TUTUP, P.TISU, P.GALON_KOSONG]));
    // Sepanjang hari tanpa sinyal: semua aksi masuk antrean dengan waktu perangkat kemarin, terkirim hari ini.
    const shiftId = newId();
    const sale1 = newId();
    const sale2 = newId();
    const countId = newId();
    const otherId = newId();
    const cmd = (type: string, payload: unknown, hhmm: string) => hp.command(op, type, payload, { deviceTime: at(hhmm), businessDate: yesterday });
    const cmds = [
      cmd("m6.consumable_receipt.create", { receiptId: newId(), source: "other", lines: [{ productId: P.TUTUP, quantity: 50 }, { productId: P.TISU, quantity: 50 }] }, "05:50"),
      cmd("m6.shift.open", { shiftId, openingCashCounted: 200_000 }, "06:00"),
      cmd("m6.pos_sale.create", { saleId: sale1, shiftId, localNumber: localNumber({ outletCode: "D04", deviceCode: "POS-D04" }, 1, yesterday), deviceSeq: 1, lines: [isi(3)], paymentMethod: "cash" }, "07:10"),
      cmd("m6.pos_sale.create", { saleId: sale2, shiftId, localNumber: localNumber({ outletCode: "D04", deviceCode: "POS-D04" }, 2, yesterday), deviceSeq: 2, lines: [isi(1)], paymentMethod: "cash" }, "08:00"),
      cmd("m6.pos_sale.void", { saleId: sale2, reason: "customer_cancelled" }, "08:01"),
      cmd("m6.water_supply.record_other", { receiptId: otherId, volumeL: 1_000, reason: "Pasokan darurat" }, "10:00"),
      cmd(
        "m6.stock_count.submit",
        {
          stockCountId: countId,
          // Opname menghitung SELURUH bahan (BR-27): bahan lain dihitung sesuai saldonya.
          lines: [
            { productId: P.TUTUP, physicalQty: 47 },
            { productId: P.TISU, physicalQty: 47 },
            ...ref.materials.filter((m) => m.id !== P.TUTUP && m.id !== P.TISU).map((m) => ({ productId: m.id, physicalQty: m.balance })),
          ],
        },
        "12:00",
      ),
      cmd("m6.shift.close", { shiftId, closingCashCounted: 215_000, stock: [{ productId: P.TUTUP, physicalQty: 47 }, { productId: P.TISU, physicalQty: 47 }, { productId: P.GALON_KOSONG, physicalQty: 0 }], saleIds: [sale1, sale2], voidedSaleIds: [sale2] }, "21:00"),
    ];
    const res = await hp.push(cmds);
    expect(res.results.map((r) => `${r.status}${r.message ? `:${r.message}` : ""}`)).toEqual(Array(cmds.length).fill("applied"));
    expect(res.results.every((r) => r.lateSync)).toBe(true);
    const [shift] = await t.db.select().from(shifts).where(eq(shifts.id, shiftId));
    expect(shift).toMatchObject({ status: "closed", businessDate: yesterday, lateSync: true, cashSales: 15_000, voidCount: 1 });
    expect(shift!.closedAt!.toISOString()).toBe(at("21:00").toISOString());
    const [s1] = await t.db.select().from(posSales).where(eq(posSales.id, sale1));
    expect(s1!.number).toMatch(new RegExp(`^D04-${yesterday.slice(2).replaceAll("-", "")}-\\d{4}$`)); // nomor resmi = tanggal bisnis perangkat
    expect((await t.db.select().from(stockCounts).where(eq(stockCounts.id, countId)))[0]!.status).toBe("approved");
    expect((await t.db.select().from(waterSupplyReceipts).where(eq(waterSupplyReceipts.id, otherId)))[0]!.businessDate).toBe(yesterday);
  });

  it("US-M6-06 KP-2 status 'tersimpan di perangkat'/'terkirim' per transaksi; pengiriman ulang tidak menggandakan (idempoten)", async () => {
    const pos = await posFor("D05");
    const { shiftId } = await openShiftVia(pos);
    const saleId = newId();
    const payload = { saleId, shiftId, localNumber: localNumber(pos, 1), deviceSeq: 1, lines: [galonBaru(1)], paymentMethod: "cash" };
    const cmd = pos.hp.command(pos.op, "m6.pos_sale.create", payload);
    const first = await pos.hp.push([cmd]);
    const again = await pos.hp.push([cmd]);
    expect(first.results[0]!.status).toBe("applied");
    expect(again.results[0]).toMatchObject({ status: "duplicate", originalStatus: "applied", objectId: saleId });
    // Perintah baru dengan ID transaksi/nomor lokal sama (mis. antrean dipulihkan) → ditolak sebagai data ganda, bukan dobel.
    const dup = await pos.hp.push([pos.hp.command(pos.op, "m6.pos_sale.create", payload)]);
    expect(dup.results[0]).toMatchObject({ status: "rejected", code: "DUPLICATE_DATA" });
    expect(await t.db.select().from(posSales).where(eq(posSales.id, saleId))).toHaveLength(1);
    expect(saleStatusText({ status: "valid", local: true })).toBe("Sah · tersimpan di perangkat");
    expect(saleStatusText({ status: "void_pending", local: false })).toBe("Void menunggu persetujuan · terkirim");
    // Ringkasan antrean di layar = hitungan status sinkron; transaksi yang dibatalkan perangkat tidak hilang.
    const ref = (await pos.hp.pull(pos.op, { keys: "m6.pos" })).data["m6.pos"] as PosReference;
    expect(ref.openShift!.sales.map((s) => s.id)).toContain(saleId);
  });

  it("US-M6-06 KP-3 tutup shift offline tetap sah; Admin Keuangan melihat 'menunggu sinkron' dan tidak dapat menerima setoran sebelum seluruh transaksi shift tersinkron", async () => {
    const pos = await posFor("D06");
    const { shiftId } = await openShiftVia(pos);
    const a = await sellVia(pos, shiftId, [isi(2)]);
    const pendingSale = newId(); // masih di antrean perangkat (mis. menunggu login ulang)
    const close = await closeVia(pos, shiftId, { counted: 210_000, saleIds: [a.saleId, pendingSale], deviceExpectedDrawer: 210_000 });
    expectApplied(close);
    expect(await isShiftFullySynced(t.db, shiftId)).toBe(false);
    expect((await shiftSyncStatus(t.db, shiftId)).missingSaleIds).toEqual([pendingSale]);
    const late = await sellVia(pos, shiftId, [isi(1)], { saleId: pendingSale });
    expect(late.res.status).toBe("conflict"); // tersimpan walau shift sudah ditutup
    expect(await isShiftFullySynced(t.db, shiftId)).toBe(true);
  });

  it("US-M6-06 KP-4 harga master berubah hari ini berlaku saat sinkron berikutnya; transaksi yang sudah terjadi memakai harga perangkat dan ditandai berbeda", async () => {
    const pos = await posFor("D07");
    const { shiftId } = await openShiftVia(pos);
    await t.db.insert(productPrices).values({
      tenantId: EQUA_TENANT_ID,
      productId: P.ISI,
      kind: "standard",
      outletId: pos.outletId,
      price: 6_000,
      effectiveFrom: toBusinessDate(new Date()),
      status: "active",
      isOwnerDirect: true,
      reason: "Uji harga naik",
      approvedAt: new Date(),
    });
    const old = await sellVia(pos, shiftId, [isi(2, 5_000)]);
    expectApplied(old.res);
    const [row] = await t.db.select().from(posSales).where(eq(posSales.id, old.saleId));
    expect(row).toMatchObject({ total: 10_000, priceMismatch: true });
    const catalog = (await pos.hp.pull(pos.op, { keys: "m1.catalog" })).data["m1.catalog"] as CatalogRef;
    expect(catalog.products.find((p) => p.id === P.ISI)!.prices.standard).toBe(6_000);
    const fresh = await sellVia(pos, shiftId, [isi(1, 6_000)]);
    expect((await t.db.select().from(posSales).where(eq(posSales.id, fresh.saleId)))[0]!.priceMismatch).toBe(false);
  });

  it("US-M6-06 KP-5 login PIN offline di perangkat terdaftar: verifier PIN tersimpan di perangkat; perangkat diblokir ditolak", async () => {
    const hp = await fieldDevice("POS-D08");
    const login = await hp.login("depot08");
    expect(await verifyPinOffline(SEED_DEMO_PIN, login.verifier)).toBe(true);
    expect(await verifyPinOffline("000000", login.verifier)).toBe(false);
    await stockUp(await posFor("D08"), { tutup: 5, tisu: 5, galonKosong: 0 });
    await t.db.update(devices).set({ status: "blocked" }).where(eq(devices.id, deviceId("POS-D08")));
    await expect(hp.auth()).rejects.toThrow();
  });
});
