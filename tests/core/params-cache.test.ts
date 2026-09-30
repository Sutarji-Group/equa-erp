/**
 * D-14 butir 4 / B-90 (v1.0.1): cache pembacaan parameter per transaksi/permintaan (`params.cached(tx)`), tambahan inti.
 * Nilai WAJIB sama dengan `params.resolve` untuk setiap tanggal × lingkup; cache terikat objek transaksi (tidak bocor
 * antar transaksi/permintaan/tenant/tanggal) dan dikosongkan saat parameter ditetapkan.
 */
import { describe, expect, it } from "vitest";

import { EQUA_TENANT_ID, outletId } from "@/db/seed";
import { withTx } from "@/server/core/db";
import * as params from "@/server/core/params";

import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { ensureTenant } from "../helpers/factories";

const NOW = new Date("2026-09-28T03:00:00Z"); // 10.00 WIB
const OTHER_TENANT = "0192f1c4-7b7a-7cc2-9d7e-3f1b2a4c5d77";

describe("params.cached — cache pembacaan parameter per transaksi (D-14 butir 4)", () => {
  const t = useTestDb({ seed: true });
  const owner = () => seededContext("pemilik", { now: NOW });

  it("US-M10-04 KP-6 D-14 nilai dari cache = params.resolve untuk setiap tanggal × lingkup (global, tenant, outlet, riwayat, bawaan)", async () => {
    await ensureTenant(t.db, OTHER_TENANT, "MITRA77", "partner");
    const d01 = outletId("D01");
    const d02 = outletId("D02");
    // Riwayat PAR-02 (lingkup global/tenant/outlet): global 10/05, tenant EQUA 10/10, outlet D01 10/20, global lagi 11/01.
    await params.set(owner(), "PAR-02", { amount: 60_000 }, "2026-10-05", "Uji cache global");
    await params.set(owner(), "PAR-02", { amount: 70_000 }, "2026-10-10", "Uji cache tenant", { tenantId: EQUA_TENANT_ID });
    await params.set(owner(), "PAR-02", { amount: 80_000 }, "2026-10-20", "Uji cache outlet", { tenantId: EQUA_TENANT_ID, outletId: d01 });
    await params.set(owner(), "PAR-02", { amount: 65_000 }, "2026-11-01", "Uji cache global 2");

    const dates = ["2025-06-01", "2026-09-30", "2026-10-04", "2026-10-05", "2026-10-09", "2026-10-10", "2026-10-19", "2026-10-20", "2026-10-31", "2026-11-01", "2027-02-01"];
    const scopes: params.ParamScopeRef[] = [
      {},
      { tenantId: EQUA_TENANT_ID },
      { tenantId: EQUA_TENANT_ID, outletId: d01 },
      { tenantId: EQUA_TENANT_ID, outletId: d02 },
      { tenantId: OTHER_TENANT },
    ];
    const keys = ["PAR-02", "PAR-01", "m12.fleet_rules"] as const;
    await withTx(async (tx) => {
      const cache = params.cached(tx);
      for (const key of keys) {
        for (const scope of scopes) {
          for (const d of dates) {
            expect(await cache.resolve(key, d, scope), `${key} ${d} ${JSON.stringify(scope)}`).toEqual(await params.resolve(tx, key, d, scope));
          }
        }
      }
      // Satu kueri per (kunci, tenant, outlet) — bukan per tanggal.
      expect(cache.queries).toBe(keys.length * scopes.length);
    });

    // Titik uji eksplisit: lingkup paling spesifik menang, lalu effective_from terbaru ≤ tanggal.
    const pc = params.cached(t.db);
    expect(await pc.get("PAR-02", "2026-10-25", { tenantId: EQUA_TENANT_ID, outletId: d01 })).toEqual({ amount: 80_000 });
    expect(await pc.get("PAR-02", "2026-11-05", { tenantId: EQUA_TENANT_ID, outletId: d02 })).toEqual({ amount: 70_000 });
    expect(await pc.get("PAR-02", "2026-11-05", { tenantId: OTHER_TENANT })).toEqual({ amount: 65_000 });
    expect((await pc.resolve("PAR-02", "2026-10-07")).source).toBe("db");

    // Galat sama dengan resolve (kunci tidak dikenal, tanggal tidak valid).
    await expect(pc.get("PAR-999" as params.ParamKey, "2026-10-01")).rejects.toMatchObject({ code: "PARAM_UNKNOWN" });
    await expect(pc.get("PAR-01", "2026-13-01")).rejects.toMatchObject({ code: "INVALID_DATE" });
  });

  it("D-14 cache terikat objek transaksi: sama dalam satu transaksi, berbeda antar transaksi; db tanpa transaksi → cache baru tiap panggilan", async () => {
    const [a, b] = await withTx(async (tx) => [params.cached(tx), params.cached(tx)] as const);
    expect(a).toBe(b);
    const c = await withTx(async (tx) => params.cached(tx));
    expect(c).not.toBe(a);
    expect(params.cached(t.db)).not.toBe(params.cached(t.db));
  });

  it("US-M10-04 KP-6 D-14 penetapan parameter di transaksi yang sama mengosongkan cache; nilai hasil aman dimutasi", async () => {
    await withTx(async (tx) => {
      const pc = params.cached(tx);
      const before = await pc.get("PAR-01", "2026-12-01");
      expect(before.amount).toBe(50_000);
      before.amount = 1; // mutasi pemanggil tidak mengubah isi cache
      expect((await pc.get("PAR-01", "2026-12-01")).amount).toBe(50_000);
      await params.set(owner(), "PAR-01", { amount: 99_000 }, "2026-12-01", "Uji pembatalan cache", { tx });
      expect((await pc.get("PAR-01", "2026-12-01")).amount).toBe(99_000);
      expect((await pc.get("PAR-01", "2026-11-30")).amount).toBe(50_000);
    });
  });
});
