import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { shifts } from "@/db/schema";
import { NAV_GROUPS } from "@/components/shared/nav/registry";
import { toBusinessDate } from "@/lib/time";
import { getApprovalHandlers } from "@/server/core/approvals";
import { ForbiddenError } from "@/server/core/errors";
import { exportReport, listReports } from "@/server/core/export";
import { listJobs } from "@/server/core/jobs";
import { listPullProviders, listSyncHandlerTypes } from "@/server/core/sync";
import { listShiftConflicts, resolveShiftConflict } from "@/server/modules/m6-pos";

import { bootstrapForTests } from "../helpers/bootstrap";
import { seededContext } from "../helpers/context";
import { useTestDb } from "../helpers/db";
import { expectApplied, finance, isi, openShiftVia, owner, posFor, sellVia } from "./helpers";

describe("M6 registrasi modul (sinkron, persetujuan, job, laporan, menu)", () => {
  const t = useTestDb({ seed: true });
  beforeAll(() => bootstrapForTests());

  it("US-M6-06 KP-1 semua aksi POS terdaftar sebagai perintah sinkron offline + penyedia pull m6.pos", () => {
    const types = listSyncHandlerTypes();
    for (const type of [
      "m6.shift.open",
      "m6.shift.close",
      "m6.pos_sale.create",
      "m6.pos_sale.void",
      "m6.shift_deposit.partial",
      "m6.shift_deposit.submit",
      "m6.water_supply.confirm",
      "m6.water_supply.record_other",
      "m6.consumable_receipt.create",
      "m6.internal_transfer.receive",
      "m6.stock_count.submit",
    ]) {
      expect(types).toContain(type);
    }
    expect(listPullProviders().map(([k]) => k)).toContain("m6.pos");
    expect(getApprovalHandlers("pos_void")?.onExpired).toBeTypeOf("function");
    expect(getApprovalHandlers("stock_adjustment")?.onApproved).toBeTypeOf("function");
    expect(listJobs().map((j) => j.key)).toEqual(expect.arrayContaining(["m6.stock_count.weekly_check", "m6.water_balance.weekly", "m6.water_balance.monthly", "m6.deposit.late_check"]));
  });

  it("US-M6-07 KP-5 laporan outlet diekspor Excel/PDF untuk pemilik/Admin Keuangan; operator & dispatcher ditolak", async () => {
    const pos = await posFor("D04");
    const { shiftId } = await openShiftVia(pos);
    expectApplied((await sellVia(pos, shiftId, [isi(2)])).res);
    const keys = listReports()
      .map((r) => r.key)
      .filter((k) => k.startsWith("m6."));
    expect(keys.sort()).toEqual(
      ["m6.outlet_daily", "m6.pos_sales", "m6.shifts", "m6.stock_card", "m6.stock_counts", "m6.usage_vs_sales", "m6.voids", "m6.water_balance", "m6.water_supply"].sort(),
    );
    const d = toBusinessDate(new Date());
    for (const key of keys) {
      const filters = key === "m6.stock_card" ? { outletId: pos.outletId } : { from: d, to: d };
      const x = await exportReport(owner(), key, "xlsx", filters);
      expect(x.body.length, key).toBeGreaterThan(0);
    }
    const pdf = await exportReport(finance(), "m6.outlet_daily", "pdf", { from: d, to: d });
    expect(pdf.contentType).toBe("application/pdf");
    await expect(exportReport(seededContext("dispatcher1"), "m6.outlet_daily", "xlsx", {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(exportReport(seededContext("depot04"), "m6.pos_sales", "xlsx", {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("US-M6-02 KP-1 konflik shift perangkat cadangan tampil ke Admin Keuangan dan ditandai ditinjau (data lapangan tidak diubah)", async () => {
    const pos = await posFor("D05");
    await openShiftVia(pos);
    const spare = await openShiftVia(pos);
    expect(spare.res.status).toBe("conflict");
    const list = await listShiftConflicts(finance());
    expect(list.map((r) => r.shift.id)).toContain(spare.shiftId);
    await expect(resolveShiftConflict(owner(), { shiftId: spare.shiftId, note: "Sudah dicocokkan" })).rejects.toBeInstanceOf(ForbiddenError);
    await resolveShiftConflict(finance(), { shiftId: spare.shiftId, note: "Perangkat cadangan dipakai saat tablet rusak; dicocokkan" });
    const [row] = await t.db.select().from(shifts).where(eq(shifts.id, spare.shiftId));
    expect(row!.conflictResolvedAt).not.toBeNull();
    expect(row!.syncConflict).toBe(true);
  });

  it("menu M6 di registri nav memakai izin katalog dan rute yang dibangun", () => {
    const items = NAV_GROUPS.flatMap((g) => g.items).filter((i) => i.id.startsWith("m6."));
    expect(items.map((i) => i.href).sort()).toEqual(["/outlet", "/outlet/[id]", "/outlet/laporan", "/outlet/shift/[id]", "/outlet/tenant"].sort());
  });
});
