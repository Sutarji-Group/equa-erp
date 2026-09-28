import { beforeAll, describe, expect, it } from "vitest";

import { seedDemoM9Reports } from "@/db/seed/demo-m9-reports";
import { toBusinessDate } from "@/lib/time";
import * as m9 from "@/server/modules/m9-reports";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { finance, owner } from "./helpers";

describe("M9 — seed demo (idempoten)", () => {
  const t = useTestDb({ seed: true });
  const today = toBusinessDate(new Date());
  beforeAll(() => bootstrapForTests());

  it("US-M9-07 KP-2 seed demo: KPI-10 dua bulan, periode paralel T1 ditarik hari ke-14 & D10 berjalan (PAR-84 terpenuhi) — idempoten", async () => {
    const first = await seedDemoM9Reports(t.db, { force: true, today });
    expect(first).toEqual({ kpiInputs: 2, parallelUnits: 2, checks: 19 });
    expect(await seedDemoM9Reports(t.db, { force: true, today })).toEqual({ kpiInputs: 0, parallelUnits: 0, checks: 0 });
    // Tanpa force (Vitest) dilewati.
    expect(await seedDemoM9Reports(t.db)).toEqual({ kpiInputs: 0, parallelUnits: 0, checks: 0 });

    const units = await m9.listParallelUnits(owner());
    const t1 = units.find((u) => u.unitLabel.startsWith("Truk T1"))!;
    const d10 = units.find((u) => u.unitLabel.startsWith("D10"))!;
    expect(t1).toMatchObject({ status: "withdrawn", dayNumber: 14, checks: 14, unexplained: 0 });
    expect(d10).toMatchObject({ status: "running", dayNumber: 7, checks: 5, par84: { met: true } });
    // Alur E2E: Admin Keuangan mengajukan tarik lebih awal D10 → persetujuan pemilik.
    const res = await m9.withdrawPaper(finance(), { withdrawalId: d10.id, withdrawnDate: today });
    expect(res.status).toBe("pending_approval");
    const page = await m9.getKpiReport(owner(), {});
    expect(page.ownerHours).toHaveLength(2);
  });
});
