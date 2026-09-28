/**
 * M9 — Katalog laporan PRD 7.9.4 (US-M9-03 KP-1): setiap baris katalog dipetakan ke laporan terdaftar (`ReportDef`)
 * yang dapat diekspor Excel (Data + Ringkasan) & PDF (identitas usaha, cap waktu, pembuat, filter) lewat
 * `/api/export/<kunci>` — dengan log ekspor & pembatasan data pribadi BR-39 (inti). Laporan bulanan berstatus Final
 * diekspor lewat `/laporan/bulanan/ekspor` agar berkasnya identik (KP-4).
 */
import "server-only";

import type { ActorContext } from "@/server/core/context";
import { getReport, listReports } from "@/server/core/export";
import { authorize, can } from "@/server/core/rbac";

export type CatalogEntry = {
  id: string;
  title: string;
  content: string;
  source: string;
  availability: string;
  readers: string;
  priority: "M" | "S" | "M / S" | "S (RL-6)";
  ref: string;
  /** Layar sumber (tanpa pindah modul untuk laporan M9). */
  screen: string;
  screenPermission: string | string[];
  /** Laporan ekspor terdaftar yang mewakili baris katalog. */
  reportKeys: string[];
  /** Laporan milik modul yang belum tergabung (mis. M11) — ditampilkan "menyusul". */
  pendingKeys?: string[];
  /** Ekspor khusus (mis. Final identik) menggantikan tautan generik. */
  customExport?: string;
};

/** Katalog 7.9.4 (+ ekspor jurnal format konsultan US-M9-03 KP-3 di M11). */
export const REPORT_CATALOG: readonly CatalogEntry[] = [
  {
    id: "h0",
    title: "Ringkasan H+0",
    content: "Omzet per lini; kas seharusnya vs diterima; selisih dan alasan; piutang terbentuk/dilunasi/lewat tempo; rit terjadwal vs selesai per truk; galon per depot; transfer belum dicocokkan; pengecualian",
    source: "M4 tutup kas",
    availability: "Harian, ≤ 30 menit setelah tutup kas",
    readers: "Pemilik",
    priority: "M",
    ref: "FR-M9-01, NFR-04",
    screen: "/laporan/hari-ini",
    screenPermission: "m9.daily_summary.read",
    reportKeys: ["m9.daily_summary", "m9.daily_summaries"],
  },
  {
    id: "cash_today",
    title: "Kas hari ini",
    content: "Posisi per sumber, status setoran",
    source: "M4",
    availability: "Real-time",
    readers: "Admin Keuangan, pemilik",
    priority: "M",
    ref: "FR-M4-01",
    screen: "/kas",
    screenPermission: "m4.cash_position.read",
    reportKeys: ["m4.cash_position"],
  },
  {
    id: "discrepancy_history",
    title: "Riwayat selisih per orang",
    content: "Kejadian, nilai, alasan, deret nihil selisih",
    source: "M4",
    availability: "Bulanan",
    readers: "Pemilik",
    priority: "S",
    ref: "FR-M4-07",
    screen: "/kas/selisih?tampil=riwayat",
    screenPermission: "m4.discrepancy.read",
    reportKeys: ["m4.discrepancy_history"],
  },
  {
    id: "receivables",
    title: "Umur piutang; kartu piutang; daftar penagihan",
    content: "Per pelanggan/segmen/lini",
    source: "M5",
    availability: "Kapan saja; ringkasan mingguan",
    readers: "Pemilik, Admin Keuangan",
    priority: "M",
    ref: "FR-M5-04",
    screen: "/piutang/umur",
    screenPermission: "m5.aging.read",
    reportKeys: ["m5.aging", "m5.aging_groups", "m5.customer_card", "m5.reminders"],
  },
  {
    id: "gross_profit",
    title: "Laba kotor per lini dan konsolidasi; laba rugi, neraca, arus kas",
    content: "Per L1–L5 dan gabungan",
    source: "M11",
    availability: "Bulanan ≤ tanggal 10",
    readers: "Pemilik, akuntan",
    priority: "M",
    ref: "FR-M9-02",
    screen: "/laporan/bulanan",
    screenPermission: "m9.monthly_report.read",
    reportKeys: ["m9.monthly_gross_profit"],
    pendingKeys: ["m11.income_statement", "m11.balance_sheet", "m11.cash_flow"],
    customExport: "/laporan/bulanan/ekspor",
  },
  {
    id: "water_cost",
    title: "Biaya produksi air per liter (L1)",
    content: "Total biaya L1 ÷ liter pengisian; per sumber dan gabungan; tren bulanan",
    source: "M11, M8",
    availability: "Bulanan ≤ tanggal 10",
    readers: "Pemilik, akuntan",
    priority: "M",
    ref: "FR-M9-02, PTB-39, CR-09",
    screen: "/laporan/bulanan#biaya-air",
    screenPermission: "m9.monthly_report.read",
    reportKeys: ["m9.water_cost_per_liter"],
  },
  {
    id: "gross_revenue",
    title: "Omzet bruto bulanan per lini; pemantauan PKP",
    content: "Untuk konsultan pajak",
    source: "M11",
    availability: "Bulanan",
    readers: "Admin Keuangan, akuntan, pemilik",
    priority: "M",
    ref: "BR-29, BR-30, FR-M11-12",
    screen: "/laporan/bulanan#pkp",
    screenPermission: "m9.monthly_report.read",
    reportKeys: ["m9.gross_revenue_pkp"],
  },
  {
    id: "orders",
    title: "Pesanan dan status; alasan pembatalan/kegagalan; dobel/terlewat",
    content: "Per pelanggan, truk, alasan",
    source: "M2",
    availability: "Kapan saja; bulanan",
    readers: "Dispatcher, pemilik",
    priority: "M",
    ref: "FR-M2-02, FR-M2-09, KPI-06",
    screen: "/pesanan?tampil=laporan",
    screenPermission: "m2.order.read",
    reportKeys: ["m2.orders", "m2.cancel_fail_monthly", "m2.kpi06_monthly"],
  },
  {
    id: "trip_realization",
    title: "Rit terealisasi vs terjadwal per truk",
    content: "Harian dan bulanan (KPI-07; pelanggan & internal terpisah)",
    source: "M2, M3",
    availability: "Harian",
    readers: "Dispatcher, pemilik",
    priority: "M",
    ref: "KPI-07",
    screen: "/laporan/katalog#trip_realization",
    screenPermission: "m9.report.read",
    reportKeys: ["m9.trip_realization"],
  },
  {
    id: "performance",
    title: "Kinerja sopir/truk dan depot/operator",
    content: "Rit, ketepatan, selisih, void, galon",
    source: "M3, M4, M6, M12",
    availability: "Bulanan",
    readers: "Pemilik",
    priority: "S",
    ref: "FR-M9-05",
    screen: "/laporan/kinerja",
    screenPermission: "m9.performance.read",
    reportKeys: ["m9.performance_drivers", "m9.performance_outlets"],
  },
  {
    id: "water_balance",
    title: "Neraca air dan susut; utilisasi kapasitas",
    content: "Per sumber",
    source: "M8",
    availability: "Harian; bulanan",
    readers: "Pemilik, operator produksi",
    priority: "M / S",
    ref: "FR-M8-03, FR-M8-04",
    screen: "/produksi/neraca-air",
    screenPermission: "m8.water_balance.read",
    reportKeys: ["m8.water_balance_daily", "m8.water_balance_monthly", "m8.utilization_daily", "m8.utilization_monthly"],
  },
  {
    id: "depot_sales",
    title: "Penjualan depot per outlet",
    content: "Galon, transaksi, void, selisih, setoran",
    source: "M6",
    availability: "Harian; bulanan",
    readers: "Pemilik",
    priority: "M",
    ref: "M6 (putaran 4)",
    screen: "/outlet/laporan",
    screenPermission: "m6.outlet.read",
    reportKeys: ["m6.outlet_daily", "m6.voids", "m6.shifts"],
  },
  {
    id: "store_stock",
    title: "Stok toko: kartu stok, laris/mati, stok minimum",
    content: "Per barang",
    source: "M7",
    availability: "Mingguan; bulanan",
    readers: "Kasir, pemilik",
    priority: "M / S",
    ref: "M7 (putaran 4)",
    screen: "/toko/laporan",
    screenPermission: ["m7.report.read", "m7.stock.read"],
    reportKeys: ["m7.stock_card", "m7.product_performance", "m7.reorder"],
  },
  {
    id: "gps",
    title: "Riwayat perjalanan dan pengecualian GPS",
    content: "Per rit, per truk per hari",
    source: "M12",
    availability: "Harian",
    readers: "Dispatcher, pemilik",
    priority: "M",
    ref: "FR-M12-02, FR-M12-04",
    screen: "/armada/riwayat",
    screenPermission: "m12.trip_history.read",
    reportKeys: ["m12.trips", "m12.truck_days", "m12.fleet_events"],
  },
  {
    id: "trend",
    title: "Tren mingguan/bulanan",
    content: "Omzet, rit, galon, piutang",
    source: "M2–M8, M11",
    availability: "Mingguan; bulanan",
    readers: "Pemilik",
    priority: "S (RL-6)",
    ref: "FR-M9-06",
    screen: "/laporan/tren",
    screenPermission: "m9.trend.read",
    reportKeys: ["m9.trend_weekly", "m9.trend_monthly"],
  },
  {
    id: "kpi",
    title: "KPI program KPI-01–KPI-11",
    content: "Nilai, target, status",
    source: "Semua",
    availability: "Bulanan (tinjauan bulan 10–12)",
    readers: "Pemilik, komite pengarah",
    priority: "S (RL-6)",
    ref: "BRD 2.3, 12.8, PTB-30",
    screen: "/laporan/kpi",
    screenPermission: "m9.kpi.read",
    reportKeys: ["m9.kpi", "m9.parallel_run_checks"],
  },
  {
    id: "audit",
    title: "Jejak audit dan log akses",
    content: "Per objek, pengguna, waktu",
    source: "M10",
    availability: "Kapan saja",
    readers: "Pemilik, admin sistem, akuntan (objek keuangan)",
    priority: "M",
    ref: "FR-M10-02",
    screen: "/audit",
    screenPermission: "m10.audit_log.read",
    reportKeys: ["core.audit_log", "m10.access_log"],
  },
  {
    id: "prices",
    title: "Riwayat harga; simulasi zona",
    content: "Per produk/pelanggan",
    source: "M1",
    availability: "Kapan saja",
    readers: "Pemilik",
    priority: "M",
    ref: "FR-M1-02, FR-M1-05, K23",
    screen: "/master/zona",
    screenPermission: "m1.tariff_zone.read",
    reportKeys: ["m1.price_history", "m1.zone_simulation"],
  },
  {
    id: "journal_export",
    title: "Ekspor jurnal ke format konsultan pajak",
    content: "Jurnal per periode dalam format konsultan (NFR-23) — mekanisme & log ekspor yang sama (US-M9-03 KP-3)",
    source: "M11",
    availability: "Bulanan",
    readers: "Admin Keuangan, akuntan",
    priority: "M",
    ref: "NFR-23, US-M11-08 KP-3",
    screen: "/akuntansi/jurnal",
    screenPermission: "m11.journal.read",
    reportKeys: [],
    pendingKeys: ["m11.journal_export"],
  },
];

export type CatalogReportView = {
  key: string;
  title: string;
  registered: boolean;
  allowed: boolean;
  containsPii: boolean;
  /** Pelaku berhak mengekspor versi lengkap data pribadi (pemilik/Admin Keuangan) — wajib tujuan (BR-39). */
  piiFull: boolean;
  needsFilters: string[];
};

export type CatalogView = CatalogEntry & { reports: CatalogReportView[]; canOpenScreen: boolean };

/** Kunci laporan katalog yang BELUM terdaftar (audit US-M9-03 KP-1; `pendingKeys` dikecualikan). */
export function missingCatalogReports(): { entry: string; key: string }[] {
  const out: { entry: string; key: string }[] = [];
  for (const e of REPORT_CATALOG) for (const key of e.reportKeys) if (!getReport(key)) out.push({ entry: e.id, key });
  return out;
}

/** Katalog laporan untuk pelaku (izin laporan & data pribadi). */
export async function getReportCatalog(ctx: ActorContext): Promise<CatalogView[]> {
  await authorize(ctx, "m9.report.read");
  const registered = new Map(listReports().map((r) => [r.key, r]));
  const piiFull = can(ctx, "m9.report.export_pii");
  return REPORT_CATALOG.map((e) => {
    const keys = [...e.reportKeys, ...(e.pendingKeys ?? []).filter((k) => registered.has(k))];
    const perms = typeof e.screenPermission === "string" ? [e.screenPermission] : e.screenPermission;
    return {
      ...e,
      canOpenScreen: perms.some((p) => can(ctx, p)),
      reports: keys.map((key) => {
        const def = registered.get(key);
        const shape = (def?.filtersSchema as unknown as { shape?: Record<string, { isOptional?: () => boolean }> } | undefined)?.shape;
        return {
          key,
          title: def?.title ?? key,
          registered: !!def,
          allowed: !!def && can(ctx, def.permission),
          containsPii: !!def?.containsPii,
          piiFull: !!def?.containsPii && piiFull,
          needsFilters: shape ? Object.entries(shape).filter(([, v]) => typeof v.isOptional === "function" && !v.isOptional()).map(([k]) => k) : [],
        };
      }),
    };
  });
}
