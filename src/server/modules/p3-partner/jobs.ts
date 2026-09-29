/**
 * P3 — pekerjaan terjadwal (`/api/cron/tick`, idempoten per slot; semua fungsi juga idempoten per objek/bulan).
 *
 * RL-7: SLA pesanan air mitra (PAR-76, 5 menit), SLA dukungan (PAR-76, 5 menit), tagihan langganan (harian 00.40,
 * menerbitkan pada tanggal PAR-12), siklus kontrak (00.30: parameter tertunda, Berakhir), neraca air mitra bulanan
 * (tgl 1, PAR-79 → pemilik), laporan bulanan mitra (harian 06.30, terbit pada/sesudah tgl `monthly_report_day`).
 * Tahap 3 (memeriksa flag sendiri): sanksi & mode baca-saja (07.00), audit mutu (07.20), skor mutu (tgl 1 07.10).
 */
import "server-only";

import { registerJob } from "@/server/core/jobs";

import { runSubscriptionBilling } from "./service/billing";
import { runContractLifecycle } from "./service/contracts";
import { runMonthlyReports } from "./service/monthly-report";
import { runAuditChecks, runQualityMonthly } from "./service/quality";
import { recordSanctionTrigger, runSanctionChecks } from "./service/sanctions";
import { runPartnerWaterBalanceCheck, runWaterOrderSlaCheck } from "./service/supply";
import { runSupportSlaCheck } from "./service/support";

export function registerJobs(): void {
  registerJob({
    key: "p3.water_order_sla",
    description: "Pesanan air mitra belum Selesai > PAR-76 jam → Dispatcher & pemilik (US-P3-08 KP-4)",
    schedule: { kind: "every_5_min" },
    run: ({ now, db }) => runWaterOrderSlaCheck(now, db),
  });
  registerJob({
    key: "p3.support_sla",
    description: "Permintaan dukungan mitra belum ditanggapi > PAR-76 jam → pemilik (US-P3-11 KP-2)",
    schedule: { kind: "every_5_min" },
    run: ({ now, db }) => runSupportSlaCheck(now, db),
  });
  registerJob({
    key: "p3.subscription_billing",
    description: "Tagihan langganan sistem mitra bulan lalu (PAR-35 × outlet aktif; terbit tanggal PAR-12) — US-P3-09 KP-1",
    schedule: { kind: "daily", at: "00:40" },
    run: ({ now, db }) => runSubscriptionBilling(now, { db }),
  });
  registerJob({
    key: "p3.contract_lifecycle",
    description: "Parameter kontrak tertunda berlaku, kontrak Berakhir, pengingat & evaluasi berkala (US-P3-04 KP-5, US-P3-01 KP-5)",
    schedule: { kind: "daily", at: "00:30" },
    run: ({ now, db }) => runContractLifecycle(now, { db }),
  });
  registerJob({
    key: "p3.water_balance_monthly",
    description: "Neraca air per mitra bulan lalu (galon × 19 L vs air diterima EQUA) > PAR-79 → pemilik (US-P3-08 KP-3); Tahap 3: pemicu sanksi",
    schedule: { kind: "monthly", day: 1, at: "06:40" },
    run: ({ now, db }) =>
      runPartnerWaterBalanceCheck(now, {
        db,
        onExceeded: async (tx, row, tenant) => {
          await recordSanctionTrigger(tx, {
            partnerTenantId: tenant.id,
            trigger: "water_balance",
            key: `water_balance:${row.outletId}:${row.month}`,
            summary: `Neraca air ${row.outletName} ${row.month}: kelebihan ${row.excessPct}% > ${row.tolerancePct}% (PAR-79).`,
            detail: { outletId: row.outletId, month: row.month, excessPct: row.excessPct },
            now,
          });
        },
      }),
  });
  registerJob({
    key: "p3.monthly_reports",
    description: "Laporan bulanan mitra terbit otomatis (tgl 5) — US-P3-10 KP-3",
    schedule: { kind: "daily", at: "06:30" },
    run: ({ now, db }) => runMonthlyReports(now, { db }),
  });
  registerJob({
    key: "p3.sanction_checks",
    description: "Pemicu sanksi (tunggakan, POS tidak dipakai), mode baca-saja, pemutusan efektif, tenggat ekspor data (US-P3-07, US-P3-02 KP-4)",
    schedule: { kind: "daily", at: "07:00" },
    run: ({ now, db }) => runSanctionChecks(now, { db }),
  });
  registerJob({
    key: "p3.audit_checks",
    description: "Jadwal audit mutu outlet mitra & temuan lewat tenggat → pemicu sanksi (US-P3-05 KP-2)",
    schedule: { kind: "daily", at: "07:20" },
    run: ({ now, db }) => runAuditChecks(now, { db }),
  });
  registerJob({
    key: "p3.quality_monthly",
    description: "Skor mutu bulanan outlet mitra (bobot pemilik) < PAR-80 → pemicu teguran (US-P3-05 KP-4)",
    schedule: { kind: "monthly", day: 1, at: "07:10" },
    run: ({ now, db }) => runQualityMonthly(now, { db }),
  });
}
