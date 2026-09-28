import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { waMessageLogs } from "@/db/schema";
import { customerId, userIdByUsername } from "@/db/seed";
import { withTx } from "@/server/core/db";
import { ValidationError } from "@/server/core/errors";
import { osrmProvider, straightLineProvider, validateZoneTable, zoneForDistance } from "@/server/core/maps";
import {
  assertWaNumber,
  buildWaLink,
  cloudApiProvider,
  formatWaNumber,
  isValidWaNumber,
  linkProvider,
  normalizeWaNumber,
  recordWaOpened,
  renderTemplate,
} from "@/server/core/wa";

import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";

describe("WhatsApp (K21, NFR-20)", () => {
  it("US-M1-01 KP-1 normalisasi nomor WA Indonesia (08…, +62…, 62…, 8…) → 628…", () => {
    expect(normalizeWaNumber("0812-3456-7890")).toBe("6281234567890");
    expect(normalizeWaNumber("+62 812 3456 7890")).toBe("6281234567890");
    expect(normalizeWaNumber("62812.3456.7890")).toBe("6281234567890");
    expect(normalizeWaNumber("812 3456 789")).toBe("62812345678" + "9");
    expect(normalizeWaNumber("(0812) 3456-7890")).toBe("6281234567890");
    expect(normalizeWaNumber("+620812345678")).toBe("62812345678");
  });

  it("US-M1-01 KP-1 nomor tidak valid ditolak dengan pesan Indonesia", () => {
    for (const bad of ["", null, "021-123456", "0812", "0812345678901234", "abc", "+1 555 123 4567", "0712345678"]) {
      expect(isValidWaNumber(bad as string), String(bad)).toBe(false);
    }
    expect(() => assertWaNumber("021-5551234")).toThrow(ValidationError);
    expect(() => assertWaNumber("021-5551234")).toThrow(/Nomor WA tidak valid/);
    expect(formatWaNumber("6281234567890")).toBe("0812-3456-7890");
  });

  it("US-M2-07 KP-1 template terisi dan tautan wa.me", () => {
    const { text, missing } = renderTemplate("Halo {{nama}}, pesanan {{ nomor }} total {{total}}. {{kosong}}", {
      nama: "Bu Ani",
      nomor: "P-26-000123",
      total: "Rp 400.000",
    });
    expect(text).toBe("Halo Bu Ani, pesanan P-26-000123 total Rp 400.000. ");
    expect(missing).toEqual(["kosong"]);
    const link = buildWaLink("0812-3456-7890", "Halo & terima kasih");
    expect(link).toBe("https://wa.me/6281234567890?text=Halo%20%26%20terima%20kasih");
  });

  it("PTB-60 penyedia tautan & Cloud API (gagal → tautan cadangan)", async () => {
    expect(await linkProvider.send({ to: "081234567890", text: "Hai", kind: "order_confirmation" })).toEqual({
      mode: "link",
      link: "https://wa.me/6281234567890?text=Hai",
    });
    const ok = cloudApiProvider({
      token: "t",
      phoneNumberId: "p",
      fetchImpl: async () => new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 }),
    });
    expect(await ok.send({ to: "081234567890", text: "Hai", kind: "trip_receipt" })).toEqual({ mode: "cloud_api", status: "sent", providerMessageId: "wamid.1" });
    const down = cloudApiProvider({ token: "t", phoneNumberId: "p", fetchImpl: async () => new Response("{}", { status: 503 }) });
    const res = await down.send({ to: "081234567890", text: "Hai", kind: "trip_receipt" });
    expect(res).toMatchObject({ mode: "cloud_api", status: "failed", fallbackLink: "https://wa.me/6281234567890?text=Hai" });
  });

  describe("pencatatan 'dibuka' (PGlite)", () => {
    const t = useTestDb({ seed: true });
    it("US-M2-07 KP-2 mencatat konfirmasi dibuka tanpa klaim terkirim", async () => {
      const row = await withTx((tx) =>
        recordWaOpened(tx, seededContext("dispatcher1"), {
          kind: "order_confirmation",
          toPhone: "0812-2000-0034",
          renderedText: "Pesanan Anda sudah kami catat",
          customerId: customerId("PLG-0034"),
          objectType: "order",
          objectId: "P-26-000123",
        }),
      );
      expect(row).toMatchObject({ status: "link_opened", provider: "link", toPhone: "6281220000034", openedBy: userIdByUsername("dispatcher1") });
      const rows = await t.db.select().from(waMessageLogs).where(eq(waMessageLogs.id, row.id));
      expect(rows).toHaveLength(1);
    });
  });
});

describe("Peta & zona (US-M1-05)", () => {
  const cianjur = { lat: -6.8172, lng: 107.1428 };
  const cugenang = { lat: -6.7712, lng: 107.0853 };

  it("US-M1-05 KP-2 cadangan garis lurus × 1,3", async () => {
    const r = await straightLineProvider.distanceKm(cianjur, cugenang);
    expect(r.method).toBe("straight_line_x1_3");
    expect(r.estimated).toBe(false);
    expect(r.km).toBeGreaterThan(10);
    expect(r.km).toBeLessThan(12);
    await expect(straightLineProvider.distanceKm({ lat: 200, lng: 0 }, cugenang)).rejects.toBeInstanceOf(ValidationError);
  });

  it("NFR-24 OSRM dipakai bila tersedia; gagal → garis lurus bertanda estimasi", async () => {
    const osrm = osrmProvider("http://osrm.test", async () => new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 12_345 }] })));
    expect(await osrm.distanceKm(cianjur, cugenang)).toEqual({ km: 12.345, meters: 12_345, method: "route", estimated: false });
    const down = osrmProvider("http://osrm.test", async () => {
      throw new Error("down");
    });
    expect(await down.distanceKm(cianjur, cugenang)).toMatchObject({ method: "straight_line_x1_3", estimated: true });
  });

  it("US-M1-05 KP-1 zona [min, max) tanpa celah/tumpang tindih", () => {
    const zones = [
      { id: "z1", code: "Z1", minDistanceM: 0, maxDistanceM: 5_000 },
      { id: "z2", code: "Z2", minDistanceM: 5_000, maxDistanceM: 10_000 },
      { id: "z3", code: "Z3", minDistanceM: 10_000, maxDistanceM: null },
    ];
    expect(zoneForDistance(zones, 0)?.code).toBe("Z1");
    expect(zoneForDistance(zones, 4.999)?.code).toBe("Z1");
    expect(zoneForDistance(zones, 5)?.code).toBe("Z2");
    expect(zoneForDistance(zones, 42)?.code).toBe("Z3");
    expect(validateZoneTable(zones)).toEqual([]);
    expect(validateZoneTable([zones[0]!, { ...zones[1]!, minDistanceM: 6_000 }]).join(" ")).toMatch(/celah/);
    expect(validateZoneTable([zones[0]!, { ...zones[1]!, minDistanceM: 4_000 }]).join(" ")).toMatch(/tumpang tindih/);
  });
});
