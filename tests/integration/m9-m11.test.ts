/**
 * Uji integrasi ronde M9 + M11: Laporan & Dashboard (M9) ↔ Akuntansi & Pajak (M11). Kedua modul dibangun paralel; M9
 * menguji laporan bulanan dengan jurnal yang ditulis langsung dan `period.locked` tiruan, M11 menguji tutup/kunci periode
 * tanpa M9. Berkas ini memastikan keduanya tersambung setelah digabung:
 * - peristiwa operasional nyata → jurnal otomatis M11 → laba kotor bulanan M9 (satu definisi omzet per lini: angka M9
 *   sama dengan laba rugi M11 untuk periode yang sama);
 * - pemilik mengunci periode lewat persetujuan `period_lock` M11 → `period.locked` → versi Final M9 tersimpan +
 *   notifikasi; buka kembali → Sementara; kunci ulang → revisi baru, revisi lama tetap tersimpan (BR-32);
 * - tanpa handler lintas modul yang gagal diam-diam (insiden).
 */
import { and, eq, like, or } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import { incidents, notifications, reportSnapshots } from "@/db/schema";
import { EQUA_TENANT_ID, userIdByUsername } from "@/db/seed";
import * as approvals from "@/server/core/approvals";
import * as m11 from "@/server/modules/m11-accounting";
import * as m9 from "@/server/modules/m9-reports";

import { bootstrapForTests } from "../helpers/bootstrap";
import { useTestDb } from "../helpers/db";
import { THIS_PERIOD, at, emitEvent, finance, journalOfEvent, owner, periodRow, setPeriod, shiftMonth, tripPayload } from "../m11-accounting/helpers";

const MONTH = shiftMonth(THIS_PERIOD, -1);
const DAY5 = `${THIS_PERIOD}-05`;
const CENTERS = ["L1", "L2", "L3", "L4", "L5", "SHARED"] as const;

/** Insiden dari handler M9/M11 yang gagal (handler terisolasi savepoint tidak menggagalkan transaksi sumber). */
async function crossModuleIncidents(db: Db) {
  return db
    .select({ title: incidents.title, description: incidents.description })
    .from(incidents)
    .where(or(like(incidents.title, "%(m9-reports:%"), like(incidents.title, "%(m11-accounting:%")));
}

async function monthlyFinals(db: Db) {
  return db
    .select()
    .from(reportSnapshots)
    .where(and(eq(reportSnapshots.tenantId, EQUA_TENANT_ID), eq(reportSnapshots.reportKey, m9.MONTHLY_REPORT_KEY), eq(reportSnapshots.period, MONTH)));
}

/** Tutup periode (Admin Keuangan) lalu pemilik mengunci lewat persetujuan `period_lock` — jalur nyata M11. */
async function closeAndLock(db: Db, periodId: string) {
  // Prasyarat tutup buku diuji M11 (US-M11-10 KP-1/KP-2); di sini status Ditutup + permintaan kunci disiapkan langsung.
  await setPeriod(db, MONTH, "closed");
  await approvals.submit(finance(at(DAY5)), {
    type: "period_lock",
    objectType: "accounting_period",
    objectId: periodId,
    reason: `Tutup buku ${MONTH} — kunci periode (uji integrasi)`,
    businessDate: `${MONTH}-28`,
    payload: { period: MONTH, late: false },
  });
  return m11.lockPeriod(owner(at(DAY5)), { periodId, note: "Laporan sesuai" });
}

describe("Integrasi M9 ↔ M11: laba kotor bulanan dari jurnal otomatis & versi Final saat periode dikunci", () => {
  const t = useTestDb({ seed: true });
  let periodId = "";

  beforeAll(async () => {
    bootstrapForTests();
    periodId = (await setPeriod(t.db, MONTH, "open")).id;
  });

  it("US-M9-02 KP-1 omzet & laba kotor per lini M9 = laba rugi M11 dari jurnal otomatis peristiwa nyata (satu definisi)", async () => {
    const before = await m9.getMonthlyReport(owner(at(DAY5)), { month: MONTH });
    expect(before.source).toBe("journals");

    const cash = await emitEvent("trip.completed", tripPayload({ price: 400_000, cashReceived: 400_000 }), { businessDate: `${MONTH}-12` });
    const credit = await emitEvent(
      "trip.completed",
      tripPayload({ price: 300_000, cashReceived: 0, paymentMethod: "credit", creditAmount: 300_000 }),
      { businessDate: `${MONTH}-13` },
    );
    for (const ev of [cash, credit]) expect(await journalOfEvent(t.db, ev.id), ev.type).toMatchObject({ status: "posted" });

    const report = await m9.getMonthlyReport(owner(at(DAY5)), { month: MONTH });
    const l2 = (r: typeof report) => r.lines.find((l) => l.profitCenter === "L2")!;
    expect(l2(report).revenue - l2(before).revenue).toBe(700_000);
    expect(report.status).toBe("provisional");

    const statements = await m11.getStatements(owner(at(DAY5)), { period: MONTH });
    expect(statements.status).toBe("provisional");
    for (const pc of CENTERS) {
      expect(report.lines.find((l) => l.profitCenter === pc)?.revenue ?? 0, pc).toBe(statements.profitLoss.centers[pc].revenue);
    }
    expect(report.consolidated.revenue).toBe(statements.profitLoss.consolidated.revenue);
    expect(await crossModuleIncidents(t.db)).toEqual([]);
  });

  it("US-M9-02 KP-2 pemilik mengunci periode (persetujuan period_lock M11) → versi Final M9 tersimpan + notifikasi; buka kembali & kunci ulang → revisi baru, lama tetap (BR-32)", async () => {
    const locked = await closeAndLock(t.db, periodId);
    expect(locked).toMatchObject({ status: "locked", revision: 1 });

    const finals = await monthlyFinals(t.db);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ status: "final", revision: 1, accountingPeriodId: periodId, supersededById: null });
    const report = await m9.getMonthlyReport(owner(at(DAY5)), { month: MONTH });
    expect(report).toMatchObject({ status: "final", final: { snapshotId: finals[0]!.id, revision: 1 } });
    expect((await m11.getStatements(owner(at(DAY5)), { period: MONTH })).status).toBe("final");
    const notes = await t.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.event, "monthly_report.final"), eq(notifications.recipientUserId, userIdByUsername("pemilik"))));
    expect(notes.length).toBeGreaterThan(0);

    // Buka kembali (pemilik, beralasan) → Sementara; kunci ulang → revisi 2, revisi 1 digantikan tetapi tetap tersimpan.
    await m11.reopenPeriod(owner(at(DAY5)), { periodId, reason: "Koreksi nilai dari akuntan (uji integrasi)" });
    expect((await m9.getMonthlyReport(owner(at(DAY5)), { month: MONTH })).status).toBe("provisional");
    expect((await periodRow(t.db, MONTH))!.revision).toBe(2);
    await closeAndLock(t.db, periodId);

    const versions = (await monthlyFinals(t.db)).sort((a, b) => b.revision - a.revision);
    expect(versions.map((v) => v.revision)).toEqual([2, 1]);
    expect(versions[0]!.supersededById).toBeNull();
    expect(versions[1]!.supersededById).toBe(versions[0]!.id);
    expect(await m9.getMonthlyReport(owner(at(DAY5)), { month: MONTH })).toMatchObject({ status: "final", final: { revision: 2 } });
    expect(await crossModuleIncidents(t.db)).toEqual([]);
  });
});
