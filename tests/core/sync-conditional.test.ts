/**
 * Pull bersyarat v1.0.1 (D-14 butir 3, B-89) lewat jalur perangkat sungguhan (`processPull` + route handler): klien lama
 * tetap v1, klien baru tanpa perubahan mendapat "tidak berubah" tanpa isi, penjualan baru dikirim sebagai delta,
 * koreksi kantor atas data LAMA ikut terkirim, isolasi tenant/perangkat/pengguna.
 */
import { gzipSync } from "node:zlib";

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { GET as pullRoute } from "@/app/api/sync/pull/route";
import type { PosReference } from "@/client/m6-pos/contract";
import type { M3Today } from "@/client/m3-driver/contract";
import type { StoreReference } from "@/client/m7-store/contract";
import { posSales } from "@/db/schema";
import { applyPullPatch, pullCursorQuery, type PullPatch } from "@/lib/pull-delta";
import * as approvals from "@/server/core/approvals";
import { signDeviceToken } from "@/server/core/auth";
import type { PullResponse } from "@/server/core/sync";
import * as m3 from "@/server/modules/m3-driver";
import { createPartnerTenant } from "@/server/modules/m6-pos";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { completeCash, departArrive, driverWorld, finance, PRICE } from "../m3-driver/helpers";
import { admin, expectApplied, galonBaru, isi, makeTestTenant, openShiftVia, owner, posFor, sellVia, type Pos } from "../m6-pos/helpers";
import * as store from "../m7-store/helpers";

const strip = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === "generatedAt" ? undefined : x)));
const size = (v: unknown) => {
  const json = JSON.stringify(v);
  return { json: json.length, gzip: gzipSync(json).length };
};

/** Klien v2 tiruan: menyimpan data + kursor per kunci seperti `refs` Dexie dan menerapkan respons. */
class ClientStore {
  data = new Map<string, unknown>();
  cursors = new Map<string, string>();
  apply(res: PullResponse) {
    for (const [key, value] of Object.entries(res.data)) {
      this.data.set(key, value);
      if (res.cursors?.[key]) this.cursors.set(key, res.cursors[key]);
    }
    for (const [key, patch] of Object.entries(res.patches ?? {})) {
      this.data.set(key, applyPullPatch(this.data.get(key), patch as PullPatch, res.serverTime));
      this.cursors.set(key, res.cursors![key]!);
    }
  }
  query(): Record<string, string> {
    return Object.fromEntries(this.cursors);
  }
  clone(): ClientStore {
    const c = new ClientStore();
    c.data = new Map(this.data);
    c.cursors = new Map(this.cursors);
    return c;
  }
}

describe("Pull bersyarat v2 (B-89, D-14 butir 3)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  async function posWithSales(code: string, n: number): Promise<{ pos: Pos; shiftId: string }> {
    const pos = await posFor(code);
    const { shiftId } = await openShiftVia(pos);
    const cmds = [];
    for (let i = 0; i < n; i++) {
      const seq = pos.seq();
      cmds.push(
        pos.hp.command(pos.op, "m6.pos_sale.create", {
          saleId: crypto.randomUUID(),
          shiftId,
          localNumber: `${code}-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-POS${code}-${String(seq).padStart(4, "0")}`,
          deviceSeq: seq,
          lines: [isi((i % 3) + 1)],
          paymentMethod: "cash",
        }),
      );
    }
    for (let i = 0; i < cmds.length; i += 50) {
      const res = await pos.hp.push(cmds.slice(i, i + 50));
      expect(res.results.every((r) => r.status === "applied"), JSON.stringify(res.results.find((r) => r.status !== "applied"))).toBe(true);
    }
    return { pos, shiftId };
  }

  it("B-89 klien lama (tanpa v=2, dengan/ tanpa `since`) menerima respons v1 persis — tanpa kursor/delta; isi sama dengan data penuh v2", async () => {
    const { pos } = await posWithSales("D06", 3);
    const v1 = await pos.hp.pull(pos.op, {});
    expect(v1.protocol).toBeUndefined();
    expect(v1.cursors).toBeUndefined();
    expect(v1.unchanged).toBeUndefined();
    expect(v1.patches).toBeUndefined();
    expect(Object.keys(v1.data)).toEqual(expect.arrayContaining(["m6.pos", "m1.catalog", "core.me"]));
    const v2 = await pos.hp.pull(pos.op, { cursors: {} });
    expect(v2.protocol).toBe(2);
    expect(strip(v2.data)).toEqual(strip(v1.data));
    expect(Object.keys(v2.cursors!).sort()).toEqual(Object.keys(v2.data).sort());
    // Route handler: klien lama (query v1) vs klien baru (v=2&c.*).
    const token = await signDeviceToken(pos.hp.secret, { deviceId: pos.hp.deviceId, sessionId: pos.op.sessionId });
    const get = async (qs: string) => (await (await pullRoute(new Request(`http://localhost/api/sync/pull?${qs}`, { headers: { authorization: `Bearer ${token}` } }))).json()) as PullResponse;
    const legacy = await get(`since=${encodeURIComponent(new Date(0).toISOString())}`);
    expect(legacy.protocol).toBeUndefined();
    expect(legacy.data["m6.pos"]).toBeTruthy();
    const modern = await get(pullCursorQuery(Object.entries(v2.cursors!)));
    expect(modern.protocol).toBe(2);
    expect(modern.data).toEqual({});
    expect(modern.unchanged!.sort()).toEqual(Object.keys(v2.data).sort());
  });

  it("B-89 NFR-17 klien baru tanpa perubahan → semua penyedia 'tidak berubah', isi kosong (POS & sopir)", async () => {
    const { pos } = await posWithSales("D07", 40);
    const store = new ClientStore();
    const first = await pos.hp.pull(pos.op, { cursors: store.query() });
    store.apply(first);
    const again = await pos.hp.pull(pos.op, { cursors: store.query() });
    expect(again.data).toEqual({});
    expect(again.patches).toEqual({});
    expect(again.unchanged!.sort()).toEqual(Object.keys(first.data).sort());
    expect(size(again).gzip).toBeLessThan(size(first).gzip / 2);

    const w = await driverWorld(t.db);
    await w.addTrip();
    await w.addTrip();
    const driverStore = new ClientStore();
    const d1 = await w.hp.pull(w.sopir, { cursors: {} });
    driverStore.apply(d1);
    expect(d1.data["m3.today"]).toBeTruthy();
    const d2 = await w.hp.pull(w.sopir, { cursors: driverStore.query() });
    expect(d2.data).toEqual({});
    expect(d2.unchanged).toEqual(expect.arrayContaining(["m3.today", "core.me", "m4.my_cash"]));
  });

  it("B-89 penjualan baru di shift terbuka → delta: hanya penjualan baru (+ saldo bahan) terkirim; data klien = data penuh server", async () => {
    const { pos, shiftId } = await posWithSales("D08", 60);
    const store = new ClientStore();
    store.apply(await pos.hp.pull(pos.op, { cursors: {} }));
    const fullBefore = size(store.data.get("m6.pos"));
    const sale = await sellVia(pos, shiftId, [isi(2)]);
    expectApplied(sale.res);
    const res = await pos.hp.pull(pos.op, { cursors: store.query() });
    expect(res.data["m6.pos"]).toBeUndefined();
    const patch = res.patches!["m6.pos"]!;
    expect(patch).toBeTruthy();
    const salesPatch = patch.cols["openShift.sales"]!;
    expect(salesPatch.from).toBe(60);
    expect(salesPatch.segs.some((s) => "copy" in s)).toBe(true);
    const sent = salesPatch.segs.flatMap((s) => ("items" in s ? s.items : [])) as { id: string }[];
    expect(sent.length).toBeLessThanOrEqual(16 * 4);
    expect(sent.map((s) => s.id)).toContain(sale.saleId);
    store.apply(res);
    const full = await pos.hp.pull(pos.op, { keys: "m6.pos" });
    expect(strip(store.data.get("m6.pos"))).toEqual(strip(full.data["m6.pos"]));
    expect((store.data.get("m6.pos") as PosReference).openShift!.sales).toHaveLength(61);
    // Muatan delta jauh lebih kecil daripada data penuh (tidak tumbuh per transaksi shift).
    expect(size(patch).json).toBeLessThan(fullBefore.json / 3);
  });

  it("B-89 koreksi kantor atas data LAMA ikut terkirim: void disetujui pemilik (POS) & koreksi harga rit Selesai oleh Admin Keuangan (sopir)", async () => {
    // POS: void besar menunggu persetujuan → klien sinkron → pemilik menyetujui di kantor (bukan dari perangkat).
    const { pos, shiftId } = await posWithSales("D09", 30);
    const big = await sellVia(pos, shiftId, [galonBaru(3)]);
    expectApplied(await pos.send("m6.pos_sale.void", { saleId: big.saleId, reason: "customer_cancelled" }));
    const store = new ClientStore();
    store.apply(await pos.hp.pull(pos.op, { cursors: {} }));
    const saleOf = () => (store.data.get("m6.pos") as PosReference).openShift!.sales.find((s) => s.id === big.saleId)!;
    expect(saleOf().status).toBe("void_pending");
    const [row] = await t.db.select().from(posSales).where(eq(posSales.id, big.saleId));
    await approvals.decide(owner(), row!.voidApprovalId!, "approve");
    const res = await pos.hp.pull(pos.op, { cursors: store.query() });
    expect(res.unchanged).not.toContain("m6.pos");
    store.apply(res);
    expect(saleOf().status).toBe("voided");
    expect(strip(store.data.get("m6.pos"))).toEqual(strip((await pos.hp.pull(pos.op, { keys: "m6.pos" })).data["m6.pos"]));

    // Sopir: rit Selesai (tunai) → klien sinkron → Admin Keuangan mengoreksi harga rit itu (kantor).
    const w = await driverWorld(t.db, { customerCredit: "credit", creditLimit: 5_000_000 });
    const a = await w.addTrip();
    await w.addTrip();
    await departArrive(w, a.id);
    expectApplied(await completeCash(w, a.id));
    const driverStore = new ClientStore();
    driverStore.apply(await w.hp.pull(w.sopir, { cursors: {} }));
    const tripOf = () => (driverStore.data.get("m3.today") as M3Today).trips.find((x) => x.id === a.id)!;
    expect(tripOf().price).toBe(PRICE);
    await m3.correctTrip(finance(), { tripId: a.id, price: PRICE - 50_000, reason: "Volume parsial — harga disepakati turun (uji pull bersyarat)" });
    const d = await w.hp.pull(w.sopir, { cursors: driverStore.query() });
    expect(d.unchanged).not.toContain("m3.today");
    driverStore.apply(d);
    expect(tripOf().price).toBe(PRICE - 50_000);
    expect(strip(driverStore.data.get("m3.today"))).toEqual(strip((await w.hp.pull(w.sopir, { keys: "m3.today" })).data["m3.today"]));
  });

  it("B-89 NFR-30 isolasi: kursor perangkat/outlet/tenant/pengguna lain tidak pernah menghasilkan 'tidak berubah' atau data milik pihak lain", async () => {
    const a = await posWithSales("D10", 5);
    const storeA = new ClientStore();
    storeA.apply(await a.pos.hp.pull(a.pos.op, { cursors: {} }));
    const salesA = (storeA.data.get("m6.pos") as PosReference).openShift!.sales.map((x) => x.id);
    expect(salesA).toHaveLength(5);

    // Outlet/perangkat lain (D04) memakai kursor D10 → hasil = data D04 sendiri. Server hanya mengirim/menyalin isi
    // yang sidiknya SAMA dengan data D04 (mis. resep tenant yang identik) — tidak pernah isi milik D10.
    const b = await posFor("D04");
    const res = await b.hp.pull(b.op, { cursors: storeA.query() });
    expect(res.unchanged).not.toContain("m6.pos");
    const asB = storeA.clone();
    asB.apply(res);
    const fullB = (await b.hp.pull(b.op, { keys: "m6.pos" })).data["m6.pos"] as PosReference;
    expect(strip(asB.data.get("m6.pos"))).toEqual(strip(fullB));
    expect((asB.data.get("m6.pos") as PosReference).outlet!.code).toBe("D04");
    expect(JSON.stringify(asB.data.get("m6.pos"))).not.toContain(salesA[0]!);
    expect(JSON.stringify(res)).not.toContain(salesA[0]!);

    // Tenant mitra memakai kursor tenant EQUA → penuh, katalog & outlet tenant mitra sendiri.
    const mitra = await makeTestTenant(t.db, async (code) => {
      const r = await createPartnerTenant(admin(), { code, name: "Mitra Pull Uji", outlets: [{ code: "M01", name: "Depot Mitra Pull" }], reason: "Uji isolasi pull bersyarat (tenant fiktif)" });
      return { tenantId: r.tenant.id, outletId: r.outlets[0]!.id, outletCode: "M01" };
    }, "PULL");
    const mp = await mitra.pos();
    const mr = await mp.hp.pull(mp.op, { cursors: storeA.query() });
    expect(mr.unchanged).not.toContain("m6.pos");
    expect(mr.unchanged).not.toContain("m1.catalog");
    const asMitra = storeA.clone();
    asMitra.apply(mr);
    const fullMitra = await mp.hp.pull(mp.op, { keys: "m6.pos,m1.catalog" });
    expect(strip(asMitra.data.get("m6.pos"))).toEqual(strip(fullMitra.data["m6.pos"]));
    expect(strip(asMitra.data.get("m1.catalog"))).toEqual(strip(fullMitra.data["m1.catalog"]));
    expect((asMitra.data.get("m6.pos") as PosReference).outlet!.tenantId).toBe(mitra.tenantId);
    expect(JSON.stringify(mr)).not.toContain(salesA[0]!);

    // Pengguna lain di perangkat yang sama (kernet memakai kursor sopir) → data kernet sendiri.
    const w = await driverWorld(t.db);
    await w.addTrip();
    const sopirStore = new ClientStore();
    sopirStore.apply(await w.hp.pull(w.sopir, { cursors: {} }));
    const kr = await w.hp.pull(w.kernet, { cursors: sopirStore.query() });
    expect(kr.unchanged).not.toContain("m3.today");
    expect(kr.unchanged).not.toContain("core.me");
    const asKernet = sopirStore.clone();
    asKernet.apply(kr);
    expect((asKernet.data.get("m3.today") as M3Today).actingRole).toBe("readonly");
    expect(strip(asKernet.data.get("m3.today"))).toEqual(strip((await w.hp.pull(w.kernet, { keys: "m3.today" })).data["m3.today"]));

    // Kursor rusak/asing → penuh (tidak pernah galat).
    const bad = await a.pos.hp.pull(a.pos.op, { cursors: { "m6.pos": "2rusakrusakrusak~~~", "core.me": "x" } });
    expect(bad.data["m6.pos"]).toBeTruthy();
    expect(bad.data["core.me"]).toBeTruthy();
    expect(bad.errors).toEqual({});
  });

  it("B-89 toko (M7): tanpa perubahan → 'tidak berubah'; penjualan baru → delta daftar penjualan terbaru-dulu & saldo barang, hasil = data penuh", async () => {
    const pos = await store.makeStore(t.db);
    await store.stockUp(t.db, pos, [{ productId: store.SP.TUTUP, quantity: 500, unitCost: 500 }]);
    const shift = await store.openShiftVia(pos);
    for (let i = 0; i < 20; i++) store.expectApplied((await store.sellVia(pos, shift, [{ productId: store.SP.TUTUP, quantity: 1, unitPrice: store.GENERAL.TUTUP }])).res);
    const client = new ClientStore();
    client.apply(await pos.hp.pull(pos.op, { cursors: {} }));
    const same = await pos.hp.pull(pos.op, { cursors: client.query() });
    expect(same.data).toEqual({});
    expect(same.unchanged).toEqual(expect.arrayContaining(["m7.store", "m6.pos", "m1.catalog"]));
    const sale = await store.sellVia(pos, shift, [{ productId: store.SP.TUTUP, quantity: 2, unitPrice: store.GENERAL.TUTUP }]);
    store.expectApplied(sale.res);
    const res = await pos.hp.pull(pos.op, { cursors: client.query() });
    expect(res.data["m7.store"]).toBeUndefined();
    const patch = res.patches!["m7.store"]!;
    expect(patch.cols.recentSales!.segs.some((x) => "copy" in x)).toBe(true);
    client.apply(res);
    const local = client.data.get("m7.store") as StoreReference;
    expect(local.recentSales[0]!.id).toBe(sale.saleId);
    expect(strip(local)).toEqual(strip((await pos.hp.pull(pos.op, { keys: "m7.store" })).data["m7.store"]));
    expect(strip(client.data.get("m6.pos"))).toEqual(strip((await pos.hp.pull(pos.op, { keys: "m6.pos" })).data["m6.pos"]));
  });

  it("B-89 kursor BUKAN waktu: `since` klien v2 diabaikan (data lama yang berubah tetap terkirim walau `since` di masa depan)", async () => {
    const { pos, shiftId } = await posWithSales("D02", 2);
    const store = new ClientStore();
    store.apply(await pos.hp.pull(pos.op, { cursors: {} }));
    const s = await sellVia(pos, shiftId, [isi(1)]);
    expectApplied(s.res);
    const future = new Date(Date.now() + 24 * 3600_000).toISOString();
    const res = await pos.hp.pull(pos.op, { cursors: store.query(), since: future });
    store.apply(res);
    expect((store.data.get("m6.pos") as PosReference).openShift!.sales.map((x) => x.id)).toContain(s.saleId);
    // Klien v1 dengan `since` di masa depan (perilaku lama) memang melewatkan penyedia yang memakai `since`.
    const v1 = await pos.hp.pull(pos.op, { since: future, keys: "m1.catalog" });
    expect(v1.data["m1.catalog"]).toBeUndefined();
  });
});
