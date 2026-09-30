/**
 * M11 — aset tetap & penyusutan otomatis (US-M11-05, BR-34, K15, NFR-34):
 * - Daftar aset: kategori, tanggal & nilai perolehan (akuntan/notaris), umur & metode (bawaan garis lurus, PAR-63),
 *   pusat laba pemakai (truk → L2, instalasi → L1, peralatan depot → L3 per outlet, bangunan → sesuai pemakaian), nilai
 *   sisa. Impor template + tanda tangan pemilik (NFR-34). Aset sewa (K15) BUKAN aset — sewanya jurnal berulang.
 * - Penyusutan bulanan otomatis (job hari pertama bulan berikutnya & saat tutup periode), satu jurnal per periode;
 *   hitung ulang bila umur/nilai diubah akuntan → jurnal penyesuaian berjejak.
 * - Penambahan dari nota/jurnal manual; pelepasan/penjualan dengan laba-rugi otomatis; riwayat per aset; laporan daftar
 *   aset & akumulasi per periode.
 */
import "server-only";

import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { accountingPeriods, accounts, dataSignoffs, depreciationEntries, fixedAssetExtras, fixedAssets, journals, manualJournalDetails, outlets, trucks, waterSources } from "@/db/schema";
import { enumValues, label, type EnumValue, type ProfitCenter } from "@/lib/labels";
import { formatRupiah, zRupiahNonNegative, zRupiahPositive } from "@/lib/money";
import { addDays as addDaysDate, isBusinessDate, monthOf, toBusinessDate, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { emit } from "@/server/core/events";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";

import { ASSET_CATEGORY_ACCOUNT, ASSET_CATEGORY_PROFIT_CENTER } from "../constants";
import { accountsByCode, currentCutover, ensurePeriod, inJobTx, insertJournal, isAccountingTenant, isOpenStatus, mappingAccounts, periodEnd, shiftPeriod, type PeriodRow, type PostedLineInput } from "./common";
import { parseAmount, parseDateText, parseTable, pick } from "./import-parse";
import { submitDraftJournal } from "./manual";

export type AssetRow = typeof fixedAssets.$inferSelect;
type Category = EnumValue<"asset_category">;

const dateSchema = z.string().refine(isBusinessDate, { error: "Tanggal harus YYYY-MM-DD." });

async function usefulLifeDefault(tx: Tx, category: Category, date: BusinessDate): Promise<number | null> {
  const v = await params.get(tx, "PAR-63", date);
  return v.useful_life_months_by_category?.[category] ?? null;
}

/** Periode mulai penyusutan: bulan perolehan bila diperoleh ≤ tanggal aturan, selain itu bulan berikutnya. */
export function depreciationStart(acquisitionDate: BusinessDate, sameMonthUntilDay: number): string {
  const day = Number(acquisitionDate.slice(8, 10));
  const m = monthOf(acquisitionDate);
  return day <= sameMonthUntilDay ? m : shiftPeriod(m, 1);
}

/** Penyusutan per bulan (garis lurus: (nilai − sisa) ÷ umur; saldo menurun ganda: 2/umur × nilai buku). */
export function monthlyDepreciation(asset: Pick<AssetRow, "acquisitionCost" | "residualValue" | "usefulLifeMonths" | "depreciationMethod">, accumulated: number): number {
  const base = asset.acquisitionCost - asset.residualValue;
  const remaining = base - accumulated;
  if (remaining <= 0 || asset.usefulLifeMonths <= 0) return 0;
  const raw =
    asset.depreciationMethod === "declining_balance"
      ? Math.round(((asset.acquisitionCost - accumulated) * 2) / asset.usefulLifeMonths)
      : Math.round(base / asset.usefulLifeMonths);
  return Math.max(0, Math.min(raw, remaining));
}

async function extrasOf(tx: Tx, assetIds: readonly string[]) {
  if (!assetIds.length) return new Map<string, typeof fixedAssetExtras.$inferSelect>();
  const rows = await tx.select().from(fixedAssetExtras).where(inArray(fixedAssetExtras.fixedAssetId, [...assetIds]));
  return new Map(rows.map((r) => [r.fixedAssetId, r]));
}

/** Akumulasi penyusutan aset s.d. akhir periode (saldo cut-over + entri terposting). */
async function accumulatedUpTo(tx: Tx, assetIds: readonly string[], period: string | null): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!assetIds.length) return out;
  const extras = await extrasOf(tx, assetIds);
  for (const id of assetIds) out.set(id, extras.get(id)?.openingAccumulated ?? 0);
  const conds = [inArray(depreciationEntries.fixedAssetId, [...assetIds])];
  if (period) conds.push(lte(accountingPeriods.period, period));
  const rows = await tx
    .select({ id: depreciationEntries.fixedAssetId, amount: sql<string>`coalesce(sum(${depreciationEntries.amount}),0)` })
    .from(depreciationEntries)
    .innerJoin(accountingPeriods, eq(accountingPeriods.id, depreciationEntries.periodId))
    .where(and(...conds))
    .groupBy(depreciationEntries.fixedAssetId);
  for (const r of rows) out.set(r.id, (out.get(r.id) ?? 0) + Number(r.amount));
  return out;
}

async function signoffSigned(tx: Tx, signoffId: string | null): Promise<boolean> {
  if (!signoffId) return true;
  const [s] = await tx.select({ status: dataSignoffs.status }).from(dataSignoffs).where(eq(dataSignoffs.id, signoffId)).limit(1);
  return s?.status === "signed";
}

async function accountsForAsset(tx: Tx, asset: AssetRow, date: BusinessDate) {
  const map = await mappingAccounts(tx, asset.tenantId, "asset.depreciated", asset.category, date);
  return { expense: asset.expenseAccountId ?? map.debitAccountId, accumulated: asset.accumulatedAccountId ?? map.creditAccountId };
}

export type DepreciationPlan = { asset: AssetRow; amount: number; accumulatedBefore: number };

/** Aset yang wajib disusutkan pada periode + jumlahnya (tanpa menulis). */
export async function depreciationPlan(tx: Tx, tenantId: string, period: string): Promise<DepreciationPlan[]> {
  const rules = await params.get(tx, "m11.accounting_rules", periodEnd(period));
  const cutover = await currentCutover(tx, periodEnd(period));
  const cutPeriod = cutover ? monthOf(cutover) : null;
  const assets = await tx
    .select()
    .from(fixedAssets)
    .where(and(eq(fixedAssets.tenantId, tenantId), lte(fixedAssets.acquisitionDate, periodEnd(period))))
    .orderBy(asc(fixedAssets.code));
  const [p] = await tx.select().from(accountingPeriods).where(and(eq(accountingPeriods.tenantId, tenantId), eq(accountingPeriods.period, period))).limit(1);
  const done = p
    ? new Set(
        (await tx.select({ id: depreciationEntries.fixedAssetId }).from(depreciationEntries).where(and(eq(depreciationEntries.periodId, p.id), eq(depreciationEntries.isAdjustment, false)))).map(
          (r) => r.id,
        ),
      )
    : new Set<string>();
  const acc = await accumulatedUpTo(
    tx,
    assets.map((a) => a.id),
    shiftPeriod(period, -1),
  );
  const out: DepreciationPlan[] = [];
  for (const a of assets) {
    if (done.has(a.id)) continue;
    if (a.status === "disposed" && a.disposedAt && monthOf(a.disposedAt) <= period) continue;
    if (!(await signoffSigned(tx, a.signoffId))) continue;
    let start = depreciationStart(a.acquisitionDate, rules.depreciation_same_month_until_day);
    if (a.source === "import" && cutPeriod && start < cutPeriod) start = cutPeriod;
    if (period < start) continue;
    const accumulatedBefore = acc.get(a.id) ?? 0;
    const amount = monthlyDepreciation(a, accumulatedBefore);
    if (amount > 0) out.push({ asset: a, amount, accumulatedBefore });
  }
  return out;
}

/** Posting penyusutan periode (idempoten per aset + periode). Satu jurnal penyusutan per periode. */
export async function postDepreciationFor(tx: Tx, ctx: ActorContext, period: PeriodRow): Promise<{ journalId: string | null; entries: number; total: number }> {
  if (!isOpenStatus(period.status)) return { journalId: null, entries: 0, total: 0 };
  const plan = await depreciationPlan(tx, period.tenantId, period.period);
  if (!plan.length) return { journalId: null, entries: 0, total: 0 };
  const lines: PostedLineInput[] = [];
  for (const { asset, amount } of plan) {
    const acc = await accountsForAsset(tx, asset, period.endDate);
    const dims = { profitCenter: asset.profitCenter, outletId: asset.outletId, truckId: asset.truckId, waterSourceId: asset.waterSourceId, memo: `Penyusutan ${asset.code} ${asset.name}` };
    lines.push({ accountId: acc.expense, debit: amount, ...dims }, { accountId: acc.accumulated, credit: amount, ...dims });
  }
  const total = plan.reduce((s, p) => s + p.amount, 0);
  const { journal } = await insertJournal(tx, {
    tenantId: period.tenantId,
    kind: "depreciation",
    date: period.endDate,
    description: `Penyusutan aset tetap ${period.period}`,
    lines,
    ctx,
    sourceType: "asset.depreciated",
    sourceObject: { type: "accounting_period", id: period.id },
    periodMode: "strict",
  });
  for (const { asset, amount, accumulatedBefore } of plan) {
    const [entry] = await tx
      .insert(depreciationEntries)
      .values({
        fixedAssetId: asset.id,
        periodId: period.id,
        amount,
        accumulatedAfter: accumulatedBefore + amount,
        bookValueAfter: asset.acquisitionCost - accumulatedBefore - amount,
        journalId: journal.id,
      })
      .returning();
    await emit(
      tx,
      "asset.depreciated",
      { depreciationEntryId: entry!.id, fixedAssetId: asset.id, category: asset.category, periodId: period.id, amount, profitCenter: asset.profitCenter, outletId: asset.outletId },
      { ctx, tenantId: period.tenantId, businessDate: period.endDate, objectType: "fixed_asset", objectId: asset.id },
    );
  }
  await auditRecord(tx, { ctx, objectType: "accounting_period", objectId: period.id, action: "depreciate", after: { period: period.period, journal: journal.number, assets: plan.length, total }, rule: "US-M11-05 KP-2" });
  return { journalId: journal.id, entries: plan.length, total };
}

const periodSchema = z.object({ periodId: z.uuid() }).strict();

/** Posting penyusutan periode sekarang (Admin Keuangan; juga otomatis saat tutup periode & job tanggal 1). */
export async function runDepreciation(ctx: ActorContext, input: z.input<typeof periodSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.fixed_asset.update", { tx: opts.tx });
  const data = parseInput(periodSchema, input);
  return runService(ctx, opts, async (tx) => {
    const [p] = await tx.select().from(accountingPeriods).where(and(eq(accountingPeriods.id, data.periodId), eq(accountingPeriods.tenantId, ctx.tenantId))).for("update").limit(1);
    if (!p) throw new NotFoundError("Periode tidak ditemukan.");
    if (!isOpenStatus(p.status)) throw new DomainError("PERIOD_NOT_OPEN", `Periode ${p.period} sudah ditutup/dikunci.`);
    return postDepreciationFor(tx, ctx, p);
  });
}

/** Job tanggal 1: penyusutan bulan lalu diposting otomatis (idempoten). */
export async function runMonthlyDepreciation(now: Date, opts: { db?: Tx } = {}): Promise<number> {
  const run = async (tx: Tx) => {
    const period = shiftPeriod(monthOf(toBusinessDate(now)), -1);
    const tenants = await tx.selectDistinct({ tenantId: fixedAssets.tenantId }).from(fixedAssets);
    let n = 0;
    for (const { tenantId } of tenants) {
      if (!(await isAccountingTenant(tx, tenantId))) continue;
      const p = await ensurePeriod(tx, tenantId, period);
      n += (await postDepreciationFor(tx, systemContext({ tenantId, now }), p)).entries;
    }
    return n;
  };
  return inJobTx(opts.db, run);
}

// --- Daftar & rincian -------------------------------------------------------------------------------------------------

export type AssetRegisterRow = {
  id: string;
  code: string;
  name: string;
  category: Category;
  profitCenter: ProfitCenter;
  outletId: string | null;
  acquisitionDate: string;
  cost: number;
  residual: number;
  usefulLifeMonths: number;
  method: string;
  accumulated: number;
  bookValue: number;
  depreciationThisPeriod: number;
  status: string;
  source: string;
  signed: boolean;
};

/** Laporan daftar aset & akumulasi penyusutan per periode (US-M11-05 KP-5). */
export async function assetRegister(ctx: ActorContext, filter: { period?: string | null } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.fixed_asset.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const period = filter.period ?? monthOf(ctxBusinessDate(ctx));
  const assets = await tx.select().from(fixedAssets).where(and(eq(fixedAssets.tenantId, ctx.tenantId), lte(fixedAssets.acquisitionDate, periodEnd(period)))).orderBy(asc(fixedAssets.code));
  const acc = await accumulatedUpTo(
    tx,
    assets.map((a) => a.id),
    period,
  );
  const [p] = await tx.select().from(accountingPeriods).where(and(eq(accountingPeriods.tenantId, ctx.tenantId), eq(accountingPeriods.period, period))).limit(1);
  const thisPeriod = p
    ? new Map(
        (
          await tx
            .select({ id: depreciationEntries.fixedAssetId, amount: sql<string>`sum(${depreciationEntries.amount})` })
            .from(depreciationEntries)
            .where(eq(depreciationEntries.periodId, p.id))
            .groupBy(depreciationEntries.fixedAssetId)
        ).map((r) => [r.id, Number(r.amount)]),
      )
    : new Map<string, number>();
  const rows: AssetRegisterRow[] = [];
  for (const a of assets) {
    const accumulated = acc.get(a.id) ?? 0;
    rows.push({
      id: a.id,
      code: a.code,
      name: a.name,
      category: a.category,
      profitCenter: a.profitCenter,
      outletId: a.outletId,
      acquisitionDate: a.acquisitionDate,
      cost: a.acquisitionCost,
      residual: a.residualValue,
      usefulLifeMonths: a.usefulLifeMonths,
      method: a.depreciationMethod,
      accumulated,
      bookValue: a.status === "disposed" && a.disposedAt && monthOf(a.disposedAt) <= period ? 0 : a.acquisitionCost - accumulated,
      depreciationThisPeriod: thisPeriod.get(a.id) ?? 0,
      status: a.status,
      source: a.source,
      signed: await signoffSigned(tx, a.signoffId),
    });
  }
  const totals = rows.reduce((s, r) => ({ cost: s.cost + r.cost, accumulated: s.accumulated + r.accumulated, bookValue: s.bookValue + r.bookValue, depreciation: s.depreciation + r.depreciationThisPeriod }), { cost: 0, accumulated: 0, bookValue: 0, depreciation: 0 });
  const pendingSignoff = await tx
    .select()
    .from(dataSignoffs)
    .where(and(eq(dataSignoffs.tenantId, ctx.tenantId), eq(dataSignoffs.group, "fixed_assets"), eq(dataSignoffs.status, "draft")))
    .orderBy(desc(dataSignoffs.createdAt))
    .limit(1);
  return { period, rows, totals, pendingSignoff: pendingSignoff[0] ?? null };
}

export async function assetDetail(ctx: ActorContext, assetId: string, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.fixed_asset.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const [a] = await tx.select().from(fixedAssets).where(and(eq(fixedAssets.id, assetId), eq(fixedAssets.tenantId, ctx.tenantId))).limit(1);
  if (!a) throw new NotFoundError("Aset tidak ditemukan.");
  const extras = (await extrasOf(tx, [a.id])).get(a.id) ?? null;
  const entries = await tx
    .select({ e: depreciationEntries, period: accountingPeriods.period, journalNumber: journals.number })
    .from(depreciationEntries)
    .innerJoin(accountingPeriods, eq(accountingPeriods.id, depreciationEntries.periodId))
    .leftJoin(journals, eq(journals.id, depreciationEntries.journalId))
    .where(eq(depreciationEntries.fixedAssetId, a.id))
    .orderBy(asc(accountingPeriods.period), asc(depreciationEntries.createdAt));
  const acc = (await accumulatedUpTo(tx, [a.id], null)).get(a.id) ?? 0;
  const refs = {
    outlet: a.outletId ? ((await tx.select({ name: outlets.name }).from(outlets).where(eq(outlets.id, a.outletId)).limit(1))[0]?.name ?? null) : null,
    truck: a.truckId ? ((await tx.select({ code: trucks.code }).from(trucks).where(eq(trucks.id, a.truckId)).limit(1))[0]?.code ?? null) : null,
    waterSource: a.waterSourceId ? ((await tx.select({ name: waterSources.name }).from(waterSources).where(eq(waterSources.id, a.waterSourceId)).limit(1))[0]?.name ?? null) : null,
  };
  return { asset: a, extras, entries, accumulated: acc, bookValue: a.acquisitionCost - acc, refs, signed: await signoffSigned(tx, a.signoffId) };
}

// --- Tambah aset (nota / jurnal manual) -----------------------------------------------------------------------------

export const assetInputSchema = z
  .object({
    code: z.string().trim().min(2).max(30),
    name: z.string().trim().min(3).max(120),
    category: z.enum(enumValues("asset_category")),
    acquisitionDate: dateSchema,
    acquisitionCost: zRupiahPositive,
    residualValue: zRupiahNonNegative.default(0),
    usefulLifeMonths: z.number().int().min(1).max(600).nullable().optional(),
    depreciationMethod: z.enum(enumValues("depreciation_method")).nullable().optional(),
    profitCenter: z.enum(enumValues("profit_center")).nullable().optional(),
    outletId: z.uuid().nullable().optional(),
    truckId: z.uuid().nullable().optional(),
    waterSourceId: z.uuid().nullable().optional(),
    /** K15: aset milik pribadi yang disewakan ke PT BUKAN aset tetap. */
    ownedByCompany: z.boolean().default(true),
    /** Asal: pembelian (nota) atau jurnal manual yang sudah terposting. */
    source: z.enum(["purchase", "manual_journal"]).default("purchase"),
    acquisitionJournalId: z.uuid().nullable().optional(),
    notes: z.string().trim().max(300).nullable().optional(),
  })
  .strict();

async function resolveAssetFields(tx: Tx, tenantId: string, data: z.output<typeof assetInputSchema> | ImportAssetRow, date: BusinessDate) {
  const life = data.usefulLifeMonths ?? (await usefulLifeDefault(tx, data.category, date));
  if (!life) throw new DomainError("LIFE_REQUIRED", `Umur ekonomis ${label("asset_category", data.category)} belum ditetapkan akuntan (PAR-63) — isi umur (bulan).`);
  const pc = (data.profitCenter ?? ASSET_CATEGORY_PROFIT_CENTER[data.category]) as ProfitCenter;
  if (data.category === "depot_equipment" && !data.outletId) throw new DomainError("OUTLET_REQUIRED", "Peralatan depot wajib memilih outlet pemakai (L3 per outlet).");
  if (data.residualValue >= data.acquisitionCost) throw new DomainError("RESIDUAL_TOO_HIGH", "Nilai sisa harus lebih kecil dari nilai perolehan.");
  const code = ASSET_CATEGORY_ACCOUNT[data.category];
  const assetAccount = (await accountsByCode(tx, tenantId, [code])).get(code);
  const map = await mappingAccounts(tx, tenantId, "asset.depreciated", data.category, date);
  return { life, pc, assetAccountId: assetAccount?.id ?? null, expenseAccountId: map.debitAccountId, accumulatedAccountId: map.creditAccountId };
}

/** Tambah aset dari pembelian/jurnal manual (Admin Keuangan). */
export async function createAsset(ctx: ActorContext, input: z.input<typeof assetInputSchema>, opts: { tx?: Tx } = {}): Promise<AssetRow> {
  await authorize(ctx, "m11.fixed_asset.create", { tx: opts.tx });
  const data = parseInput(assetInputSchema, input, { code: "Kode aset", name: "Nama aset", acquisitionCost: "Nilai perolehan", usefulLifeMonths: "Umur ekonomis" });
  if (!data.ownedByCompany) {
    throw new DomainError("LEASED_ASSET", "Aset milik pribadi yang disewakan ke PT (K15) tidak masuk daftar aset — catat sewanya sebagai jurnal berulang (Sewa).");
  }
  return runService(ctx, opts, async (tx) => {
    const f = await resolveAssetFields(tx, ctx.tenantId, data, ctxBusinessDate(ctx));
    const dup = await tx.select({ id: fixedAssets.id }).from(fixedAssets).where(and(eq(fixedAssets.tenantId, ctx.tenantId), eq(fixedAssets.code, data.code))).limit(1);
    if (dup[0]) throw new DomainError("ASSET_EXISTS", `Kode aset ${data.code} sudah dipakai.`);
    if (data.acquisitionJournalId) {
      const [j] = await tx.select().from(journals).where(and(eq(journals.id, data.acquisitionJournalId), eq(journals.tenantId, ctx.tenantId))).limit(1);
      if (!j) throw new NotFoundError("Jurnal perolehan tidak ditemukan.");
      if (j.status !== "posted") throw new DomainError("JOURNAL_NOT_POSTED", `Jurnal perolehan ${j.number} belum terposting.`);
    }
    const [row] = await tx
      .insert(fixedAssets)
      .values({
        tenantId: ctx.tenantId,
        code: data.code,
        name: data.name,
        category: data.category,
        acquisitionDate: data.acquisitionDate,
        acquisitionCost: data.acquisitionCost,
        residualValue: data.residualValue,
        usefulLifeMonths: f.life,
        depreciationMethod: data.depreciationMethod ?? (await params.get(tx, "PAR-63", data.acquisitionDate)).method,
        profitCenter: f.pc,
        outletId: data.outletId ?? null,
        truckId: data.truckId ?? null,
        waterSourceId: data.waterSourceId ?? null,
        assetAccountId: f.assetAccountId,
        accumulatedAccountId: f.accumulatedAccountId,
        expenseAccountId: f.expenseAccountId,
        source: data.source,
        notes: data.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    await tx.insert(fixedAssetExtras).values({ fixedAssetId: row!.id, acquisitionJournalId: data.acquisitionJournalId ?? null });
    await auditRecord(tx, { ctx, objectType: "fixed_asset", objectId: row!.id, action: "create", after: { code: row!.code, category: row!.category, cost: row!.acquisitionCost, life: row!.usefulLifeMonths, profitCenter: row!.profitCenter, source: row!.source }, rule: "US-M11-05 KP-4" });
    return row!;
  });
}

// --- Impor template (NFR-34) -----------------------------------------------------------------------------------------

type ImportAssetRow = {
  line: number;
  code: string;
  name: string;
  category: Category;
  acquisitionDate: string;
  acquisitionCost: number;
  residualValue: number;
  usefulLifeMonths: number | null;
  profitCenter: ProfitCenter | null;
  outletId: string | null;
  truckId: string | null;
  openingAccumulated: number;
  errors: string[];
};

const CATEGORY_ALIASES: Record<string, Category> = {
  truk: "truck",
  truck: "truck",
  kendaraan: "truck",
  instalasi: "water_installation",
  "instalasi sumber air": "water_installation",
  "peralatan depot": "depot_equipment",
  depot: "depot_equipment",
  bangunan: "building",
  gedung: "building",
  lainnya: "other",
  lain: "other",
};

const importSchema = z.object({ fileName: z.string().min(1), content: z.union([z.string(), z.instanceof(Buffer)]), commit: z.boolean().default(false) }).strict();

/** Impor daftar aset dari template (akuntan & notaris, K15) → menunggu tanda tangan pemilik (NFR-34). */
export async function importAssets(ctx: ActorContext, input: z.input<typeof importSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.fixed_asset.import", { tx: opts.tx });
  const data = parseInput(importSchema, input);
  const table = await parseTable(data.fileName, data.content);
  return runService(ctx, opts, async (tx) => {
    const outletRows = await tx.select({ id: outlets.id, code: outlets.code }).from(outlets).where(eq(outlets.tenantId, ctx.tenantId));
    const truckRows = await tx.select({ id: trucks.id, code: trucks.code }).from(trucks).where(eq(trucks.tenantId, ctx.tenantId));
    const existing = new Set((await tx.select({ code: fixedAssets.code }).from(fixedAssets).where(eq(fixedAssets.tenantId, ctx.tenantId))).map((r) => r.code));
    const rows: ImportAssetRow[] = table.rows.map((r, i) => {
      const errors: string[] = [];
      const catRaw = pick(r, ["kategori", "category"]).toLowerCase();
      const category = CATEGORY_ALIASES[catRaw] ?? null;
      if (!category) errors.push(`Kategori "${catRaw}" tidak dikenal`);
      const acquisitionDate = parseDateText(pick(r, ["tanggal perolehan", "tanggal", "acquisition date"]));
      if (!acquisitionDate) errors.push("Tanggal perolehan tidak valid");
      const cost = parseAmount(pick(r, ["nilai perolehan", "nilai", "harga perolehan"]));
      if (!cost || cost <= 0) errors.push("Nilai perolehan wajib > 0");
      const life = pick(r, ["umur (bulan)", "umur", "umur ekonomis"]);
      const pcRaw = pick(r, ["pusat laba", "lini"]).toUpperCase();
      const outletCode = pick(r, ["kode outlet", "outlet"]);
      const truckCode = pick(r, ["kode truk", "truk"]);
      const outletId = outletCode ? (outletRows.find((o) => o.code === outletCode)?.id ?? null) : null;
      if (outletCode && !outletId) errors.push(`Outlet ${outletCode} tidak ditemukan`);
      const truckId = truckCode ? (truckRows.find((t) => t.code === truckCode)?.id ?? null) : null;
      if (truckCode && !truckId) errors.push(`Truk ${truckCode} tidak ditemukan`);
      const code = pick(r, ["kode", "kode aset"]);
      if (!code) errors.push("Kode aset kosong");
      if (existing.has(code)) errors.push(`Kode aset ${code} sudah ada`);
      return {
        line: i + 2,
        code,
        name: pick(r, ["nama", "nama aset"]),
        category: (category ?? "other") as Category,
        acquisitionDate: acquisitionDate ?? "",
        acquisitionCost: cost ?? 0,
        residualValue: parseAmount(pick(r, ["nilai sisa", "residu"])) ?? 0,
        usefulLifeMonths: life ? Number(life) : null,
        profitCenter: (["L1", "L2", "L3", "L4", "L5", "SHARED"].includes(pcRaw) ? pcRaw : null) as ProfitCenter | null,
        outletId,
        truckId,
        openingAccumulated: parseAmount(pick(r, ["akumulasi penyusutan", "akumulasi"])) ?? 0,
        errors,
      };
    });
    const errorRows = rows.filter((r) => r.errors.length).length;
    const summary = { rows, errors: errorRows, count: rows.length, totalCost: rows.reduce((s, r) => s + r.acquisitionCost, 0), totalAccumulated: rows.reduce((s, r) => s + r.openingAccumulated, 0), committed: false, signoffId: null as string | null };
    if (!data.commit) return summary;
    if (errorRows) throw new DomainError("IMPORT_ERRORS", `Masih ada ${errorRows} baris bermasalah. Perbaiki berkas lalu impor ulang.`);
    const [signoff] = await tx
      .insert(dataSignoffs)
      .values({
        tenantId: ctx.tenantId,
        group: "fixed_assets",
        title: `Daftar aset tetap (impor ${rows.length} aset)`,
        summary: { count: rows.length, totalCost: summary.totalCost, totalAccumulated: summary.totalAccumulated, file: data.fileName },
        status: "draft",
        createdBy: ctx.userId,
      })
      .returning();
    for (const r of rows) {
      const f = await resolveAssetFields(tx, ctx.tenantId, r, ctxBusinessDate(ctx));
      const [row] = await tx
        .insert(fixedAssets)
        .values({
          tenantId: ctx.tenantId,
          code: r.code,
          name: r.name,
          category: r.category,
          acquisitionDate: r.acquisitionDate,
          acquisitionCost: r.acquisitionCost,
          residualValue: r.residualValue,
          usefulLifeMonths: f.life,
          depreciationMethod: (await params.get(tx, "PAR-63", r.acquisitionDate)).method,
          profitCenter: f.pc,
          outletId: r.outletId,
          truckId: r.truckId,
          assetAccountId: f.assetAccountId,
          accumulatedAccountId: f.accumulatedAccountId,
          expenseAccountId: f.expenseAccountId,
          source: "import",
          signoffId: signoff!.id,
          createdBy: ctx.userId,
        })
        .returning();
      await tx.insert(fixedAssetExtras).values({ fixedAssetId: row!.id, openingAccumulated: r.openingAccumulated });
      await auditRecord(tx, { ctx, objectType: "fixed_asset", objectId: row!.id, action: "import", after: { code: r.code, cost: r.acquisitionCost, openingAccumulated: r.openingAccumulated }, rule: "US-M11-05 KP-1" });
    }
    await notify(tx, {
      event: "asset.signoff_pending",
      tenantId: ctx.tenantId,
      title: `Daftar aset tetap menunggu tanda tangan (${rows.length} aset)`,
      body: `Total nilai perolehan ${formatRupiah(summary.totalCost)}, akumulasi ${formatRupiah(summary.totalAccumulated)}.`,
      objectType: "data_signoff",
      objectId: signoff!.id,
      link: "/akuntansi/aset",
      now: ctx.now,
    });
    return { ...summary, committed: true, signoffId: signoff!.id };
  });
}

const signSchema = z.object({ signoffId: z.uuid(), note: z.string().trim().max(300).nullable().optional() }).strict();

/** Pemilik menandatangani daftar aset impor (NFR-34). Aset baru disusutkan setelah ditandatangani. */
export async function signAssetRegister(ctx: ActorContext, input: z.input<typeof signSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.fixed_asset.sign", { tx: opts.tx });
  const data = parseInput(signSchema, input);
  return runService(ctx, opts, async (tx) => {
    const [s] = await tx.select().from(dataSignoffs).where(and(eq(dataSignoffs.id, data.signoffId), eq(dataSignoffs.tenantId, ctx.tenantId))).for("update").limit(1);
    if (!s || s.group !== "fixed_assets") throw new NotFoundError("Ringkasan daftar aset tidak ditemukan.");
    if (s.status !== "draft") throw new DomainError("ALREADY_SIGNED", "Daftar aset ini sudah ditandatangani.");
    const [row] = await tx.update(dataSignoffs).set({ status: "signed", signedBy: ctx.userId, signedAt: ctx.now, notes: data.note ?? s.notes, updatedAt: new Date() }).where(eq(dataSignoffs.id, s.id)).returning();
    await auditRecord(tx, { ctx, objectType: "data_signoff", objectId: s.id, action: "sign", after: { group: s.group, summary: s.summary }, reason: data.note ?? null, rule: "NFR-34" });
    return row!;
  });
}

// --- Hitung ulang (umur/nilai diubah akuntan) -------------------------------------------------------------------------

const estimateSchema = z
  .object({
    assetId: z.uuid(),
    usefulLifeMonths: z.number().int().min(1).max(600).nullable().optional(),
    residualValue: zRupiahNonNegative.nullable().optional(),
    acquisitionCost: zRupiahPositive.nullable().optional(),
    reason: z.string().trim().min(5, { error: "Alasan (keputusan akuntan) wajib diisi." }),
    /** Wajib bila nilai perolehan aset impor diubah (penyesuaian saldo awal, PTB-44). */
    accountantNote: z.string().trim().min(5, { error: "Catatan akuntan wajib diisi (minimal 5 karakter)." }).nullable().optional(),
    attachmentId: z.uuid().nullable().optional(),
  })
  .strict();

type AssetEstimate = { usefulLifeMonths: number; residualValue: number; acquisitionCost: number; depreciationMethod: AssetRow["depreciationMethod"] };

/**
 * Hitung ulang penyusutan aset dengan parameter baru: selisih akumulasi seharusnya s.d. periode terakhir yang disusutkan
 * dengan yang sudah terposting dibukukan sebagai jurnal penyesuaian berjejak (US-M11-05 KP-2). Memperbarui aset.
 */
async function applyEstimate(tx: Tx, ctx: ActorContext, a: AssetRow, next: AssetEstimate, reason: string): Promise<{ asset: AssetRow; diff: number; journalNumber: string | null }> {
  if (next.residualValue >= next.acquisitionCost) throw new DomainError("RESIDUAL_TOO_HIGH", "Nilai sisa harus lebih kecil dari nilai perolehan.");
  const entries = await tx
    .select({ amount: depreciationEntries.amount, isAdjustment: depreciationEntries.isAdjustment, period: accountingPeriods.period })
    .from(depreciationEntries)
    .innerJoin(accountingPeriods, eq(accountingPeriods.id, depreciationEntries.periodId))
    .where(eq(depreciationEntries.fixedAssetId, a.id))
    .orderBy(asc(accountingPeriods.period));
  const regular = entries.filter((e) => !e.isAdjustment);
  const opening = (await extrasOf(tx, [a.id])).get(a.id)?.openingAccumulated ?? 0;
  const posted = opening + entries.reduce((s, e) => s + e.amount, 0);
  // Akumulasi seharusnya: saldo cut-over + penyusutan bulanan dengan parameter baru untuk jumlah bulan yang sudah disusutkan.
  let expected = opening;
  for (let i = 0; i < regular.length; i++) expected += monthlyDepreciation(next, expected);
  const diff = expected - posted;
  const [updated] = await tx.update(fixedAssets).set({ ...next, updatedAt: new Date() }).where(eq(fixedAssets.id, a.id)).returning();
  let journalNumber: string | null = null;
  if (diff !== 0) {
    const today = ctxBusinessDate(ctx);
    const period = await ensurePeriod(tx, a.tenantId, monthOf(today));
    const acc = await accountsForAsset(tx, updated!, today);
    const dims = { profitCenter: a.profitCenter, outletId: a.outletId, truckId: a.truckId, waterSourceId: a.waterSourceId };
    const { journal } = await insertJournal(tx, {
      tenantId: a.tenantId,
      kind: "depreciation",
      date: today,
      description: `Penyesuaian penyusutan ${a.code} (umur/nilai diubah akuntan): ${reason}`,
      lines:
        diff > 0
          ? [
              { accountId: acc.expense, debit: diff, ...dims },
              { accountId: acc.accumulated, credit: diff, ...dims },
            ]
          : [
              { accountId: acc.accumulated, debit: -diff, ...dims },
              { accountId: acc.expense, credit: -diff, ...dims },
            ],
      ctx,
      sourceType: "m11.asset_adjustment",
      sourceObject: { type: "fixed_asset", id: a.id },
      periodMode: "strict",
    });
    await tx.insert(depreciationEntries).values({ fixedAssetId: a.id, periodId: period.id, amount: diff, accumulatedAfter: expected, bookValueAfter: next.acquisitionCost - expected, journalId: journal.id, isAdjustment: true });
    journalNumber = journal.number;
  }
  return { asset: updated!, diff, journalNumber };
}

/**
 * Ubah umur/nilai aset (keputusan akuntan) → penyusutan dihitung ulang (US-M11-05 KP-2). Nilai perolehan ASET IMPOR
 * adalah saldo awal: perubahannya diajukan sebagai penyesuaian saldo awal (US-M11-09 KP-3, PTB-44 — persetujuan pemilik
 * `opening_balance_adjustment` + catatan akuntan, hanya ≤ PAR-62 bulan setelah cut-over); nilai perolehan & jurnalnya
 * baru berlaku setelah pemilik menyetujui. Lewat batas PAR-62 → koreksi lewat jurnal manual biasa (ambang PAR-20).
 */
export async function updateAssetEstimate(ctx: ActorContext, input: z.input<typeof estimateSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.fixed_asset.update", { tx: opts.tx });
  const data = parseInput(estimateSchema, input, { reason: "Alasan", accountantNote: "Catatan akuntan" });
  return runService(ctx, opts, async (tx) => {
    const [a] = await tx.select().from(fixedAssets).where(and(eq(fixedAssets.id, data.assetId), eq(fixedAssets.tenantId, ctx.tenantId))).for("update").limit(1);
    if (!a) throw new NotFoundError("Aset tidak ditemukan.");
    if (a.status === "disposed") throw new DomainError("ASSET_DISPOSED", "Aset sudah dilepas.");
    const costChange = !!data.acquisitionCost && data.acquisitionCost !== a.acquisitionCost;
    if (costChange && a.source !== "import") {
      throw new DomainError("COST_CHANGE", "Koreksi nilai perolehan aset pembelian dilakukan lewat jurnal manual beralasan; di sini hanya aset impor (nilai akuntan/notaris).");
    }
    const next: AssetEstimate = {
      usefulLifeMonths: data.usefulLifeMonths ?? a.usefulLifeMonths,
      residualValue: data.residualValue ?? a.residualValue,
      acquisitionCost: a.acquisitionCost,
      depreciationMethod: a.depreciationMethod,
    };
    let pendingApprovalId: string | null = null;
    if (costChange) {
      if (!a.assetAccountId) throw new DomainError("ASSET_ACCOUNT", "Akun aset belum diatur untuk aset ini.");
      if (!data.accountantNote) throw new DomainError("ACCOUNTANT_NOTE_REQUIRED", "Perubahan nilai perolehan aset impor adalah penyesuaian saldo awal — isi catatan akuntan (PTB-44).");
      if ((data.residualValue ?? a.residualValue) >= data.acquisitionCost!) throw new DomainError("RESIDUAL_TOO_HIGH", "Nilai sisa harus lebih kecil dari nilai perolehan.");
      pendingApprovalId = await submitAssetCostAdjustment(tx, ctx, a, { acquisitionCost: data.acquisitionCost!, reason: data.reason, accountantNote: data.accountantNote, attachmentId: data.attachmentId ?? null });
    }
    const changed = next.usefulLifeMonths !== a.usefulLifeMonths || next.residualValue !== a.residualValue;
    const res = changed ? await applyEstimate(tx, ctx, a, next, data.reason) : { asset: a, diff: 0, journalNumber: null };
    await auditRecord(tx, {
      ctx,
      objectType: "fixed_asset",
      objectId: a.id,
      action: "update",
      before: { usefulLifeMonths: a.usefulLifeMonths, residualValue: a.residualValue, acquisitionCost: a.acquisitionCost },
      after: { ...next, adjustment: res.diff, journal: res.journalNumber, acquisitionCostPending: costChange ? data.acquisitionCost : null, approvalId: pendingApprovalId },
      reason: data.reason,
      rule: costChange ? "US-M11-05 KP-2, US-M11-09 KP-3, PTB-44" : "US-M11-05 KP-2",
    });
    return { asset: res.asset, adjustment: res.diff, journalNumber: res.journalNumber, pendingApprovalId };
  });
}

/** Ajukan penyesuaian saldo awal atas nilai perolehan aset impor (jurnal Diajukan + persetujuan pemilik + catatan akuntan). */
async function submitAssetCostAdjustment(
  tx: Tx,
  ctx: ActorContext,
  a: AssetRow,
  input: { acquisitionCost: number; reason: string; accountantNote: string; attachmentId: string | null },
): Promise<string> {
  const today = ctxBusinessDate(ctx);
  const cutover = await currentCutover(tx, today);
  if (!cutover) throw new DomainError("CUTOVER_REQUIRED", "Tanggal cut-over akuntansi belum ditetapkan pemilik — nilai perolehan aset impor belum dapat disesuaikan.");
  const { max_months_after_cutover } = await params.get(tx, "PAR-62", today);
  const deadline = addDaysDate(`${shiftPeriod(monthOf(cutover), max_months_after_cutover)}-01`, -1);
  if (today > deadline) {
    throw new DomainError(
      "ADJUSTMENT_WINDOW_CLOSED",
      `Penyesuaian saldo awal hanya sampai ${deadline} (${max_months_after_cutover} bulan setelah cut-over, PTB-44). Catat koreksi nilai perolehan sebagai jurnal manual biasa (dengan lampiran; di atas ambang perlu persetujuan pemilik).`,
    );
  }
  const open = await tx
    .select({ id: journals.id })
    .from(journals)
    .where(and(eq(journals.tenantId, a.tenantId), eq(journals.kind, "opening_adjustment"), eq(journals.status, "submitted"), eq(journals.sourceObjectType, "fixed_asset"), eq(journals.sourceObjectId, a.id)))
    .limit(1);
  if (open[0]) throw new DomainError("ADJUSTMENT_PENDING", "Penyesuaian nilai perolehan aset ini masih menunggu keputusan pemilik.");
  const eq0 = await mappingAccounts(tx, a.tenantId, "m11.opening_balance", "equity_balancing", today);
  const delta = input.acquisitionCost - a.acquisitionCost;
  const { journal } = await insertJournal(tx, {
    tenantId: a.tenantId,
    kind: "opening_adjustment",
    status: "submitted",
    date: today,
    description: `Penyesuaian saldo awal — nilai perolehan ${a.code} ${a.name}: ${input.reason}`,
    lines: [
      { accountId: a.assetAccountId!, profitCenter: a.profitCenter, outletId: a.outletId, ...(delta > 0 ? { debit: delta, credit: 0 } : { debit: 0, credit: -delta }) },
      { accountId: eq0.debitAccountId, profitCenter: "SHARED", ...(delta > 0 ? { debit: 0, credit: delta } : { debit: -delta, credit: 0 }) },
    ],
    ctx,
    attachmentId: input.attachmentId,
    sourceType: "m11.opening_balance",
    sourceObject: { type: "fixed_asset", id: a.id },
  });
  if (input.attachmentId) await linkAttachment(tx, input.attachmentId, { type: "journal", id: journal.id });
  await tx.insert(manualJournalDetails).values({ tenantId: a.tenantId, journalId: journal.id, accountantNote: input.accountantNote });
  const req = await approvals.submit(
    ctx,
    {
      type: "opening_balance_adjustment",
      objectType: "opening_adjustment_journal",
      objectId: journal.id,
      amount: journal.totalDebit,
      reason: `${journal.number}: nilai perolehan ${a.code} ${formatRupiah(a.acquisitionCost)} → ${formatRupiah(input.acquisitionCost)}. ${input.reason}. Catatan akuntan: ${input.accountantNote}`,
      payload: { number: journal.number, link: `/akuntansi/aset/${a.id}`, assetCost: { assetId: a.id, acquisitionCost: input.acquisitionCost, reason: input.reason } },
    },
    { tx },
  );
  await tx.update(journals).set({ approvalRequestId: req.id, updatedAt: new Date() }).where(eq(journals.id, journal.id));
  return req.id;
}

/**
 * Penyesuaian nilai perolehan aset impor disetujui pemilik (dipanggil handler `opening_balance_adjustment` setelah
 * jurnalnya terposting): nilai perolehan aset diperbarui + penyusutan dihitung ulang (NFR-34: daftar aset perlu
 * ditandatangani ulang — ringkasan tanda tangan kembali Draf).
 */
export async function applyApprovedAssetCost(tx: Tx, ctx: ActorContext, info: { assetId: string; acquisitionCost: number; reason: string }): Promise<{ adjustment: number }> {
  const [a] = await tx.select().from(fixedAssets).where(eq(fixedAssets.id, info.assetId)).for("update").limit(1);
  if (!a || a.status === "disposed") return { adjustment: 0 };
  const res = await applyEstimate(tx, ctx, a, { usefulLifeMonths: a.usefulLifeMonths, residualValue: a.residualValue, acquisitionCost: info.acquisitionCost, depreciationMethod: a.depreciationMethod }, info.reason);
  const reopened = await tx
    .update(dataSignoffs)
    .set({ status: "draft", signedBy: null, signedAt: null, notes: `Nilai perolehan ${a.code} disesuaikan setelah tanda tangan — tanda tangani ulang (NFR-34).`, updatedAt: new Date() })
    .where(and(eq(dataSignoffs.tenantId, a.tenantId), eq(dataSignoffs.group, "fixed_assets"), eq(dataSignoffs.status, "signed")))
    .returning({ id: dataSignoffs.id });
  await auditRecord(tx, {
    ctx,
    objectType: "fixed_asset",
    objectId: a.id,
    action: "update",
    before: { acquisitionCost: a.acquisitionCost },
    after: { acquisitionCost: info.acquisitionCost, adjustment: res.diff, journal: res.journalNumber, signoffReopened: reopened.length },
    reason: info.reason,
    rule: "US-M11-09 KP-3, PTB-44, NFR-34",
  });
  return { adjustment: res.diff };
}

// --- Pelepasan (US-M11-05 KP-4) --------------------------------------------------------------------------------------

const disposeSchema = z
  .object({
    assetId: z.uuid(),
    date: dateSchema,
    proceeds: zRupiahNonNegative.default(0),
    proceedsAccountId: z.uuid().nullable().optional(),
    reason: z.string().trim().min(5, { error: "Alasan pelepasan wajib diisi." }),
    /** Bukti pelepasan (bukti jual / berita acara) — wajib (BR-35). */
    attachmentId: z.uuid({ error: "Lampirkan bukti pelepasan (bukti jual atau berita acara)." }),
  })
  .strict();

/**
 * Lepas/jual aset (US-M11-05 KP-4, BR-35): jurnal pelepasan dibuat sebagai JURNAL MANUAL berlampiran lalu diajukan —
 * di atas PAR-20 menunggu persetujuan pemilik (`manual_journal`), di bawahnya terposting dan masuk daftar tinjauan
 * pemilik. Aset ditandai "Dilepas" saat jurnal terposting. Akun penerimaan hanya akun kas/bank/piutang.
 */
export async function disposeAsset(ctx: ActorContext, input: z.input<typeof disposeSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m11.fixed_asset.dispose", { tx: opts.tx });
  const data = parseInput(disposeSchema, input, { reason: "Alasan", proceeds: "Hasil penjualan", attachmentId: "Bukti pelepasan" });
  return runService(ctx, opts, async (tx) => {
    const [a] = await tx.select().from(fixedAssets).where(and(eq(fixedAssets.id, data.assetId), eq(fixedAssets.tenantId, ctx.tenantId))).for("update").limit(1);
    if (!a) throw new NotFoundError("Aset tidak ditemukan.");
    if (a.status === "disposed") throw new DomainError("ASSET_DISPOSED", "Aset sudah dilepas.");
    if (!a.assetAccountId) throw new DomainError("ASSET_ACCOUNT", "Akun aset belum diatur untuk aset ini.");
    if (data.proceeds > 0 && !data.proceedsAccountId) throw new DomainError("PROCEEDS_ACCOUNT", "Pilih akun penerimaan hasil penjualan (kas/bank/piutang).");
    if (data.proceeds > 0) {
      const [pa] = await tx.select().from(accounts).where(and(eq(accounts.id, data.proceedsAccountId!), eq(accounts.tenantId, ctx.tenantId))).limit(1);
      if (!pa || pa.type !== "asset" || !(pa.isCash || pa.code.startsWith("1-14"))) {
        throw new DomainError("PROCEEDS_ACCOUNT", "Akun penerimaan hasil penjualan harus akun kas, bank, atau piutang.");
      }
    }
    const pending = await tx
      .select({ id: manualJournalDetails.id })
      .from(manualJournalDetails)
      .innerJoin(journals, eq(journals.id, manualJournalDetails.journalId))
      .where(and(eq(journals.tenantId, ctx.tenantId), inArray(journals.status, ["draft", "submitted"]), sql`${manualJournalDetails.assetDisposal}->>'assetId' = ${a.id}`))
      .limit(1);
    if (pending[0]) throw new DomainError("DISPOSAL_PENDING", "Pelepasan aset ini sudah diajukan dan menunggu keputusan pemilik.");
    const accumulated = (await accumulatedUpTo(tx, [a.id], null)).get(a.id) ?? 0;
    const bookValue = a.acquisitionCost - accumulated;
    const gainLoss = data.proceeds - bookValue;
    const acc = await accountsForAsset(tx, a, data.date);
    const gl = await mappingAccounts(tx, ctx.tenantId, "m11.asset_disposal", "gain_loss", data.date);
    const dims = { profitCenter: a.profitCenter, outletId: a.outletId, truckId: a.truckId, waterSourceId: a.waterSourceId };
    const lines: PostedLineInput[] = [{ accountId: a.assetAccountId, credit: a.acquisitionCost, ...dims }];
    if (accumulated > 0) lines.push({ accountId: acc.accumulated, debit: accumulated, ...dims });
    if (data.proceeds > 0) lines.push({ accountId: data.proceedsAccountId!, debit: data.proceeds, ...dims, profitCenter: "SHARED", outletId: null });
    if (gainLoss > 0) lines.push({ accountId: gl.creditAccountId, credit: gainLoss, ...dims });
    if (gainLoss < 0) lines.push({ accountId: gl.debitAccountId, debit: -gainLoss, ...dims });
    const { journal } = await insertJournal(tx, {
      tenantId: ctx.tenantId,
      kind: "manual",
      status: "draft",
      date: data.date,
      description: `Pelepasan aset ${a.code} ${a.name}: ${data.reason}`,
      lines,
      ctx,
      attachmentId: data.attachmentId,
      sourceType: "m11.asset_disposal",
      sourceObject: { type: "fixed_asset", id: a.id },
    });
    await linkAttachment(tx, data.attachmentId, { type: "journal", id: journal.id });
    await tx.insert(manualJournalDetails).values({ tenantId: ctx.tenantId, journalId: journal.id, assetDisposal: { assetId: a.id, date: data.date, proceeds: data.proceeds, gainLoss, bookValue } });
    await auditRecord(tx, { ctx, objectType: "fixed_asset", objectId: a.id, action: "request_dispose", before: { status: a.status, bookValue }, after: { proceeds: data.proceeds, gainLoss, journal: journal.number }, reason: data.reason, rule: "US-M11-05 KP-4, BR-35" });
    const submitted = await submitDraftJournal(tx, ctx, journal.id);
    const [row] = await tx.select().from(fixedAssets).where(eq(fixedAssets.id, a.id)).limit(1);
    return {
      asset: row!,
      journal: submitted.journal,
      status: submitted.status,
      approvalId: submitted.status === "submitted" ? submitted.approvalId : null,
      gainLoss,
      bookValue,
    };
  });
}

/** Aset aktif yang penyusutannya belum terposting pada periode (prasyarat tutup periode). */
export async function depreciationPending(tx: Tx, tenantId: string, period: string): Promise<number> {
  return (await depreciationPlan(tx, tenantId, period)).length;
}

/** Nilai buku aset per akun aset (prefill saldo awal kelompok aset tetap). */
export async function importedAssetsForOpening(tx: Tx, tenantId: string) {
  const assets = await tx.select().from(fixedAssets).where(and(eq(fixedAssets.tenantId, tenantId), eq(fixedAssets.source, "import")));
  const extras = await extrasOf(
    tx,
    assets.map((a) => a.id),
  );
  return assets.map((a) => ({ asset: a, openingAccumulated: extras.get(a.id)?.openingAccumulated ?? 0 }));
}
