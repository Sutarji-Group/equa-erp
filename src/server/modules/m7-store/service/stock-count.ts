/**
 * M7 — opname toko bulanan & stok awal cut-over (US-M7-05, US-M7-02 KP-5; BR-27, PAR-32, NFR-34).
 *
 * - Kasir menghitung di POS (perintah `m7.stock_count.count`, dapat bertahap per barang): lembar hitung TANPA saldo
 *   sistem — saldo tampil setelah jumlah fisik dimasukkan (hitung buta). Saldo sistem = saldo PADA WAKTU hitung per
 *   barang (penjualan tetap boleh selama opname, KP-3). Selisih jumlah & nilai (harga pokok rata-rata).
 * - Admin Keuangan (kantor) memeriksa lembar bersama kasir, melengkapi alasan (rusak/hilang/salah catat/lainnya) lalu
 *   mengajukan penyesuaian → persetujuan pemilik `stock_adjustment` (handler kerangka POS M6: kartu stok
 *   "Penyesuaian opname" + `stock.adjusted` → M11 beban selisih stok L4).
 * - Opname bulan lalu yang belum diajukan sampai `m7.store_rules.stock_count_deadline_day` → ditandai ke pemilik (job).
 * - Stok awal cut-over: Admin Keuangan mencatat hasil opname fisik + harga beli terakhir → pemilik menandatangani
 *   (data_signoffs "Stok toko & bahan depot") → kartu stok "Stok awal".
 */
import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { dataSignoffs, employees, notifications, outlets, products, stockBalances, stockCountLines, stockCounts, stockLedger, users } from "@/db/schema";
import { enumValues, label } from "@/lib/labels";
import { formatRupiah, zRupiahNonNegative } from "@/lib/money";
import { toWibParts } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import { getDb } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { inJobTx } from "@/server/core/jobs";
import { notify } from "@/server/core/notifications";
import { authorize, authorizeAny, runService, sod } from "@/server/core/rbac";
import { postStockMovement, type FieldWriteMeta } from "@/server/modules/m6-pos";

import { balanceAt, loadProductsById, loadStoreOutlet, monthLabel, previousMonthLabel, resolveOfficeStore, resolveStorePosOutlet, storeOutletsOf, storeRules } from "./common";

type StockCountRow = typeof stockCounts.$inferSelect;
type StockCountLineRow = typeof stockCountLines.$inferSelect;

// =====================================================================================================================
// Hitung (POS kasir)
// =====================================================================================================================

export const storeCountSchema = z
  .object({
    stockCountId: z.uuid(),
    lines: z
      .array(
        z
          .object({
            productId: z.uuid(),
            physicalQty: z.number().int().min(0).max(1_000_000),
            /** Waktu barang ini dihitung di perangkat (bawaan waktu perintah). */
            countedAt: z.iso.datetime({ offset: true }).nullable().optional(),
            reason: z.enum(enumValues("stock_adjust_reason")).nullable().optional(),
            reasonNote: z.string().trim().max(300).nullable().optional(),
          })
          .strict(),
      )
      .min(1, { error: "Isi hitungan minimal satu barang." })
      .max(300),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export type CountedLine = { productId: string; physicalQty: number; systemQty: number; differenceQty: number; unitCost: number; differenceValue: number };

export async function recordStoreCount(
  ctx: ActorContext,
  input: z.output<typeof storeCountSchema>,
  meta: FieldWriteMeta,
): Promise<{ stockCount: StockCountRow; lines: CountedLine[]; lockedProductIds: string[] }> {
  const { tx } = meta;
  await authorize(ctx, "m7.stock_count.create", { tx, objectType: "stock_count", objectId: input.stockCountId });
  const outlet = await resolveStorePosOutlet(tx, ctx, meta.device);
  const period = monthLabel(meta.businessDate);
  let [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, input.stockCountId)).for("update").limit(1);
  if (count) {
    if (count.tenantId !== outlet.tenantId || count.outletId !== outlet.id) throw new NotFoundError("Opname tidak ditemukan untuk toko ini.");
    if (count.status !== "counting") throw new DomainError("COUNT_CLOSED", "Opname ini sudah diajukan/diputuskan; hitungan tidak dapat diubah.");
  } else {
    const [running] = await tx
      .select()
      .from(stockCounts)
      .where(and(eq(stockCounts.outletId, outlet.id), eq(stockCounts.periodLabel, period), eq(stockCounts.kind, "monthly_store"), inArray(stockCounts.status, ["counting", "submitted"])))
      .limit(1);
    if (running) throw new DomainError("COUNT_RUNNING", `Opname ${period} toko ini sudah berjalan (status ${label("stock_count_status", running.status).toLowerCase()}). Lanjutkan lembar yang ada.`);
    [count] = await tx
      .insert(stockCounts)
      .values({
        id: input.stockCountId,
        tenantId: outlet.tenantId,
        outletId: outlet.id,
        kind: "monthly_store",
        periodLabel: period,
        status: "counting",
        startedAt: meta.deviceTime,
        countedBy: ctx.userId,
        notes: input.notes ?? null,
        createdBy: ctx.userId,
        ...meta.fieldValues,
      })
      .returning();
  }
  const byId = await loadProductsById(
    tx,
    input.lines.map((l) => l.productId),
  );
  const out: CountedLine[] = [];
  // US-M7-05 KP-1 (hitung buta): baris yang SUDAH dihitung terkunci — kasir tidak dapat "menyamakan angka" setelah
  // saldo sistem terlihat; hitung ulang hanya lewat Admin Keuangan (`recountStoreLine`, jejak nilai awal).
  const existingLines = await tx.select().from(stockCountLines).where(eq(stockCountLines.stockCountId, count!.id));
  const existingBy = new Map(existingLines.map((l) => [l.productId, l]));
  const lockedProductIds: string[] = [];
  for (const l of input.lines) {
    const p = byId.get(l.productId);
    if (!p || p.tenantId !== outlet.tenantId || p.line !== "store") throw new NotFoundError("Barang toko tidak ditemukan.");
    const prior = existingBy.get(p.id);
    if (prior) {
      if (prior.physicalQty !== l.physicalQty) lockedProductIds.push(p.id);
      out.push({ productId: p.id, physicalQty: prior.physicalQty, systemQty: prior.systemQtyAtCount, differenceQty: prior.differenceQty, unitCost: prior.unitCost ?? 0, differenceValue: prior.differenceValue ?? 0 });
      continue;
    }
    const at = l.countedAt ? new Date(l.countedAt) : meta.deviceTime;
    const sys = await balanceAt(tx, outlet.id, p.id, at);
    const diff = l.physicalQty - sys.quantity;
    const value = diff * sys.avgCost;
    const values = {
      physicalQty: l.physicalQty,
      systemQtyAtCount: sys.quantity,
      countedAt: at,
      differenceQty: diff,
      unitCost: sys.avgCost,
      differenceValue: value,
      reason: diff === 0 ? null : (l.reason ?? null),
      reasonNote: diff === 0 ? null : (l.reasonNote ?? null),
    };
    await tx
      .insert(stockCountLines)
      .values({ tenantId: outlet.tenantId, stockCountId: count!.id, productId: p.id, ...values })
      .onConflictDoNothing({ target: [stockCountLines.stockCountId, stockCountLines.productId] });
    out.push({ productId: p.id, physicalQty: l.physicalQty, systemQty: sys.quantity, differenceQty: diff, unitCost: sys.avgCost, differenceValue: value });
  }
  await auditRecord(tx, {
    ctx,
    objectType: "stock_count",
    objectId: count!.id,
    action: "count",
    after: { periodLabel: count!.periodLabel, lines: out.map((l) => ({ productId: l.productId, physical: l.physicalQty, system: l.systemQty, diff: l.differenceQty })), lockedProductIds },
    reason: lockedProductIds.length ? "Hitung ulang dari POS diabaikan (baris terkunci; hitung ulang lewat Admin Keuangan)." : null,
    businessDate: meta.businessDate,
  });
  return { stockCount: count!, lines: out, lockedProductIds };
}

export const recountStoreLineSchema = z
  .object({
    stockCountId: z.uuid(),
    productId: z.uuid(),
    physicalQty: z.number().int().min(0).max(1_000_000),
    reason: z.string().trim().min(5, { error: "Tulis alasan hitung ulang (minimal 5 karakter)." }).max(300),
  })
  .strict();

/**
 * Hitung ulang satu barang oleh Admin Keuangan (US-M7-05 KP-1 hitung buta): hanya selama opname "Menghitung"; nilai
 * awal kasir tersimpan di jejak audit; saldo sistem dihitung ulang pada waktu hitung ulang.
 */
export async function recountStoreLine(ctx: ActorContext, input: z.input<typeof recountStoreLineSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.stock_adjustment.request", { tx: opts.tx, objectType: "stock_count", objectId: input.stockCountId });
  const data = parseInput(recountStoreLineSchema, input, { physicalQty: "Jumlah fisik", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, data.stockCountId)).for("update").limit(1);
    if (!count || count.tenantId !== ctx.tenantId) throw new NotFoundError("Opname tidak ditemukan.");
    await loadStoreOutlet(tx, ctx, count.outletId);
    if (count.status !== "counting") throw new DomainError("COUNT_CLOSED", "Opname ini sudah diajukan/diputuskan; hitungan tidak dapat diubah.");
    const [line] = await tx.select().from(stockCountLines).where(and(eq(stockCountLines.stockCountId, count.id), eq(stockCountLines.productId, data.productId))).limit(1);
    if (!line) throw new NotFoundError("Barang belum dihitung kasir pada opname ini.");
    const sys = await balanceAt(tx, count.outletId, data.productId, ctx.now);
    const diff = data.physicalQty - sys.quantity;
    const [after] = await tx
      .update(stockCountLines)
      .set({ physicalQty: data.physicalQty, systemQtyAtCount: sys.quantity, countedAt: ctx.now, differenceQty: diff, unitCost: sys.avgCost, differenceValue: diff * sys.avgCost, updatedAt: new Date() })
      .where(eq(stockCountLines.id, line.id))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "stock_count",
      objectId: count.id,
      action: "recount",
      before: { productId: line.productId, physicalQty: line.physicalQty, systemQty: line.systemQtyAtCount, countedAt: line.countedAt },
      after: { productId: line.productId, physicalQty: data.physicalQty, systemQty: sys.quantity },
      reason: data.reason,
      rule: "US-M7-05 KP-1",
    });
    return after!;
  });
}

// =====================================================================================================================
// Ajukan penyesuaian (Admin Keuangan bersama kasir) → persetujuan pemilik
// =====================================================================================================================

export const submitStoreCountSchema = z
  .object({
    stockCountId: z.uuid(),
    reasons: z
      .array(
        z
          .object({
            productId: z.uuid(),
            reason: z.enum(enumValues("stock_adjust_reason")),
            reasonNote: z.string().trim().max(300).nullable().optional(),
          })
          .strict(),
      )
      .max(300)
      .optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export async function submitStoreStockCount(ctx: ActorContext, input: z.input<typeof submitStoreCountSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.stock_adjustment.request", { tx: opts.tx, objectType: "stock_count", objectId: input.stockCountId });
  const data = parseInput(submitStoreCountSchema, input, { reasons: "Alasan selisih" });
  return runService(ctx, opts, async (tx) => {
    const [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, data.stockCountId)).for("update").limit(1);
    if (!count || count.tenantId !== ctx.tenantId) throw new NotFoundError("Opname tidak ditemukan.");
    const outlet = await loadStoreOutlet(tx, ctx, count.outletId);
    if (count.kind !== "monthly_store") throw new DomainError("NOT_MONTHLY_COUNT", "Hanya opname bulanan toko yang diajukan dari sini.");
    if (count.status !== "counting") throw new DomainError("COUNT_CLOSED", "Opname ini sudah diajukan/diputuskan.");
    // Opname dilakukan kasir BERSAMA Admin Keuangan: pengaju (pemeriksa) ≠ penghitung.
    sod.assertNotSelf(count.countedBy, ctx.userId, "opname", { objectType: "stock_count", objectId: count.id });
    for (const r of data.reasons ?? []) {
      await tx
        .update(stockCountLines)
        .set({ reason: r.reason, reasonNote: r.reasonNote ?? null, updatedAt: new Date() })
        .where(and(eq(stockCountLines.stockCountId, count.id), eq(stockCountLines.productId, r.productId)));
    }
    const lines = await tx.select().from(stockCountLines).where(eq(stockCountLines.stockCountId, count.id));
    if (!lines.length) throw new DomainError("COUNT_EMPTY", "Lembar hitung masih kosong.");
    // US-M7-05 KP-1 / BR-27: opname mencakup SELURUH barang toko aktif yang bersaldo — opname sebagian tidak dapat
    // diajukan (tetap "Menghitung" dan tetap ditandai belum dilakukan).
    const counted = new Set(lines.map((l) => l.productId));
    const stocked = await tx
      .select({ id: products.id, name: products.name })
      .from(products)
      .innerJoin(stockBalances, and(eq(stockBalances.productId, products.id), eq(stockBalances.outletId, count.outletId)))
      .where(and(eq(products.tenantId, count.tenantId), eq(products.line, "store"), eq(products.status, "active"), sql`${stockBalances.quantity} <> 0`));
    const missing = stocked.filter((p) => !counted.has(p.id));
    if (missing.length) {
      throw new DomainError(
        "COUNT_INCOMPLETE",
        `Opname belum lengkap: ${missing.length} barang bersaldo belum dihitung (${missing.slice(0, 5).map((p) => p.name).join(", ")}${missing.length > 5 ? ", …" : ""}). Minta kasir menghitung seluruh barang dulu.`,
      );
    }
    const byId = await loadProductsById(
      tx,
      lines.map((l) => l.productId),
    );
    const diffs = lines.filter((l) => l.differenceQty !== 0);
    for (const l of diffs) {
      const name = byId.get(l.productId)?.name ?? "Barang";
      if (!l.reason) throw new DomainError("ADJUST_REASON_REQUIRED", `${name}: selisih ${l.differenceQty} — pilih alasan (rusak, hilang, salah catat, lainnya).`);
      if (l.reason === "other" && (l.reasonNote?.trim().length ?? 0) < 3) throw new DomainError("ADJUST_REASON_REQUIRED", `${name}: alasan "Lainnya" wajib diisi keterangannya.`);
    }
    const totalValue = diffs.reduce((s, l) => s + (l.differenceValue ?? 0), 0);
    const [updated] = await tx
      .update(stockCounts)
      .set({
        coCounterUserId: ctx.userId,
        submittedAt: ctx.now,
        status: diffs.length ? "submitted" : "approved",
        decidedAt: diffs.length ? null : ctx.now,
        notes: data.notes ?? count.notes,
        updatedAt: new Date(),
      })
      .where(eq(stockCounts.id, count.id))
      .returning();
    let approval = null;
    if (diffs.length) {
      approval = await approvals.submit(
        ctx,
        {
          type: "stock_adjustment",
          objectType: "stock_count",
          objectId: count.id,
          amount: Math.abs(totalValue),
          reason: `Opname ${outlet.name} ${count.periodLabel}: ${diffs.length} barang selisih (${formatRupiah(totalValue)}). ${diffs
            .map((l) => `${byId.get(l.productId)?.name ?? "Barang"} ${l.differenceQty > 0 ? "+" : ""}${l.differenceQty} (${label("stock_adjust_reason", l.reason!)}${l.reasonNote ? `: ${l.reasonNote}` : ""})`)
            .join("; ")}`.slice(0, 1000),
          payload: { outletId: outlet.id, outletName: outlet.name, periodLabel: count.periodLabel, lines: diffs.map((l) => ({ productId: l.productId, diff: l.differenceQty, value: l.differenceValue })), link: `/toko/opname/${count.id}` },
        },
        { tx },
      );
      await tx.update(stockCounts).set({ approvalRequestId: approval.id, dueAt: approval.deadlineAt }).where(eq(stockCounts.id, count.id));
    }
    await auditRecord(tx, {
      ctx,
      objectType: "stock_count",
      objectId: count.id,
      action: "submit",
      before: { status: "counting" },
      after: { status: updated!.status, differences: diffs.length, totalValue, coCounter: ctx.userId },
      reason: data.notes ?? null,
      rule: "BR-27",
    });
    return { stockCount: { ...updated!, approvalRequestId: approval?.id ?? null }, approval, differences: diffs.length, totalValue };
  });
}

// =====================================================================================================================
// Stok awal cut-over (US-M7-02 KP-5)
// =====================================================================================================================

export const openingStockSchema = z
  .object({
    outletId: z.uuid().nullable().optional(),
    lines: z
      .array(z.object({ productId: z.uuid(), quantity: z.number().int().min(0).max(1_000_000), unitCost: zRupiahNonNegative }).strict())
      .min(1, { error: "Isi minimal satu barang." })
      .max(500),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

/** Admin Keuangan mencatat hasil opname fisik cut-over + harga beli terakhir → draf tanda tangan pemilik. */
export async function prepareOpeningStock(ctx: ActorContext, input: z.input<typeof openingStockSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.stock_count.create", { tx: opts.tx, objectType: "stock_count" });
  const data = parseInput(openingStockSchema, input, { lines: "Barang", unitCost: "Harga beli terakhir" });
  return runService(ctx, opts, async (tx) => {
    const outlet = await resolveOfficeStore(tx, ctx, data.outletId ?? null);
    if (!outlet) throw new DomainError("STORE_REQUIRED", "Belum ada toko aktif.");
    const ids = data.lines.map((l) => l.productId);
    if (new Set(ids).size !== ids.length) throw new DomainError("DUPLICATE_LINES", "Setiap barang cukup satu baris.");
    const byId = await loadProductsById(tx, ids);
    for (const id of ids) {
      const p = byId.get(id);
      if (!p || p.tenantId !== outlet.tenantId || p.line !== "store") throw new NotFoundError("Barang toko tidak ditemukan.");
    }
    const moved = await tx
      .selectDistinct({ productId: stockLedger.productId })
      .from(stockLedger)
      .where(and(eq(stockLedger.outletId, outlet.id), inArray(stockLedger.productId, ids)));
    if (moved.length) {
      throw new DomainError("OPENING_ALREADY", `Stok awal hanya untuk barang yang belum punya kartu stok: ${moved.map((m) => byId.get(m.productId)?.name).join(", ")}.`);
    }
    const [pending] = await tx
      .select({ id: stockCounts.id })
      .from(stockCounts)
      .where(and(eq(stockCounts.outletId, outlet.id), eq(stockCounts.kind, "cutover"), eq(stockCounts.status, "counting")))
      .limit(1);
    if (pending) throw new DomainError("OPENING_PENDING", "Masih ada stok awal yang menunggu tanda tangan pemilik untuk toko ini.");
    const [count] = await tx
      .insert(stockCounts)
      .values({
        tenantId: outlet.tenantId,
        outletId: outlet.id,
        kind: "cutover",
        periodLabel: `cutover-${ctxBusinessDate(ctx)}`,
        status: "counting",
        startedAt: ctx.now,
        countedBy: ctx.userId,
        notes: data.notes ?? null,
        recordedByOffice: true,
        officeRecordReason: "Stok awal cut-over dari opname fisik (NFR-34)",
        createdBy: ctx.userId,
      })
      .returning();
    await tx.insert(stockCountLines).values(
      data.lines.map((l) => ({
        tenantId: outlet.tenantId,
        stockCountId: count!.id,
        productId: l.productId,
        physicalQty: l.quantity,
        systemQtyAtCount: 0,
        countedAt: ctx.now,
        differenceQty: l.quantity,
        unitCost: l.unitCost,
        differenceValue: l.quantity * l.unitCost,
      })),
    );
    const totalValue = data.lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);
    const [signoff] = await tx
      .insert(dataSignoffs)
      .values({
        tenantId: outlet.tenantId,
        group: "stock_opening",
        title: `Stok awal ${outlet.name}`,
        summary: { stockCountId: count!.id, outletId: outlet.id, outletName: outlet.name, products: data.lines.length, totalQuantity: data.lines.reduce((s, l) => s + l.quantity, 0), totalValue },
        status: "draft",
        notes: data.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    await notify(tx, {
      event: "initial_data.signoff_pending",
      tenantId: outlet.tenantId,
      title: `Stok awal ${outlet.name} menunggu tanda tangan`,
      body: `${data.lines.length} barang, nilai ${formatRupiah(totalValue)} (harga beli terakhir). Tinjau & tanda tangani di Opname toko.`,
      objectType: "stock_count",
      objectId: count!.id,
      valueAmount: totalValue,
      link: `/toko/opname/${count!.id}`,
      now: ctx.now,
    });
    await auditRecord(tx, { ctx, objectType: "stock_count", objectId: count!.id, action: "prepare_opening", after: { lines: data.lines, totalValue, signoffId: signoff!.id }, rule: "NFR-34" });
    return { stockCount: count!, signoff: signoff!, totalValue };
  });
}

async function signoffFor(tx: Tx, tenantId: string, stockCountId: string) {
  const rows = await tx
    .select()
    .from(dataSignoffs)
    .where(and(eq(dataSignoffs.tenantId, tenantId), eq(dataSignoffs.group, "stock_opening"), sql`${dataSignoffs.summary}->>'stockCountId' = ${stockCountId}`))
    .orderBy(desc(dataSignoffs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Pemilik menandatangani stok awal → kartu stok "Stok awal" dengan harga beli terakhir sebagai harga pokok awal. */
export async function signOpeningStock(ctx: ActorContext, input: { stockCountId: string; note?: string | null }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m1.data_signoff.sign", { tx: opts.tx, objectType: "stock_count", objectId: input.stockCountId });
  const data = parseInput(z.object({ stockCountId: z.uuid(), note: z.string().trim().max(500).nullable().optional() }), input);
  return runService(ctx, opts, async (tx) => {
    const [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, data.stockCountId)).for("update").limit(1);
    if (!count || count.tenantId !== ctx.tenantId || count.kind !== "cutover") throw new NotFoundError("Stok awal tidak ditemukan.");
    if (count.status !== "counting") throw new DomainError("ALREADY_SIGNED", "Stok awal ini sudah ditandatangani.");
    sod.assertNotSelf(count.countedBy, ctx.userId, "stok awal", { objectType: "stock_count", objectId: count.id });
    const signoff = await signoffFor(tx, count.tenantId, count.id);
    const lines = await tx.select().from(stockCountLines).where(eq(stockCountLines.stockCountId, count.id));
    const today = ctxBusinessDate(ctx);
    for (const l of lines) {
      if (l.physicalQty <= 0) continue;
      await postStockMovement(tx, {
        tenantId: count.tenantId,
        outletId: count.outletId,
        productId: l.productId,
        kind: "opening",
        quantity: l.physicalQty,
        unitCost: l.unitCost ?? 0,
        businessDate: today,
        occurredAt: ctx.now,
        source: { type: "stock_count", id: count.id },
        createdBy: ctx.userId,
        note: "Stok awal cut-over (opname bertanda tangan)",
      });
    }
    await tx.update(stockCounts).set({ status: "approved", decidedAt: ctx.now, adjustmentPostedAt: ctx.now, updatedAt: new Date() }).where(eq(stockCounts.id, count.id));
    if (signoff) await tx.update(dataSignoffs).set({ status: "signed", signedBy: ctx.userId, signedAt: ctx.now, notes: data.note ?? signoff.notes }).where(eq(dataSignoffs.id, signoff.id));
    await auditRecord(tx, { ctx, objectType: "stock_count", objectId: count.id, action: "sign_opening", after: { status: "approved", lines: lines.length, signoffId: signoff?.id ?? null }, reason: data.note ?? null, rule: "NFR-34" });
    return { stockCountId: count.id, lines: lines.length };
  });
}

// =====================================================================================================================
// Tampilan & riwayat (US-M7-05 KP-5)
// =====================================================================================================================

export async function listStoreStockCounts(ctx: ActorContext, filter: { outletId?: string | null; limit?: number } = {}, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.stock_count.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const outlet = await resolveOfficeStore(tx, ctx, filter.outletId ?? null);
  if (!outlet) return { outlet: null, rows: [] };
  const rows = await tx.select().from(stockCounts).where(eq(stockCounts.outletId, outlet.id)).orderBy(desc(stockCounts.startedAt)).limit(filter.limit ?? 50);
  const ids = rows.map((r) => r.id);
  const agg = ids.length
    ? await tx
        .select({
          id: stockCountLines.stockCountId,
          n: sql<number>`count(*)::int`,
          diffs: sql<number>`count(*) filter (where ${stockCountLines.differenceQty} <> 0)::int`,
          value: sql<string>`coalesce(sum(${stockCountLines.differenceValue}), 0)`,
        })
        .from(stockCountLines)
        .where(inArray(stockCountLines.stockCountId, ids))
        .groupBy(stockCountLines.stockCountId)
    : [];
  const byId = new Map(agg.map((a) => [a.id, a]));
  return {
    outlet,
    rows: rows.map((r) => ({ ...r, lineCount: Number(byId.get(r.id)?.n ?? 0), differenceCount: Number(byId.get(r.id)?.diffs ?? 0), differenceValue: Number(byId.get(r.id)?.value ?? 0) })),
  };
}

export async function getStoreStockCount(ctx: ActorContext, id: string, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m7.stock_count.read", { tx: opts.tx, objectType: "stock_count", objectId: id });
  const tx = opts.tx ?? getDb();
  const [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, id)).limit(1);
  if (!count || count.tenantId !== ctx.tenantId) throw new NotFoundError("Opname tidak ditemukan.");
  const outlet = await loadStoreOutlet(tx, ctx, count.outletId);
  const lines = await tx
    .select({ l: stockCountLines, code: products.code, name: products.name, unit: products.unit })
    .from(stockCountLines)
    .innerJoin(products, eq(products.id, stockCountLines.productId))
    .where(eq(stockCountLines.stockCountId, count.id))
    .orderBy(products.sortOrder, products.code);
  const people = [count.countedBy, count.coCounterUserId].filter((x): x is string => !!x);
  const names = people.length
    ? await tx.select({ id: users.id, name: employees.fullName }).from(users).innerJoin(employees, eq(employees.id, users.employeeId)).where(inArray(users.id, people))
    : [];
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  const approval = count.approvalRequestId ? await approvals.getApproval(tx, count.approvalRequestId) : null;
  const signoff = count.kind === "cutover" ? await signoffFor(tx, count.tenantId, count.id) : null;
  return {
    count,
    outlet,
    lines: lines.map((r) => ({ ...r.l, code: r.code, name: r.name, unit: r.unit })),
    countedByName: count.countedBy ? (nameOf.get(count.countedBy) ?? null) : null,
    coCounterName: count.coCounterUserId ? (nameOf.get(count.coCounterUserId) ?? null) : null,
    approval,
    signoff,
  };
}

export type StockCountHistoryRow = {
  periodLabel: string;
  stockCountId: string;
  status: StockCountRow["status"];
  kind: StockCountRow["kind"];
  productId: string;
  code: string;
  name: string;
  physicalQty: number;
  systemQty: number;
  differenceQty: number;
  differenceValue: number;
  reason: StockCountLineRow["reason"];
  reasonNote: string | null;
  countedAt: Date;
};

/** Riwayat opname & selisih per barang per bulan (masukan laporan margin US-M7-07). */
export async function stockCountHistory(ctx: ActorContext, filter: { outletId?: string | null; productId?: string | null; fromMonth?: string | null; toMonth?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<StockCountHistoryRow[]> {
  await authorizeAny(ctx, ["m7.stock_count.read", "m7.report.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const outlet = await resolveOfficeStore(tx, ctx, filter.outletId ?? null);
  if (!outlet) return [];
  const conds = [eq(stockCounts.outletId, outlet.id), inArray(stockCounts.kind, ["monthly_store", "cutover"])];
  if (filter.productId) conds.push(eq(stockCountLines.productId, filter.productId));
  if (filter.fromMonth) conds.push(sql`${stockCounts.periodLabel} >= ${filter.fromMonth}`);
  if (filter.toMonth) conds.push(sql`${stockCounts.periodLabel} <= ${filter.toMonth}`);
  const rows = await tx
    .select({ c: stockCounts, l: stockCountLines, code: products.code, name: products.name })
    .from(stockCountLines)
    .innerJoin(stockCounts, eq(stockCounts.id, stockCountLines.stockCountId))
    .innerJoin(products, eq(products.id, stockCountLines.productId))
    .where(and(...conds))
    .orderBy(desc(stockCounts.periodLabel), products.code);
  return rows.map(({ c, l, code, name }) => ({
    periodLabel: c.periodLabel,
    stockCountId: c.id,
    status: c.status,
    kind: c.kind,
    productId: l.productId,
    code,
    name,
    physicalQty: l.physicalQty,
    systemQty: l.systemQtyAtCount,
    differenceQty: l.differenceQty,
    differenceValue: l.differenceValue ?? 0,
    reason: l.reason,
    reasonNote: l.reasonNote,
    countedAt: l.countedAt,
  }));
}

// =====================================================================================================================
// Job: opname bulan lalu belum dilakukan sampai tanggal N → pemilik (US-M7-05 KP-4)
// =====================================================================================================================

export async function runStoreStockCountCheck(now: Date, db: Tx): Promise<{ flagged: number }> {
  const today = ctxBusinessDate(systemContext({ now }));
  const day = toWibParts(now).day;
  const tenants = await db.selectDistinct({ tenantId: outlets.tenantId }).from(outlets).where(and(eq(outlets.kind, "store"), eq(outlets.isActive, true)));
  let flagged = 0;
  for (const { tenantId } of tenants) {
    const rules = await storeRules(db, today, tenantId);
    if (day <= rules.stock_count_deadline_day) continue;
    const period = previousMonthLabel(today);
    for (const outlet of await storeOutletsOf(db, tenantId)) {
      const done = await db
        .select({ id: stockCounts.id })
        .from(stockCounts)
        .where(and(eq(stockCounts.outletId, outlet.id), eq(stockCounts.periodLabel, period), eq(stockCounts.kind, "monthly_store"), inArray(stockCounts.status, ["submitted", "approved"])))
        .limit(1);
      if (done[0]) continue;
      const groupKey = `store.stock_count_overdue:${outlet.id}:${period}`;
      const [dup] = await db.select({ id: notifications.id }).from(notifications).where(eq(notifications.groupKey, groupKey)).limit(1);
      if (dup) continue;
      // D-12 butir 8: notifikasi ke beberapa penerima = beberapa baris → satu transaksi per toko.
      await inJobTx(db, (tx) => notify(tx, {
        event: "stock_count.overdue",
        tenantId,
        recipients: { roles: ["owner"] },
        title: `Opname ${outlet.name} bulan ${period} belum dilakukan`,
        body: `Opname bulanan toko (PAR-32) belum diajukan sampai tanggal ${rules.stock_count_deadline_day}. Minta kasir & Admin Keuangan menyelesaikan opname.`,
        objectType: "outlet",
        objectId: outlet.id,
        link: "/toko/opname",
        groupKey,
        now,
      }));
      flagged++;
    }
  }
  return { flagged };
}

export type { StockCountRow as StoreStockCountRow, StockCountLineRow };
