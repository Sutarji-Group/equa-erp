/**
 * M4 — penerimaan setoran & selisih (US-M4-02; Bab 5.2 setoran: Berjalan → Diajukan (M3/M6/M7) → Diterima → Ditutup).
 *
 * - Daftar setoran Diajukan (sopir) & tutup shift belum disetor (depot/toko), dengan status sinkron (US-M3-09 KP-3,
 *   US-M6-06 KP-3: tidak dapat diterima bila perangkat masih punya antrean — "menunggu sinkron").
 * - Seharusnya dihitung sistem, tidak dapat diubah: sopir = Σ tunai rit + Σ pelunasan tunai yang tertaut ke setoran ini
 *   (termasuk tunai terlambat sinkron dari hari sebelumnya, Bab 5.3) − pengeluaran dari kas yang DITERIMA saat verifikasi
 *   (PTB-20); depot/toko = tunai seharusnya − kas awal tetap − Σ setor sebagian (M6).
 * - selisih = diterima − (seharusnya − pengeluaran diterima); ≠ 0 → alasan wajib dari daftar + objek Selisih.
 * - Diterima setelah PAR-06 atau hari berikutnya → "terlambat" beralasan. Setor bank dengan slip → Diterima setelah
 *   mutasi cocok (lihat `transfers.ts`).
 * - Ditutup → `deposit.closed` (BR-10: kunci rit sopir hari berikutnya terbuka; M3 membaca status setoran).
 * - Pemisahan tugas: penerima ≠ penyetor (SOD-02); pemilik tidak menerima setoran (SOD-08, izin); penerima tidak dapat
 *   mengubah transaksi lapangan (masukan tidak memuat angka seharusnya — skema ketat).
 */
import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import { cashCloseExceptions, customerPayments, customers, deposits, discrepancies, outlets, shifts, tripExpenses, tripPayments, trips, trucks } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { notify } from "@/server/core/notifications";
import { authorize, runService, sod } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";
import * as m3 from "@/server/modules/m3-driver";
import * as m6 from "@/server/modules/m6-pos";

import { closeDepositSchema, receiveDepositSchema, reopenDepositSchema, verifyExpenseSchema } from "../schemas";
import {
  cashRules,
  depositSourceInfo,
  isAfterCutoff,
  loadDeposit,
  openCashDate,
  postOfficeCash,
  profitCenterFor,
  userNames,
  type DepositRow,
  type DiscrepancyReason,
} from "./common";
import { closeBelowThreshold, formDiscrepancy, resolvePendingDepositDiscrepancy, type DiscrepancyRow } from "./discrepancies";

type TripExpenseRow = typeof tripExpenses.$inferSelect;

// =====================================================================================================================
// Angka seharusnya (dihitung sistem)
// =====================================================================================================================

export type CarryOverItem = { kind: "trip_payment" | "collection"; id: string; label: string; amount: number; businessDate: string };

export type DepositExpense = {
  id: string;
  kind: string;
  amount: number;
  fundingSource: "cash_on_hand" | "personal";
  status: "pending_verification" | "accepted" | "rejected";
  businessDate: string;
  receiptAttachmentId: string | null;
  note: string | null;
  rejectionReason: string | null;
  tripNumber: string | null;
  reimbursed: boolean;
};

export type DepositFigures = {
  /** Tunai seharusnya tanggal setoran (tunai rit + pelunasan tunai). */
  sameDayCash: number;
  /** Rincian tunai seharusnya per rit/pelunasan tanggal setoran (US-M4-02 KP-1) — dari data tersinkron. */
  sameDayItems: CarryOverItem[];
  /** Tunai terlambat sinkron dari tanggal lain yang dibawa ke setoran ini (Bab 5.3). */
  carryOverCash: number;
  carryOverItems: CarryOverItem[];
  expectedCash: number;
  expenses: DepositExpense[];
  pendingExpenses: number;
  acceptedCashExpenses: number;
  acceptedPersonalExpenses: number;
  /** Seharusnya − pengeluaran diterima. */
  expectedNet: number;
};

async function liveExpenses(tx: Tx, depositId: string): Promise<(TripExpenseRow & { tripNumber: string | null })[]> {
  const rows = await tx
    .select({ e: tripExpenses, tripNumber: trips.number })
    .from(tripExpenses)
    .leftJoin(trips, eq(trips.id, tripExpenses.tripId))
    .where(and(eq(tripExpenses.depositId, depositId), isNull(tripExpenses.reversalOfId)))
    .orderBy(asc(tripExpenses.createdAt));
  if (!rows.length) return [];
  const reversed = await tx
    .select({ id: tripExpenses.reversalOfId })
    .from(tripExpenses)
    .where(inArray(tripExpenses.reversalOfId, rows.map((r) => r.e.id)));
  const gone = new Set(reversed.map((r) => r.id));
  return rows.filter((r) => !gone.has(r.e.id)).map((r) => ({ ...r.e, tripNumber: r.tripNumber }));
}

/** Angka seharusnya setoran (sopir: dari item tertaut; depot/toko: dari M6). `decisions` = keputusan verifikasi yang diusulkan. */
export async function depositFigures(tx: Tx, dep: DepositRow, decisions: ReadonlyMap<string, boolean> = new Map()): Promise<DepositFigures> {
  if (dep.sourceType !== "driver") {
    return {
      sameDayCash: dep.expectedCash,
      sameDayItems: [],
      carryOverCash: 0,
      carryOverItems: [],
      expectedCash: dep.expectedCash,
      expenses: [],
      pendingExpenses: 0,
      acceptedCashExpenses: 0,
      acceptedPersonalExpenses: 0,
      expectedNet: dep.expectedCash,
    };
  }
  const pays = await tx
    .select({ id: tripPayments.id, amount: tripPayments.receivedAmount, businessDate: tripPayments.businessDate, reversalOfId: tripPayments.reversalOfId, reversedAt: tripPayments.reversedAt, tripNumber: trips.number, customerName: customers.name })
    .from(tripPayments)
    .innerJoin(trips, eq(trips.id, tripPayments.tripId))
    .innerJoin(customers, eq(customers.id, tripPayments.customerId))
    .where(and(eq(tripPayments.depositId, dep.id), eq(tripPayments.method, "cash")));
  const cols = await tx
    .select({ id: customerPayments.id, amount: customerPayments.amount, businessDate: customerPayments.businessDate, reversalOfId: customerPayments.reversalOfId, customerName: customers.name })
    .from(customerPayments)
    .innerJoin(customers, eq(customers.id, customerPayments.customerId))
    .where(and(eq(customerPayments.depositId, dep.id), eq(customerPayments.method, "cash")));
  const reversedCols = cols.length
    ? new Set((await tx.select({ id: customerPayments.reversalOfId }).from(customerPayments).where(inArray(customerPayments.reversalOfId, cols.map((c) => c.id)))).map((r) => r.id))
    : new Set<string | null>();
  const livePays = pays.filter((p) => !p.reversalOfId && !p.reversedAt);
  const liveCols = cols.filter((c) => !c.reversalOfId && !reversedCols.has(c.id));
  let sameDayCash = 0;
  let carryOverCash = 0;
  const sameDayItems: CarryOverItem[] = [];
  const carryOverItems: CarryOverItem[] = [];
  for (const p of livePays) {
    const item: CarryOverItem = { kind: "trip_payment", id: p.id, label: `Rit ${p.tripNumber} — ${p.customerName}`, amount: p.amount, businessDate: p.businessDate };
    if (p.businessDate === dep.businessDate) {
      sameDayCash += p.amount;
      sameDayItems.push(item);
    } else {
      carryOverCash += p.amount;
      carryOverItems.push(item);
    }
  }
  for (const c of liveCols) {
    const item: CarryOverItem = { kind: "collection", id: c.id, label: `Pelunasan — ${c.customerName}`, amount: c.amount, businessDate: c.businessDate };
    if (c.businessDate === dep.businessDate) {
      sameDayCash += c.amount;
      sameDayItems.push(item);
    } else {
      carryOverCash += c.amount;
      carryOverItems.push(item);
    }
  }
  // Setoran lama/demo tanpa item tertaut: pakai angka ringkasan terkunci saat Diajukan.
  if (pays.length === 0 && cols.length === 0) sameDayCash = dep.expectedCash;
  const exps = await liveExpenses(tx, dep.id);
  const expenses: DepositExpense[] = exps.map((e) => {
    const decided = decisions.get(e.id);
    const status = e.status === "pending_verification" && decided !== undefined ? (decided ? "accepted" : "rejected") : e.status;
    return {
      id: e.id,
      kind: e.kind,
      amount: e.amount,
      fundingSource: e.fundingSource,
      status,
      businessDate: e.businessDate,
      receiptAttachmentId: e.receiptAttachmentId,
      note: e.note,
      rejectionReason: e.rejectionReason,
      tripNumber: e.tripNumber,
      reimbursed: !!e.reimbursedAt,
    };
  });
  const acceptedCashExpenses = expenses.filter((e) => e.status === "accepted" && e.fundingSource === "cash_on_hand").reduce((s, e) => s + e.amount, 0);
  const acceptedPersonalExpenses = expenses.filter((e) => e.status === "accepted" && e.fundingSource === "personal").reduce((s, e) => s + e.amount, 0);
  const expectedCash = sameDayCash + carryOverCash;
  return {
    sameDayCash,
    sameDayItems,
    carryOverCash,
    carryOverItems,
    expectedCash,
    expenses,
    pendingExpenses: expenses.filter((e) => e.status === "pending_verification").length,
    acceptedCashExpenses,
    acceptedPersonalExpenses,
    expectedNet: expectedCash - acceptedCashExpenses,
  };
}

// =====================================================================================================================
// Status sinkron ("menunggu sinkron")
// =====================================================================================================================

export type DepositSyncStatus = { fullySynced: boolean; message: string; missingCount: number };

export async function depositSyncStatus(tx: Tx, dep: DepositRow): Promise<DepositSyncStatus> {
  if (dep.sourceType === "driver") {
    if (!dep.depositorUserId) return { fullySynced: true, message: "Tanpa perangkat.", missingCount: 0 };
    const s = await m3.driverDaySyncStatus(tx, dep.depositorUserId, dep.businessDate);
    const missing = s.missing.completedTripIds.length + s.missing.failedTripIds.length + s.missing.collectionIds.length + s.missing.expenseIds.length;
    return { fullySynced: s.fullySynced, message: s.message, missingCount: missing || (s.deviceQueue ?? 0) };
  }
  if (!dep.shiftId || dep.isPartial) return { fullySynced: true, message: "Tidak memerlukan sinkron.", missingCount: 0 };
  const s = await m6.shiftSyncStatus(tx, dep.shiftId);
  const missing = s.missingSaleIds.length + s.missingVoidIds.length;
  return {
    fullySynced: s.fullySynced,
    missingCount: missing,
    message: s.fullySynced
      ? "Semua transaksi shift sudah tersinkron."
      : !s.closed
        ? "Shift belum ditutup di perangkat."
        : `Menunggu sinkron: ${missing} transaksi/void dari tablet POS belum masuk. Minta operator menekan "Kirim sekarang" saat ada sinyal.`,
  };
}

// =====================================================================================================================
// Daftar & rincian (US-M4-02 KP-1)
// =====================================================================================================================

export type DepositListRow = {
  id: string;
  number: string;
  sourceType: DepositRow["sourceType"];
  status: DepositRow["status"];
  method: DepositRow["method"];
  isPartial: boolean;
  businessDate: string;
  sourceLabel: string;
  sourceDetail: string | null;
  phone: string | null;
  expectedCash: number;
  expectedNet: number;
  receivedAmount: number | null;
  discrepancyAmount: number | null;
  discrepancyReason: DepositRow["discrepancyReason"];
  submittedAt: Date | null;
  submittedLate: boolean;
  receivedAt: Date | null;
  receivedLate: boolean;
  closedAt: Date | null;
  shiftClosedAt: Date | null;
  shiftDepositStatus: string | null;
  /** Setoran depot/toko belum diterima > PAR-27 hari sejak tutup shift. */
  depotLate: boolean;
  pendingExpenses: number;
  sync: DepositSyncStatus | null;
  awaitingTransferMatch: boolean;
};

async function toListRows(tx: Tx, ctx: ActorContext, rows: DepositRow[], opts: { withSync: boolean }): Promise<DepositListRow[]> {
  const today = ctxBusinessDate(ctx);
  const rules = await cashRules(tx, today, ctx.tenantId);
  const shiftIds = rows.map((r) => r.shiftId).filter((x): x is string => !!x);
  const shiftRows = shiftIds.length ? await tx.select({ id: shifts.id, closedAt: shifts.closedAt, depositStatus: shifts.depositStatus }).from(shifts).where(inArray(shifts.id, shiftIds)) : [];
  const shiftById = new Map(shiftRows.map((s) => [s.id, s]));
  const pendingExp = rows.length
    ? await tx
        .select({ depositId: tripExpenses.depositId, n: sql<number>`count(*)::int` })
        .from(tripExpenses)
        .where(and(inArray(tripExpenses.depositId, rows.map((r) => r.id)), eq(tripExpenses.status, "pending_verification"), isNull(tripExpenses.reversalOfId)))
        .groupBy(tripExpenses.depositId)
    : [];
  const pendingBy = new Map(pendingExp.map((p) => [p.depositId, Number(p.n)]));
  const out: DepositListRow[] = [];
  for (const d of rows) {
    const info = await depositSourceInfo(tx, d);
    const sh = d.shiftId ? shiftById.get(d.shiftId) : undefined;
    const depotLate =
      d.sourceType !== "driver" && !d.isPartial && (d.status === "submitted" || d.status === "running") && !!sh?.closedAt && ctx.now.getTime() - sh.closedAt.getTime() > rules.depotLateDays * 86_400_000;
    out.push({
      id: d.id,
      number: d.number,
      sourceType: d.sourceType,
      status: d.status,
      method: d.method,
      isPartial: d.isPartial,
      businessDate: d.businessDate,
      sourceLabel: info.label,
      sourceDetail: info.detail,
      phone: info.phone,
      expectedCash: d.expectedCash,
      expectedNet: d.expectedNet,
      receivedAmount: d.receivedAmount,
      discrepancyAmount: d.discrepancyAmount,
      discrepancyReason: d.discrepancyReason,
      submittedAt: d.submittedAt,
      submittedLate: d.submittedLate,
      receivedAt: d.receivedAt,
      receivedLate: d.receivedLate,
      closedAt: d.closedAt,
      shiftClosedAt: sh?.closedAt ?? null,
      shiftDepositStatus: sh?.depositStatus ?? null,
      depotLate,
      pendingExpenses: pendingBy.get(d.id) ?? 0,
      sync: opts.withSync && d.status === "submitted" ? await depositSyncStatus(tx, d) : null,
      awaitingTransferMatch: d.status === "submitted" && d.method === "bank_slip",
    });
  }
  return out;
}

/**
 * Setoran menunggu diterima: sopir Diajukan, tutup shift depot/toko belum disetor/diterima, setoran lewat slip menunggu
 * mutasi, dan setoran Diterima yang belum Ditutup (US-M4-02 KP-1).
 */
export async function listDepositsForReceipt(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<{ waiting: DepositListRow[]; received: DepositListRow[] }> {
  await authorize(ctx, "m4.deposit.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const rows = await tx
    .select()
    .from(deposits)
    .where(and(eq(deposits.tenantId, ctx.tenantId), inArray(deposits.status, ["submitted", "received"])))
    .orderBy(asc(deposits.businessDate), asc(deposits.submittedAt));
  const list = await toListRows(tx, ctx, rows, { withSync: true });
  return { waiting: list.filter((r) => r.status === "submitted"), received: list.filter((r) => r.status === "received") };
}

/** Riwayat setoran per tanggal/rentang (semua status). */
export async function listDeposits(
  ctx: ActorContext,
  filter: { from?: string | null; to?: string | null; sourceType?: DepositRow["sourceType"] | null; status?: DepositRow["status"] | null } = {},
  opts: { tx?: Tx } = {},
): Promise<DepositListRow[]> {
  await authorize(ctx, "m4.deposit.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const to = filter.to ?? ctxBusinessDate(ctx);
  const from = filter.from ?? to;
  const conds = [eq(deposits.tenantId, ctx.tenantId), sql`${deposits.businessDate} between ${from} and ${to}`];
  if (filter.sourceType) conds.push(eq(deposits.sourceType, filter.sourceType));
  if (filter.status) conds.push(eq(deposits.status, filter.status));
  const rows = await tx.select().from(deposits).where(and(...conds)).orderBy(desc(deposits.businessDate), asc(deposits.number)).limit(1000);
  return toListRows(tx, ctx, rows, { withSync: false });
}

export type DepositDetail = {
  deposit: DepositRow;
  source: Awaited<ReturnType<typeof depositSourceInfo>>;
  figures: DepositFigures;
  sync: DepositSyncStatus;
  snapshot: Record<string, unknown> | null;
  shift: (typeof shifts.$inferSelect & { outletCode: string; outletName: string }) | null;
  discrepancies: DiscrepancyRow[];
  receivedByName: string | null;
  closedByName: string | null;
  late: { afterCutoff: boolean; cutoff: string };
  discrepancyThreshold: number;
  canReceive: boolean;
  canReopen: boolean;
  blockReason: string | null;
};

export async function getDepositDetail(ctx: ActorContext, id: string, opts: { tx?: Tx } = {}): Promise<DepositDetail> {
  await authorize(ctx, "m4.deposit.read", { tx: opts.tx, objectType: "deposit", objectId: id });
  const tx = opts.tx ?? getDb();
  const dep = await loadDeposit(tx, ctx, id);
  const [source, figures, sync, rules] = await Promise.all([depositSourceInfo(tx, dep), depositFigures(tx, dep), depositSyncStatus(tx, dep), cashRules(tx, ctxBusinessDate(ctx), ctx.tenantId)]);
  const shiftRow = dep.shiftId
    ? (await tx.select({ s: shifts, outletCode: outlets.code, outletName: outlets.name }).from(shifts).innerJoin(outlets, eq(outlets.id, shifts.outletId)).where(eq(shifts.id, dep.shiftId)).limit(1))[0]
    : undefined;
  const discs = await tx.select().from(discrepancies).where(eq(discrepancies.depositId, dep.id)).orderBy(desc(discrepancies.createdAt));
  const names = await userNames(tx, [dep.receivedBy, dep.closedBy]);
  let blockReason: string | null = null;
  if (dep.status !== "submitted") blockReason = null;
  else if (dep.method === "bank_slip") blockReason = "Setoran lewat setor bank dengan slip — diterima setelah mutasi cocok di menu Transfer masuk.";
  else if (!sync.fullySynced) blockReason = sync.message;
  else if (dep.depositorUserId && dep.depositorUserId === ctx.userId) blockReason = "Anda tidak dapat menerima setoran Anda sendiri.";
  else if ((await selfRecordedItems(tx, dep.id, ctx.userId)) > 0) blockReason = `${SELF_RECORDED_MESSAGE}.`;
  return {
    deposit: dep,
    source,
    figures,
    sync,
    snapshot: (dep.summarySnapshot as Record<string, unknown> | null) ?? null,
    shift: shiftRow ? { ...shiftRow.s, outletCode: shiftRow.outletCode, outletName: shiftRow.outletName } : null,
    discrepancies: discs,
    receivedByName: dep.receivedBy ? (names.get(dep.receivedBy)?.name ?? null) : null,
    closedByName: dep.closedBy ? (names.get(dep.closedBy)?.name ?? null) : null,
    late: { afterCutoff: isAfterCutoff(ctx.now, dep.businessDate, rules.cashCloseTime), cutoff: rules.cashCloseTime },
    discrepancyThreshold: rules.discrepancyThreshold,
    canReceive: dep.status === "submitted" && !blockReason,
    canReopen: dep.sourceType === "driver" && dep.status === "submitted",
    blockReason,
  };
}

// =====================================================================================================================
// Verifikasi pengeluaran rit (US-M4-02 KP-2, PTB-20)
// =====================================================================================================================

async function applyExpenseDecision(tx: Tx, ctx: ActorContext, dep: DepositRow, expense: TripExpenseRow, accept: boolean, reason: string | null): Promise<void> {
  if (expense.status !== "pending_verification") throw new DomainError("EXPENSE_VERIFIED", "Pengeluaran ini sudah diverifikasi.");
  // SOD-01: pencatat pengeluaran tidak memverifikasi pengeluarannya sendiri.
  sod.assertNotSelf(expense.driverUserId ?? expense.createdBy, ctx.userId, "pengeluaran rit", { objectType: "trip_expense", objectId: expense.id });
  if (!accept && (!reason || reason.length < 3)) throw new DomainError("REASON_REQUIRED", "Alasan penolakan pengeluaran wajib diisi (minimal 3 karakter).");
  let movementId: string | null = null;
  if (accept && expense.fundingSource === "personal") {
    // Uang pribadi sopir diganti dari kas kantor (penggantian pengeluaran rit, US-M4-01 KP-3); hari kas yang sudah
    // ditutup tidak berubah — penggantian masuk hari kas terbuka berikutnya (US-M4-06 KP-7).
    const cashDate = await openCashDate(tx, dep.tenantId, ctxBusinessDate(ctx));
    const mv = await postOfficeCash(tx, ctx, {
      tenantId: dep.tenantId,
      businessDate: cashDate.date,
      kind: "expense_reimbursement",
      direction: "out",
      amount: expense.amount,
      sourceObjectType: "trip_expense",
      sourceObjectId: expense.id,
      description: `Penggantian ${label("trip_expense_kind", expense.kind)} ${dep.number}${cashDate.shifted ? " (setelah kas ditutup)" : ""}`,
    });
    movementId = mv?.id ?? null;
  }
  await tx
    .update(tripExpenses)
    .set({
      status: accept ? "accepted" : "rejected",
      verifiedBy: ctx.userId,
      verifiedAt: ctx.now,
      rejectionReason: accept ? null : reason,
      reimbursedAt: movementId ? ctx.now : expense.reimbursedAt,
      officeCashMovementId: movementId ?? expense.officeCashMovementId,
      updatedAt: ctx.now,
    })
    .where(eq(tripExpenses.id, expense.id));
  await auditRecord(tx, {
    ctx,
    objectType: "trip_expense",
    objectId: expense.id,
    action: accept ? "approve" : "reject",
    before: { status: expense.status },
    after: { status: accept ? "accepted" : "rejected", reimbursed: !!movementId },
    reason,
    rule: "PTB-20, US-M4-02 KP-2",
    businessDate: expense.businessDate,
  });
  await emit(
    tx,
    "expense.verified",
    { tripExpenseId: expense.id, truckId: expense.truckId, kind: expense.kind, amount: expense.amount, fundingSource: expense.fundingSource, accepted: accept, depositId: dep.id },
    { ctx, businessDate: expense.businessDate, objectType: "trip_expense", objectId: expense.id },
  );
}

/** Verifikasi satu pengeluaran rit (terima/tolak) sebelum menerima setoran. */
export async function verifyExpense(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m4.deposit.receive", { tx: opts.tx, objectType: "trip_expense" });
  const data = parseInput(verifyExpenseSchema, input, { accept: "Keputusan", reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const expense = (await tx.select().from(tripExpenses).where(eq(tripExpenses.id, data.expenseId)).for("update").limit(1))[0];
    if (!expense || expense.tenantId !== ctx.tenantId || !expense.depositId) throw new NotFoundError("Pengeluaran rit tidak ditemukan.");
    const dep = await loadDeposit(tx, ctx, expense.depositId, { forUpdate: true });
    if (dep.status === "closed" || dep.status === "received") throw new DomainError("DEPOSIT_RECEIVED", "Setoran sudah diterima; verifikasi pengeluaran tidak dapat diubah.");
    await applyExpenseDecision(tx, ctx, dep, expense, data.accept, data.reason);
    return { expenseId: expense.id, status: data.accept ? "accepted" : "rejected" };
  });
}

/**
 * FR-M10-03 / 7.4.5 (penerima setoran bukan pembuat transaksinya): transaksi dalam setoran yang dicatat pelaku sendiri —
 * pembayaran rit / pelunasan / pengeluaran rit lewat jalur "dicatat kantor" atau koreksi/pembaliknya. Kosong = boleh.
 */
async function selfRecordedItems(tx: Tx, depositId: string, userId: string | null): Promise<number> {
  if (!userId) return 0;
  const [a] = await tx.select({ n: sql<number>`count(*)::int` }).from(tripPayments).where(and(eq(tripPayments.depositId, depositId), eq(tripPayments.createdBy, userId)));
  const [b] = await tx.select({ n: sql<number>`count(*)::int` }).from(customerPayments).where(and(eq(customerPayments.depositId, depositId), eq(customerPayments.createdBy, userId)));
  const [c] = await tx.select({ n: sql<number>`count(*)::int` }).from(tripExpenses).where(and(eq(tripExpenses.depositId, depositId), eq(tripExpenses.createdBy, userId)));
  return Number(a?.n ?? 0) + Number(b?.n ?? 0) + Number(c?.n ?? 0);
}

const SELF_RECORDED_MESSAGE = "Setoran ini memuat transaksi yang Anda catat sendiri (dicatat kantor atau koreksi); minta Admin Keuangan lain menerima dan menutupnya";

async function assertNotSelfRecorded(tx: Tx, ctx: ActorContext, dep: DepositRow): Promise<void> {
  if ((await selfRecordedItems(tx, dep.id, ctx.userId)) > 0) {
    throw sod.sodViolation("SOD-02", SELF_RECORDED_MESSAGE, { objectType: "deposit", objectId: dep.id });
  }
}

// =====================================================================================================================
// Terima & tutup (US-M4-02 KP-2..KP-9)
// =====================================================================================================================

export type ReceiveResult = { deposit: DepositRow; discrepancy: DiscrepancyRow | null; closed: boolean };

type ReceiveCore = {
  receivedAmount: number;
  via: "physical" | "bank";
  denominations?: Record<string, number> | null;
  discrepancyReason?: DiscrepancyReason | null;
  discrepancyNote?: string | null;
  lateReason?: string | null;
  evidenceAttachmentId?: string | null;
  close: boolean;
  /** Transfer masuk yang dicocokkan (setor bank dengan slip). */
  transferId?: string | null;
  /** Rekening PT penerima setor bank dengan slip (dari transfer/mutasi yang dicocokkan). */
  bankAccountId?: string | null;
};

/**
 * Inti penerimaan (dipakai penerimaan fisik & pencocokan slip setor bank). Pemanggil sudah `authorize`; SoD, sinkron,
 * verifikasi, keterlambatan, selisih, kas kantor, event dilakukan di sini.
 */
export async function receiveDepositCore(tx: Tx, ctx: ActorContext, depositId: string, input: ReceiveCore): Promise<ReceiveResult> {
  const dep = await loadDeposit(tx, ctx, depositId, { forUpdate: true });
  if (dep.status !== "submitted") {
    throw new DomainError(
      "DEPOSIT_NOT_SUBMITTED",
      dep.status === "running" ? `Setoran ${dep.number} belum diajukan penyetor dari aplikasi.` : `Setoran ${dep.number} sudah ${label("deposit_status", dep.status).toLowerCase()}.`,
    );
  }
  // SOD-02: penerima bukan penyetor — dan bukan pembuat transaksi di dalam setoran (FR-M10-03, 7.4.5).
  sod.assertReceiverNotDepositor(dep.depositorUserId, ctx.userId, { objectType: "deposit", objectId: dep.id });
  await assertNotSelfRecorded(tx, ctx, dep);
  if (input.via === "physical" && dep.method === "bank_slip") {
    throw new DomainError("BANK_SLIP_DEPOSIT", `Setoran ${dep.number} disetor lewat bank dengan slip — diterima setelah mutasi cocok (menu Transfer masuk).`);
  }
  // US-M3-09 KP-3 / US-M6-06 KP-3: "menunggu sinkron".
  const sync = await depositSyncStatus(tx, dep);
  if (!sync.fullySynced) throw new DomainError("WAITING_SYNC", sync.message);

  const today = ctxBusinessDate(ctx);
  const rules = await cashRules(tx, today, ctx.tenantId);
  const figures = await depositFigures(tx, dep);
  if (figures.pendingExpenses > 0) {
    throw new DomainError("EXPENSES_PENDING", `Masih ada ${figures.pendingExpenses} pengeluaran rit menunggu verifikasi. Terima atau tolak setiap pengeluaran dulu.`);
  }
  const discrepancyAmount = input.receivedAmount - figures.expectedNet;
  if (discrepancyAmount !== 0) {
    if (!input.discrepancyReason) {
      throw new DomainError("DISCREPANCY_REASON_REQUIRED", `Selisih ${formatRupiah(discrepancyAmount, { signed: true })} — pilih alasan selisih dari daftar.`);
    }
    if (input.discrepancyReason === "other" && (!input.discrepancyNote || input.discrepancyNote.length < 3)) {
      throw new DomainError("DISCREPANCY_NOTE_REQUIRED", "Alasan \"Lainnya\" wajib diberi keterangan (minimal 3 karakter).");
    }
  }
  // US-M4-02 KP-6: diterima setelah PAR-06 atau hari berikutnya → terlambat beralasan.
  // Setor bank dengan slip: waktu terima = mutasi cocok (bukan keterlambatan penyetor).
  const late = input.via === "physical" && isAfterCutoff(ctx.now, dep.businessDate, rules.cashCloseTime);
  if (late && (!input.lateReason || input.lateReason.length < 3)) {
    throw new DomainError("LATE_REASON_REQUIRED", `Setoran ${formatTanggal(dep.businessDate, { weekday: false })} diterima setelah ${rules.cashCloseTime.replace(":", ".")} atau pada hari berikutnya — isi alasan keterlambatan.`);
  }
  if (input.evidenceAttachmentId) await linkAttachment(tx, input.evidenceAttachmentId, { type: "deposit", id: dep.id });

  const receiptSnapshot = {
    via: input.via,
    transferId: input.transferId ?? null,
    submittedExpectedCash: dep.expectedCash,
    submittedExpectedNet: dep.expectedNet,
    sameDayCash: figures.sameDayCash,
    carryOverItems: figures.carryOverItems,
    expenses: figures.expenses.map((e) => ({ id: e.id, kind: e.kind, amount: e.amount, fundingSource: e.fundingSource, status: e.status })),
    acceptedPersonalExpenses: figures.acceptedPersonalExpenses,
    syncMessage: sync.message,
  };
  const [updated] = await tx
    .update(deposits)
    .set({
      status: "received",
      expectedCash: figures.expectedCash - figures.carryOverCash,
      carryOverCash: figures.carryOverCash,
      acceptedExpenses: figures.acceptedCashExpenses,
      expectedNet: figures.expectedNet,
      receivedAmount: input.receivedAmount,
      discrepancyAmount,
      discrepancyReason: discrepancyAmount !== 0 ? (input.discrepancyReason ?? null) : null,
      discrepancyNote: discrepancyAmount !== 0 ? (input.discrepancyNote ?? null) : null,
      denominations: input.denominations ?? null,
      receiptSnapshot,
      receivedAt: ctx.now,
      receivedBy: ctx.userId,
      receivedLate: late,
      lateReason: late ? (input.lateReason ?? null) : null,
      slipTransferId: input.transferId ?? dep.slipTransferId,
      updatedAt: ctx.now,
    })
    .where(eq(deposits.id, dep.id))
    .returning();
  let deposit = updated!;
  // Kas kantor bertambah sebesar uang fisik yang diterima (setor bank tidak melewati kas kantor) pada hari kas terbuka
  // paling awal ≥ tanggal setoran: setoran kemarin yang diterima pagi ini masuk kas kemarin selama kas kemarin belum
  // ditutup (tutup kas tertunda 7.4.6 tanpa selisih palsu). Hari kas setoran sudah ditutup (setoran tertunda PTB-21)
  // → masuk kas hari berikutnya bertanda (Bab 5.3, US-M4-06 KP-7).
  if (input.via === "physical") {
    const cashDate = await openCashDate(tx, dep.tenantId, dep.businessDate < today ? dep.businessDate : today);
    await postOfficeCash(tx, ctx, {
      tenantId: dep.tenantId,
      businessDate: cashDate.date,
      kind: "deposit_received",
      direction: "in",
      amount: input.receivedAmount,
      sourceObjectType: "deposit",
      sourceObjectId: dep.id,
      description: `Setoran ${dep.number} (${label("deposit_source_type", dep.sourceType)})${cashDate.shifted ? " — diterima setelah kas ditutup" : ""}`,
    });
  }
  const source = await depositSourceInfo(tx, dep);
  let discrepancy: DiscrepancyRow | null = null;
  if (discrepancyAmount !== 0) {
    discrepancy = await formDiscrepancy(tx, ctx, {
      tenantId: dep.tenantId,
      source: dep.sourceType,
      businessDate: dep.businessDate,
      amount: discrepancyAmount,
      depositId: dep.id,
      employeeId: dep.depositorEmployeeId ?? source.employeeId,
      userId: dep.depositorUserId,
      truckId: dep.truckId,
      outletId: dep.outletId,
      shiftId: dep.shiftId,
      reason: input.discrepancyReason ?? null,
      reasonNote: input.discrepancyNote ?? null,
      evidenceAttachmentId: input.evidenceAttachmentId ?? null,
      sourceLabel: source.label,
    });
  }
  await auditRecord(tx, {
    ctx,
    objectType: "deposit",
    objectId: dep.id,
    action: "receive",
    before: { status: dep.status },
    after: {
      status: "received",
      expectedCash: figures.expectedCash,
      acceptedExpenses: figures.acceptedCashExpenses,
      expectedNet: figures.expectedNet,
      receivedAmount: input.receivedAmount,
      discrepancyAmount,
      receivedLate: late,
      via: input.via,
    },
    reason: late ? input.lateReason : (input.discrepancyNote ?? null),
    rule: "US-M4-02",
    businessDate: dep.businessDate,
  });
  // PTB-21: setoran tertunda yang diterima menyelesaikan pengecualian tutup kas.
  await resolveExceptionsForDeposit(tx, ctx, dep.id);
  await emit(
    tx,
    "deposit.received",
    {
      depositId: dep.id,
      sourceType: dep.sourceType,
      sourceUserId: dep.depositorUserId,
      truckId: dep.truckId,
      outletId: dep.outletId,
      expectedAmount: figures.expectedNet,
      receivedAmount: input.receivedAmount,
      discrepancyAmount,
      receivedBy: ctx.userId!,
      profitCenter: profitCenterFor(dep.sourceType),
      late,
      method: dep.method,
      bankAccountId: input.bankAccountId ?? (((dep.summarySnapshot as { bankAccountId?: string | null } | null)?.bankAccountId ?? null) as string | null),
      isPartial: dep.isPartial,
      depositNumber: dep.number,
      businessDate: dep.businessDate,
      shiftId: dep.shiftId,
      employeeId: dep.depositorEmployeeId,
      expectedCash: figures.expectedCash,
      acceptedExpenses: figures.acceptedCashExpenses,
      carryOverCash: figures.carryOverCash,
      discrepancyId: discrepancy?.id ?? null,
      discrepancyReason: discrepancy?.reason ?? null,
    },
    { ctx, businessDate: dep.businessDate, objectType: "deposit", objectId: dep.id },
  );
  let closed = false;
  if (input.close) {
    deposit = await closeDepositCore(tx, ctx, deposit);
    closed = true;
  }
  return { deposit, discrepancy, closed };
}

/** Terima setoran fisik (US-M4-02 KP-2): jumlah fisik + verifikasi pengeluaran + alasan selisih/terlambat. */
export async function receiveDeposit(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<ReceiveResult> {
  await authorize(ctx, "m4.deposit.receive", { tx: opts.tx, objectType: "deposit" });
  const data = parseInput(receiveDepositSchema, input, {
    receivedAmount: "Jumlah diterima",
    discrepancyReason: "Alasan selisih",
    discrepancyNote: "Keterangan selisih",
    lateReason: "Alasan terlambat",
    denominations: "Rincian pecahan",
  });
  if (data.denominations) {
    const sum = Object.entries(data.denominations).reduce((s, [value, count]) => s + Number(value) * count, 0);
    if (sum !== data.receivedAmount) {
      throw new DomainError("DENOMINATION_MISMATCH", `Jumlah rincian pecahan ${formatRupiah(sum)} tidak sama dengan jumlah diterima ${formatRupiah(data.receivedAmount)}. Periksa hitungan.`);
    }
  }
  return runService(ctx, opts, async (tx) => {
    const dep = await loadDeposit(tx, ctx, data.depositId, { forUpdate: true });
    if (data.expenseDecisions.length) {
      const ids = data.expenseDecisions.map((d) => d.expenseId);
      const rows = await tx.select().from(tripExpenses).where(and(inArray(tripExpenses.id, ids), eq(tripExpenses.depositId, dep.id))).for("update");
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const d of data.expenseDecisions) {
        const e = byId.get(d.expenseId);
        if (!e) throw new NotFoundError("Pengeluaran rit tidak termasuk setoran ini.");
        if (e.status !== "pending_verification") continue;
        await applyExpenseDecision(tx, ctx, dep, e, d.accept, d.reason);
      }
    }
    return receiveDepositCore(tx, ctx, dep.id, {
      receivedAmount: data.receivedAmount,
      via: "physical",
      denominations: data.denominations ?? null,
      discrepancyReason: data.discrepancyReason ?? null,
      discrepancyNote: data.discrepancyNote,
      lateReason: data.lateReason,
      evidenceAttachmentId: data.evidenceAttachmentId ?? null,
      close: data.close,
    });
  });
}

async function closeDepositCore(tx: Tx, ctx: ActorContext, dep: DepositRow): Promise<DepositRow> {
  if (dep.status !== "received") throw new DomainError("DEPOSIT_NOT_RECEIVED", `Setoran ${dep.number} belum diterima — masukkan jumlah fisik dulu.`);
  if ((dep.discrepancyAmount ?? 0) !== 0 && !dep.discrepancyReason) {
    throw new DomainError("DISCREPANCY_REASON_REQUIRED", "Setiap selisih wajib diberi alasan sebelum setoran ditutup.");
  }
  // US-M3-09 KP-3: setoran sopir hanya DITUTUP bila seluruh data hari itu tersinkron.
  if (dep.sourceType === "driver" && dep.depositorUserId && !(await m3.isDriverDayFullySynced(tx, dep.depositorUserId, dep.businessDate))) {
    const s = await m3.driverDaySyncStatus(tx, dep.depositorUserId, dep.businessDate);
    throw new DomainError("WAITING_SYNC", s.message);
  }
  const [row] = await tx.update(deposits).set({ status: "closed", closedAt: ctx.now, closedBy: ctx.userId, updatedAt: ctx.now }).where(eq(deposits.id, dep.id)).returning();
  // Selisih di bawah ambang ditutup Admin Keuangan bersama setoran (US-M4-02 KP-4); ≥ ambang tetap di alur pemilik.
  await closeBelowThreshold(tx, ctx, dep.id);
  await auditRecord(tx, { ctx, objectType: "deposit", objectId: dep.id, action: "close", before: { status: "received" }, after: { status: "closed" }, rule: "US-M4-02 KP-4/KP-8, BR-10", businessDate: dep.businessDate });
  await emit(
    tx,
    "deposit.closed",
    {
      depositId: dep.id,
      sourceType: dep.sourceType,
      sourceUserId: dep.depositorUserId,
      closedBy: ctx.userId!,
      depositNumber: dep.number,
      businessDate: dep.businessDate,
      truckId: dep.truckId,
      outletId: dep.outletId,
      shiftId: dep.shiftId,
      employeeId: dep.depositorEmployeeId,
      receivedAmount: dep.receivedAmount,
      discrepancyAmount: dep.discrepancyAmount,
      unlocksTrips: dep.sourceType === "driver",
    },
    { ctx, businessDate: dep.businessDate, objectType: "deposit", objectId: dep.id },
  );
  // US-M4-02 KP-8 / US-M6-02 KP-5: hasil penerimaan tampil ke penyetor.
  if (dep.depositorUserId) {
    const diff = dep.discrepancyAmount ?? 0;
    await notify(tx, {
      event: "deposit.result",
      tenantId: dep.tenantId,
      recipients: { userIds: [dep.depositorUserId] },
      title: `Setoran ${dep.number} ditutup Admin Keuangan`,
      body: `Diterima ${formatRupiah(dep.receivedAmount ?? 0)}${diff ? `, selisih ${formatRupiah(diff, { signed: true })} (${dep.discrepancyReason ? label("discrepancy_reason", dep.discrepancyReason) : "—"})` : ", tanpa selisih"}.${dep.sourceType === "driver" ? " Rit hari berikutnya terbuka." : ""}`,
      objectType: "deposit",
      objectId: dep.id,
      valueAmount: dep.receivedAmount,
      now: ctx.now,
    });
  }
  return row!;
}

/** Tutup setoran yang sudah Diterima (US-M4-02 KP-4): tidak menunggu keputusan pemilik atas selisih. */
export async function closeDeposit(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}): Promise<DepositRow> {
  await authorize(ctx, "m4.deposit.receive", { tx: opts.tx, objectType: "deposit" });
  const data = parseInput(closeDepositSchema, input);
  return runService(ctx, opts, async (tx) => {
    const dep = await loadDeposit(tx, ctx, data.depositId, { forUpdate: true });
    sod.assertReceiverNotDepositor(dep.depositorUserId, ctx.userId, { objectType: "deposit", objectId: dep.id });
    await assertNotSelfRecorded(tx, ctx, dep);
    return closeDepositCore(tx, ctx, dep);
  });
}

/** Buka kembali setoran sopir Diajukan yang belum Diterima (US-M3-07 KP-2) — lewat M3. */
export async function reopenDeposit(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  const data = parseInput(reopenDepositSchema, input, { reason: "Alasan" });
  return m3.reopenDriverDeposit(ctx, data, opts);
}

// =====================================================================================================================
// Kueri untuk posisi kas & tutup kas
// =====================================================================================================================

/** Setoran (bukan sebagian) tanggal itu. */
export async function depositsOn(tx: Tx, tenantId: string, date: BusinessDate): Promise<DepositRow[]> {
  return tx
    .select()
    .from(deposits)
    .where(and(eq(deposits.tenantId, tenantId), eq(deposits.businessDate, date)))
    .orderBy(asc(deposits.number));
}

/** Setoran belum Diterima/Ditutup sampai tanggal (untuk penghalang tutup kas). */
export async function openDepositsUpTo(tx: Tx, tenantId: string, date: BusinessDate): Promise<DepositRow[]> {
  return tx
    .select()
    .from(deposits)
    .where(and(eq(deposits.tenantId, tenantId), lte(deposits.businessDate, date), inArray(deposits.status, ["running", "submitted"]), eq(deposits.isPartial, false)))
    .orderBy(asc(deposits.businessDate));
}

/** Waktu setoran terakhir tanggal itu Diterima (KPI-02). */
export async function lastReceivedAt(tx: Tx, tenantId: string, date: BusinessDate): Promise<Date | null> {
  const [r] = await tx
    .select({ at: sql<Date | null>`max(${deposits.receivedAt})` })
    .from(deposits)
    .where(and(eq(deposits.tenantId, tenantId), eq(deposits.businessDate, date), isNotNull(deposits.receivedAt)));
  const v = r?.at ?? null;
  return v ? new Date(v) : null;
}

/** Rit hari itu yang masih Berangkat/Tiba (penghalang tutup kas). */
export async function activeTripsOn(tx: Tx, tenantId: string, date: BusinessDate) {
  return tx
    .select({ id: trips.id, number: trips.number, status: trips.status, truckId: trips.truckId, truckCode: trucks.code, driverUserId: trips.driverUserId })
    .from(trips)
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .where(and(eq(trips.tenantId, tenantId), lte(trips.scheduledDate, date), inArray(trips.status, ["departed", "arrived"]), isNull(trips.withdrawnAt)));
}

/** Rit Selesai terakhir pengguna pada tanggal (PAR-44). */
export async function lastCompletedTripAt(tx: Tx, userId: string, date: BusinessDate): Promise<Date | null> {
  const [r] = await tx
    .select({ at: sql<Date | null>`max(${trips.completedAt})` })
    .from(trips)
    .where(and(eq(trips.driverUserId, userId), or(eq(trips.completionBusinessDate, date), and(isNull(trips.completionBusinessDate), eq(trips.scheduledDate, date))), eq(trips.status, "completed")));
  const v = r?.at ?? null;
  return v ? new Date(v) : null;
}

/**
 * Setoran pengecualian diterima → pengecualian "Kas diterima". Pengecualian yang sudah lewat batas (menjadi selisih
 * "setoran tertunda", US-M4-06 KP-2) → selisih itu diselesaikan; selisih sisa hanya dari penerimaan aktual.
 */
export async function resolveExceptionsForDeposit(tx: Tx, ctx: ActorContext, depositId: string): Promise<void> {
  const rows = await tx.select().from(cashCloseExceptions).where(and(eq(cashCloseExceptions.depositId, depositId), inArray(cashCloseExceptions.status, ["approved", "expired"]), isNull(cashCloseExceptions.resolvedAt)));
  if (!rows.length) return;
  const dep = (await tx.select({ number: deposits.number }).from(deposits).where(eq(deposits.id, depositId)).limit(1))[0];
  for (const e of rows) {
    if (e.status === "approved") await tx.update(cashCloseExceptions).set({ status: "resolved", resolvedAt: ctx.now, updatedAt: ctx.now }).where(eq(cashCloseExceptions.id, e.id));
    else await tx.update(cashCloseExceptions).set({ resolvedAt: ctx.now, updatedAt: ctx.now }).where(eq(cashCloseExceptions.id, e.id));
    await auditRecord(tx, { ctx, objectType: "cash_close_exception", objectId: e.id, action: "resolve", before: { status: e.status }, after: { status: e.status === "approved" ? "resolved" : e.status, resolvedAt: ctx.now }, rule: "PTB-21", businessDate: e.businessDate });
    if (e.convertedDiscrepancyId) await resolvePendingDepositDiscrepancy(tx, ctx, e.convertedDiscrepancyId, { depositNumber: dep?.number ?? "" });
  }
}
