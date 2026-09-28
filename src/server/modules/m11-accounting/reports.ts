/**
 * M11 — laporan yang dapat diekspor Excel/PDF (`/api/export/<kunci>`, US-M11-04 KP-4, US-M9-03). Laporan keuangan
 * periode Dikunci diambil dari versi Final tersimpan (identik saat diekspor ulang, US-M9-03 KP-4).
 */
import "server-only";

import { z } from "zod";

import { label } from "@/lib/labels";
import { monthOf, toBusinessDate } from "@/lib/time";

import { registerReport } from "@/server/core/export";

import { listAccounts } from "./service/accounts";
import { assetRegister } from "./service/assets";
import { dailyReconciliation } from "./service/daily";
import { listJournals } from "./service/journals";
import { listMappings } from "./service/mappings";
import { openingOverview } from "./service/opening";
import { payablesView } from "./service/payables";
import { listPeriods } from "./service/periods";
import { listJournalQueue } from "./service/queue";
import { reconciliationHistory } from "./service/reconciliation";
import { getLedger, getStatements, type Basis } from "./service/statements";
import { monthlyRevenueReport, taxOverview } from "./service/tax";

const periodField = z
  .string()
  .regex(/^\d{4}-\d{2}$/, { error: "Periode berformat YYYY-MM." })
  .optional();
const basisField = z.enum(["period", "ytd"]).optional();
const statementFilters = z.object({ period: periodField, basis: basisField }).passthrough();
type StatementFilters = z.infer<typeof statementFilters>;

const currentPeriod = (now: Date) => monthOf(toBusinessDate(now));
const basisLabel = (b?: string) => (b === "ytd" ? "Kumulatif tahun berjalan" : "Periode");

export function registerReports(): void {
  registerReport({
    key: "m11.accounts",
    title: "Bagan akun",
    module: "m11",
    permission: "m11.account.read",
    containsPii: false,
    columns: [
      { key: "code", header: "Kode" },
      { key: "name", header: "Nama akun", width: 34 },
      { key: "type", header: "Jenis", type: "enum", enumName: "account_type" },
      { key: "profitCenter", header: "Pusat laba", type: "enum", enumName: "profit_center" },
      { key: "parentCode", header: "Induk" },
      { key: "isPostable", header: "Dapat diposting", type: "boolean" },
      { key: "isInternalTransfer", header: "Transfer internal", type: "boolean" },
      { key: "isCash", header: "Kas/bank", type: "boolean" },
      { key: "isActive", header: "Aktif", type: "boolean" },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: await listAccounts(ctx, { includeInactive: true }, { tx }) }),
  });

  registerReport({
    key: "m11.mappings",
    title: "Pemetaan peristiwa → akun",
    module: "m11",
    permission: "m11.journal_mapping.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "event", header: "Peristiwa" },
      { key: "entry", header: "Entri" },
      { key: "label", header: "Uraian", width: 36 },
      { key: "debit", header: "Akun debit", value: (r) => (r as { current?: { debitCode: string; debitName: string } }).current ? `${(r as { current: { debitCode: string; debitName: string } }).current.debitCode} ${(r as { current: { debitName: string } }).current.debitName}` : "—" },
      { key: "credit", header: "Akun kredit", value: (r) => (r as { current?: { creditCode: string; creditName: string } }).current ? `${(r as { current: { creditCode: string } }).current.creditCode} ${(r as { current: { creditName: string } }).current.creditName}` : "—" },
      { key: "effectiveFrom", header: "Berlaku mulai", type: "date", value: (r) => (r as { current?: { effectiveFrom: string } }).current?.effectiveFrom ?? null },
      { key: "status", header: "Status", value: (r) => ((r as { status: string }).status === "ok" ? "Lengkap" : (r as { status: string }).status === "missing" ? "Belum ada" : "Akun nonaktif") },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: (await listMappings(ctx, {}, { tx })).mappings }),
  });

  const journalFilters = z.object({ period: periodField, kind: z.string().optional(), status: z.string().optional() }).passthrough();
  registerReport({
    key: "m11.journals",
    title: "Daftar jurnal",
    module: "m11",
    permission: "m11.journal.read",
    containsPii: false,
    filtersSchema: journalFilters,
    orientation: "landscape",
    columns: [
      { key: "journalDate", header: "Tanggal", type: "date" },
      { key: "number", header: "No. jurnal" },
      { key: "period", header: "Periode" },
      { key: "kind", header: "Jenis", type: "enum", enumName: "journal_kind" },
      { key: "status", header: "Status", type: "enum", enumName: "journal_status" },
      { key: "description", header: "Keterangan", width: 40 },
      { key: "sourceType", header: "Sumber" },
      { key: "originPeriod", header: "Asal periode" },
      { key: "totalDebit", header: "Nilai", type: "rupiah", total: true },
    ],
    fetch: async (ctx, f: z.infer<typeof journalFilters>, { tx }) => ({
      rows: await listJournals(ctx, { period: f.period ?? null, kind: (f.kind as never) ?? null, status: (f.status as never) ?? null, limit: 2000 }, { tx }),
    }),
  });

  registerReport({
    key: "m11.journal_queue",
    title: "Daftar tunggu jurnal otomatis",
    module: "m11",
    permission: "m11.journal_queue.read",
    containsPii: false,
    columns: [
      { key: "journalDate", header: "Tanggal", type: "date" },
      { key: "eventKey", header: "Peristiwa" },
      { key: "reason", header: "Alasan", type: "enum", enumName: "journal_queue_reason" },
      { key: "message", header: "Keterangan", width: 44 },
      { key: "attempts", header: "Percobaan", type: "number" },
      { key: "status", header: "Status", type: "enum", enumName: "journal_queue_status" },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: await listJournalQueue(ctx, { status: "all" }, { tx }) }),
  });

  const ledgerFilters = z.object({ accountId: z.uuid({ error: "Pilih akun." }), from: periodField, to: periodField, profitCenter: z.string().optional() }).passthrough();
  registerReport({
    key: "m11.ledger",
    title: "Buku besar",
    module: "m11",
    permission: "m11.ledger.read",
    containsPii: false,
    filtersSchema: ledgerFilters,
    orientation: "landscape",
    columns: [
      { key: "date", header: "Tanggal", type: "date" },
      { key: "number", header: "No. jurnal" },
      { key: "description", header: "Keterangan", width: 40 },
      { key: "profitCenter", header: "Pusat laba", type: "enum", enumName: "profit_center" },
      { key: "debit", header: "Debit", type: "rupiah", total: true },
      { key: "credit", header: "Kredit", type: "rupiah", total: true },
      { key: "balance", header: "Saldo", type: "rupiah" },
    ],
    fetch: async (ctx, f: z.infer<typeof ledgerFilters>, { tx }) => {
      const from = f.from ?? currentPeriod(ctx.now);
      const res = await getLedger(ctx, { accountId: f.accountId, fromPeriod: from, toPeriod: f.to ?? from, profitCenter: (f.profitCenter as never) ?? null }, { tx });
      return {
        rows: res.lines,
        summary: [
          { label: "Akun", value: `${res.account.code} ${res.account.name}` },
          { label: "Saldo awal", value: res.opening, type: "rupiah" },
          { label: "Saldo akhir", value: res.closing, type: "rupiah" },
        ],
      };
    },
  });

  const statementReport = (key: string, title: string, columns: Parameters<typeof registerReport>[0]["columns"], pick: (s: Awaited<ReturnType<typeof getStatements>>) => Record<string, unknown>[]) =>
    registerReport({
      key,
      title,
      module: "m11",
      permission: "m11.financial_report.read",
      containsPii: false,
      filtersSchema: statementFilters,
      describeFilters: (f: StatementFilters) => [`Periode: ${f.period ?? "berjalan"}`, `Dasar: ${basisLabel(f.basis)}`],
      orientation: "landscape",
      columns,
      fetch: async (ctx, f: StatementFilters, { tx }) => {
        const s = await getStatements(ctx, { period: f.period ?? currentPeriod(ctx.now), basis: (f.basis ?? "period") as Basis }, { tx });
        return { rows: pick(s), status: `${s.status === "final" ? "Final" : "Sementara"}${s.revision > 1 ? ` (revisi ${s.revision})` : ""}${s.retroactive ? " — dibangkitkan retroaktif, diverifikasi akuntan" : ""}` };
      },
    });

  statementReport(
    "m11.trial_balance",
    "Neraca saldo",
    [
      { key: "code", header: "Kode" },
      { key: "name", header: "Akun", width: 34 },
      { key: "openingDebit", header: "Saldo awal D", type: "rupiah", total: true },
      { key: "openingCredit", header: "Saldo awal K", type: "rupiah", total: true },
      { key: "debit", header: "Mutasi D", type: "rupiah", total: true },
      { key: "credit", header: "Mutasi K", type: "rupiah", total: true },
      { key: "closingDebit", header: "Saldo akhir D", type: "rupiah", total: true },
      { key: "closingCredit", header: "Saldo akhir K", type: "rupiah", total: true },
    ],
    (s) => s.trialBalance.rows,
  );
  statementReport(
    "m11.profit_loss",
    "Laba rugi per lini & konsolidasi",
    [
      { key: "section", header: "Kelompok" },
      { key: "code", header: "Kode" },
      { key: "name", header: "Akun", width: 30 },
      { key: "L1", header: "L1", type: "rupiah", total: true },
      { key: "L2", header: "L2", type: "rupiah", total: true },
      { key: "L3", header: "L3", type: "rupiah", total: true },
      { key: "L4", header: "L4", type: "rupiah", total: true },
      { key: "L5", header: "L5", type: "rupiah", total: true },
      { key: "SHARED", header: "Bersama", type: "rupiah", total: true },
      { key: "elimination", header: "Eliminasi", type: "rupiah", total: true },
      { key: "consolidated", header: "Konsolidasi", type: "rupiah", total: true },
    ],
    (s) => s.profitLoss.rows.map((r) => ({ section: r.section, code: r.code, name: r.name, ...r.byCenter, elimination: r.elimination, consolidated: r.consolidated })),
  );
  statementReport(
    "m11.balance_sheet",
    "Neraca",
    [
      { key: "section", header: "Kelompok", value: (r) => ({ asset: "Aset", liability: "Liabilitas", equity: "Ekuitas" })[(r as { section: string }).section] },
      { key: "code", header: "Kode" },
      { key: "name", header: "Akun", width: 36 },
      { key: "amount", header: "Saldo", type: "rupiah" },
    ],
    (s) => s.balanceSheet.rows,
  );
  statementReport(
    "m11.cash_flow",
    "Arus kas (metode langsung)",
    [
      { key: "label", header: "Arus kas", width: 40 },
      { key: "inflow", header: "Masuk", type: "rupiah", total: true },
      { key: "outflow", header: "Keluar", type: "rupiah", total: true },
      { key: "net", header: "Bersih", type: "rupiah", total: true },
    ],
    (s) => s.cashFlow.categories,
  );

  registerReport({
    key: "m11.assets",
    title: "Daftar aset & akumulasi penyusutan",
    module: "m11",
    permission: "m11.fixed_asset.read",
    containsPii: false,
    filtersSchema: z.object({ period: periodField }).passthrough(),
    orientation: "landscape",
    columns: [
      { key: "code", header: "Kode" },
      { key: "name", header: "Aset", width: 30 },
      { key: "category", header: "Kategori", type: "enum", enumName: "asset_category" },
      { key: "profitCenter", header: "Pusat laba", type: "enum", enumName: "profit_center" },
      { key: "acquisitionDate", header: "Perolehan", type: "date" },
      { key: "cost", header: "Nilai perolehan", type: "rupiah", total: true },
      { key: "usefulLifeMonths", header: "Umur (bln)", type: "number" },
      { key: "depreciationThisPeriod", header: "Penyusutan periode", type: "rupiah", total: true },
      { key: "accumulated", header: "Akumulasi", type: "rupiah", total: true },
      { key: "bookValue", header: "Nilai buku", type: "rupiah", total: true },
      { key: "status", header: "Status", type: "enum", enumName: "asset_status" },
    ],
    fetch: async (ctx, f: { period?: string }, { tx }) => ({ rows: (await assetRegister(ctx, { period: f.period ?? null }, { tx })).rows }),
  });

  registerReport({
    key: "m11.bank_reconciliations",
    title: "Rekonsiliasi bank",
    module: "m11",
    permission: "m11.reconciliation.read",
    containsPii: false,
    columns: [
      { key: "period", header: "Periode" },
      { key: "bank", header: "Rekening", value: (r) => `${(r as { bankName: string }).bankName} ${(r as { accountNumber: string }).accountNumber}` },
      { key: "statement", header: "Saldo rekening", type: "rupiah", value: (r) => (r as { r: { statementBalance: number } }).r.statementBalance },
      { key: "book", header: "Saldo buku", type: "rupiah", value: (r) => (r as { r: { bookBalance: number } }).r.bookBalance },
      { key: "difference", header: "Selisih", type: "rupiah", value: (r) => (r as { r: { difference: number } }).r.difference },
      { key: "status", header: "Status", type: "enum", enumName: "reconciliation_status", value: (r) => (r as { r: { status: string } }).r.status },
      { key: "completedAt", header: "Selesai", type: "datetime", value: (r) => (r as { r: { completedAt: Date | null } }).r.completedAt },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: (await reconciliationHistory(ctx, { tx })).bank }),
  });

  registerReport({
    key: "m11.cash_reconciliations",
    title: "Rekonsiliasi kas",
    module: "m11",
    permission: "m11.reconciliation.read",
    containsPii: false,
    columns: [
      { key: "period", header: "Periode" },
      { key: "kind", header: "Jenis", type: "enum", enumName: "cash_reconciliation_kind", value: (r) => (r as { r: { kind: string } }).r.kind },
      { key: "system", header: "Buku", type: "rupiah", value: (r) => (r as { r: { systemBalance: number } }).r.systemBalance },
      { key: "physical", header: "Fisik", type: "rupiah", value: (r) => (r as { r: { physicalBalance: number } }).r.physicalBalance },
      { key: "difference", header: "Selisih", type: "rupiah", value: (r) => (r as { r: { difference: number } }).r.difference },
      { key: "reason", header: "Alasan", value: (r) => (r as { r: { reason: string | null } }).r.reason },
      { key: "status", header: "Status", type: "enum", enumName: "reconciliation_status", value: (r) => (r as { r: { status: string } }).r.status },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: (await reconciliationHistory(ctx, { tx })).cash }),
  });

  const revenueFilters = z.object({ from: periodField, to: periodField }).passthrough();
  registerReport({
    key: "m11.revenue_tax",
    title: "Omzet bruto bulanan per lini & estimasi PPh final",
    module: "m11",
    permission: "m11.tax.read",
    containsPii: false,
    filtersSchema: revenueFilters,
    orientation: "landscape",
    columns: [
      { key: "period", header: "Periode" },
      { key: "L1", header: "L1", type: "rupiah", total: true },
      { key: "L2", header: "L2 Air truk", type: "rupiah", total: true },
      { key: "L3", header: "L3 Depot", type: "rupiah", total: true },
      { key: "L4", header: "L4 Toko", type: "rupiah", total: true },
      { key: "L5", header: "L5 Kemitraan", type: "rupiah", total: true },
      { key: "total", header: "Omzet bruto", type: "rupiah", total: true },
      { key: "pphEstimate", header: "Estimasi PPh final", type: "rupiah", total: true },
    ],
    fetch: async (ctx, f: z.infer<typeof revenueFilters>, { tx }) => {
      const to = f.to ?? currentPeriod(ctx.now);
      const from = f.from ?? `${to.slice(0, 4)}-01`;
      const overview = await taxOverview(ctx, { period: to }, { tx });
      return {
        rows: await monthlyRevenueReport(ctx, { fromPeriod: from, toPeriod: to }, { tx }),
        summary: [
          { label: "Skema pajak", value: overview.schemeLabel },
          { label: "Omzet 12 bulan berjalan", value: overview.pkp.total, type: "rupiah" },
          { label: "Batas PKP", value: overview.pkp.threshold, type: "rupiah" },
          { label: "Tanpa PPN (PT non-PKP)", value: "Ya" },
        ],
      };
    },
  });

  registerReport({
    key: "m11.payables",
    title: "Utang usaha per pemasok & jatuh tempo",
    module: "m11",
    permission: "m11.payable.read",
    containsPii: false,
    orientation: "landscape",
    columns: [
      { key: "supplierName", header: "Pemasok/penerima", width: 28 },
      { key: "description", header: "Dokumen", width: 30 },
      { key: "businessDate", header: "Tanggal", type: "date" },
      { key: "dueDate", header: "Jatuh tempo", type: "date" },
      { key: "total", header: "Nilai", type: "rupiah", total: true },
      { key: "paid", header: "Dibayar", type: "rupiah", total: true },
      { key: "outstanding", header: "Sisa", type: "rupiah", total: true },
      { key: "daysOverdue", header: "Lewat (hari)", type: "number" },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: (await payablesView(ctx, {}, { tx })).rows }),
  });

  registerReport({
    key: "m11.opening_balances",
    title: "Saldo awal akuntansi per kelompok",
    module: "m11",
    permission: "m11.opening_balance.read",
    containsPii: false,
    columns: [
      { key: "label", header: "Kelompok" },
      { key: "status", header: "Status", value: (r) => ((r as { batch: { status: string } | null }).batch ? label("opening_batch_status", (r as { batch: { status: string } }).batch.status) : "Belum diisi") },
      { key: "debit", header: "Debit", type: "rupiah", total: true },
      { key: "credit", header: "Kredit", type: "rupiah", total: true },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: (await openingOverview(ctx, { tx })).groups }),
  });

  registerReport({
    key: "m11.periods",
    title: "Periode akuntansi",
    module: "m11",
    permission: "m11.period.read",
    containsPii: false,
    columns: [
      { key: "period", header: "Periode" },
      { key: "status", header: "Status", type: "enum", enumName: "period_status" },
      { key: "closedAt", header: "Ditutup", type: "datetime" },
      { key: "closedLate", header: "Terlambat", type: "boolean" },
      { key: "lockedAt", header: "Dikunci", type: "datetime" },
      { key: "revision", header: "Revisi", type: "number" },
      { key: "isRetroactive", header: "Retroaktif", type: "boolean" },
    ],
    fetch: async (ctx, _f, { tx }) => ({ rows: await listPeriods(ctx, { tx }) }),
  });

  const dayFilters = z.object({ date: z.string().optional() }).passthrough();
  registerReport({
    key: "m11.daily_reconciliation",
    title: "Rekonsiliasi jurnal harian vs H+0",
    module: "m11",
    permission: "m11.journal.read",
    containsPii: false,
    filtersSchema: dayFilters,
    columns: [
      { key: "module", header: "Modul" },
      { key: "label", header: "Peristiwa", width: 30 },
      { key: "events", header: "Jumlah H+0", type: "number" },
      { key: "eventValue", header: "Nilai H+0", type: "rupiah" },
      { key: "journals", header: "Jumlah jurnal", type: "number" },
      { key: "journalValue", header: "Nilai jurnal", type: "rupiah" },
      { key: "queued", header: "Daftar tunggu", type: "number" },
      { key: "match", header: "Cocok", type: "boolean" },
    ],
    fetch: async (ctx, f: z.infer<typeof dayFilters>, { tx }) => ({ rows: (await dailyReconciliation(ctx, { date: f.date ?? toBusinessDate(ctx.now) }, { tx })).rows }),
  });
}
