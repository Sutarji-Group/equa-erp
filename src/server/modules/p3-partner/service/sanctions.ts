/**
 * P3 — sanksi bertingkat, pemutusan & pelepasan data (Tahap 3 US-P3-07, PTB-58/59; flag `phase3.partner_portal`) dan
 * mode baca-saja tenant menunggak (US-P3-02 KP-4).
 *
 * - KP-1: PEMICU tercatat otomatis (`recordSanctionTrigger`: tunggakan lewat tempo, neraca air di luar toleransi, skor
 *   mutu rendah, temuan audit lewat tenggat, POS tidak dipakai, uji air tidak lulus berturut) — status "Pemicu tercatat"
 *   + notifikasi pemilik & pembina. SANKSI selalu diputuskan pemilik (persetujuan `partner_sanction`, beralasan):
 *   Teguran tertulis (surat dari templat, tercatat) → Penghentian pasokan sementara (pesanan air mitra diblokir lewat
 *   handler `order.created`; portal menampilkan alasan & syarat pemulihan) → Pemutusan.
 * - KP-2: Pemutusan → kontrak Diputus; tenant dinonaktifkan pada tanggal berakhir (job); ekspor data outlet untuk
 *   mitra ≤ `p3.partner_rules.data_export_days` hari (PTB-58); data tetap tersimpan (tanpa DELETE).
 * - KP-3: seluruh tahap tampil di dashboard pembina & riwayat mitra; pencabutan tercatat dengan alasan.
 * - US-P3-02 KP-4: tunggakan > `read_only_overdue_days` SETELAH teguran berlaku → tenant mode baca-saja (tidak dapat
 *   membuka shift POS baru); pulih otomatis saat tunggakan lunas.
 */
import "server-only";

import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { customers, invoices, outlets, partnerContracts, partnerSanctions, posSales, tenants } from "@/db/schema";
import { label, type EnumValue } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, daysBetween, formatTanggal, isBusinessDate, toBusinessDate, type BusinessDate } from "@/lib/time";

import * as approvals from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, systemContext, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import { authorize, authorizeAny, runService } from "@/server/core/rbac";

import {
  activeContractFor,
  assertOwnerTenant,
  assertPortalEnabled,
  latestContractFor,
  loadContract,
  loadPartnerTenant,
  notifyOnce,
  ownerTenantId,
  partnerCustomersOf,
  partnerRules,
  partnerTenants,
  partnerTerms,
  portalEnabled,
  tenantOutlets,
} from "./common";

export type SanctionRow = typeof partnerSanctions.$inferSelect;
export type SanctionLevel = EnumValue<"sanction_level">;
export type SanctionTrigger = EnumValue<"sanction_trigger">;

const LEVEL_ORDER: readonly SanctionLevel[] = ["warning", "supply_suspension", "termination"];

/** Tingkat berikutnya setelah sanksi aktif tertinggi (bertingkat, PTB-59). */
export function nextSanctionLevel(active: readonly SanctionLevel[]): SanctionLevel {
  const highest = Math.max(-1, ...active.map((l) => LEVEL_ORDER.indexOf(l)));
  return LEVEL_ORDER[Math.min(highest + 1, LEVEL_ORDER.length - 1)]!;
}

/** Sanksi yang berlaku (status Berlaku, sudah efektif, belum dicabut) untuk tenant mitra. */
export async function activeSanctions(tx: Tx, partnerTenantId: string, date: BusinessDate): Promise<SanctionRow[]> {
  return tx
    .select()
    .from(partnerSanctions)
    .where(
      and(
        eq(partnerSanctions.tenantId, partnerTenantId),
        eq(partnerSanctions.status, "active"),
        isNull(partnerSanctions.liftedAt),
        sql`(${partnerSanctions.effectiveFrom} is null or ${partnerSanctions.effectiveFrom} <= ${date})`,
      ),
    )
    .orderBy(desc(partnerSanctions.decidedAt));
}

/** Penghentian pasokan sementara yang berlaku (null bila tidak ada). */
export async function activeSupplySuspension(tx: Tx, partnerTenantId: string, date: BusinessDate): Promise<SanctionRow | null> {
  return (await activeSanctions(tx, partnerTenantId, date)).find((s) => s.level === "supply_suspension") ?? null;
}

type TriggerDetail = { key?: string; summary?: string; recoveryConditions?: string; letterText?: string; effectiveDate?: string; proposedLevel?: SanctionLevel; [k: string]: unknown };

// =====================================================================================================================
// KP-1: pemicu otomatis
// =====================================================================================================================

/**
 * Catat pemicu sanksi (sekali per `key`). Hanya bila portal Tahap 3 aktif untuk tenant mitra (pada Fase 1 sanksi
 * manual di luar sistem, 9.10). Mengembalikan baris baru atau null (sudah ada / flag mati / tanpa kontrak).
 */
export async function recordSanctionTrigger(
  tx: Tx,
  input: { partnerTenantId: string; trigger: SanctionTrigger; key: string; summary: string; detail?: Record<string, unknown>; now: Date },
): Promise<SanctionRow | null> {
  if (!(await portalEnabled(tx, input.partnerTenantId))) return null;
  const date = toBusinessDate(input.now);
  const contract = (await activeContractFor(tx, input.partnerTenantId, date)) ?? (await latestContractFor(tx, input.partnerTenantId));
  if (!contract || !["active", "extended"].includes(contract.status)) return null;
  const [dup] = await tx
    .select({ id: partnerSanctions.id })
    .from(partnerSanctions)
    .where(and(eq(partnerSanctions.tenantId, input.partnerTenantId), sql`${partnerSanctions.triggerDetail}->>'key' = ${input.key}`))
    .limit(1);
  if (dup) return null;
  const active = (await activeSanctions(tx, input.partnerTenantId, date)).map((s) => s.level);
  const level = nextSanctionLevel(active);
  const detail: TriggerDetail = { ...(input.detail ?? {}), key: input.key, summary: input.summary };
  const [row] = await tx
    .insert(partnerSanctions)
    .values({ tenantId: input.partnerTenantId, contractId: contract.id, level, status: "triggered", trigger: input.trigger, triggerDetail: detail, createdAt: input.now })
    .returning();
  const tenant = await loadPartnerTenant(tx, input.partnerTenantId);
  const equa = await ownerTenantId(tx);
  await auditRecord(tx, {
    ctx: systemContext({ tenantId: equa, now: input.now }),
    objectType: "partner_sanction",
    objectId: row!.id,
    action: "trigger",
    after: { trigger: input.trigger, level, summary: input.summary, tenantId: tenant.id, contract: contract.number },
    rule: "US-P3-07 KP-1",
  });
  await notifyOnce(tx, {
    event: "partner.sanction_triggered",
    tenantId: equa,
    title: `Pemicu sanksi mitra ${tenant.name}: ${label("sanction_trigger", input.trigger)}`,
    body: `${input.summary} Usulan tingkat berikutnya: ${label("sanction_level", level)} — keputusan tetap di tangan pemilik (PTB-59).`,
    objectType: "partner_sanction",
    objectId: row!.id,
    link: `/kemitraan/sanksi?id=${row!.id}`,
    groupKey: `partner.sanction_triggered:${input.key}`,
    now: input.now,
  });
  return row!;
}

// =====================================================================================================================
// Usulan → keputusan pemilik (6.2a `partner_sanction`)
// =====================================================================================================================

const proposeSchema = z.object({
  sanctionId: z.uuid().nullable().optional(),
  /** Usulan tanpa pemicu otomatis (mis. temuan lain) — wajib tenant mitra. */
  tenantId: z.uuid().nullable().optional(),
  level: z.enum(["warning", "supply_suspension", "termination"]).nullable().optional(),
  reason: z.string().trim().min(10, { error: "Jelaskan dasar usulan sanksi (minimal 10 karakter)." }).max(1000),
  recoveryConditions: z.string().trim().max(1000).nullable().optional(),
  effectiveDate: z
    .string()
    .refine(isBusinessDate, { error: "Tanggal berlaku harus YYYY-MM-DD." })
    .nullable()
    .optional(),
});
export type ProposeSanctionInput = z.input<typeof proposeSchema>;

/** Templat surat teguran tertulis (tercatat bersama keputusan). */
export async function warningLetterText(tx: Tx, input: { tenantName: string; contractNumber: string; reason: string; date: BusinessDate; recovery?: string | null }): Promise<string> {
  const terms = await partnerTerms(tx);
  return [
    `SURAT TEGURAN TERTULIS — ${terms.program}`,
    `Tanggal: ${formatTanggal(input.date, { weekday: false })}`,
    `Kepada: ${input.tenantName} (kontrak ${input.contractNumber})`,
    "",
    `Berdasarkan pemantauan EQUA, kami menyampaikan teguran tertulis atas hal berikut: ${input.reason}`,
    input.recovery ? `Mohon lakukan perbaikan berikut: ${input.recovery}` : "Mohon lakukan perbaikan dalam waktu yang wajar dan konfirmasikan kepada pembina wilayah.",
    "Teguran ini merupakan tahap pertama sanksi bertingkat sesuai perjanjian kemitraan. Bila tidak ada perbaikan, EQUA dapat melanjutkan ke tahap berikutnya.",
    "",
    "Hormat kami,",
    "Pemilik EQUA",
  ].join("\n");
}

/** Pembina/Admin Keuangan mengusulkan sanksi (dari pemicu atau manual) → persetujuan pemilik. */
export async function proposeSanction(ctx: ActorContext, input: ProposeSanctionInput, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "p3.sanction.propose", { tx: opts.tx, objectType: "partner_sanction", objectId: input?.sanctionId ?? undefined });
  const data = parseInput(proposeSchema, input, { level: "Tingkat", reason: "Dasar usulan", recoveryConditions: "Syarat pemulihan", effectiveDate: "Tanggal berlaku" });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    const today = ctxBusinessDate(ctx);
    let row: SanctionRow;
    if (data.sanctionId) {
      const [s] = await tx.select().from(partnerSanctions).where(eq(partnerSanctions.id, data.sanctionId)).for("update").limit(1);
      if (!s) throw new NotFoundError("Pemicu sanksi tidak ditemukan.");
      if (s.status !== "triggered") throw new DomainError("SANCTION_NOT_TRIGGERED", `Sanksi ini sudah ${label("sanction_status", s.status).toLowerCase()}.`);
      row = s;
    } else {
      if (!data.tenantId) throw ValidationError.field("tenantId", "Pilih mitra yang diusulkan sanksi.");
      const contract = (await activeContractFor(tx, data.tenantId, today)) ?? null;
      if (!contract) throw new DomainError("NO_ACTIVE_CONTRACT", "Mitra ini tidak punya kontrak berlaku.");
      const active = (await activeSanctions(tx, data.tenantId, today)).map((s) => s.level);
      const [s] = await tx
        .insert(partnerSanctions)
        .values({ tenantId: data.tenantId, contractId: contract.id, level: data.level ?? nextSanctionLevel(active), status: "triggered", trigger: "other", triggerDetail: { key: `manual:${ctx.now.toISOString()}`, summary: data.reason }, createdBy: ctx.userId })
        .returning();
      row = s!;
    }
    await assertPortalEnabled(tx, row.tenantId);
    const tenant = await loadPartnerTenant(tx, row.tenantId);
    const contract = await loadContract(tx, row.contractId);
    const active = (await activeSanctions(tx, row.tenantId, today)).map((s) => s.level);
    const level = data.level ?? row.level;
    // Bertingkat (PTB-59): tidak boleh melompati tingkat.
    const allowed = nextSanctionLevel(active);
    if (LEVEL_ORDER.indexOf(level) > LEVEL_ORDER.indexOf(allowed)) {
      throw ValidationError.field("level", `Sanksi bertingkat: tahap berikutnya untuk mitra ini adalah ${label("sanction_level", allowed)} (PTB-59).`);
    }
    if (level === "supply_suspension" && !data.recoveryConditions) {
      throw ValidationError.field("recoveryConditions", "Isi syarat pemulihan pasokan — ditampilkan ke mitra di portal (US-P3-07 KP-1).");
    }
    const effectiveDate = data.effectiveDate && data.effectiveDate > today ? data.effectiveDate : today;
    const detail: TriggerDetail = { ...((row.triggerDetail ?? {}) as TriggerDetail), proposedLevel: level, recoveryConditions: data.recoveryConditions ?? undefined, effectiveDate, proposalReason: data.reason };
    await tx.update(partnerSanctions).set({ level, triggerDetail: detail, updatedAt: ctx.now }).where(eq(partnerSanctions.id, row.id));
    const approval = await approvals.submit(
      ctx,
      {
        type: "partner_sanction",
        objectType: "partner_sanction",
        objectId: row.id,
        reason: data.reason,
        payload: {
          tenantName: tenant.name,
          contract: contract.number,
          level,
          levelLabel: label("sanction_level", level),
          trigger: label("sanction_trigger", row.trigger),
          summary: detail.summary ?? null,
          recoveryConditions: data.recoveryConditions ?? null,
          effectiveDate,
          link: `/kemitraan/sanksi?id=${row.id}`,
        },
      },
      { tx },
    );
    await tx.update(partnerSanctions).set({ approvalRequestId: approval.id }).where(eq(partnerSanctions.id, row.id));
    await auditRecord(tx, { ctx, objectType: "partner_sanction", objectId: row.id, action: "propose", after: { level, effectiveDate, approval: approval.number }, reason: data.reason, rule: "US-P3-07 KP-1, PTB-59" });
    return { sanctionId: row.id, approval };
  });
}

/** Handler persetujuan disetujui (ctx = pemilik): sanksi Berlaku + efeknya. */
export async function applySanctionDecision(tx: Tx, ctx: ActorContext, request: approvals.ApprovalRow, reason: string | null): Promise<Record<string, unknown>> {
  const [s] = await tx.select().from(partnerSanctions).where(eq(partnerSanctions.id, request.objectId)).for("update").limit(1);
  if (!s) return { skipped: "Sanksi tidak ditemukan." };
  if (s.status !== "triggered") return { skipped: `Sanksi sudah ${label("sanction_status", s.status)}.` };
  const today = ctxBusinessDate(ctx);
  const detail = (s.triggerDetail ?? {}) as TriggerDetail;
  const tenant = await loadPartnerTenant(tx, s.tenantId);
  const contract = await loadContract(tx, s.contractId, { forUpdate: true });
  const effectiveFrom = detail.effectiveDate && detail.effectiveDate > today ? detail.effectiveDate : today;
  const effects: Record<string, unknown> = { level: s.level, effectiveFrom };
  const next: TriggerDetail = { ...detail };
  if (s.level === "warning") {
    next.letterText = await warningLetterText(tx, { tenantName: tenant.name, contractNumber: contract.number, reason: String(detail.proposalReason ?? request.reason), date: today, recovery: detail.recoveryConditions ?? null });
  }
  await tx
    .update(partnerSanctions)
    .set({ status: "active", decidedBy: ctx.userId, decidedAt: ctx.now, decisionReason: reason ?? request.reason, effectiveFrom, triggerDetail: next, updatedAt: ctx.now })
    .where(eq(partnerSanctions.id, s.id));
  if (s.level === "termination") {
    const rules = await partnerRules(tx, today);
    const exportDue = addDays(effectiveFrom, rules.data_export_days);
    await tx
      .update(partnerContracts)
      .set({ status: "terminated", terminatedAt: ctx.now, terminationReason: reason ?? request.reason, endDate: effectiveFrom < contract.endDate ? effectiveFrom : contract.endDate, dataExportDueDate: exportDue, updatedAt: ctx.now })
      .where(eq(partnerContracts.id, contract.id));
    await auditRecord(tx, {
      ctx,
      objectType: "partner_contract",
      objectId: contract.id,
      action: "terminate",
      before: { status: contract.status, endDate: contract.endDate },
      after: { status: "terminated", endDate: effectiveFrom < contract.endDate ? effectiveFrom : contract.endDate, dataExportDueDate: exportDue },
      reason: reason ?? request.reason,
      rule: "US-P3-07 KP-2, PTB-58",
    });
    effects.dataExportDueDate = exportDue;
    if (effectiveFrom <= today) effects.tenantDeactivated = await deactivatePartnerTenant(tx, ctx, tenant.id, `Pemutusan kontrak ${contract.number}`);
  }
  await auditRecord(tx, { ctx, objectType: "partner_sanction", objectId: s.id, action: "decide", before: { status: "triggered" }, after: { status: "active", level: s.level, effectiveFrom }, reason: reason ?? request.reason, rule: "US-P3-07 KP-1, 6.2a" });
  await notify(tx, {
    event: "partner.sanction_triggered",
    tenantId: tenant.id,
    recipients: { roles: ["partner_owner"] },
    title: `${label("sanction_level", s.level)} dari EQUA berlaku mulai ${formatTanggal(effectiveFrom, { weekday: false })}`,
    body: s.level === "supply_suspension" ? `Pesanan air diblokir sementara. Syarat pemulihan: ${detail.recoveryConditions ?? "-"}` : String(detail.proposalReason ?? request.reason),
    objectType: "partner_sanction",
    objectId: s.id,
    link: "/mitra/sanksi",
    now: ctx.now,
  });
  return effects;
}

/** Handler ditolak: sanksi tidak dilanjutkan (tercatat). */
export async function dismissSanctionOnRejection(tx: Tx, ctx: ActorContext, request: approvals.ApprovalRow, reason: string | null): Promise<Record<string, unknown>> {
  const [s] = await tx.select().from(partnerSanctions).where(eq(partnerSanctions.id, request.objectId)).for("update").limit(1);
  if (!s || s.status !== "triggered") return { skipped: true };
  await tx.update(partnerSanctions).set({ status: "dismissed", decidedBy: ctx.userId, decidedAt: ctx.now, decisionReason: reason, updatedAt: ctx.now }).where(eq(partnerSanctions.id, s.id));
  await auditRecord(tx, { ctx, objectType: "partner_sanction", objectId: s.id, action: "dismiss", before: { status: "triggered" }, after: { status: "dismissed" }, reason, rule: "US-P3-07 KP-1" });
  return { status: "dismissed" };
}

const liftSchema = z.object({ sanctionId: z.uuid(), reason: z.string().trim().min(10, { error: "Alasan pencabutan wajib diisi (minimal 10 karakter)." }).max(1000) });

/** KP-3: pemilik mencabut sanksi berlaku / tidak melanjutkan pemicu (beralasan, tercatat). */
export async function liftSanction(ctx: ActorContext, input: z.input<typeof liftSchema>, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "p3.sanction.lift", { tx: opts.tx, objectType: "partner_sanction", objectId: input?.sanctionId });
  const data = parseInput(liftSchema, input, { reason: "Alasan" });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    const [s] = await tx.select().from(partnerSanctions).where(eq(partnerSanctions.id, data.sanctionId)).for("update").limit(1);
    if (!s) throw new NotFoundError("Sanksi tidak ditemukan.");
    if (s.status === "triggered") {
      const req = s.approvalRequestId ? await approvals.getApproval(tx, s.approvalRequestId) : null;
      if (req?.status === "submitted") throw new DomainError("SANCTION_PENDING", `Usulan ${req.number} masih menunggu keputusan — putuskan di Persetujuan.`);
      const [row] = await tx.update(partnerSanctions).set({ status: "dismissed", decidedBy: ctx.userId, decidedAt: ctx.now, decisionReason: data.reason, updatedAt: ctx.now }).where(eq(partnerSanctions.id, s.id)).returning();
      await auditRecord(tx, { ctx, objectType: "partner_sanction", objectId: s.id, action: "dismiss", before: { status: s.status }, after: { status: "dismissed" }, reason: data.reason, rule: "US-P3-07 KP-3" });
      return row!;
    }
    if (s.status !== "active") throw new DomainError("SANCTION_NOT_ACTIVE", `Sanksi ini sudah ${label("sanction_status", s.status).toLowerCase()}.`);
    if (s.level === "termination") throw new DomainError("TERMINATION_FINAL", "Pemutusan tidak dapat dicabut; kemitraan baru memerlukan kontrak baru (9.4).");
    const [row] = await tx.update(partnerSanctions).set({ status: "lifted", liftedAt: ctx.now, liftedBy: ctx.userId, liftReason: data.reason, updatedAt: ctx.now }).where(eq(partnerSanctions.id, s.id)).returning();
    await auditRecord(tx, { ctx, objectType: "partner_sanction", objectId: s.id, action: "lift", before: { status: "active" }, after: { status: "lifted" }, reason: data.reason, rule: "US-P3-07 KP-3" });
    await notify(tx, {
      event: "partner.sanction_triggered",
      tenantId: s.tenantId,
      recipients: { roles: ["partner_owner"] },
      title: `${label("sanction_level", s.level)} dicabut EQUA`,
      body: data.reason,
      objectType: "partner_sanction",
      objectId: s.id,
      link: "/mitra/sanksi",
      now: ctx.now,
    });
    return row!;
  });
}

/** Nonaktifkan tenant mitra (pemutusan; data tetap tersimpan). */
async function deactivatePartnerTenant(tx: Tx, ctx: ActorContext, tenantId: string, reason: string): Promise<boolean> {
  const [t] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).for("update").limit(1);
  if (!t || !t.isActive) return false;
  await tx.update(tenants).set({ isActive: false, deactivatedAt: ctx.now, deactivationReason: reason, updatedAt: ctx.now }).where(eq(tenants.id, tenantId));
  await auditRecord(tx, { ctx, objectType: "tenant", objectId: tenantId, action: "deactivate", before: { isActive: true }, after: { isActive: false }, reason, rule: "US-P3-07 KP-2" });
  return true;
}

// =====================================================================================================================
// Kueri
// =====================================================================================================================

export type SanctionView = SanctionRow & { tenantName: string; contractNumber: string; approvalNumber: string | null; approvalStatus: string | null; detail: TriggerDetail };

export async function listSanctions(ctx: ActorContext, filter: { tenantId?: string | null; status?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<SanctionView[]> {
  await authorizeAny(ctx, ["p3.sanction.propose", "p3.partner.read"], { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  await assertOwnerTenant(tx, ctx);
  const conds = [];
  if (filter.tenantId) conds.push(eq(partnerSanctions.tenantId, filter.tenantId));
  if (filter.status) conds.push(eq(partnerSanctions.status, filter.status as SanctionRow["status"]));
  const rows = await tx
    .select({ s: partnerSanctions, tenantName: tenants.name, contractNumber: partnerContracts.number })
    .from(partnerSanctions)
    .innerJoin(tenants, eq(tenants.id, partnerSanctions.tenantId))
    .innerJoin(partnerContracts, eq(partnerContracts.id, partnerSanctions.contractId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(partnerSanctions.createdAt))
    .limit(300);
  const out: SanctionView[] = [];
  for (const r of rows) {
    const req = r.s.approvalRequestId ? await approvals.getApproval(tx, r.s.approvalRequestId) : null;
    out.push({ ...r.s, tenantName: r.tenantName, contractNumber: r.contractNumber, approvalNumber: req?.number ?? null, approvalStatus: req?.status ?? null, detail: (r.s.triggerDetail ?? {}) as TriggerDetail });
  }
  return out;
}

/** Sanksi yang berlaku & riwayat — sudut pandang mitra (portal). Tanpa otorisasi; pemanggil memastikan tenant. */
export async function sanctionsOfTenant(tx: Tx, tenantId: string): Promise<SanctionView[]> {
  const rows = await tx
    .select({ s: partnerSanctions, contractNumber: partnerContracts.number })
    .from(partnerSanctions)
    .innerJoin(partnerContracts, eq(partnerContracts.id, partnerSanctions.contractId))
    .where(and(eq(partnerSanctions.tenantId, tenantId), inArray(partnerSanctions.status, ["active", "lifted"])))
    .orderBy(desc(partnerSanctions.decidedAt));
  return rows.map((r) => ({ ...r.s, tenantName: "", contractNumber: r.contractNumber, approvalNumber: null, approvalStatus: null, detail: (r.s.triggerDetail ?? {}) as TriggerDetail }));
}

// =====================================================================================================================
// Job harian: pemicu tunggakan & POS tidak dipakai, mode baca-saja, pemutusan efektif, tenggat ekspor data
// =====================================================================================================================

export type SanctionJobResult = { triggers: string[]; readOnly: string[]; restored: string[]; deactivated: string[]; exportsDue: string[] };

/** Faktur mitra lewat tempo (sisa > 0) — hari terlama. */
async function overdueOf(tx: Tx, partnerTenantId: string, today: BusinessDate): Promise<{ amount: number; maxDays: number; count: number }> {
  const custIds = (await partnerCustomersOf(tx, partnerTenantId)).map((c) => c.id);
  if (!custIds.length) return { amount: 0, maxDays: 0, count: 0 };
  const rows = await tx
    .select({ dueDate: invoices.dueDate, outstanding: invoices.outstandingAmount })
    .from(invoices)
    .where(and(inArray(invoices.customerId, custIds), gt(invoices.outstandingAmount, 0), sql`${invoices.dueDate} < ${today}`, eq(invoices.disputeStatus, "none")));
  return { amount: rows.reduce((s, r) => s + r.outstanding, 0), maxDays: rows.reduce((m, r) => Math.max(m, daysBetween(r.dueDate, today)), 0), count: rows.length };
}

export async function runSanctionChecks(now: Date, opts: { db?: Db } = {}): Promise<SanctionJobResult> {
  const today = toBusinessDate(now);
  return withTx(
    async (tx) => {
      const out: SanctionJobResult = { triggers: [], readOnly: [], restored: [], deactivated: [], exportsDue: [] };
      const equa = await ownerTenantId(tx);
      const sys = systemContext({ tenantId: equa, now, businessDate: today });
      const rules = await partnerRules(tx, today);
      for (const tenant of await partnerTenants(tx, { includeInactive: true })) {
        const phase3 = await portalEnabled(tx, tenant.id);
        // Pemutusan efektif → tenant nonaktif pada tanggal berakhir (KP-2).
        const terminated = await tx
          .select()
          .from(partnerContracts)
          .where(and(eq(partnerContracts.tenantId, tenant.id), eq(partnerContracts.status, "terminated")));
        for (const c of terminated) {
          if (c.endDate <= today && tenant.isActive && (await deactivatePartnerTenant(tx, sys, tenant.id, `Pemutusan kontrak ${c.number} berlaku ${c.endDate}`))) out.deactivated.push(tenant.id);
          if (c.dataExportDueDate && !c.dataExportedAt && addDays(c.dataExportDueDate, -7) <= today) {
            const sent = await notifyOnce(tx, {
              event: "partner.data_export_due",
              tenantId: equa,
              title: `Ekspor data outlet mitra ${tenant.name} jatuh tempo ${c.dataExportDueDate}`,
              body: `Serahkan ekspor data outlet (transaksi, stok, laporan) ke mitra paling lambat ${formatTanggal(c.dataExportDueDate, { weekday: false })} (PTB-58).`,
              objectType: "partner_contract",
              objectId: c.id,
              link: `/kemitraan/sanksi?mitra=${tenant.id}`,
              groupKey: `partner.data_export_due:${c.id}`,
              now,
            });
            if (sent) out.exportsDue.push(c.id);
          }
        }
        if (!tenant.isActive) continue;
        const od = await overdueOf(tx, tenant.id, today);
        // Mode baca-saja (US-P3-02 KP-4): hanya SETELAH teguran berlaku, tunggakan > N hari.
        const act = await activeSanctions(tx, tenant.id, today);
        const warned = act.some((s) => s.level === "warning" || s.level === "supply_suspension");
        if (phase3 && warned && od.maxDays > rules.read_only_overdue_days && !tenant.readOnly) {
          await tx.update(tenants).set({ readOnly: true, updatedAt: now }).where(eq(tenants.id, tenant.id));
          await auditRecord(tx, { ctx: sys, objectType: "tenant", objectId: tenant.id, action: "read_only", before: { readOnly: false }, after: { readOnly: true, overdueDays: od.maxDays, overdue: od.amount }, rule: "US-P3-02 KP-4" });
          await notify(tx, {
            event: "partner.read_only",
            tenantId: equa,
            title: `Mitra ${tenant.name} beralih ke mode baca-saja`,
            body: `Tunggakan ${formatRupiah(od.amount)} lewat ${od.maxDays} hari (> ${rules.read_only_overdue_days} hari) setelah teguran. POS tidak dapat membuka shift baru sampai lunas.`,
            objectType: "tenant",
            objectId: tenant.id,
            link: `/kemitraan/mitra/${tenant.id}`,
            now,
          });
          await notify(tx, {
            event: "partner.read_only",
            tenantId: tenant.id,
            recipients: { roles: ["partner_owner"] },
            title: "Sistem POS Anda dalam mode baca-saja",
            body: `Tunggakan ${formatRupiah(od.amount)} lewat ${od.maxDays} hari setelah teguran. Lunasi tagihan agar shift POS dapat dibuka kembali.`,
            objectType: "tenant",
            objectId: tenant.id,
            link: "/mitra/tagihan",
            now,
          });
          out.readOnly.push(tenant.id);
        } else if (tenant.readOnly && od.maxDays <= rules.read_only_overdue_days) {
          await tx.update(tenants).set({ readOnly: false, updatedAt: now }).where(eq(tenants.id, tenant.id));
          await auditRecord(tx, { ctx: sys, objectType: "tenant", objectId: tenant.id, action: "read_only_lifted", before: { readOnly: true }, after: { readOnly: false }, rule: "US-P3-02 KP-4" });
          out.restored.push(tenant.id);
        }
        if (!phase3) continue;
        // Pemicu tunggakan (KP-1) — sekali per bulan lewat tempo tertua.
        if (od.count > 0) {
          const row = await recordSanctionTrigger(tx, {
            partnerTenantId: tenant.id,
            trigger: "overdue",
            key: `overdue:${tenant.id}:${today.slice(0, 7)}`,
            summary: `Tunggakan ${formatRupiah(od.amount)} (${od.count} faktur), lewat tempo terlama ${od.maxDays} hari.`,
            detail: { amount: od.amount, maxDays: od.maxDays },
            now,
          });
          if (row) out.triggers.push(row.id);
        }
        // POS tidak dipakai N hari (outlet Aktif).
        for (const o of await tenantOutlets(tx, tenant.id, { depotOnly: true })) {
          if (!o.isActive || !o.activatedOn || addDays(o.activatedOn, rules.pos_unused_days) > today) continue;
          const [last] = await tx
            .select({ d: sql<string | null>`max(${posSales.businessDate})` })
            .from(posSales)
            .where(eq(posSales.outletId, o.id));
          const lastDate = last?.d ?? null;
          const idle = lastDate ? daysBetween(lastDate, today) : daysBetween(o.activatedOn, today);
          if (idle >= rules.pos_unused_days) {
            const row = await recordSanctionTrigger(tx, {
              partnerTenantId: tenant.id,
              trigger: "pos_unused",
              key: `pos_unused:${o.id}:${lastDate ?? o.activatedOn}`,
              summary: `POS ${o.name} tidak dipakai ${idle} hari (terakhir ${lastDate ?? "belum pernah"}).`,
              detail: { outletId: o.id, idleDays: idle },
              now,
            });
            if (row) out.triggers.push(row.id);
          }
        }
      }
      return out;
    },
    opts.db ? { db: opts.db } : {},
  );
}

// =====================================================================================================================
// KP-2: ekspor data outlet untuk mitra yang berakhir (PTB-58)
// =====================================================================================================================

/** Ringkas data outlet mitra untuk ekspor (transaksi, stok, laporan harian). Tanpa otorisasi. */
export async function partnerDataForExport(tx: Tx, tenantId: string) {
  const outletRows = await tx.select().from(outlets).where(eq(outlets.tenantId, tenantId)).orderBy(asc(outlets.code));
  const sales = await tx
    .select({ number: posSales.number, localNumber: posSales.localNumber, outletId: posSales.outletId, businessDate: posSales.businessDate, total: posSales.total, method: posSales.paymentMethod, status: posSales.status })
    .from(posSales)
    .where(eq(posSales.tenantId, tenantId))
    .orderBy(asc(posSales.businessDate))
    .limit(100_000);
  return { outlets: outletRows, sales };
}

/** Tandai ekspor data sudah diserahkan (pemilik/Admin Keuangan) — dipanggil setelah unduhan berhasil. */
export async function markPartnerDataExported(ctx: ActorContext, input: { tenantId: string }, opts: { tx?: Tx } = {}) {
  await authorize(ctx, "p3.partner_data_export.create", { tx: opts.tx, objectType: "tenant", objectId: input.tenantId });
  return runService(ctx, opts, async (tx) => {
    await assertOwnerTenant(tx, ctx);
    const contract = await latestContractFor(tx, input.tenantId);
    if (!contract || !["terminated", "ended"].includes(contract.status)) throw new DomainError("CONTRACT_NOT_ENDED", "Ekspor data untuk mitra hanya saat kontrak berakhir/diputus (PTB-58).");
    if (!contract.dataExportedAt) {
      await tx.update(partnerContracts).set({ dataExportedAt: ctx.now, updatedAt: ctx.now }).where(eq(partnerContracts.id, contract.id));
      await auditRecord(tx, { ctx, objectType: "partner_contract", objectId: contract.id, action: "data_exported", after: { dataExportedAt: ctx.now }, rule: "US-P3-07 KP-2, PTB-58" });
    }
    return { contractId: contract.id, exportedAt: contract.dataExportedAt ?? ctx.now };
  });
}

/** Pelanggan mitra tertaut (untuk handler). */
export async function partnerTenantOfCustomer(tx: Tx, customerId: string): Promise<string | null> {
  const [c] = await tx.select({ isEquaPartner: customers.isEquaPartner, partnerTenantId: customers.partnerTenantId }).from(customers).where(eq(customers.id, customerId)).limit(1);
  return c?.isEquaPartner ? c.partnerTenantId : null;
}

export function describeSanction(s: Pick<SanctionRow, "level" | "status">): string {
  return `${label("sanction_level", s.level)} · ${label("sanction_status", s.status)}`;
}
