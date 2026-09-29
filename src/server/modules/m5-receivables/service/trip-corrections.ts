/**
 * M5 — piutang dari KOREKSI rit M3 oleh Admin Keuangan (tambahan S5, backlog B-34; BR-38, US-M3-10 KP-2, 7.5.6):
 *
 * - `trip.corrected` (harga rit dikoreksi):
 *   - naik (+Δ) → tagihan pelanggan bertambah: rit tagihan bulanan yang belum ditagih → `unbilled_charges.amount` + Δ;
 *     selain itu faktur koreksi (jenis `underpayment`, jatuh tempo H+`underpayment_due_days`) sebesar Δ.
 *   - turun (−Δ) → piutang rit yang masih terbuka dikurangi lebih dulu (belum ditagih bulanan, lalu nota kredit
 *     `trip_correction` atas faktur rit yang masih bersisa); bagian yang melebihi piutang terbuka (`advanceAmount`,
 *     dihitung M3 dengan `tripOpenReceivable` sebelum event) menjadi UANG MUKA pelanggan (tinjau/kembalikan).
 * - `trip_payment.reversed` (pembayaran tunai/transfer rit dibalik) → pelanggan kembali berutang sebesar uang yang
 *   dibalik: faktur koreksi jenis `underpayment` (M4 membatalkan transfer rit yang belum cocok; M11 D piutang / K kas).
 *
 * Jurnal: pendapatan/piutang dijurnal M11 dari `trip.corrected` / `trip_payment.reversed` (peristiwa sumber, D-10
 * butir 1). Faktur koreksi (`invoice.issued`) & nota kredit `trip_correction` TIDAK dijurnal ulang (M11 melewatinya).
 * Semua handler IDEMPOTEN: kunci = `correctionId` / `reversalId` di keterangan dokumen.
 */
import "server-only";

import { and, eq, gt, inArray, like } from "drizzle-orm";

import { creditNotes, customerAdvances, invoiceLines, invoices, trips, unbilledCharges } from "@/db/schema";
import { formatRupiah } from "@/lib/money";
import { addDays, type BusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import type { Tx } from "@/server/core/db";
import type { DomainEvent } from "@/server/core/events";

import { receivableRules } from "./common";
import { afterReceivablesChanged } from "./credit-hold";
import { createAdvance, issueCreditNote, issueInvoice, recomputeInvoice } from "./ledger";

export type TripOpenReceivable = {
  /** Rit tagihan bulanan yang belum ditagih. */
  unbilled: { id: string; amount: number } | null;
  /** Faktur rit yang masih bersisa (kurang bayar/koreksi dulu, lalu faktur kirim; faktur bulanan dibatasi baris rit). */
  invoices: { id: string; number: string; kind: string; outstanding: number }[];
  /** Total piutang rit yang masih terbuka. */
  total: number;
};

/** Piutang rit yang masih terbuka (belum ditagih + sisa faktur rit). Dipakai M3 sebelum `trip.corrected` (B-34). */
export async function tripOpenReceivable(tx: Tx, tripId: string): Promise<TripOpenReceivable> {
  const [charge] = await tx
    .select({ id: unbilledCharges.id, amount: unbilledCharges.amount })
    .from(unbilledCharges)
    .where(and(eq(unbilledCharges.tripId, tripId), eq(unbilledCharges.status, "unbilled")))
    .limit(1);
  const own = await tx
    .select({ id: invoices.id, number: invoices.number, kind: invoices.kind, outstanding: invoices.outstandingAmount })
    .from(invoices)
    .where(and(eq(invoices.tripId, tripId), gt(invoices.outstandingAmount, 0)));
  // Faktur bulanan: rit menjadi baris faktur (faktur tanpa `trip_id`) — sisa dibatasi nilai baris rit itu.
  const monthly = await tx
    .select({ id: invoices.id, number: invoices.number, kind: invoices.kind, outstanding: invoices.outstandingAmount, lineAmount: invoiceLines.amount })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(eq(invoiceLines.tripId, tripId), gt(invoices.outstandingAmount, 0)));
  const seen = new Set(own.map((i) => i.id));
  const rows = [
    // Kurang bayar & koreksi dulu (jatuh tempo lebih awal), lalu faktur kirim.
    ...own.sort((a, b) => (a.kind === "underpayment" ? 0 : 1) - (b.kind === "underpayment" ? 0 : 1)),
    ...monthly.filter((m) => !seen.has(m.id)).map((m) => ({ id: m.id, number: m.number, kind: m.kind, outstanding: Math.min(m.outstanding, m.lineAmount) })),
  ];
  const unbilled = charge && charge.amount > 0 ? charge : null;
  return { unbilled, invoices: rows, total: (unbilled?.amount ?? 0) + rows.reduce((s, r) => s + r.outstanding, 0) };
}

async function loadTrip(tx: Tx, tripId: string) {
  const [trip] = await tx.select().from(trips).where(eq(trips.id, tripId)).limit(1);
  return trip ?? null;
}

async function correctionInvoice(
  tx: Tx,
  ctx: ActorContext,
  input: { trip: NonNullable<Awaited<ReturnType<typeof loadTrip>>>; key: string; amount: number; date: BusinessDate; title: string; detail: string; reason: string },
): Promise<string> {
  const { trip } = input;
  const [dup] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.tripId, trip.id), like(invoices.description, `%[${input.key}]%`)))
    .limit(1);
  if (dup) return dup.id;
  const rules = await receivableRules(tx, input.date, trip.tenantId);
  const inv = await issueInvoice(tx, ctx, {
    tenantId: trip.tenantId,
    customerId: trip.customerId,
    kind: "underpayment",
    addressId: trip.addressId,
    tripId: trip.id,
    issueDate: input.date,
    dueDate: addDays(input.date, rules.underpayment_due_days),
    description: `${input.title} rit ${trip.number} [${input.key}]`,
    lines: [{ component: "trip", description: input.detail, tripId: trip.id, serviceDate: input.date, quantity: 1, unitPrice: input.amount, amount: input.amount, volumeL: trip.deliveredVolumeL ?? trip.plannedVolumeL }],
    rule: "BR-38, B-34",
    reason: input.reason,
  });
  return inv.id;
}

export type TripCorrectionResult = { invoiceId: string | null; creditNoteIds: string[]; unbilledAdjusted: number; advanceId: string | null };

/** Koreksi dengan kunci ini sudah diterapkan (event diputar ulang) — dokumen M5 mana pun memuat `[kunci]`. */
async function correctionApplied(tx: Tx, tripId: string, customerId: string, key: string): Promise<boolean> {
  const tag = `%[${key}]%`;
  const checks = await Promise.all([
    tx.select({ id: unbilledCharges.id }).from(unbilledCharges).where(and(eq(unbilledCharges.tripId, tripId), like(unbilledCharges.description, tag))).limit(1),
    tx.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.tripId, tripId), like(invoices.description, tag))).limit(1),
    tx.select({ id: creditNotes.id }).from(creditNotes).where(and(eq(creditNotes.customerId, customerId), like(creditNotes.reason, tag))).limit(1),
    tx.select({ id: customerAdvances.id }).from(customerAdvances).where(and(eq(customerAdvances.customerId, customerId), like(customerAdvances.notes, tag))).limit(1),
  ]);
  return checks.some((rows) => rows.length > 0);
}

/** `trip.corrected` → faktur koreksi / pengurangan piutang rit / uang muka (idempoten per `correctionId`). */
export async function onTripCorrected(tx: Tx, ctx: ActorContext, event: DomainEvent<"trip.corrected">): Promise<TripCorrectionResult | null> {
  const p = event.payload;
  const out: TripCorrectionResult = { invoiceId: null, creditNoteIds: [], unbilledAdjusted: 0, advanceId: null };
  if (!p.priceDelta) return out;
  const trip = await loadTrip(tx, p.tripId);
  if (!trip || trip.isInternal) return null;
  const key = p.correctionId ?? event.id;
  if (await correctionApplied(tx, trip.id, trip.customerId, key)) return out;
  const date = (p.businessDate ?? event.businessDate ?? ctxBusinessDate(ctx)) as BusinessDate;
  const why = `Koreksi harga rit ${trip.number} oleh Admin Keuangan: ${p.reason}`;
  const open = await tripOpenReceivable(tx, trip.id);

  const adjustUnbilled = async (chargeId: string, delta: number) => {
    const [row] = await tx.select().from(unbilledCharges).where(eq(unbilledCharges.id, chargeId)).for("update").limit(1);
    const sign = delta > 0 ? "+" : "−";
    await tx
      .update(unbilledCharges)
      .set({ amount: row!.amount + delta, description: `${row!.description} · koreksi ${sign}${formatRupiah(Math.abs(delta))} [${key}]`, updatedAt: ctx.now })
      .where(eq(unbilledCharges.id, row!.id));
    await auditRecord(tx, { ctx, objectType: "unbilled_charge", objectId: row!.id, action: "trip_correction", before: { amount: row!.amount }, after: { amount: row!.amount + delta, correctionId: key }, reason: why, rule: "BR-38, B-34" });
    out.unbilledAdjusted = delta;
  };

  if (p.priceDelta > 0) {
    // Tagihan bulanan belum terbit → nilai rit yang belum ditagih ikut naik; selain itu faktur koreksi.
    if (open.unbilled) await adjustUnbilled(open.unbilled.id, p.priceDelta);
    else {
      out.invoiceId = await correctionInvoice(tx, ctx, {
        trip,
        key,
        amount: p.priceDelta,
        date,
        title: "Koreksi harga",
        detail: `Koreksi harga rit ${trip.number}: +${formatRupiah(p.priceDelta)} (${p.reason})`,
        reason: why,
      });
    }
    await afterReceivablesChanged(tx, ctx, [trip.customerId]);
    return out;
  }

  // --- Harga turun: piutang rit terbuka dikurangi dulu, sisanya uang muka ---
  const decrease = -p.priceDelta;
  const toAdvance = Math.min(decrease, Math.max(0, p.advanceAmount ?? 0));
  let remaining = decrease - toAdvance;
  if (remaining > 0 && open.unbilled) {
    const cut = Math.min(remaining, open.unbilled.amount);
    await adjustUnbilled(open.unbilled.id, -cut);
    remaining -= cut;
  }
  for (const inv of open.invoices) {
    if (remaining <= 0) break;
    await recomputeInvoice(tx, ctx, inv.id);
    const [fresh] = await tx.select({ outstanding: invoices.outstandingAmount }).from(invoices).where(eq(invoices.id, inv.id)).limit(1);
    const cut = Math.min(remaining, inv.outstanding, fresh?.outstanding ?? 0);
    if (cut <= 0) continue;
    const res = await issueCreditNote(tx, ctx, { invoiceId: inv.id, amount: cut, reason: `${why} [${key}]`, purpose: "trip_correction", issueDate: date });
    if (res.creditNote) out.creditNoteIds.push(res.creditNote.id);
    remaining -= res.applied;
  }
  // Bagian yang tidak tertampung piutang terbuka (rit sudah dibayar) → uang muka pelanggan (Admin Keuangan meninjau).
  const advance = toAdvance + Math.max(0, remaining);
  if (advance > 0) {
    const adv = await createAdvance(tx, ctx, {
      tenantId: trip.tenantId,
      customerId: trip.customerId,
      amount: advance,
      notes: `Kelebihan bayar karena koreksi harga rit ${trip.number} (−${formatRupiah(decrease)}): ${p.reason} [${key}]`,
    });
    out.advanceId = adv.id;
  }
  await afterReceivablesChanged(tx, ctx, [trip.customerId]);
  return out;
}

/** `trip_payment.reversed` (tunai/transfer) → faktur koreksi sebesar uang yang dibalik (idempoten per `reversalId`). */
export async function onTripPaymentReversed(tx: Tx, ctx: ActorContext, event: DomainEvent<"trip_payment.reversed">): Promise<string | null> {
  const p = event.payload;
  if ((p.method !== "cash" && p.method !== "transfer") || p.amount <= 0) return null;
  const trip = await loadTrip(tx, p.tripId);
  if (!trip || trip.isInternal) return null;
  const date = (p.businessDate ?? event.businessDate ?? ctxBusinessDate(ctx)) as BusinessDate;
  const id = await correctionInvoice(tx, ctx, {
    trip,
    key: p.reversalId,
    amount: p.amount,
    date,
    title: "Pembalik pembayaran",
    detail: `Pembayaran ${p.method === "cash" ? "tunai" : "transfer"} rit ${trip.number} ${formatRupiah(p.amount)} dibalik Admin Keuangan: ${p.reason}`,
    reason: p.reason,
  });
  await afterReceivablesChanged(tx, ctx, [trip.customerId]);
  return id;
}

/** Faktur koreksi rit (untuk layar/uji): faktur `underpayment` rit yang keterangannya memuat kunci koreksi. */
export async function correctionInvoicesFor(tx: Tx, tripIds: string[]) {
  if (!tripIds.length) return [];
  return tx
    .select({ id: invoices.id, number: invoices.number, tripId: invoices.tripId, amount: invoices.amount, description: invoices.description })
    .from(invoices)
    .where(and(inArray(invoices.tripId, tripIds), eq(invoices.kind, "underpayment"), like(invoices.description, "%[%]%")));
}
