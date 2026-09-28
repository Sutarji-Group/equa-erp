/**
 * Seed demo Laporan & Dashboard (M9) — idempoten (ID deterministik + ON CONFLICT DO NOTHING). M9 tidak punya transaksi
 * usaha sendiri: angka H+0, bulanan, tren, kinerja, dan KPI dihitung dari data demo M2–M8/M12 yang sudah ada. H+0 hari
 * kas yang sudah ditutup (demo M4) diterbitkan otomatis oleh job/tampilan (`publishPendingSummaries`) — tidak di-seed.
 *
 * Isi (tanggal relatif hari seed):
 * - KPI-10: jam pemilik per minggu untuk 2 bulan terakhir (input manual pemilik, US-M9-07 KP-2).
 * - Periode paralel (NFR-35): truk T1 — nota kertas ditarik pada hari ke-14 (lembar pencocokan 14 hari, 1 hari selisih
 *   terjelaskan); depot D10 — berjalan hari ke-7, 5 lembar cocok (syarat PAR-84 terpenuhi → siap diajukan tarik lebih
 *   awal ke pemilik).
 *
 * Dilewati saat snapshot DB uji Vitest dibangun (tanggal relatif); uji M9 membuat datanya sendiri.
 */
import { addDays, toBusinessDate } from "../../lib/time";
import type { DbOrTx } from "../client";
import { kpiManualInputs, parallelRunChecks, unitPaperWithdrawals } from "../schema";
import { seedId } from "./ids";
import { EQUA_TENANT_ID, outletId, truckId, userIdByUsername } from "./org";

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export async function seedDemoM9Reports(tx: DbOrTx, opts: { force?: boolean; today?: string } = {}): Promise<{ kpiInputs: number; parallelUnits: number; checks: number }> {
  if (!opts.force && (process.env.VITEST || process.env.NODE_ENV === "test")) return { kpiInputs: 0, parallelUnits: 0, checks: 0 };
  const today = opts.today ?? toBusinessDate(new Date());
  const owner = userIdByUsername("pemilik");
  const finance = userIdByUsername("keuangan1");
  const month = today.slice(0, 7);

  // KPI-10 (US-M9-07 KP-2).
  const kpi = await tx
    .insert(kpiManualInputs)
    .values([
      { id: seedId(`m9:kpi10:${shiftMonth(month, -2)}`), tenantId: EQUA_TENANT_ID, kpiCode: "KPI-10", period: shiftMonth(month, -2), value: 9.5, note: "Catatan buku saku pemilik (sebelum go-live)", createdBy: owner },
      { id: seedId(`m9:kpi10:${shiftMonth(month, -1)}`), tenantId: EQUA_TENANT_ID, kpiCode: "KPI-10", period: shiftMonth(month, -1), value: 7, note: "Mulai membaca H+0 tiap malam", createdBy: owner },
    ])
    .onConflictDoNothing()
    .returning({ id: kpiManualInputs.id });

  // Periode paralel: T1 ditarik hari ke-14; D10 berjalan hari ke-7.
  const t1Start = addDays(today, -20);
  const d10Start = addDays(today, -6);
  const units = await tx
    .insert(unitPaperWithdrawals)
    .values([
      { id: seedId("m9:parallel:T1"), tenantId: EQUA_TENANT_ID, unitType: "truck" as const, truckId: truckId("T1"), parallelStartDate: t1Start, withdrawnDate: addDays(t1Start, 13), notes: "Unit pilot pertama", createdBy: finance },
      { id: seedId("m9:parallel:D10"), tenantId: EQUA_TENANT_ID, unitType: "outlet" as const, outletId: outletId("D10"), parallelStartDate: d10Start, notes: "Perluasan depot D10", createdBy: finance },
    ])
    .onConflictDoNothing()
    .returning({ id: unitPaperWithdrawals.id });

  const checks: (typeof parallelRunChecks.$inferInsert)[] = [];
  for (let i = 0; i < 14; i++) {
    const date = addDays(t1Start, i);
    const diff = i === 4;
    checks.push({
      id: seedId(`m9:check:T1:${i}`),
      tenantId: EQUA_TENANT_ID,
      unitType: "truck",
      truckId: truckId("T1"),
      businessDate: date,
      paperCount: diff ? 6 : 5,
      paperAmount: diff ? 1_500_000 : 1_250_000,
      systemCount: 5,
      systemAmount: 1_250_000,
      differenceCount: diff ? 1 : 0,
      differenceAmount: diff ? 250_000 : 0,
      explained: true,
      cause: diff ? "Nota rit ke-6 ditulis ganda oleh kernet; sistem benar" : null,
      createdBy: finance,
    });
  }
  for (let i = 0; i < 5; i++) {
    checks.push({
      id: seedId(`m9:check:D10:${i}`),
      tenantId: EQUA_TENANT_ID,
      unitType: "outlet",
      outletId: outletId("D10"),
      businessDate: addDays(d10Start, i),
      paperCount: 0,
      paperAmount: 0,
      systemCount: 0,
      systemAmount: 0,
      differenceCount: 0,
      differenceAmount: 0,
      explained: true,
      createdBy: finance,
    });
  }
  const inserted = await tx.insert(parallelRunChecks).values(checks).onConflictDoNothing().returning({ id: parallelRunChecks.id });
  return { kpiInputs: kpi.length, parallelUnits: units.length, checks: inserted.length };
}
