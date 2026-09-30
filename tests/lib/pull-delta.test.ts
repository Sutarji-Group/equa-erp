import { describe, expect, it } from "vitest";

import {
  applyPullPatch,
  MAX_PULL_CURSOR_LENGTH,
  PullPatchError,
  pullCursorQuery,
  readPullCursors,
  touchVolatile,
  type PullPatch,
} from "@/lib/pull-delta";
import { compareWithCursor, versionOf, type PullCollections } from "@/server/core/sync/conditional";

/** Penjualan tiruan ±0,35 KB seperti `PosSaleRef`. */
function sale(i: number, status = "valid") {
  return {
    id: `0192a000-0000-7000-8000-${String(i).padStart(12, "0")}`,
    number: `D05-${String(i).padStart(6, "0")}`,
    localNumber: `D05-260930-POSD05-${String(i).padStart(4, "0")}`,
    soldAt: new Date(Date.UTC(2026, 8, 30, 0, 0, i)).toISOString(),
    total: 5_000 * ((i % 4) + 1),
    paymentMethod: i % 5 === 0 ? "qris" : "cash",
    status,
    lines: [{ productId: "p-isi", quantity: (i % 4) + 1, unitPrice: 5_000, lineTotal: 5_000 * ((i % 4) + 1), gallonSizeL: 19 }],
  };
}

function posRef(sales: ReturnType<typeof sale>[], extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    businessDate: "2026-09-30",
    outlet: { id: "o-d05", code: "D05", name: "Depot 5" },
    settings: { cashLimit: 2_000_000, voidApprovalAbove: 100_000 },
    openShift: { id: "shift-1", partialDepositTotal: 0, openingStock: [{ productId: "p-tutup", systemQty: 40 }], sales },
    conflictShifts: [],
    materials: [
      { id: "p-tutup", balance: 40 },
      { id: "p-tisu", balance: 60 },
    ],
    voidsToday: 0,
    ...extra,
  };
}

const POS: PullCollections = { "openShift.sales": 16, "openShift.openingStock": 8, conflictShifts: 1, materials: 1 };

/** Satu putaran pull bersyarat: klien memegang (data, kursor) → server memberi respons → klien menerapkan. */
function roundTrip(client: { data: unknown; cursor: string | undefined }, current: unknown, cols: PullCollections, serverTime = "2026-09-30T08:00:00.000Z") {
  const version = versionOf(current, cols);
  const result = compareWithCursor(version, client.cursor);
  let data: unknown;
  let bytes: number;
  if (result.kind === "unchanged") {
    data = touchVolatile(client.data, serverTime);
    bytes = 0;
  } else if (result.kind === "patch") {
    data = applyPullPatch(client.data, result.patch, serverTime);
    bytes = JSON.stringify(result.patch).length;
  } else {
    data = current;
    bytes = JSON.stringify(current).length;
  }
  return { result, data, bytes, cursor: result.kind === "unchanged" ? client.cursor : version.cursor };
}

const strip = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === "generatedAt" ? undefined : x)));

describe("Pull bersyarat — sidik isi & delta koleksi (B-89, D-14 butir 3)", () => {
  it("B-89 data sama → kursor sama → 'tidak berubah' tanpa isi; generatedAt tidak ikut sidik", () => {
    const a = posRef([sale(1), sale(2)]);
    const b = { ...posRef([sale(1), sale(2)]), generatedAt: "2026-09-30T09:59:59.000Z" };
    const va = versionOf(a, POS);
    const vb = versionOf(b, POS);
    expect(vb.cursor).toBe(va.cursor);
    expect(compareWithCursor(vb, va.cursor)).toEqual({ kind: "unchanged" });
    // "Tidak berubah": klien hanya menyegarkan generatedAt ke waktu server pull.
    expect(touchVolatile(a, "2026-09-30T10:00:00.000Z")).toMatchObject({ generatedAt: "2026-09-30T10:00:00.000Z", voidsToday: 0 });
    // Kursor hanya karakter aman URL.
    expect(va.cursor).toMatch(/^[A-Za-z0-9_.~!-]+$/);
  });

  it("B-89 klien tanpa kursor / kursor rusak / format lain → data penuh (kompatibel mundur, tidak pernah salah terap)", () => {
    const v = versionOf(posRef([sale(1)]), POS);
    for (const bad of [undefined, "", "x", "2", "2AAAAAAAAAAAA", "3" + v.cursor.slice(1), v.cursor + "~extra", v.cursor.replace(/~/g, "")]) {
      expect(compareWithCursor(v, bad).kind).toBe("full");
    }
  });

  it("B-89 penjualan baru di shift terbuka → delta hanya penjualan baru (salin sisanya); hasil = data penuh", () => {
    let client = { data: posRef(Array.from({ length: 70 }, (_, i) => sale(i))) as unknown, cursor: undefined as string | undefined };
    client = roundTrip(client, client.data, POS);
    const fullBytes = JSON.stringify(client.data).length;
    for (let n = 70; n < 90; n++) {
      const current = posRef(Array.from({ length: n + 1 }, (_, i) => sale(i)), { materials: [{ id: "p-tutup", balance: 40 - n }, { id: "p-tisu", balance: 60 }] });
      const step = roundTrip(client, current, POS);
      expect(step.result.kind).toBe("patch");
      expect(strip(step.data)).toEqual(strip(current));
      const patch = (step.result as { patch: PullPatch }).patch;
      expect(patch.base).toBeUndefined(); // bagian luar tidak berubah
      expect(patch.cols["openShift.sales"]!.segs.some((s) => "copy" in s)).toBe(true);
      expect(step.bytes).toBeLessThan(fullBytes / 3);
      client = { data: step.data, cursor: step.cursor };
    }
  });

  it("B-89 koreksi atas data LAMA (void/koreksi kantor pada penjualan pertama, pembalik di tengah) ikut terkirim — tidak ada yang terlewat", () => {
    const sales = Array.from({ length: 120 }, (_, i) => sale(i));
    let client = roundTrip({ data: undefined, cursor: undefined }, posRef(sales), POS);
    // Kantor menyetujui void penjualan PERTAMA (data lama) — waktu tidak berperan sama sekali.
    const voided = sales.map((s, i) => (i === 0 ? { ...s, status: "voided" } : s));
    let step = roundTrip({ data: client.data, cursor: client.cursor }, posRef(voided), POS);
    expect(step.result.kind).toBe("patch");
    expect((step.data as ReturnType<typeof posRef>).openShift.sales[0]!.status).toBe("voided");
    expect(strip(step.data)).toEqual(strip(posRef(voided)));
    client = step;
    // Baris pembalik disisipkan di TENGAH daftar (urutan waktu jual) + perubahan bagian luar (voidsToday).
    const withReversal = [...voided.slice(0, 60), { ...sale(9_999), total: -5_000 }, ...voided.slice(60)];
    step = roundTrip({ data: client.data, cursor: client.cursor }, posRef(withReversal, { voidsToday: 1 }), POS);
    expect(step.result.kind).toBe("patch");
    expect(strip(step.data)).toEqual(strip(posRef(withReversal, { voidsToday: 1 })));
    const patch = (step.result as { patch: PullPatch }).patch;
    expect(patch.base).toBeDefined();
    const sent = patch.cols["openShift.sales"]!.segs.filter((s) => "items" in s).reduce((n, s) => n + (s as { items: unknown[] }).items.length, 0);
    expect(sent).toBeLessThan(withReversal.length / 2); // hanya ember di sekitar sisipan
  });

  it("B-89 daftar terbaru-dulu dengan jendela (penjualan toko 200 terakhir) → sisipan di depan & butir keluar di belakang tetap delta", () => {
    const cols: PullCollections = { recentSales: 16 };
    const ref = (from: number, to: number) => ({ generatedAt: "x", recentSales: Array.from({ length: to - from }, (_, i) => sale(to - 1 - i)) });
    let client = roundTrip({ data: undefined, cursor: undefined }, ref(0, 200), cols);
    for (let k = 1; k <= 5; k++) {
      const current = ref(k, 200 + k);
      const step = roundTrip({ data: client.data, cursor: client.cursor }, current, cols);
      expect(strip(step.data)).toEqual(strip(current));
      expect(step.bytes).toBeLessThan(JSON.stringify(current).length / 4);
      client = step;
    }
  });

  it("B-89 koleksi objek (faktur per pelanggan) & per butir (rit): hanya entri yang berubah dikirim", () => {
    const cols: PullCollections = { trips: 1, invoicesByCustomer: 1 };
    const trip = (i: number, status: string) => ({ id: `t${i}`, number: `R-${i}`, status, address: "x".repeat(400) });
    const base = { generatedAt: "a", date: "2026-09-30", deposit: { expectedCash: 0 } };
    const v1 = { ...base, trips: [trip(1, "assigned"), trip(2, "assigned"), trip(3, "assigned")], invoicesByCustomer: { c1: [{ id: "i1", remaining: 10 }], c2: [] } };
    const v2 = { ...base, trips: [trip(1, "completed"), trip(2, "assigned"), trip(3, "assigned")], invoicesByCustomer: { c1: [{ id: "i1", remaining: 0 }], c2: [] } };
    const client = roundTrip({ data: undefined, cursor: undefined }, v1, cols);
    const step = roundTrip({ data: client.data, cursor: client.cursor }, v2, cols);
    expect(strip(step.data)).toEqual(strip(v2));
    const patch = (step.result as { patch: PullPatch }).patch;
    expect(patch.cols.trips!.segs).toEqual([{ items: [trip(1, "completed")] }, { copy: [1, 2] }]);
    expect(patch.cols.invoicesByCustomer).toMatchObject({ record: true, segs: [{ items: [["c1", [{ id: "i1", remaining: 0 }]]] }, { copy: [1, 1] }] });
  });

  it("B-89 induk koleksi muncul/hilang (shift dibuka/ditutup) & koleksi kosong ditangani; bagian luar berubah → semua koleksi disertakan", () => {
    const noShift = { ...posRef([]), openShift: null };
    let client = roundTrip({ data: undefined, cursor: undefined }, noShift, POS);
    const opened = posRef([sale(1)]);
    let step = roundTrip({ data: client.data, cursor: client.cursor }, opened, POS);
    expect(strip(step.data)).toEqual(strip(opened));
    client = step;
    step = roundTrip({ data: client.data, cursor: client.cursor }, noShift, POS);
    expect(strip(step.data)).toEqual(strip(noShift));
  });

  it("B-89 klien menerapkan delta hanya bila data lokal cocok (panjang koleksi, rentang salin) — selain itu galat → tarik penuh", () => {
    const old = posRef(Array.from({ length: 20 }, (_, i) => sale(i)));
    const client = roundTrip({ data: undefined, cursor: undefined }, old, POS);
    const current = posRef(Array.from({ length: 21 }, (_, i) => sale(i)));
    const res = compareWithCursor(versionOf(current, POS), client.cursor);
    expect(res.kind).toBe("patch");
    const patch = (res as { patch: PullPatch }).patch;
    const tampered = { ...old, openShift: { ...old.openShift, sales: old.openShift.sales.slice(0, 5) } };
    expect(() => applyPullPatch(tampered, patch, "t")).toThrow(PullPatchError);
    expect(() => applyPullPatch(undefined, patch, "t")).toThrow(PullPatchError);
    expect(() => applyPullPatch(old, { cols: { "openShift.sales": { from: 20, segs: [{ copy: [15, 10] }] } } }, "t")).toThrow(PullPatchError);
  });

  it("B-89 parameter kursor: `v=2&c.<kunci>=<kursor>`; tanpa v=2 → klien lama (null); kunci/kursor tidak sah diabaikan", () => {
    const q = pullCursorQuery([
      ["m6.pos", "2abcdefghijkl~Aa_-9xyz1.Bb2"],
      ["core.me", "2ZZZZZZZZZZZZ"],
      ["BAD KEY", "2x"],
      ["m1.catalog", "bad cursor!!?"],
      ["m7.store", "x".repeat(MAX_PULL_CURSOR_LENGTH + 1)],
    ]);
    expect(q).toBe("v=2&c.m6.pos=2abcdefghijkl~Aa_-9xyz1.Bb2&c.core.me=2ZZZZZZZZZZZZ");
    expect(readPullCursors(new URLSearchParams(q))).toEqual({ "m6.pos": "2abcdefghijkl~Aa_-9xyz1.Bb2", "core.me": "2ZZZZZZZZZZZZ" });
    expect(readPullCursors(new URLSearchParams("since=2026-09-30T00:00:00Z&keys=m6.pos"))).toBeNull();
    expect(readPullCursors(new URLSearchParams("v=2"))).toEqual({});
    expect(readPullCursors(new URLSearchParams("v=2&c.m6.pos=%3Cscript%3E&c.x=1"))).toEqual({});
  });

  it("B-89 acak: 200 perubahan campuran (tambah, ubah, sisip, hapus, bagian luar) — hasil klien selalu identik dengan data penuh", () => {
    let seed = 20260930;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % n;
    };
    let sales = Array.from({ length: 40 }, (_, i) => sale(i));
    let voids = 0;
    let next = 1_000;
    let client = roundTrip({ data: undefined, cursor: undefined }, posRef(sales), POS);
    for (let step = 0; step < 200; step++) {
      const op = rnd(6);
      if (op <= 1) sales = [...sales, sale(next++)];
      else if (op === 2 && sales.length) sales = sales.map((s, i) => (i === rnd(sales.length) ? { ...s, status: "voided" } : s));
      else if (op === 3) {
        const at = rnd(sales.length + 1);
        sales = [...sales.slice(0, at), sale(next++), ...sales.slice(at)];
      } else if (op === 4 && sales.length > 1) sales = sales.filter((_, i) => i !== rnd(sales.length));
      else voids++;
      const current = posRef(sales, { voidsToday: voids });
      const res = roundTrip({ data: client.data, cursor: client.cursor }, current, POS);
      expect(strip(res.data)).toEqual(strip(current));
      client = res;
    }
  });
});
