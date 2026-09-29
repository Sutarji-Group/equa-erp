/**
 * M4 — Selisih (Bab 5.2; BR-09, BR-11, BR-12; US-M4-02 KP-3/4/10, US-M4-03, US-M4-06 KP-6).
 *
 * Siklus: Terbentuk → Dijelaskan (alasan penyetor/Admin Keuangan) → Disetujui/Ditolak (pemilik; wajib bila ≥ PAR-01,
 * lewat persetujuan `cash_discrepancy` ≤ 24 jam, lewat tenggat tetap terbuka & naik ke puncak) → Ditindaklanjuti →
 * Selesai. Di bawah ambang: ditutup Admin Keuangan saat setoran ditutup (Selesai) dan dapat dibuka kembali pemilik
 * ≤ `m4.cash_rules.discrepancy_reopen_days`. Disetujui → beban selisih kas pusat laba sumber (M11 lewat
 * `discrepancy.decided`); Ditolak → ganti rugi karyawan bila flag `cash.restitution_active` (PTB-22), dikembalikan ke
 * Admin Keuangan untuk ditindaklanjuti. Alur selisih tidak menahan penutupan setoran; PAR-83 (PTB-62) mengunci rit sopir
 * lewat `discrepancies.locks_trips` (dibaca M3 `driverLock`).
 */
import "server-only";

import { and, desc, eq, gte, inArray, lte, ne } from "drizzle-orm";

import { approvalRequests, deposits, discrepancies, employees, outlets, restitutions, shifts, tripPayments, trips, trucks } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, firstDayOfMonth, formatTanggal, monthOf, toBusinessDate, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput } from "@/server/core/errors";
import { emit } from "@/server/core/events";
import { isEnabled } from "@/server/core/flags";
import { markActionedForObject, notify } from "@/server/core/notifications";
import { authorize, runService } from "@/server/core/rbac";

import { completeFollowUpSchema, decideDiscrepancySchema, explainDiscrepancySchema, reopenDiscrepancySchema } from "../schemas";
import { cashRules, employeeNames, profitCenterFor, userIdOfEmployee, type DiscrepancyReason, type DiscrepancySource } from "./common";

export type DiscrepancyRow = typeof discrepancies.$inferSelect;

const OPEN_STATUSES = ["formed", "explained", "approved", "rejected", "followed_up"] as const;

export function discrepancySourceType(source: DiscrepancySource): "driver" | "depot_shift" | "store_shift" | "office_cash" | "stock" {
  if (source === "driver" || source === "depot_shift" || source === "store_shift") return source;
  if (source === "pending_deposit") return "driver";
  return "office_cash";
}

async function loadDiscrepancy(tx: Tx, ctx: ActorContext, id: string, opts: { forUpdate?: boolean } = {}): Promise<DiscrepancyRow> {
  const q = tx.select().from(discrepancies).where(eq(discrepancies.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  const row = rows[0];
  if (!row || row.tenantId !== ctx.tenantId) throw new NotFoundError("Selisih tidak ditemukan.");
  return row;
}

// =====================================================================================================================
// Pembentukan (dipakai penerimaan setoran, tutup kas, kas kecil, pengecualian lewat 24 jam)
// =====================================================================================================================

export type FormDiscrepancyInput = {
  tenantId: string;
  source: DiscrepancySource;
  businessDate: BusinessDate;
  /** Bertanda: negatif = kurang, positif = lebih. */
  amount: number;
  depositId?: string | null;
  employeeId?: string | null;
  userId?: string | null;
  truckId?: string | null;
  outletId?: string | null;
  shiftId?: string | null;
  reason?: DiscrepancyReason | null;
  reasonNote?: string | null;
  explanation?: string | null;
  evidenceAttachmentId?: string | null;
  /** Nama sumber untuk judul notifikasi/persetujuan. */
  sourceLabel: string;
};

/**
 * Bentuk objek Selisih (US-M4-02 KP-3). Beralasan → Dijelaskan; |selisih| ≥ PAR-01 → notifikasi kritis pemilik &
 * Admin Keuangan + persetujuan `cash_discrepancy` (bila pelaku Admin Keuangan). PAR-83 → `locks_trips`.
 */
export async function formDiscrepancy(tx: Tx, ctx: ActorContext, input: FormDiscrepancyInput): Promise<DiscrepancyRow> {
  const rules = await cashRules(tx, input.businessDate, input.tenantId);
  const locksTrips =
    (input.source === "driver" || input.source === "pending_deposit") && input.amount < 0 && rules.tripLock.enabled && -input.amount >= rules.tripLock.amountGte;
  // 6.2a `cash_discrepancy`: ambang PAR-01 berlaku "per sopir/outlet per hari" — selisih lain sumber yang sama pada
  // tanggal itu ikut dijumlahkan, sehingga kekurangan yang dipecah (dua shift, shift dibuka-tutup) tetap ke pemilik.
  const siblings = await sameSourceDayDiscrepancies(tx, input);
  const dayTotal = siblings.reduce((sum, d) => sum + d.amount, 0) + input.amount;
  const overDaily = siblings.length > 0 && Math.abs(dayTotal) >= rules.discrepancyThreshold;
  // PAR-83 (PTB-62): kunci rit bertahan "sampai pemilik memutuskan" — selisih yang mengunci SELALU menunggu keputusan
  // pemilik, juga bila ambang PAR-83 diatur di bawah PAR-01 (tidak ikut ditutup Admin Keuangan bersama setoran).
  const requiresOwnerDecision = Math.abs(input.amount) >= rules.discrepancyThreshold || overDaily || locksTrips;
  const explained = !!input.reason;
  const [row] = await tx
    .insert(discrepancies)
    .values({
      tenantId: input.tenantId,
      source: input.source,
      depositId: input.depositId ?? null,
      employeeId: input.employeeId ?? null,
      userId: input.userId ?? null,
      truckId: input.truckId ?? null,
      outletId: input.outletId ?? null,
      shiftId: input.shiftId ?? null,
      businessDate: input.businessDate,
      amount: input.amount,
      status: explained ? "explained" : "formed",
      reason: input.reason ?? null,
      reasonNote: input.reasonNote ?? null,
      explanation: input.explanation ?? input.reasonNote ?? null,
      explainedBy: explained ? ctx.userId : null,
      explainedAt: explained ? ctx.now : null,
      requiresOwnerDecision,
      locksTrips,
      evidenceAttachmentId: input.evidenceAttachmentId ?? null,
      createdBy: ctx.userId,
    })
    .returning();
  const disc = row!;
  await auditRecord(tx, {
    ctx,
    objectType: "discrepancy",
    objectId: disc.id,
    action: "create",
    after: { source: disc.source, amount: disc.amount, status: disc.status, reason: disc.reason, requiresOwnerDecision, locksTrips, depositId: disc.depositId },
    reason: input.reasonNote ?? null,
    rule: requiresOwnerDecision ? "BR-09" : "US-M4-02 KP-3",
    businessDate: input.businessDate,
  });
  let approvalId: string | null = null;
  if (requiresOwnerDecision) {
    await notify(tx, {
      event: "discrepancy.over_threshold",
      tenantId: input.tenantId,
      title: `Selisih ${formatRupiah(disc.amount, { signed: true })} — ${input.sourceLabel}`,
      body: `${formatTanggal(input.businessDate, { weekday: false })}. ${disc.reason ? `Alasan: ${label("discrepancy_reason", disc.reason)}${disc.reasonNote ? ` — ${disc.reasonNote}` : ""}.` : "Menunggu penjelasan."} Keputusan pemilik ≤ ${rules.followUpHours} jam.`,
      objectType: "discrepancy",
      objectId: disc.id,
      valueAmount: disc.amount,
      link: `/kas/selisih?id=${disc.id}`,
      groupKey: `discrepancy.over_threshold:${disc.id}`,
      now: ctx.now,
    });
    if (explained && ctx.userId && ctx.roles.includes("finance_admin")) approvalId = await submitOwnerDecision(tx, ctx, disc, input.sourceLabel);
    if (overDaily) await escalateSameDaySiblings(tx, ctx, siblings, { total: dayTotal, sourceLabel: input.sourceLabel });
  }
  await emit(
    tx,
    "discrepancy.formed",
    {
      discrepancyId: disc.id,
      depositId: disc.depositId,
      sourceType: discrepancySourceType(disc.source),
      amount: disc.amount,
      overThreshold: requiresOwnerDecision,
      employeeId: disc.employeeId,
      profitCenter: profitCenterFor(disc.source),
      businessDate: disc.businessDate,
      userId: disc.userId,
      truckId: disc.truckId,
      outletId: disc.outletId,
      shiftId: disc.shiftId,
      reason: disc.reason,
      source: disc.source,
      locksTrips,
      approvalId,
    },
    { ctx, tenantId: input.tenantId, businessDate: input.businessDate, objectType: "discrepancy", objectId: disc.id },
  );
  return approvalId ? { ...disc, approvalRequestId: approvalId } : disc;
}

/**
 * Selisih lain dari sumber yang sama pada tanggal bisnis yang sama (6.2a "per sopir/outlet per hari"): setoran sopir per
 * karyawan (atau pengguna), shift depot/toko per outlet. Setoran tertunda (`pending_deposit`) bukan hasil hitung — tidak
 * ikut dijumlahkan. Sumber lain (kas kantor, kas kecil) dinilai per kejadian.
 */
async function sameSourceDayDiscrepancies(tx: Tx, input: FormDiscrepancyInput): Promise<DiscrepancyRow[]> {
  const base = [eq(discrepancies.tenantId, input.tenantId), eq(discrepancies.businessDate, input.businessDate)];
  if (input.source === "driver") {
    if (input.employeeId) return tx.select().from(discrepancies).where(and(...base, eq(discrepancies.source, "driver"), eq(discrepancies.employeeId, input.employeeId)));
    if (input.userId) return tx.select().from(discrepancies).where(and(...base, eq(discrepancies.source, "driver"), eq(discrepancies.userId, input.userId)));
    return [];
  }
  if ((input.source === "depot_shift" || input.source === "store_shift") && input.outletId) {
    return tx.select().from(discrepancies).where(and(...base, eq(discrepancies.source, input.source), eq(discrepancies.outletId, input.outletId)));
  }
  return [];
}

/**
 * Total selisih hari itu ≥ PAR-01 → selisih lain sumber yang sama ikut menunggu keputusan pemilik: yang sudah ditutup
 * Admin Keuangan di bawah ambang dibuka kembali, yang sudah dijelaskan diajukan `cash_discrepancy` (BR-09, 6.2a).
 */
async function escalateSameDaySiblings(tx: Tx, ctx: ActorContext, siblings: DiscrepancyRow[], info: { total: number; sourceLabel: string }): Promise<void> {
  const reason = `Total selisih ${info.sourceLabel} hari itu ${formatRupiah(info.total, { signed: true })} mencapai ambang keputusan pemilik (PAR-01 per sopir/outlet per hari).`;
  for (const d of siblings) {
    if (d.decision || d.requiresOwnerDecision) continue;
    const reopen = d.status === "done" && !!d.closedBelowThresholdAt;
    const status = reopen ? (d.reason ? "explained" : "formed") : d.status;
    const [row] = await tx
      .update(discrepancies)
      .set({
        requiresOwnerDecision: true,
        status,
        doneAt: reopen ? null : d.doneAt,
        reopenedAt: reopen ? ctx.now : d.reopenedAt,
        reopenedBy: reopen ? ctx.userId : d.reopenedBy,
        reopenReason: reopen ? reason : d.reopenReason,
        updatedAt: ctx.now,
      })
      .where(eq(discrepancies.id, d.id))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "discrepancy",
      objectId: d.id,
      action: reopen ? "reopen" : "escalate",
      before: { status: d.status, requiresOwnerDecision: false },
      after: { status, requiresOwnerDecision: true },
      reason,
      rule: "BR-09, 6.2a",
      businessDate: d.businessDate,
    });
    if (row!.status === "explained" && !row!.approvalRequestId && ctx.userId && ctx.roles.includes("finance_admin")) {
      await submitOwnerDecision(tx, ctx, row!, await sourceLabelOf(tx, row!));
    }
  }
}

/** Ajukan keputusan pemilik (6.2a `cash_discrepancy`, Admin Keuangan atas nama sopir/outlet, tenggat 24 jam). */
async function submitOwnerDecision(tx: Tx, ctx: ActorContext, disc: DiscrepancyRow, sourceLabel: string): Promise<string> {
  const reasonText = `${sourceLabel} ${formatTanggal(disc.businessDate, { weekday: false })}: selisih ${formatRupiah(disc.amount, { signed: true })}. Alasan: ${disc.reason ? label("discrepancy_reason", disc.reason) : "—"}${disc.reasonNote ? ` — ${disc.reasonNote}` : ""}`;
  const req = await approvals.submit(
    ctx,
    {
      type: "cash_discrepancy",
      objectType: "discrepancy",
      objectId: disc.id,
      amount: disc.amount,
      reason: reasonText,
      businessDate: disc.businessDate,
      payload: {
        link: `/kas/selisih?id=${disc.id}`,
        source: disc.source,
        sourceLabel,
        businessDate: disc.businessDate,
        reason: disc.reason,
        reasonNote: disc.reasonNote,
        depositId: disc.depositId,
        locksTrips: disc.locksTrips,
      },
    },
    { tx },
  );
  await tx.update(discrepancies).set({ approvalRequestId: req.id, updatedAt: ctx.now }).where(eq(discrepancies.id, disc.id));
  return req.id;
}

/** Rujukan kejadian ganti rugi (US-M4-03 KP-2 "rit/shift"): rit bertunai pada setoran sopir, atau shift outlet. */
async function incidentReference(tx: Tx, disc: DiscrepancyRow): Promise<{ tripIds: string[]; text: string | null }> {
  if (disc.shiftId) {
    const s = (await tx.select({ code: outlets.code, date: shifts.businessDate }).from(shifts).innerJoin(outlets, eq(outlets.id, shifts.outletId)).where(eq(shifts.id, disc.shiftId)).limit(1))[0];
    return { tripIds: [], text: s ? `shift ${s.code} ${formatTanggal(s.date, { weekday: false })}` : null };
  }
  if (!disc.depositId) return { tripIds: [], text: null };
  const rows = await tx
    .selectDistinct({ id: trips.id, number: trips.number })
    .from(tripPayments)
    .innerJoin(trips, eq(trips.id, tripPayments.tripId))
    .where(eq(tripPayments.depositId, disc.depositId))
    .orderBy(trips.number);
  const dep = (await tx.select({ number: deposits.number }).from(deposits).where(eq(deposits.id, disc.depositId)).limit(1))[0];
  const numbers = rows.map((r) => r.number);
  const tripText = numbers.length ? `rit ${numbers.slice(0, 5).join(", ")}${numbers.length > 5 ? ` +${numbers.length - 5}` : ""}` : null;
  return { tripIds: rows.map((r) => r.id), text: [dep ? `setoran ${dep.number}` : null, tripText].filter(Boolean).join(", ") || null };
}

async function sourceLabelOf(tx: Tx, disc: DiscrepancyRow): Promise<string> {
  if (disc.outletId) {
    const o = (await tx.select({ code: outlets.code, name: outlets.name }).from(outlets).where(eq(outlets.id, disc.outletId)).limit(1))[0];
    if (o) return `${label("discrepancy_source", disc.source)} ${o.code} — ${o.name}`;
  }
  if (disc.employeeId) {
    const e = (await employeeNames(tx, [disc.employeeId])).get(disc.employeeId);
    if (e) return `${label("discrepancy_source", disc.source)} — ${e.name}`;
  }
  return label("discrepancy_source", disc.source);
}

/** Tutup selisih di bawah ambang saat setoran ditutup Admin Keuangan (US-M4-02 KP-4; dapat dibuka kembali pemilik). */
export async function closeBelowThreshold(tx: Tx, ctx: ActorContext, depositId: string): Promise<number> {
  const rows = await tx
    .select()
    .from(discrepancies)
    .where(and(eq(discrepancies.depositId, depositId), eq(discrepancies.status, "explained"), eq(discrepancies.requiresOwnerDecision, false)));
  for (const d of rows) {
    await tx
      .update(discrepancies)
      .set({ status: "done", closedBelowThresholdBy: ctx.userId, closedBelowThresholdAt: ctx.now, doneAt: ctx.now, updatedAt: ctx.now })
      .where(eq(discrepancies.id, d.id));
    await auditRecord(tx, { ctx, objectType: "discrepancy", objectId: d.id, action: "close", before: { status: d.status }, after: { status: "done", closedBelowThreshold: true }, rule: "US-M4-02 KP-4", businessDate: d.businessDate });
  }
  return rows.length;
}

/**
 * Setoran tertunda yang sudah lewat batas (US-M4-06 KP-2) akhirnya DITERIMA: selisih "setoran tertunda" sebesar seluruh
 * setoran diselesaikan ("kas diterima") — tidak lagi menunggu keputusan pemilik, tidak mengunci rit, tidak dihitung
 * KPI-03 sebagai terbuka. Persetujuan yang masih menunggu dibatalkan; bila pemilik sudah MENOLAK dan ganti rugi
 * tercatat (BR-11c), beban ganti rugi gugur dan jurnal piutang karyawan dibalik (`discrepancy.reopened` → M11).
 * Selisih sisa hanya berasal dari penerimaan aktual (dibentuk `receiveDepositCore`).
 */
export async function resolvePendingDepositDiscrepancy(tx: Tx, ctx: ActorContext, discrepancyId: string, info: { depositNumber: string }): Promise<boolean> {
  const disc = (await tx.select().from(discrepancies).where(eq(discrepancies.id, discrepancyId)).for("update").limit(1))[0];
  if (!disc || disc.source !== "pending_deposit") return false;
  const note = `Kas setoran ${info.depositNumber} diterima ${formatTanggal(toBusinessDate(ctx.now), { weekday: false })} — selisih setoran tertunda diselesaikan.`;
  if (disc.status === "done" && disc.decision !== "rejected") return false;
  if (disc.approvalRequestId) {
    const req = (await tx.select().from(approvalRequests).where(eq(approvalRequests.id, disc.approvalRequestId)).limit(1))[0];
    if (req?.status === "submitted") await approvals.cancel(systemContext({ tenantId: disc.tenantId, now: ctx.now }), req.id, note, { tx });
  }
  let restitutionVoided: string | null = null;
  if (disc.decision === "rejected") {
    const rest = (await tx.select().from(restitutions).where(eq(restitutions.discrepancyId, disc.id)).for("update").limit(1))[0];
    if (rest && rest.status !== "settled") {
      await tx.update(restitutions).set({ settledAmount: rest.amount, status: "settled", settledAt: ctx.now, updatedAt: ctx.now }).where(eq(restitutions.id, rest.id));
      await auditRecord(tx, { ctx, objectType: "restitution", objectId: rest.id, action: "void", before: { status: rest.status, settledAmount: rest.settledAmount }, after: { status: "settled", settledAmount: rest.amount }, reason: `Ganti rugi gugur: ${note}`, rule: "BR-11c, US-M4-06 KP-2", businessDate: rest.businessDate });
      restitutionVoided = rest.id;
    }
    await emit(
      tx,
      "discrepancy.reopened",
      { discrepancyId: disc.id, previousDecision: "rejected", amount: disc.amount, employeeId: disc.employeeId, profitCenter: profitCenterFor(disc.source), reason: note },
      { ctx, tenantId: disc.tenantId, businessDate: disc.businessDate, objectType: "discrepancy", objectId: disc.id },
    );
  }
  await tx
    .update(discrepancies)
    .set({ status: "done", locksTrips: false, followUpNote: note, followedUpBy: ctx.userId, followedUpAt: disc.followedUpAt ?? ctx.now, doneAt: ctx.now, updatedAt: ctx.now })
    .where(eq(discrepancies.id, disc.id));
  await auditRecord(tx, { ctx, objectType: "discrepancy", objectId: disc.id, action: "resolve", before: { status: disc.status, decision: disc.decision }, after: { status: "done", restitutionVoided }, reason: note, rule: "US-M4-06 KP-2, PTB-21", businessDate: disc.businessDate });
  await markActionedForObject(tx, { objectType: "discrepancy", objectId: disc.id, now: ctx.now });
  return true;
}

// =====================================================================================================================
// Keputusan pemilik (US-M4-03 KP-2; US-M4-06 KP-6 satu ketuk dari ringkasan H+0)
// =====================================================================================================================

/**
 * Terapkan keputusan (dipanggil handler persetujuan `cash_discrepancy` dengan ctx pemilik, atau keputusan langsung atas
 * selisih yang dibuka kembali pemilik). Menulis langsung dengan `tx` (bukan layanan harian — SOD-08).
 */
export async function applyDiscrepancyDecision(tx: Tx, ctx: ActorContext, discrepancyId: string, decision: "approved" | "rejected", reason: string | null, opts: { approvalId?: string | null } = {}) {
  const disc = (await tx.select().from(discrepancies).where(eq(discrepancies.id, discrepancyId)).for("update").limit(1))[0];
  if (!disc) throw new NotFoundError("Selisih tidak ditemukan.");
  if (disc.decision) throw new DomainError("DISCREPANCY_DECIDED", `Selisih ini sudah diputuskan (${label("discrepancy_decision", disc.decision)}).`);
  const tenantId = disc.tenantId;
  const restitutionActive = await isEnabled(tx, "cash.restitution_active", { tenantId });
  let restitutionId: string | null = null;
  let status: DiscrepancyRow["status"];
  if (decision === "approved") {
    status = "done";
  } else if (restitutionActive && disc.amount < 0 && disc.employeeId) {
    // BR-11c: beban ganti rugi karyawan per kejadian (karyawan, tanggal, jumlah, rit/shift, alasan) — sistem tidak
    // memotong gaji.
    const ref = await incidentReference(tx, disc);
    const [rest] = await tx
      .insert(restitutions)
      .values({
        tenantId,
        employeeId: disc.employeeId,
        discrepancyId: disc.id,
        businessDate: disc.businessDate,
        amount: -disc.amount,
        tripId: ref.tripIds.length === 1 ? ref.tripIds[0]! : null,
        shiftId: disc.shiftId,
        reason: `${label("discrepancy_source", disc.source)} ${formatTanggal(disc.businessDate, { weekday: false })}${ref.text ? ` (${ref.text})` : ""}: ${disc.reason ? label("discrepancy_reason", disc.reason) : "selisih kurang"}${reason ? ` — ditolak: ${reason}` : ""}`,
        createdBy: ctx.userId,
      })
      .returning();
    restitutionId = rest!.id;
    status = "followed_up";
    await auditRecord(tx, { ctx, objectType: "restitution", objectId: rest!.id, action: "create", after: { employeeId: disc.employeeId, amount: rest!.amount, discrepancyId: disc.id }, rule: "BR-11c, PTB-22", businessDate: disc.businessDate });
    await emit(
      tx,
      "restitution.recorded",
      { restitutionId: rest!.id, employeeId: disc.employeeId, amount: rest!.amount, discrepancyId: disc.id, businessDate: disc.businessDate, profitCenter: profitCenterFor(disc.source) },
      { ctx, tenantId, businessDate: disc.businessDate, objectType: "restitution", objectId: rest!.id },
    );
    const employeeUser = await userIdOfEmployee(tx, disc.employeeId);
    await notify(tx, {
      event: "restitution.recorded",
      tenantId,
      recipients: { roles: ["finance_admin"], userIds: employeeUser ? [employeeUser] : [] },
      title: `Ganti rugi tercatat ${formatRupiah(rest!.amount)}`,
      body: rest!.reason,
      objectType: "restitution",
      objectId: rest!.id,
      valueAmount: rest!.amount,
      link: "/kas/ganti-rugi",
      now: ctx.now,
    });
  } else {
    status = "rejected";
  }
  const [updated] = await tx
    .update(discrepancies)
    .set({
      status,
      decision,
      decidedBy: ctx.userId,
      decidedAt: ctx.now,
      decisionReason: reason,
      locksTrips: false,
      followedUpAt: status === "followed_up" ? ctx.now : disc.followedUpAt,
      doneAt: status === "done" ? ctx.now : null,
      approvalRequestId: opts.approvalId ?? disc.approvalRequestId,
      updatedAt: ctx.now,
    })
    .where(eq(discrepancies.id, disc.id))
    .returning();
  await auditRecord(tx, {
    ctx,
    objectType: "discrepancy",
    objectId: disc.id,
    action: decision === "approved" ? "approve" : "reject",
    before: { status: disc.status },
    after: { status, decision, restitutionId, restitutionActive },
    reason,
    rule: "BR-09, US-M4-03 KP-2",
    businessDate: disc.businessDate,
  });
  await emit(
    tx,
    "discrepancy.decided",
    {
      discrepancyId: disc.id,
      decision,
      amount: disc.amount,
      employeeId: disc.employeeId,
      restitutionActive,
      profitCenter: profitCenterFor(disc.source),
      source: disc.source,
      depositId: disc.depositId,
      businessDate: disc.businessDate,
      outletId: disc.outletId,
      truckId: disc.truckId,
      restitutionId,
      decidedBy: ctx.userId,
      reason,
    },
    { ctx, tenantId, businessDate: disc.businessDate, objectType: "discrepancy", objectId: disc.id },
  );
  await markActionedForObject(tx, { objectType: "discrepancy", objectId: disc.id, now: ctx.now });
  if (decision === "rejected") {
    // US-M4-06 KP-6: penolakan mengembalikan selisih ke Admin Keuangan.
    await notify(tx, {
      event: "discrepancy.returned",
      tenantId,
      title: `Selisih ${formatRupiah(disc.amount, { signed: true })} ditolak pemilik`,
      body: `${await sourceLabelOf(tx, disc)} ${formatTanggal(disc.businessDate, { weekday: false })}.${reason ? ` Alasan: ${reason}.` : ""} ${restitutionId ? "Ganti rugi karyawan tercatat." : restitutionActive ? "" : "Ganti rugi belum aktif — tercatat tanpa beban."} Tindak lanjuti lalu tandai Selesai.`,
      objectType: "discrepancy",
      objectId: disc.id,
      valueAmount: disc.amount,
      link: `/kas/selisih?id=${disc.id}`,
      groupKey: `discrepancy.returned:${disc.id}`,
      now: ctx.now,
    });
  }
  return { discrepancy: updated!, restitutionId };
}

/**
 * Pemilik memutuskan selisih (dashboard M9 / layar selisih): lewat persetujuan `cash_discrepancy` yang terbuka, atau
 * langsung untuk selisih yang dibuka kembali pemilik (US-M4-03 KP-5).
 */
export async function decideDiscrepancy(ctx: ActorContext, id: string, input: { decision: "approve" | "reject"; reason?: string | null }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m4.discrepancy.decide", { tx: opts.tx, objectType: "discrepancy", objectId: id });
  const data = parseInput(decideDiscrepancySchema, input, { decision: "Keputusan", reason: "Alasan" });
  if (data.decision === "reject" && (!data.reason || data.reason.length < 3)) throw new DomainError("REASON_REQUIRED", "Alasan wajib diisi saat menolak penjelasan selisih (minimal 3 karakter).");
  return runService(ctx, opts, async (tx) => {
    const disc = await loadDiscrepancy(tx, ctx, id, { forUpdate: true });
    if (disc.decision || disc.status === "done") throw new DomainError("DISCREPANCY_DECIDED", "Selisih ini sudah diputuskan atau sudah Selesai.");
    if (disc.approvalRequestId) {
      const req = (await tx.select().from(approvalRequests).where(eq(approvalRequests.id, disc.approvalRequestId)).limit(1))[0];
      if (req?.status === "submitted") {
        await approvals.decide(ctx, req.id, data.decision, data.reason ?? null, { tx });
        return (await loadDiscrepancy(tx, ctx, id))!;
      }
    }
    if (disc.status === "formed") throw new DomainError("NOT_EXPLAINED", "Selisih ini belum dijelaskan Admin Keuangan. Keputusan diberikan setelah alasan tercatat.");
    if (!disc.requiresOwnerDecision) throw new DomainError("NO_DECISION_NEEDED", "Selisih di bawah ambang ditutup Admin Keuangan. Buka kembali dulu bila perlu diputuskan.");
    const res = await applyDiscrepancyDecision(tx, ctx, disc.id, data.decision === "approve" ? "approved" : "rejected", data.reason ?? null);
    return res.discrepancy;
  });
}

// =====================================================================================================================
// Admin Keuangan: jelaskan, selesaikan tindak lanjut
// =====================================================================================================================

/** Admin Keuangan memberi/memperbarui penjelasan selisih yang belum diputuskan (Terbentuk → Dijelaskan). */
export async function explainDiscrepancy(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m4.discrepancy.explain", { tx: opts.tx });
  const data = parseInput(explainDiscrepancySchema, input, { reason: "Alasan", explanation: "Penjelasan" });
  return runService(ctx, opts, async (tx) => {
    const disc = await loadDiscrepancy(tx, ctx, data.discrepancyId, { forUpdate: true });
    if (disc.decision || !["formed", "explained"].includes(disc.status)) throw new DomainError("DISCREPANCY_DECIDED", "Selisih ini sudah diputuskan; penjelasan tidak dapat diubah.");
    const [updated] = await tx
      .update(discrepancies)
      .set({ status: "explained", reason: data.reason, explanation: data.explanation, reasonNote: disc.reasonNote ?? data.explanation, explainedBy: ctx.userId, explainedAt: ctx.now, updatedAt: ctx.now })
      .where(eq(discrepancies.id, disc.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "discrepancy", objectId: disc.id, action: "explain", before: { status: disc.status, reason: disc.reason, explanation: disc.explanation }, after: { status: "explained", reason: data.reason, explanation: data.explanation }, rule: "US-M4-03", businessDate: disc.businessDate });
    let row = updated!;
    if (disc.requiresOwnerDecision && !disc.approvalRequestId) {
      const approvalId = await submitOwnerDecision(tx, ctx, row, await sourceLabelOf(tx, row));
      row = { ...row, approvalRequestId: approvalId };
    }
    return row;
  });
}

/** Admin Keuangan menyelesaikan tindak lanjut selisih yang ditolak (Ditolak/Ditindaklanjuti → Selesai). */
export async function completeDiscrepancyFollowUp(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m4.discrepancy.explain", { tx: opts.tx });
  const data = parseInput(completeFollowUpSchema, input, { note: "Catatan" });
  return runService(ctx, opts, async (tx) => {
    const disc = await loadDiscrepancy(tx, ctx, data.discrepancyId, { forUpdate: true });
    if (disc.status !== "rejected" && disc.status !== "followed_up") throw new DomainError("NOT_REJECTED", "Hanya selisih yang ditolak pemilik yang ditindaklanjuti Admin Keuangan.");
    const [updated] = await tx
      .update(discrepancies)
      .set({ status: "done", followUpNote: data.note, followedUpBy: ctx.userId, followedUpAt: disc.followedUpAt ?? ctx.now, doneAt: ctx.now, updatedAt: ctx.now })
      .where(eq(discrepancies.id, disc.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "discrepancy", objectId: disc.id, action: "follow_up", before: { status: disc.status }, after: { status: "done" }, reason: data.note, rule: "US-M4-03 KP-2", businessDate: disc.businessDate });
    await markActionedForObject(tx, { objectType: "discrepancy", objectId: disc.id, now: ctx.now });
    return updated!;
  });
}

/** Pemilik membuka kembali selisih di bawah ambang yang ditutup Admin Keuangan (≤ N hari, US-M4-03 KP-5). */
export async function reopenDiscrepancy(ctx: ActorContext, input: unknown, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "m4.discrepancy.reopen", { tx: opts.tx });
  const data = parseInput(reopenDiscrepancySchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    const disc = await loadDiscrepancy(tx, ctx, data.discrepancyId, { forUpdate: true });
    if (!disc.closedBelowThresholdAt || disc.status !== "done" || disc.decision) {
      throw new DomainError("NOT_REOPENABLE", "Hanya selisih di bawah ambang yang ditutup Admin Keuangan yang dapat dibuka kembali.");
    }
    const rules = await cashRules(tx, ctxBusinessDate(ctx), ctx.tenantId);
    const ageDays = (ctx.now.getTime() - disc.closedBelowThresholdAt.getTime()) / 86_400_000;
    if (ageDays > rules.reopenDays) throw new DomainError("REOPEN_WINDOW_PASSED", `Selisih ini ditutup lebih dari ${rules.reopenDays} hari lalu; tidak dapat dibuka kembali.`);
    const [updated] = await tx
      .update(discrepancies)
      .set({ status: "explained", requiresOwnerDecision: true, reopenedBy: ctx.userId, reopenedAt: ctx.now, reopenReason: data.reason, doneAt: null, updatedAt: ctx.now })
      .where(eq(discrepancies.id, disc.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "discrepancy", objectId: disc.id, action: "reopen", before: { status: "done" }, after: { status: "explained", requiresOwnerDecision: true }, reason: data.reason, rule: "US-M4-03 KP-5", businessDate: disc.businessDate });
    await emit(
      tx,
      "discrepancy.reopened",
      { discrepancyId: disc.id, previousDecision: "approved", amount: disc.amount, employeeId: disc.employeeId, profitCenter: profitCenterFor(disc.source), reason: data.reason },
      { ctx, businessDate: disc.businessDate, objectType: "discrepancy", objectId: disc.id },
    );
    return updated!;
  });
}

// =====================================================================================================================
// Daftar, umur & KPI-03 (US-M4-03 KP-1), riwayat per orang (US-M4-03 KP-6, S)
// =====================================================================================================================

export type DiscrepancyListRow = DiscrepancyRow & {
  sourceLabel: string;
  employeeName: string | null;
  depositNumber: string | null;
  ageHours: number;
  overdue: boolean;
  approvalStatus: string | null;
  approvalNumber: string | null;
  approvalDeadlineAt: Date | null;
  canReopen: boolean;
};

export async function listDiscrepancies(
  ctx: ActorContext,
  filter: { view?: "open" | "all"; from?: string | null; to?: string | null; employeeId?: string | null; id?: string | null } = {},
  opts: { tx?: Tx } = {},
): Promise<{ rows: DiscrepancyListRow[]; overdueCount: number; followUpHours: number }> {
  await authorize(ctx, "m4.discrepancy.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const rules = await cashRules(tx, today, ctx.tenantId);
  const conds = [eq(discrepancies.tenantId, ctx.tenantId)];
  if (filter.id) conds.push(eq(discrepancies.id, filter.id));
  else {
    if ((filter.view ?? "open") === "open") conds.push(ne(discrepancies.status, "done"));
    if (filter.from) conds.push(gte(discrepancies.businessDate, filter.from));
    if (filter.to) conds.push(lte(discrepancies.businessDate, filter.to));
    if (filter.employeeId) conds.push(eq(discrepancies.employeeId, filter.employeeId));
  }
  const rows = await tx
    .select({ d: discrepancies, depositNumber: deposits.number, outletCode: outlets.code, outletName: outlets.name, truckCode: trucks.code, employeeName: employees.fullName, a: approvalRequests })
    .from(discrepancies)
    .leftJoin(deposits, eq(deposits.id, discrepancies.depositId))
    .leftJoin(outlets, eq(outlets.id, discrepancies.outletId))
    .leftJoin(trucks, eq(trucks.id, discrepancies.truckId))
    .leftJoin(employees, eq(employees.id, discrepancies.employeeId))
    .leftJoin(approvalRequests, eq(approvalRequests.id, discrepancies.approvalRequestId))
    .where(and(...conds))
    .orderBy(desc(discrepancies.createdAt))
    .limit(500);
  const out = rows.map(({ d, depositNumber, outletCode, outletName, truckCode, employeeName, a }) => {
    const ageHours = Math.max(0, Math.floor(((d.doneAt ?? ctx.now).getTime() - d.createdAt.getTime()) / 3_600_000));
    const sourceLabel = d.outletId
      ? `${label("discrepancy_source", d.source)} ${outletCode ?? ""} — ${outletName ?? ""}`
      : `${label("discrepancy_source", d.source)}${employeeName ? ` — ${employeeName}` : ""}${truckCode ? ` (${truckCode})` : ""}`;
    const canReopen = !!d.closedBelowThresholdAt && d.status === "done" && !d.decision && (ctx.now.getTime() - d.closedBelowThresholdAt.getTime()) / 86_400_000 <= rules.reopenDays;
    return {
      ...d,
      sourceLabel,
      employeeName: employeeName ?? null,
      depositNumber: depositNumber ?? null,
      ageHours,
      overdue: d.status !== "done" && ageHours > rules.followUpHours,
      approvalStatus: a?.status ?? null,
      approvalNumber: a?.number ?? null,
      approvalDeadlineAt: a?.deadlineAt ?? null,
      canReopen,
    };
  });
  // US-M4-03 KP-1: lewat tenggat di atas (sama dengan kotak masuk persetujuan).
  out.sort((x, y) => Number(y.overdue) - Number(x.overdue));
  return { rows: out, overdueCount: out.filter((r) => r.overdue).length, followUpHours: rules.followUpHours };
}

/** KPI-03: jumlah selisih yang belum Selesai lebih dari N jam sejak terbentuk (per rentang tanggal bisnis). */
export async function kpi03(tx: Tx, tenantId: string, input: { from: BusinessDate; to: BusinessDate; now: Date }): Promise<{ total: number; overdue: number; followUpHours: number }> {
  const rules = await cashRules(tx, input.to, tenantId);
  const rows = await tx
    .select({ createdAt: discrepancies.createdAt, doneAt: discrepancies.doneAt })
    .from(discrepancies)
    .where(and(eq(discrepancies.tenantId, tenantId), gte(discrepancies.businessDate, input.from), lte(discrepancies.businessDate, input.to)));
  const limitMs = rules.followUpHours * 3_600_000;
  const overdue = rows.filter((r) => (r.doneAt ?? input.now).getTime() - r.createdAt.getTime() > limitMs).length;
  return { total: rows.length, overdue, followUpHours: rules.followUpHours };
}

export type DiscrepancyHistoryRow = {
  employeeId: string;
  employeeName: string;
  month: string;
  count: number;
  shortage: number;
  surplus: number;
  reasons: Record<string, number>;
};

export type DiscrepancyStreak = {
  employeeId: string;
  employeeName: string;
  /** Deret hari setor berturut-turut tanpa selisih sampai hari ini. */
  daysWithoutDiscrepancy: number;
  lastDiscrepancyDate: string | null;
  /** Tanpa selisih selama `zeroDiscrepancyMonths` bulan terakhir (dasar insentif nihil selisih, BR-12). */
  zeroForMonths: boolean;
};

/** Riwayat selisih per sopir/operator per bulan + deret hari tanpa selisih (US-M4-03 KP-6, FR-M4-07). */
export async function discrepancyHistory(ctx: ActorContext, filter: { employeeId?: string | null; months?: number } = {}, opts: { tx?: Tx } = {}): Promise<{ rows: DiscrepancyHistoryRow[]; streaks: DiscrepancyStreak[]; zeroMonths: number; from: string }> {
  await authorize(ctx, "m4.discrepancy.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const today = ctxBusinessDate(ctx);
  const rules = await cashRules(tx, today, ctx.tenantId);
  const months = Math.max(filter.months ?? 6, rules.zeroDiscrepancyMonths);
  const from = firstDayOfMonth(addDays(today, -31 * (months - 1)));
  const conds = [eq(discrepancies.tenantId, ctx.tenantId), gte(discrepancies.businessDate, from), inArray(discrepancies.source, ["driver", "depot_shift", "store_shift", "pending_deposit"])];
  if (filter.employeeId) conds.push(eq(discrepancies.employeeId, filter.employeeId));
  const discs = await tx.select().from(discrepancies).where(and(...conds));
  const depConds = [eq(deposits.tenantId, ctx.tenantId), gte(deposits.businessDate, from), eq(deposits.isPartial, false), inArray(deposits.status, ["received", "closed"])];
  if (filter.employeeId) depConds.push(eq(deposits.depositorEmployeeId, filter.employeeId));
  const deps = await tx.select({ employeeId: deposits.depositorEmployeeId, businessDate: deposits.businessDate }).from(deposits).where(and(...depConds));
  const employeeIds = [...new Set([...discs.map((d) => d.employeeId), ...deps.map((d) => d.employeeId)].filter((x): x is string => !!x))];
  const names = await employeeNames(tx, employeeIds);
  const byKey = new Map<string, DiscrepancyHistoryRow>();
  for (const d of discs) {
    if (!d.employeeId) continue;
    const month = monthOf(d.businessDate);
    const key = `${d.employeeId}|${month}`;
    const cur = byKey.get(key) ?? { employeeId: d.employeeId, employeeName: names.get(d.employeeId)?.name ?? "—", month, count: 0, shortage: 0, surplus: 0, reasons: {} };
    cur.count++;
    if (d.amount < 0) cur.shortage += -d.amount;
    else cur.surplus += d.amount;
    const r = d.reason ?? "other";
    cur.reasons[r] = (cur.reasons[r] ?? 0) + 1;
    byKey.set(key, cur);
  }
  const zeroFrom = firstDayOfMonth(addDays(today, -31 * (rules.zeroDiscrepancyMonths - 1)));
  const streaks: DiscrepancyStreak[] = employeeIds.map((employeeId) => {
    const discDates = new Set(discs.filter((d) => d.employeeId === employeeId).map((d) => d.businessDate));
    const depDates = [...new Set(deps.filter((d) => d.employeeId === employeeId).map((d) => d.businessDate))].sort().reverse();
    let streak = 0;
    for (const date of depDates) {
      if (discDates.has(date)) break;
      streak++;
    }
    const last = [...discDates].sort().reverse()[0] ?? null;
    const hadDepositsSinceZeroFrom = depDates.some((dd) => dd >= zeroFrom);
    return {
      employeeId,
      employeeName: names.get(employeeId)?.name ?? "—",
      daysWithoutDiscrepancy: streak,
      lastDiscrepancyDate: last,
      zeroForMonths: hadDepositsSinceZeroFrom && (!last || last < zeroFrom),
    };
  });
  const rows = [...byKey.values()].sort((a, b) => (a.month === b.month ? a.employeeName.localeCompare(b.employeeName) : b.month.localeCompare(a.month)));
  return { rows, streaks: streaks.sort((a, b) => b.daysWithoutDiscrepancy - a.daysWithoutDiscrepancy), zeroMonths: rules.zeroDiscrepancyMonths, from };
}

export type DiscrepancyDayRow = DiscrepancyRow & {
  /** "Shift depot D02 — Depot Cibeber · Operator: Nama" / "Sopir — Nama (T2)". */
  sourceLabel: string;
  outletLabel: string | null;
  truckCode: string | null;
  employeeName: string | null;
};

/** Selisih hari itu (layar tutup kas, US-M4-06 KP-3) — dengan outlet/truk & nama karyawan (D-12 butir 7), satu kueri. */
export async function discrepanciesOn(tx: Tx, tenantId: string, date: BusinessDate): Promise<DiscrepancyDayRow[]> {
  const rows = await tx
    .select({ d: discrepancies, outletCode: outlets.code, outletName: outlets.name, truckCode: trucks.code, employeeName: employees.fullName })
    .from(discrepancies)
    .leftJoin(outlets, eq(outlets.id, discrepancies.outletId))
    .leftJoin(trucks, eq(trucks.id, discrepancies.truckId))
    .leftJoin(employees, eq(employees.id, discrepancies.employeeId))
    .where(and(eq(discrepancies.tenantId, tenantId), eq(discrepancies.businessDate, date)))
    .orderBy(desc(discrepancies.createdAt));
  return rows.map(({ d, outletCode, outletName, truckCode, employeeName }) => {
    const outletLabel = outletCode ? `${outletCode} — ${outletName ?? ""}` : null;
    const where = outletLabel ?? (truckCode ? `Truk ${truckCode}` : null);
    const sourceLabel = [label("discrepancy_source", d.source), where, employeeName].filter(Boolean).join(" · ");
    return { ...d, sourceLabel, outletLabel, truckCode: truckCode ?? null, employeeName: employeeName ?? null };
  });
}

/** Selisih terbuka (belum Selesai) — untuk ringkasan. */
export function isOpenStatus(status: string): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}
