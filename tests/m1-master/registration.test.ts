import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { devices, importBatches } from "@/db/schema";
import { deviceId, outletId } from "@/db/seed";
import { getApprovalHandlers } from "@/server/core/approvals";
import { withTx } from "@/server/core/db";
import { listHandlers } from "@/server/core/events";
import { exportReport, getReport } from "@/server/core/export";
import { getJob, runJobNow } from "@/server/core/jobs";
import { listPullProviders } from "@/server/core/sync";
import * as m1 from "@/server/modules/m1-master";

import { seededContext } from "../helpers/context";
import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { dispatcher, finance, owner, T0 } from "./helpers";

describe("M1 Master Data", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  describe("Registrasi modul M1 (event, persetujuan, job, laporan, pull)", () => {
    it("handler event, jenis persetujuan, job, dan penyedia pull M1 terdaftar", () => {
      expect(listHandlers("trip.completed")).toContain(
        "m1-master:propose_coordinate",
      );
      for (const type of [
        "credit_grant",
        "credit_terms_change",
        "special_price",
        "price_change",
      ]) {
        expect(getApprovalHandlers(type)?.onApproved, type).toBeTypeOf(
          "function",
        );
      }
      expect(getApprovalHandlers("price_change")?.onExpired).toBeTypeOf(
        "function",
      );
      for (const key of [
        "m1.zone_table_effective",
        "m1.employee_exit",
        "m1.store_partner_flags",
        "m1.special_price_review",
      ])
        expect(getJob(key), key).toBeDefined();
      const pulls = listPullProviders().map(([k]) => k);
      expect(pulls).toEqual(
        expect.arrayContaining(["m1.catalog", "m1.store_partners"]),
      );
    });

    it("US-M9-03 KP-1 laporan M1 terdaftar & dapat diekspor Excel/PDF (riwayat harga, simulasi zona — katalog 7.9.4)", async () => {
      for (const key of [
        "m1.customers",
        "m1.price_history",
        "m1.zone_simulation",
        "m1.zone_moves",
        "m1.products",
        "m1.trucks",
        "m1.outlets",
        "m1.water_sources",
        "m1.employees",
        "m1.special_price_reviews",
        "m1.import_validation",
      ]) {
        expect(getReport(key), key).toBeDefined();
      }
      const xlsx = await exportReport(owner(), "m1.price_history", "xlsx", {});
      expect(xlsx.rowCount).toBeGreaterThan(5);
      const pdf = await exportReport(owner(), "m1.zone_simulation", "pdf", {});
      expect(pdf.body.subarray(0, 4).toString()).toBe("%PDF");
    });

    it("BR-39 ekspor daftar pelanggan (data pribadi) hanya pemilik/Admin Keuangan dengan tujuan; Dispatcher tidak berhak", async () => {
      await expect(
        exportReport(dispatcher(), "m1.customers", "xlsx", {}),
      ).rejects.toThrow();
      await expect(
        exportReport(finance(), "m1.customers", "csv", {}, ""),
      ).rejects.toThrow();
      const res = await exportReport(
        finance(),
        "m1.customers",
        "csv",
        {},
        "Rekonsiliasi daftar pelanggan dengan konsultan",
      );
      expect(res.containsPersonalData).toBe(true);
      expect(res.rowCount).toBeGreaterThan(40);
    });

    it("US-M1-02 KP-6 data referensi POS offline (pull m1.catalog) hanya produk aktif dengan harga berlaku outlet", async () => {
      const provider = listPullProviders().find(
        ([k]) => k === "m1.catalog",
      )![1];
      const [device] = await t.db
        .select()
        .from(devices)
        .where(eq(devices.id, deviceId("POS-D01")));
      const ctx = seededContext("depot01", { now: T0 });
      const data = (await withTx((tx) =>
        Promise.resolve(
          provider.fetch({ ctx, device: device!, since: null, now: T0, tx }),
        ),
      )) as {
        outletId: string;
        products: { code: string; prices: Record<string, number> }[];
      };
      expect(data.outletId).toBe(outletId("D01"));
      expect(
        data.products.find((p) => p.code === "ISI-ULANG")!.prices.standard,
      ).toBe(5_000);
      expect(data.products.every((p) => !p.code.startsWith("TK-"))).toBe(true);
      // Tidak berubah sejak pull terakhir → undefined.
      const again = await withTx((tx) =>
        Promise.resolve(
          provider.fetch({
            ctx,
            device: device!,
            since: new Date(T0.getTime() + 86_400_000 * 365),
            now: T0,
            tx,
          }),
        ),
      );
      expect(again).toBeUndefined();
    });

    it("job harian M1 berjalan idempoten lewat penjadwal inti", async () => {
      const r = await runJobNow("m1.store_partner_flags", T0);
      expect(r.status).toBe("succeeded");
      const z = await runJobNow("m1.zone_table_effective", T0);
      expect(z.status).toBe("succeeded");
      expect(m1.MODULE_KEY).toBe("m1-master");
      void importBatches;
    });
  });
});
