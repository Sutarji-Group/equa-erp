/**
 * Registrasi seluruh modul (docs/ARCHITECTURE.md §2): handler event, persetujuan, sinkron lapangan, job, dan laporan.
 * Dipanggil sekali per proses oleh `ensureBootstrapped()` (`src/server/core/bootstrap.ts`).
 *
 * Menambah modul baru: buat folder `src/server/modules/<modul>/` berisi index/events/approvals/sync/jobs/reports lalu
 * tambahkan entrinya di `MODULES` (append).
 */
import "server-only";

import * as m1_master_approvals from "./m1-master/approvals";
import * as m1_master_events from "./m1-master/events";
import * as m1_master_jobs from "./m1-master/jobs";
import * as m1_master_reports from "./m1-master/reports";
import * as m1_master_sync from "./m1-master/sync";
import * as m2_orders_approvals from "./m2-orders/approvals";
import * as m2_orders_events from "./m2-orders/events";
import * as m2_orders_jobs from "./m2-orders/jobs";
import * as m2_orders_reports from "./m2-orders/reports";
import * as m2_orders_sync from "./m2-orders/sync";
import * as m3_driver_approvals from "./m3-driver/approvals";
import * as m3_driver_events from "./m3-driver/events";
import * as m3_driver_jobs from "./m3-driver/jobs";
import * as m3_driver_reports from "./m3-driver/reports";
import * as m3_driver_sync from "./m3-driver/sync";
import * as m4_cash_approvals from "./m4-cash/approvals";
import * as m4_cash_events from "./m4-cash/events";
import * as m4_cash_jobs from "./m4-cash/jobs";
import * as m4_cash_reports from "./m4-cash/reports";
import * as m4_cash_sync from "./m4-cash/sync";
import * as m5_receivables_approvals from "./m5-receivables/approvals";
import * as m5_receivables_events from "./m5-receivables/events";
import * as m5_receivables_jobs from "./m5-receivables/jobs";
import * as m5_receivables_reports from "./m5-receivables/reports";
import * as m5_receivables_sync from "./m5-receivables/sync";
import * as m6_pos_approvals from "./m6-pos/approvals";
import * as m6_pos_events from "./m6-pos/events";
import * as m6_pos_jobs from "./m6-pos/jobs";
import * as m6_pos_reports from "./m6-pos/reports";
import * as m6_pos_sync from "./m6-pos/sync";
import * as m7_store_approvals from "./m7-store/approvals";
import * as m7_store_events from "./m7-store/events";
import * as m7_store_jobs from "./m7-store/jobs";
import * as m7_store_reports from "./m7-store/reports";
import * as m7_store_sync from "./m7-store/sync";
import * as m8_production_approvals from "./m8-production/approvals";
import * as m8_production_events from "./m8-production/events";
import * as m8_production_jobs from "./m8-production/jobs";
import * as m8_production_reports from "./m8-production/reports";
import * as m8_production_sync from "./m8-production/sync";
import * as m9_reports_approvals from "./m9-reports/approvals";
import * as m9_reports_events from "./m9-reports/events";
import * as m9_reports_jobs from "./m9-reports/jobs";
import * as m9_reports_reports from "./m9-reports/reports";
import * as m9_reports_sync from "./m9-reports/sync";
import * as m10_access_approvals from "./m10-access/approvals";
import * as m10_access_events from "./m10-access/events";
import * as m10_access_jobs from "./m10-access/jobs";
import * as m10_access_reports from "./m10-access/reports";
import * as m10_access_sync from "./m10-access/sync";
import * as m11_accounting_approvals from "./m11-accounting/approvals";
import * as m11_accounting_events from "./m11-accounting/events";
import * as m11_accounting_jobs from "./m11-accounting/jobs";
import * as m11_accounting_reports from "./m11-accounting/reports";
import * as m11_accounting_sync from "./m11-accounting/sync";
import * as m12_fleet_approvals from "./m12-fleet/approvals";
import * as m12_fleet_events from "./m12-fleet/events";
import * as m12_fleet_jobs from "./m12-fleet/jobs";
import * as m12_fleet_reports from "./m12-fleet/reports";
import * as m12_fleet_sync from "./m12-fleet/sync";
import * as p2_customer_approvals from "./p2-customer/approvals";
import * as p2_customer_events from "./p2-customer/events";
import * as p2_customer_jobs from "./p2-customer/jobs";
import * as p2_customer_reports from "./p2-customer/reports";
import * as p2_customer_sync from "./p2-customer/sync";
import * as p3_partner_approvals from "./p3-partner/approvals";
import * as p3_partner_events from "./p3-partner/events";
import * as p3_partner_jobs from "./p3-partner/jobs";
import * as p3_partner_reports from "./p3-partner/reports";
import * as p3_partner_sync from "./p3-partner/sync";

export type ModuleRegistration = {
  key: string;
  registerEvents: () => void;
  registerApprovals: () => void;
  registerSync: () => void;
  registerJobs: () => void;
  registerReports: () => void;
};

export const MODULES: readonly ModuleRegistration[] = [
  {
    key: "m1-master",
    registerEvents: m1_master_events.registerEvents,
    registerApprovals: m1_master_approvals.registerApprovals,
    registerSync: m1_master_sync.registerSync,
    registerJobs: m1_master_jobs.registerJobs,
    registerReports: m1_master_reports.registerReports,
  },
  {
    key: "m2-orders",
    registerEvents: m2_orders_events.registerEvents,
    registerApprovals: m2_orders_approvals.registerApprovals,
    registerSync: m2_orders_sync.registerSync,
    registerJobs: m2_orders_jobs.registerJobs,
    registerReports: m2_orders_reports.registerReports,
  },
  {
    key: "m3-driver",
    registerEvents: m3_driver_events.registerEvents,
    registerApprovals: m3_driver_approvals.registerApprovals,
    registerSync: m3_driver_sync.registerSync,
    registerJobs: m3_driver_jobs.registerJobs,
    registerReports: m3_driver_reports.registerReports,
  },
  {
    key: "m4-cash",
    registerEvents: m4_cash_events.registerEvents,
    registerApprovals: m4_cash_approvals.registerApprovals,
    registerSync: m4_cash_sync.registerSync,
    registerJobs: m4_cash_jobs.registerJobs,
    registerReports: m4_cash_reports.registerReports,
  },
  {
    key: "m5-receivables",
    registerEvents: m5_receivables_events.registerEvents,
    registerApprovals: m5_receivables_approvals.registerApprovals,
    registerSync: m5_receivables_sync.registerSync,
    registerJobs: m5_receivables_jobs.registerJobs,
    registerReports: m5_receivables_reports.registerReports,
  },
  {
    key: "m6-pos",
    registerEvents: m6_pos_events.registerEvents,
    registerApprovals: m6_pos_approvals.registerApprovals,
    registerSync: m6_pos_sync.registerSync,
    registerJobs: m6_pos_jobs.registerJobs,
    registerReports: m6_pos_reports.registerReports,
  },
  {
    key: "m7-store",
    registerEvents: m7_store_events.registerEvents,
    registerApprovals: m7_store_approvals.registerApprovals,
    registerSync: m7_store_sync.registerSync,
    registerJobs: m7_store_jobs.registerJobs,
    registerReports: m7_store_reports.registerReports,
  },
  {
    key: "m8-production",
    registerEvents: m8_production_events.registerEvents,
    registerApprovals: m8_production_approvals.registerApprovals,
    registerSync: m8_production_sync.registerSync,
    registerJobs: m8_production_jobs.registerJobs,
    registerReports: m8_production_reports.registerReports,
  },
  {
    key: "m9-reports",
    registerEvents: m9_reports_events.registerEvents,
    registerApprovals: m9_reports_approvals.registerApprovals,
    registerSync: m9_reports_sync.registerSync,
    registerJobs: m9_reports_jobs.registerJobs,
    registerReports: m9_reports_reports.registerReports,
  },
  {
    key: "m10-access",
    registerEvents: m10_access_events.registerEvents,
    registerApprovals: m10_access_approvals.registerApprovals,
    registerSync: m10_access_sync.registerSync,
    registerJobs: m10_access_jobs.registerJobs,
    registerReports: m10_access_reports.registerReports,
  },
  {
    key: "m11-accounting",
    registerEvents: m11_accounting_events.registerEvents,
    registerApprovals: m11_accounting_approvals.registerApprovals,
    registerSync: m11_accounting_sync.registerSync,
    registerJobs: m11_accounting_jobs.registerJobs,
    registerReports: m11_accounting_reports.registerReports,
  },
  {
    key: "m12-fleet",
    registerEvents: m12_fleet_events.registerEvents,
    registerApprovals: m12_fleet_approvals.registerApprovals,
    registerSync: m12_fleet_sync.registerSync,
    registerJobs: m12_fleet_jobs.registerJobs,
    registerReports: m12_fleet_reports.registerReports,
  },
  {
    key: "p2-customer",
    registerEvents: p2_customer_events.registerEvents,
    registerApprovals: p2_customer_approvals.registerApprovals,
    registerSync: p2_customer_sync.registerSync,
    registerJobs: p2_customer_jobs.registerJobs,
    registerReports: p2_customer_reports.registerReports,
  },
  {
    key: "p3-partner",
    registerEvents: p3_partner_events.registerEvents,
    registerApprovals: p3_partner_approvals.registerApprovals,
    registerSync: p3_partner_sync.registerSync,
    registerJobs: p3_partner_jobs.registerJobs,
    registerReports: p3_partner_reports.registerReports,
  },
];

let registered = false;

/** Jalankan semua fungsi registrasi modul (idempoten per proses). */
export function registerAllModules(): void {
  if (registered) return;
  registered = true;
  for (const mod of MODULES) {
    mod.registerEvents();
    mod.registerApprovals();
    mod.registerSync();
    mod.registerJobs();
    mod.registerReports();
  }
}
