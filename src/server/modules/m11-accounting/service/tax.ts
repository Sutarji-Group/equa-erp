/**
 * M11 — pajak PT non-PKP & pemantauan batas PKP (US-M11-08, BR-29..31, K10, R11, NFR-23):
 * - Tanpa PPN & faktur pajak (BR-29): sistem tidak punya akun/komponen PPN pada penjualan.
 * - Omzet bruto bulanan per lini (pendapatan luar; transfer internal & pendapatan lain dikecualikan) + estimasi PPh final
 *   (PAR-64) bila skema `non_pkp_final`; skema lain = tarif parameter (`tax_scheme_rates`) diinput Admin Keuangan.
 * - Ekspor jurnal / buku besar / omzet ke format konsultan lewat TEMPLATE TERKONFIGURASI (`export_templates`) — format
 *   dapat diubah tanpa rilis aplikasi.
 * - Pemantauan PKP: omzet 12 bulan berjalan vs PAR-22; peringatan 80% & 90% ke pemilik & Admin Keuangan (job harian),
 *   proyeksi bulan tercapai dari rata-rata 3 bulan terakhir; fungsi `pkpStatus` untuk dasbor M9.
 * - Retensi pembukuan ≥ 10 tahun (PAR-29) — data tidak dapat dihapus (penjaga DB EQ001).
 */
import "server-only";

import { createHash } from "node:crypto";

import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { accountingPeriods, accounts, exportLogs, exportTemplates, journalLines, journals, notifications, taxSchemeRates, taxSettings } from "@/db/schema";
import { enumValues, label, type ProfitCenter } from "@/lib/labels";
import { isBusinessDate, monthOf, toBusinessDate, type BusinessDate } from "@/lib/time";

import { logAccess } from "@/server/core/access-log";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { renderCsv, renderExcel, renderPdf, type RenderColumn, type ReportColumnType } from "@/server/core/export";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, authorizeAny, runService } from "@/server/core/rbac";

import { isAccountingTenant, isPeriodLabel, periodEnd, shiftPeriod } from "./common";
import { computeTrialBalance } from "./statements";

const LINES: ProfitCenter[] = ["L1", "L2", "L3", "L4", "L5"];

export type TaxSetting = typeof taxSettings.$inferSelect & { ratePercent: number | null };

export async function taxSettingAt(tx: Tx, tenantId: string, date: BusinessDate): Promise<TaxSetting | null> {
  const [s] = await tx
    .select()
    .from(taxSettings)
    .where(and(eq(taxSettings.tenantId, tenantId), lte(taxSettings.effectiveFrom, date)))
    .orderBy(desc(taxSettings.effectiveFrom))
    .limit(1);
  if (!s) return null;
  const [r] = await tx.select().from(taxSchemeRates).where(eq(taxSchemeRates.taxSettingId, s.id)).limit(1);
  return { ...s, ratePercent: r?.ratePercent ?? null };
}

/** Omzet bruto luar per bulan & lini (pendapatan non-internal pada lini L1–L5; SHARED = pendapatan lain, dikecualikan). */
export async function revenueByMonth(tx: Tx, tenantId: string, fromPeriod: string, toPeriod: string): Promise<Map<string, Record<ProfitCenter, number>>> {
  const rows = await tx
    .select({
      period: accountingPeriods.period,
      pc: journalLines.profitCenter,
      d: sql<string>`coalesce(sum(${journalLines.debit}),0)`,
      c: sql<string>`coalesce(sum(${journalLines.credit}),0)`,
    })
    .from(journalLines)
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accountingPeriods, eq(accountingPeriods.id, journals.periodId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(
      and(
        eq(journals.tenantId, tenantId),
        eq(journals.status, "posted"),
        eq(accounts.type, "revenue"),
        eq(accounts.isInternalTransfer, false),
        gte(accountingPeriods.period, fromPeriod),
        lte(accountingPeriods.period, toPeriod),
      ),
    )
    .groupBy(accountingPeriods.period, journalLines.profitCenter);
  const out = new Map<string, Record<ProfitCenter, number>>();
  for (const r of rows) {
    if (r.pc === "SHARED") continue;
    const cur = out.get(r.period) ?? { L1: 0, L2: 0, L3: 0, L4: 0, L5: 0, SHARED: 0 };
    cur[r.pc] += Number(r.c) - Number(r.d);
    out.set(r.period, cur);
  }
  return out;
}

export type PkpStatus = {
  asOf: string;
  windowMonths: number;
  fromPeriod: string;
  toPeriod: string;
  total: number;
  threshold: number;
  percent: number;
  warnPercents: number[];
  level: number | null;
  months: { period: string; revenue: number }[];
  avg3: number;
  projectedPeriod: string | null;
};

/** Omzet 12 bulan berjalan vs batas PKP (PAR-22) + proyeksi bulan tercapai (rata-rata 3 bulan). Untuk dasbor M9. */
export async function pkpStatus(tx: Tx, tenantId: string, date: BusinessDate): Promise<PkpStatus> {
  const par = await params.get(tx, "PAR-22", date);
  const toPeriod = monthOf(date);
  const fromPeriod = shiftPeriod(toPeriod, -(par.window_months - 1));
  const byMonth = await revenueByMonth(tx, tenantId, fromPeriod, toPeriod);
  const months: { period: string; revenue: number }[] = [];
  for (let p = fromPeriod; p <= toPeriod; p = shiftPeriod(p, 1)) {
    const r = byMonth.get(p);
    months.push({ period: p, revenue: r ? LINES.reduce((s, l) => s + r[l], 0) : 0 });
  }
  const total = months.reduce((s, m) => s + m.revenue, 0);
  const percent = par.threshold > 0 ? Math.round((total / par.threshold) * 10000) / 100 : 0;
  const warn = [...par.warn_percents].sort((a, b) => a - b);
  const level = [...warn].reverse().find((w) => percent >= w) ?? null;
  const last3 = months.slice(-3);
  const avg3 = last3.length ? Math.round(last3.reduce((s, m) => s + m.revenue, 0) / last3.length) : 0;
  let projectedPeriod: string | null = null;
  if (total >= par.threshold) projectedPeriod = toPeriod;
  else if (avg3 > 0) {
    // Jendela bergulir: bulan tertua keluar, bulan baru (≈ rata-rata 3 bulan) masuk.
    let running = total;
    const window = months.map((m) => m.revenue);
    for (let i = 1; i <= 60; i++) {
      running = running - (window[i - 1] ?? 0) + avg3;
      if (running >= par.threshold) {
        projectedPeriod = shiftPeriod(toPeriod, i);
        break;
      }
      if (i >= window.length && running < par.threshold && avg3 * par.window_months < par.threshold) break;
    }
  }
  return { asOf: date, windowMonths: par.window_months, fromPeriod, toPeriod, total, threshold: par.threshold, percent, warnPercents: warn, level, months, avg3, projectedPeriod };
}

export type TaxOverview = {
  period: string;
  setting: TaxSetting | null;
  schemeLabel: string;
  revenue: Record<ProfitCenter, number>;
  total: number;
  ratePercent: number | null;
  pphEstimate: number | null;
  noVat: true;
  pkp: PkpStatus;
  retentionYears: number;
};

/** Ringkasan pajak periode: omzet bruto per lini, estimasi PPh final (informasi), status PKP, retensi. */
export async function taxOverview(ctx: ActorContext, filter: { period?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<TaxOverview> {
  await authorize(ctx, "m11.tax.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const period = filter.period && isPeriodLabel(filter.period) ? filter.period : monthOf(ctxBusinessDate(ctx));
  const end = periodEnd(period);
  const setting = await taxSettingAt(tx, ctx.tenantId, end);
  const rev = (await revenueByMonth(tx, ctx.tenantId, period, period)).get(period) ?? { L1: 0, L2: 0, L3: 0, L4: 0, L5: 0, SHARED: 0 };
  const total = LINES.reduce((s, l) => s + rev[l], 0);
  let ratePercent: number | null = null;
  if (setting?.scheme === "non_pkp_final") ratePercent = (await params.get(tx, "PAR-64", end)).percent;
  else if (setting?.scheme === "non_pkp_other") ratePercent = setting.ratePercent;
  const retention = await params.get(tx, "PAR-29", ctxBusinessDate(ctx));
  return {
    period,
    setting,
    schemeLabel: setting ? label("tax_scheme", setting.scheme) : "Belum ditetapkan",
    revenue: rev,
    total,
    ratePercent,
    pphEstimate: ratePercent !== null ? Math.round((total * ratePercent) / 100) : null,
    noVat: true,
    pkp: await pkpStatus(tx, ctx.tenantId, ctxBusinessDate(ctx)),
    retentionYears: retention.accounting_years,
  };
}

/** Omzet bruto bulanan per lini untuk rentang (laporan & ekspor). */
export async function monthlyRevenueReport(ctx: ActorContext, filter: { fromPeriod: string; toPeriod: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.tax.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const byMonth = await revenueByMonth(tx, ctx.tenantId, filter.fromPeriod, filter.toPeriod);
  const rows: { period: string; L1: number; L2: number; L3: number; L4: number; L5: number; total: number; pphEstimate: number | null }[] = [];
  for (let p = filter.fromPeriod; p <= filter.toPeriod; p = shiftPeriod(p, 1)) {
    const r = byMonth.get(p) ?? { L1: 0, L2: 0, L3: 0, L4: 0, L5: 0, SHARED: 0 };
    const total = LINES.reduce((s, l) => s + r[l], 0);
    const setting = await taxSettingAt(tx, ctx.tenantId, periodEnd(p));
    const rate = setting?.scheme === "non_pkp_final" ? (await params.get(tx, "PAR-64", periodEnd(p))).percent : setting?.scheme === "non_pkp_other" ? setting.ratePercent : null;
    rows.push({ period: p, L1: r.L1, L2: r.L2, L3: r.L3, L4: r.L4, L5: r.L5, total, pphEstimate: rate !== null ? Math.round((total * rate) / 100) : null });
    if (rows.length > 36) break;
  }
  return rows;
}

const schemeSchema = z
  .object({
    scheme: z.enum(enumValues("tax_scheme")),
    effectiveFrom: z.string().refine(isBusinessDate, { error: "Tanggal berlaku harus YYYY-MM-DD." }),
    ratePercent: z.number().min(0).max(100).nullable().optional(),
    notes: z.string().trim().min(5, { error: "Catatan (keputusan konsultan pajak) wajib diisi." }).max(500),
  })
  .strict();

/** Atur skema pajak berlaku per tanggal (Admin Keuangan, keputusan konsultan; 7.11.7 "PT menjadi PKP"). */
export async function setTaxScheme(ctx: ActorContext, input: z.input<typeof schemeSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.tax.update", { tx: opts.tx });
  const data = parseInput(schemeSchema, input, { notes: "Catatan", ratePercent: "Tarif" });
  if (data.scheme === "non_pkp_other" && (data.ratePercent === null || data.ratePercent === undefined)) {
    throw new DomainError("RATE_REQUIRED", "Skema lain wajib diisi tarifnya (% omzet) sesuai keputusan konsultan pajak.");
  }
  if (data.effectiveFrom < ctxBusinessDate(ctx)) throw new DomainError("NOT_RETROACTIVE", "Skema pajak berlaku mulai hari ini atau sesudahnya.");
  return runService(ctx, opts, async (tx) => {
    const prev = await taxSettingAt(tx, ctx.tenantId, data.effectiveFrom);
    const [same] = await tx.select().from(taxSettings).where(and(eq(taxSettings.tenantId, ctx.tenantId), eq(taxSettings.effectiveFrom, data.effectiveFrom))).limit(1);
    const [row] = same
      ? await tx.update(taxSettings).set({ scheme: data.scheme, isPkp: data.scheme === "pkp", notes: data.notes, updatedAt: new Date() }).where(eq(taxSettings.id, same.id)).returning()
      : await tx.insert(taxSettings).values({ tenantId: ctx.tenantId, scheme: data.scheme, isPkp: data.scheme === "pkp", effectiveFrom: data.effectiveFrom, notes: data.notes, createdBy: ctx.userId }).returning();
    if (data.scheme === "non_pkp_other") {
      await tx
        .insert(taxSchemeRates)
        .values({ taxSettingId: row!.id, ratePercent: data.ratePercent! })
        .onConflictDoUpdate({ target: taxSchemeRates.taxSettingId, set: { ratePercent: data.ratePercent!, updatedAt: new Date() } });
    }
    await auditRecord(tx, { ctx, objectType: "tax_setting", objectId: row!.id, action: same ? "update" : "create", before: prev ? { scheme: prev.scheme, rate: prev.ratePercent, from: prev.effectiveFrom } : null, after: { scheme: data.scheme, rate: data.ratePercent ?? null, from: data.effectiveFrom }, reason: data.notes, rule: "US-M11-08 KP-2" });
    return row!;
  });
}

/** Job harian: peringatan PKP 80%/90% (sekali per tingkat per bulan) ke pemilik & Admin Keuangan (BR-29). */
export async function runPkpMonitor(now: Date, opts: { db?: Tx } = {}): Promise<number> {
  const run = async (tx: Tx) => {
    const date = toBusinessDate(now);
    const tenants = await tx.selectDistinct({ tenantId: journals.tenantId }).from(journals);
    let sent = 0;
    for (const { tenantId } of tenants) {
      if (!(await isAccountingTenant(tx, tenantId))) continue;
      const st = await pkpStatus(tx, tenantId, date);
      if (st.level === null) continue;
      const groupKey = `tax.pkp_threshold:${tenantId}:${st.level}:${monthOf(date)}`;
      const [dup] = await tx.select({ id: notifications.id }).from(notifications).where(eq(notifications.groupKey, groupKey)).limit(1);
      if (dup) continue;
      await notify(tx, {
        event: "tax.pkp_threshold",
        tenantId,
        title: `Omzet 12 bulan berjalan ${st.percent.toLocaleString("id-ID")}% dari batas PKP`,
        body: `Omzet ${st.fromPeriod} s.d. ${st.toPeriod}: Rp ${st.total.toLocaleString("id-ID")} dari Rp ${st.threshold.toLocaleString("id-ID")} (peringatan ${st.level}%).${
          st.projectedPeriod ? ` Proyeksi batas tercapai: ${st.projectedPeriod}.` : ""
        } Siapkan pengukuhan PKP bersama konsultan pajak.`,
        objectType: "tax",
        objectId: tenantId,
        valueAmount: st.total,
        groupKey,
        link: "/akuntansi/pajak",
        now,
      });
      sent++;
    }
    return sent;
  };
  return opts.db ? run(opts.db) : withTx(run);
}

// =====================================================================================================================
// Template ekspor konsultan (US-M11-08 KP-3)
// =====================================================================================================================

export const EXPORT_FIELDS: Record<"journals" | "ledger" | "revenue", { field: string; label: string; type: ReportColumnType }[]> = {
  journals: [
    { field: "journalDate", label: "Tanggal", type: "date" },
    { field: "period", label: "Periode", type: "text" },
    { field: "number", label: "No. jurnal", type: "text" },
    { field: "kind", label: "Jenis", type: "text" },
    { field: "accountCode", label: "Kode akun", type: "text" },
    { field: "accountName", label: "Nama akun", type: "text" },
    { field: "profitCenter", label: "Pusat laba", type: "text" },
    { field: "description", label: "Keterangan", type: "text" },
    { field: "debit", label: "Debit", type: "rupiah" },
    { field: "credit", label: "Kredit", type: "rupiah" },
    { field: "sourceType", label: "Sumber", type: "text" },
  ],
  ledger: [
    { field: "accountCode", label: "Kode akun", type: "text" },
    { field: "accountName", label: "Nama akun", type: "text" },
    { field: "openingDebit", label: "Saldo awal debit", type: "rupiah" },
    { field: "openingCredit", label: "Saldo awal kredit", type: "rupiah" },
    { field: "debit", label: "Mutasi debit", type: "rupiah" },
    { field: "credit", label: "Mutasi kredit", type: "rupiah" },
    { field: "closingDebit", label: "Saldo akhir debit", type: "rupiah" },
    { field: "closingCredit", label: "Saldo akhir kredit", type: "rupiah" },
  ],
  revenue: [
    { field: "period", label: "Periode", type: "text" },
    { field: "L1", label: "L1 Produksi air", type: "rupiah" },
    { field: "L2", label: "L2 Air truk", type: "rupiah" },
    { field: "L3", label: "L3 Depot", type: "rupiah" },
    { field: "L4", label: "L4 Toko", type: "rupiah" },
    { field: "L5", label: "L5 Kemitraan", type: "rupiah" },
    { field: "total", label: "Omzet bruto", type: "rupiah" },
    { field: "pphEstimate", label: "Estimasi PPh final", type: "rupiah" },
  ],
};

export async function listExportTemplates(ctx: ActorContext, opts: { tx?: Tx } = {}) {
  await authorizeAny(ctx, ["m11.tax.read", "m11.journal.export"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  return tx.select().from(exportTemplates).where(eq(exportTemplates.tenantId, ctx.tenantId)).orderBy(asc(exportTemplates.key), desc(exportTemplates.version));
}

const templateSchema = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]{3,40}$/, { error: "Kunci template huruf kecil/angka/tanda hubung (3–40)." }),
    name: z.string().trim().min(3).max(120),
    target: z.enum(["journals", "ledger", "revenue"]),
    format: z.enum(["xlsx", "csv", "pdf"]).default("xlsx"),
    columns: z
      .array(z.object({ header: z.string().trim().min(1).max(60), field: z.string().trim().min(1) }).strict())
      .min(1, { error: "Template minimal satu kolom." })
      .max(30),
    reason: z.string().trim().min(5, { error: "Alasan perubahan wajib diisi." }),
  })
  .strict();

/** Simpan template ekspor (versi baru; versi lama nonaktif) — format konsultan tanpa rilis aplikasi. */
export async function saveExportTemplate(ctx: ActorContext, input: z.input<typeof templateSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.export_template.update", { tx: opts.tx });
  const data = parseInput(templateSchema, input, { key: "Kunci", name: "Nama", columns: "Kolom" });
  const allowed = new Set(EXPORT_FIELDS[data.target].map((f) => f.field));
  const bad = data.columns.filter((c) => !allowed.has(c.field));
  if (bad.length) throw new DomainError("TEMPLATE_FIELD", `Kolom tidak dikenal untuk ${data.target}: ${bad.map((b) => b.field).join(", ")}.`);
  return runService(ctx, opts, async (tx) => {
    const [latest] = await tx.select().from(exportTemplates).where(and(eq(exportTemplates.tenantId, ctx.tenantId), eq(exportTemplates.key, data.key))).orderBy(desc(exportTemplates.version)).limit(1);
    if (latest) await tx.update(exportTemplates).set({ isActive: false, updatedAt: new Date() }).where(and(eq(exportTemplates.tenantId, ctx.tenantId), eq(exportTemplates.key, data.key)));
    const [row] = await tx
      .insert(exportTemplates)
      .values({ tenantId: ctx.tenantId, key: data.key, name: data.name, target: data.target, format: data.format, columnMapping: data.columns, version: (latest?.version ?? 0) + 1, isActive: true, createdBy: ctx.userId })
      .returning();
    await auditRecord(tx, { ctx, objectType: "export_template", objectId: row!.id, action: latest ? "update" : "create", before: latest ? { version: latest.version, columns: latest.columnMapping } : null, after: { version: row!.version, columns: data.columns, format: data.format }, reason: data.reason, rule: "US-M11-08 KP-3" });
    return row!;
  });
}

async function templateRows(tx: Tx, ctx: ActorContext, target: "journals" | "ledger" | "revenue", period: string): Promise<Record<string, unknown>[]> {
  if (target === "journals") {
    const rows = await tx
      .select({ j: journals, l: journalLines, a: accounts, period: accountingPeriods.period })
      .from(journalLines)
      .innerJoin(journals, eq(journals.id, journalLines.journalId))
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .innerJoin(accountingPeriods, eq(accountingPeriods.id, journals.periodId))
      .where(and(eq(journals.tenantId, ctx.tenantId), eq(journals.status, "posted"), eq(accountingPeriods.period, period)))
      .orderBy(asc(journals.journalDate), asc(journals.number), asc(journalLines.lineNo));
    return rows.map(({ j, l, a, period: p }) => ({
      journalDate: j.journalDate,
      period: p,
      number: j.number,
      kind: label("journal_kind", j.kind),
      accountCode: a.code,
      accountName: a.name,
      profitCenter: l.profitCenter,
      description: l.description ? `${j.description} — ${l.description}` : j.description,
      debit: l.debit,
      credit: l.credit,
      sourceType: j.sourceType,
    }));
  }
  if (target === "ledger") {
    const tb = await computeTrialBalance(tx, ctx.tenantId, period, "period");
    return tb.rows.map((r) => ({ accountCode: r.code, accountName: r.name, openingDebit: r.openingDebit, openingCredit: r.openingCredit, debit: r.debit, credit: r.credit, closingDebit: r.closingDebit, closingCredit: r.closingCredit }));
  }
  return monthlyRevenueReport(ctx, { fromPeriod: `${period.slice(0, 4)}-01`, toPeriod: period }, { tx });
}

const exportSchema = z.object({ templateKey: z.string().min(1), period: z.string().refine(isPeriodLabel, { error: "Periode YYYY-MM." }), format: z.enum(["xlsx", "csv", "pdf"]).nullable().optional() }).strict();

/** Ekspor dengan template konsultan aktif (dicatat di log ekspor & log akses). */
export async function exportWithTemplate(ctx: ActorContext, input: z.input<typeof exportSchema>) {
  await authorizeAny(ctx, ["m11.tax.export", "m11.journal.export"]);
  const data = parseInput(exportSchema, input, { period: "Periode" });
  const db = getDb();
  const [tpl] = await db
    .select()
    .from(exportTemplates)
    .where(and(eq(exportTemplates.tenantId, ctx.tenantId), eq(exportTemplates.key, data.templateKey), eq(exportTemplates.isActive, true)))
    .orderBy(desc(exportTemplates.version))
    .limit(1);
  if (!tpl) throw new NotFoundError("Template ekspor tidak ditemukan atau nonaktif.");
  const target = tpl.target as "journals" | "ledger" | "revenue";
  const fields = new Map(EXPORT_FIELDS[target].map((f) => [f.field, f]));
  const mapping = (tpl.columnMapping as { header: string; field: string }[]).filter((c) => fields.has(c.field));
  const columns: RenderColumn[] = mapping.map((c) => ({ key: c.field, header: c.header, type: fields.get(c.field)!.type }));
  const rows = await templateRows(db, ctx, target, data.period);
  const format = data.format ?? tpl.format;
  const identity = await params.get(db, "company.identity", ctxBusinessDate(ctx));
  const renderInput = {
    title: `${tpl.name} — ${data.period}`,
    company: { name: identity.name, legalName: identity.legal_name, address: identity.address, phone: identity.phone },
    generatedAt: ctx.now,
    generatedBy: ctx.roles.map((r) => label("role", r)).join("/"),
    filters: [`Periode: ${data.period}`, `Template: ${tpl.key} v${tpl.version}`],
    columns,
    rows: rows.map((r) => columns.map((c) => r[c.key] ?? null)),
    summary: [],
    orientation: (columns.length > 7 ? "landscape" : "portrait") as "landscape" | "portrait",
    notes: ["Tanpa PPN (PT non-PKP, BR-29)."],
  };
  const body = format === "xlsx" ? await renderExcel(renderInput) : format === "pdf" ? await renderPdf(renderInput) : renderCsv(renderInput);
  const sha256 = createHash("sha256").update(body).digest("hex");
  await withTx(async (tx) => {
    const [log] = await tx
      .insert(exportLogs)
      .values({ tenantId: ctx.tenantId, userId: ctx.userId!, reportKey: `m11.template.${tpl.key}`, format, filters: { period: data.period, version: tpl.version }, rowCount: rows.length, fileSha256: sha256 })
      .returning({ id: exportLogs.id });
    await logAccess(tx, { tenantId: ctx.tenantId, userId: ctx.userId, event: "export", success: true, objectType: "report", objectId: `m11.template.${tpl.key}`, details: { format, rowCount: rows.length, exportLogId: log!.id }, occurredAt: ctx.now });
  });
  const contentType = format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : format === "pdf" ? "application/pdf" : "text/csv; charset=utf-8";
  return { filename: `${tpl.key}-${data.period}.${format}`, contentType, body, rowCount: rows.length, sha256 };
}
