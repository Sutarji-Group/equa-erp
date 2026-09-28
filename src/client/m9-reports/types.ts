/**
 * M9 — tipe data isomorfik (server ↔ komponen UI). Tanpa impor server; aman diimpor komponen klien.
 *
 * Satu definisi angka (US-M9-01, US-M9-06 KP-2): semua angka dihitung `src/server/modules/m9-reports/metrics.ts`
 * dan disajikan dengan bentuk di bawah ini untuk H+0 (harian & rentang), tren, dan KPI.
 */

/** Omzet per lini (BR-33: transfer internal terpisah, tidak dihitung omzet luar). */
export type RevenueFigures = {
  /** L2 air truk: Σ harga rit pelanggan (bukan internal) berstatus Selesai. */
  L2: { amount: number; trips: number };
  /** L3 depot: Σ transaksi POS depot yang dihitung (termasuk pembalik). */
  L3: { amount: number; transactions: number };
  /** L4 toko: Σ transaksi POS toko yang dihitung (termasuk pembalik). */
  L4: { amount: number; transactions: number };
  /** Omzet luar = L2 + L3 + L4. */
  external: number;
  internal: {
    /** Rit internal pasokan depot (L2 → L3). */
    truckToDepot: { amount: number; trips: number; liters: number };
    /** Transfer internal barang toko → depot (L4 → L3). */
    storeToDepot: { amount: number; transfers: number };
  };
};

export type CashLineFigures = { line: "driver" | "depot" | "store" | "office"; label: string; expected: number; received: number; discrepancy: number; count: number };

/** Kas seharusnya vs diterima vs selisih (definisi M4 `buildCashPosition`). */
export type CashFigures = {
  expected: number;
  received: number;
  discrepancy: number;
  unmatchedTransfers: number;
  byLine: CashLineFigures[];
  /** Kas kantor sistem vs fisik (hari kas ditutup). */
  office: { system: number | null; physical: number | null; difference: number | null };
  cashDayStatus: "open" | "closed";
  /** KPI-02: menit setoran terakhir Diterima → kas ditutup. */
  kpi02Minutes: number | null;
};

/** Piutang (definisi M5: faktur terbuka + rit belum ditagih; KPI-04 = lewat tempo ÷ total). */
export type ReceivableFigures = {
  /** Saldo pada akhir periode. */
  balance: number;
  /** Faktur/tagihan terbentuk dalam periode. */
  formed: number;
  /** Alokasi pelunasan dalam periode. */
  paid: number;
  /** Lewat jatuh tempo pada akhir periode. */
  overdue: number;
  /** KPI-04 (%). */
  overduePct: number;
  /** Sasaran KPI-04 (% maksimal). */
  targetPct: number;
};

export type TruckTripFigures = {
  truckId: string;
  truckCode: string;
  scheduled: number;
  completed: number;
  failed: number;
  running: number;
  internalScheduled: number;
  internalCompleted: number;
};

export type TripFigures = {
  byTruck: TruckTripFigures[];
  totals: { scheduled: number; completed: number; failed: number; running: number; internalScheduled: number; internalCompleted: number };
};

export type DepotGallonFigures = { outletId: string; code: string; name: string; gallons: number; liters: number; transactions: number; sales: number };

export type GallonFigures = { byDepot: DepotGallonFigures[]; total: number; liters: number };

export type DiscrepancyAwaiting = {
  id: string;
  amount: number;
  sourceLabel: string;
  personName: string | null;
  depositId: string | null;
  depositNumber: string | null;
  businessDate: string;
  explanation: string | null;
  approvalId: string | null;
  /** Lewat batas tindak lanjut (24 jam) → dihitung KPI-03. */
  overdue: boolean;
  createdAt: string;
};

export type ExceptionFigures = {
  approvalsPending: number;
  approvalsOverdue: number;
  discrepancies: DiscrepancyAwaiting[];
  failedTrips: { id: string; number: string; truckCode: string | null; customerName: string; reason: string | null }[];
  fleet: {
    offSchedule: number;
    unknownStops: number;
    deviationsL2: number;
    inconsistent: number;
    geofenceFlags: number;
    awaitingReview: number;
    unexplained: number;
    deviceOutages: { truckCode: string; minutes: number }[];
  };
  water: {
    lossFlags: { sourceCode: string; status: string; lossPct: number | null; date?: string }[];
    utilizationHigh: { sourceCode: string; utilizationPct: number | null; date?: string }[];
    productionIncomplete: { sourceCode: string; date?: string }[];
  };
  unmatchedTransfers: number;
  /** Jumlah butir yang menunggu keputusan pemilik (untuk ubin). */
  total: number;
};

/** Snapshot enam blok H+0 (versi 1) — disimpan terkunci di `daily_summaries.snapshot` setelah terbit. */
export type DailySnapshot = {
  version: 1;
  from: string;
  to: string;
  computedAt: string;
  revenue: RevenueFigures;
  cash: CashFigures;
  receivables: ReceivableFigures;
  trips: TripFigures;
  gallons: GallonFigures;
  exceptions: ExceptionFigures;
};

export type H0Range = "today" | "yesterday" | "last7" | "month";

export type AddendumView = {
  id: string;
  businessDate: string;
  recordedOn: string;
  kind: "late_sync" | "correction" | "late_deposit";
  kindLabel: string;
  description: string;
  objectType: string | null;
  objectId: string | null;
  delta: Record<string, unknown> | null;
};

export type SummaryStatusView = {
  status: "running" | "published" | "reviewed" | "mixed";
  label: string;
  cashClosedAt: string | null;
  publishedAt: string | null;
  publishedLate: boolean;
  /** Menit tutup kas → terbit (KPI-08). */
  publishMinutes: number | null;
  reviewedAt: string | null;
  summaryId: string | null;
  /** Rentang: hari terbit / seluruh hari. */
  publishedDays?: number;
  totalDays?: number;
};

export type KpiStatus = "met" | "not_met" | "baseline" | "no_data" | "pending";

export type KpiValue = {
  code: string;
  name: string;
  formula: string;
  source: string;
  unit: "percent" | "minutes" | "count" | "hours" | "text";
  value: number | null;
  display: string;
  target: string;
  status: KpiStatus;
  detail?: string;
};

export type TrendPoint = {
  key: string;
  label: string;
  from: string;
  to: string;
  L2: number;
  L3: number;
  L4: number;
  external: number;
  internal: number;
  tripsCompleted: number;
  tripsScheduled: number;
  gallons: number;
  receivableBalance: number;
  overduePct: number;
  byTruck: Record<string, number>;
  byDepot: Record<string, number>;
};
