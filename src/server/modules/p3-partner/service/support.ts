/**
 * P3 — permintaan dukungan teknis mitra dengan SLA 48 jam (RL-7 US-P3-11, S; BRD 9.5, 9.8):
 *
 * - KP-1: pemilik mitra mengajukan dari portal (jenis, uraian, foto, outlet) → Diajukan → Ditanggapi (pembina/admin
 *   sistem EQUA) → Selesai; setiap perubahan bercap waktu (kolom + jejak audit).
 * - KP-2: waktu tanggap = Diajukan → Ditanggapi; lewat PAR-76 (48 jam) → notifikasi pemilik EQUA (job); ringkasan
 *   kepatuhan SLA per bulan masuk laporan bulanan mitra (US-P3-10 KP-3).
 * - KP-3: spare part dipesan lewat penjualan toko M7 harga mitra (BR-18) dan dirujuk dari permintaan.
 */
import "server-only";

import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { attachments, outlets, partnerSupportRequests, posSales, tenants } from "@/db/schema";
import { enumValues, label } from "@/lib/labels";
import { businessDateToUtcRange, formatTanggalJam, toBusinessDate } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, parseInput, ValidationError } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import * as params from "@/server/core/params";
import { authorize, can, runService } from "@/server/core/rbac";
import { linkAttachment } from "@/server/core/storage";

import { assertPartnerActor, denyCrossTenant, loadTenant, monthRange, notifyOnce, ownerTenantId, partnerCustomersOf } from "./common";

export type SupportRequestRow = typeof partnerSupportRequests.$inferSelect;
export type SupportRequestView = SupportRequestRow & { tenantName: string; outletName: string; responseHours: number | null; slaStatus: "on_time" | "late" | "open" };

function viewOf(r: SupportRequestRow, tenantName: string, outletName: string, now: Date): SupportRequestView {
  const responseHours = r.respondedAt ? Math.round(((r.respondedAt.getTime() - r.submittedAt.getTime()) / 3_600_000) * 10) / 10 : null;
  const due = r.slaDueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const slaStatus = r.respondedAt ? (r.respondedAt.getTime() <= due ? "on_time" : "late") : now.getTime() > due ? "late" : "open";
  return { ...r, tenantName, outletName, responseHours, slaStatus };
}

async function decorate(tx: Tx, rows: SupportRequestRow[], now: Date): Promise<SupportRequestView[]> {
  if (!rows.length) return [];
  const tenantRows = await tx.select({ id: tenants.id, name: tenants.name }).from(tenants).where(inArray(tenants.id, [...new Set(rows.map((r) => r.tenantId))]));
  const outletRows = await tx.select({ id: outlets.id, name: outlets.name }).from(outlets).where(inArray(outlets.id, [...new Set(rows.map((r) => r.outletId))]));
  return rows.map((r) => viewOf(r, tenantRows.find((t) => t.id === r.tenantId)?.name ?? "-", outletRows.find((o) => o.id === r.outletId)?.name ?? "-", now));
}

// =====================================================================================================================
// KP-1: ajukan (portal)
// =====================================================================================================================

const submitSchema = z.object({
  outletId: z.uuid({ error: "Pilih outlet." }),
  kind: z.enum(enumValues("support_request_kind"), { error: "Pilih jenis permintaan (peralatan, spare part, sistem, mutu air)." }),
  description: z.string().trim().min(10, { error: "Uraikan kendalanya (minimal 10 karakter)." }).max(2000),
  photoAttachmentId: z.uuid().nullable().optional(),
});
export type SubmitSupportInput = z.input<typeof submitSchema>;

export async function submitSupportRequest(ctx: ActorContext, input: SubmitSupportInput, opts: { tx?: Tx } = {}): Promise<SupportRequestRow> {
  await authorize(ctx, "p3.support_request.create", { tx: opts.tx, objectType: "partner_support_request" });
  const data = parseInput(submitSchema, input, { outletId: "Outlet", kind: "Jenis", description: "Uraian", photoAttachmentId: "Foto" });
  const db = opts.tx ?? getDb();
  const [o] = await db.select().from(outlets).where(eq(outlets.id, data.outletId)).limit(1);
  if (o && o.tenantId !== ctx.tenantId) await denyCrossTenant(ctx, "outlet", "outlet", data.outletId, opts.tx);
  return runService(ctx, opts, async (tx) => {
    const tenant = await assertPartnerActor(tx, ctx);
    if (!o || o.tenantId !== tenant.id) throw ValidationError.field("outletId", "Outlet tidak ditemukan.");
    if (data.photoAttachmentId) {
      const [att] = await tx.select({ tenantId: attachments.tenantId }).from(attachments).where(eq(attachments.id, data.photoAttachmentId)).limit(1);
      if (!att || att.tenantId !== tenant.id) throw ValidationError.field("photoAttachmentId", "Foto tidak ditemukan. Unggah ulang fotonya.");
    }
    const sla = await params.get(tx, "PAR-76", ctxBusinessDate(ctx));
    const [row] = await tx
      .insert(partnerSupportRequests)
      .values({
        tenantId: tenant.id,
        outletId: o.id,
        kind: data.kind,
        description: data.description,
        photoAttachmentId: data.photoAttachmentId ?? null,
        status: "submitted",
        submittedAt: ctx.now,
        submittedBy: ctx.userId,
        slaDueAt: new Date(ctx.now.getTime() + sla.support_response_hours * 3_600_000),
      })
      .returning();
    if (data.photoAttachmentId) await linkAttachment(tx, data.photoAttachmentId, { type: "partner_support_request", id: row!.id });
    await auditRecord(tx, {
      ctx,
      objectType: "partner_support_request",
      objectId: row!.id,
      action: "create",
      after: { status: "submitted", kind: data.kind, outletId: o.id, slaDueAt: row!.slaDueAt },
      rule: "US-P3-11 KP-1",
    });
    await notify(tx, {
      event: "partner.support_submitted",
      tenantId: await ownerTenantId(tx),
      title: `Permintaan dukungan mitra ${tenant.name}: ${label("support_request_kind", data.kind)}`,
      body: `${o.name}: ${data.description.slice(0, 200)}. Tanggapi sebelum ${formatTanggalJam(row!.slaDueAt!)} (PAR-76).`,
      objectType: "partner_support_request",
      objectId: row!.id,
      deadlineAt: row!.slaDueAt,
      link: `/kemitraan/dukungan/${row!.id}`,
      now: ctx.now,
    });
    return row!;
  });
}

// =====================================================================================================================
// Tanggapi, selesai, rujukan spare part (EQUA / mitra)
// =====================================================================================================================

async function loadRequest(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<SupportRequestRow> {
  const q = tx.select().from(partnerSupportRequests).where(eq(partnerSupportRequests.id, id)).limit(1);
  const rows = opts.forUpdate ? await q.for("update") : await q;
  if (!rows[0]) throw new NotFoundError("Permintaan dukungan tidak ditemukan.");
  return rows[0];
}

/** Penjualan toko M7 harga mitra untuk pelanggan mitra tenant ini (US-P3-11 KP-3, BR-18). */
async function assertPartnerSparePartSale(tx: Tx, tenantId: string, posSaleId: string) {
  const [sale] = await tx.select().from(posSales).where(eq(posSales.id, posSaleId)).limit(1);
  const custIds = (await partnerCustomersOf(tx, tenantId)).map((c) => c.id);
  if (!sale || !sale.customerId || !custIds.includes(sale.customerId)) {
    throw ValidationError.field("relatedPosSaleId", "Transaksi toko tidak ditemukan untuk pelanggan mitra ini. Catat dulu penjualan spare part harga mitra di POS toko (M7).");
  }
  if (sale.priceKind !== "partner") throw ValidationError.field("relatedPosSaleId", "Spare part mitra wajib memakai harga mitra (BR-18).");
  return sale;
}

const respondSchema = z.object({
  requestId: z.uuid(),
  response: z.string().trim().min(5, { error: "Tulis tanggapan (minimal 5 karakter)." }).max(2000),
  relatedPosSaleId: z.uuid().nullable().optional(),
});

export async function respondSupportRequest(ctx: ActorContext, input: z.input<typeof respondSchema>, opts: { tx?: Tx } = {}): Promise<SupportRequestRow> {
  await authorize(ctx, "p3.support_request.respond", { tx: opts.tx, objectType: "partner_support_request", objectId: input?.requestId });
  const data = parseInput(respondSchema, input, { response: "Tanggapan" });
  return runService(ctx, opts, async (tx) => {
    const req = await loadRequest(tx, data.requestId, { forUpdate: true });
    const own = await loadTenant(tx, ctx.tenantId);
    if (own?.kind !== "owner") throw new NotFoundError("Permintaan dukungan tidak ditemukan.");
    if (req.status !== "submitted") throw new DomainError("SUPPORT_ALREADY_RESPONDED", `Permintaan ini sudah ${label("support_request_status", req.status).toLowerCase()}.`);
    if (data.relatedPosSaleId) await assertPartnerSparePartSale(tx, req.tenantId, data.relatedPosSaleId);
    const breached = !!req.slaDueAt && ctx.now.getTime() > req.slaDueAt.getTime();
    const [row] = await tx
      .update(partnerSupportRequests)
      .set({ status: "responded", respondedAt: ctx.now, respondedBy: ctx.userId, response: data.response, slaBreached: req.slaBreached || breached, relatedPosSaleId: data.relatedPosSaleId ?? req.relatedPosSaleId, updatedAt: ctx.now })
      .where(eq(partnerSupportRequests.id, req.id))
      .returning();
    await auditRecord(tx, {
      ctx,
      objectType: "partner_support_request",
      objectId: req.id,
      action: "respond",
      before: { status: req.status },
      after: { status: "responded", respondedAt: ctx.now, slaBreached: row!.slaBreached, relatedPosSaleId: row!.relatedPosSaleId },
      reason: data.response,
      rule: "US-P3-11 KP-1/KP-2",
    });
    await notify(tx, {
      event: "partner.support_responded",
      tenantId: req.tenantId,
      recipients: { roles: ["partner_owner"] },
      title: "Permintaan dukungan Anda ditanggapi EQUA",
      body: data.response.slice(0, 300),
      objectType: "partner_support_request",
      objectId: req.id,
      link: `/mitra/dukungan`,
      now: ctx.now,
    });
    return row!;
  });
}

const completeSchema = z.object({ requestId: z.uuid(), note: z.string().trim().max(1000).nullable().optional() });

/** Tandai Selesai (penanggap EQUA atau pemilik mitra atas permintaannya sendiri). */
export async function completeSupportRequest(ctx: ActorContext, input: z.input<typeof completeSchema>, opts: { tx?: Tx } = {}): Promise<SupportRequestRow> {
  const data = parseInput(completeSchema, input, { note: "Catatan" });
  if (!can(ctx, "p3.support_request.respond")) await authorize(ctx, "p3.support_request.create", { tx: opts.tx, objectType: "partner_support_request", objectId: data.requestId });
  const db = opts.tx ?? getDb();
  const pre = await loadRequest(db, data.requestId);
  const own = await loadTenant(db, ctx.tenantId);
  if (own?.kind === "partner" && pre.tenantId !== ctx.tenantId) await denyCrossTenant(ctx, "permintaan dukungan", "partner_support_request", pre.id, opts.tx);
  return runService(ctx, opts, async (tx) => {
    const req = await loadRequest(tx, data.requestId, { forUpdate: true });
    if (req.status === "done") throw new DomainError("SUPPORT_DONE", "Permintaan ini sudah Selesai.");
    if (req.status !== "responded") throw new DomainError("SUPPORT_NOT_RESPONDED", "Permintaan belum ditanggapi EQUA; tandai Selesai setelah ada tanggapan.");
    const [row] = await tx.update(partnerSupportRequests).set({ status: "done", doneAt: ctx.now, updatedAt: ctx.now }).where(eq(partnerSupportRequests.id, req.id)).returning();
    await auditRecord(tx, { ctx, objectType: "partner_support_request", objectId: req.id, action: "complete", before: { status: req.status }, after: { status: "done", doneAt: ctx.now }, reason: data.note ?? null, rule: "US-P3-11 KP-1" });
    return row!;
  });
}

const linkSaleSchema = z.object({ requestId: z.uuid(), posSaleId: z.uuid({ error: "Pilih transaksi toko (harga mitra)." }) });

/** KP-3: rujuk penjualan spare part M7 harga mitra dari permintaan dukungan. */
export async function linkSupportSparePart(ctx: ActorContext, input: z.input<typeof linkSaleSchema>, opts: { tx?: Tx } = {}): Promise<SupportRequestRow> {
  await authorize(ctx, "p3.support_request.respond", { tx: opts.tx, objectType: "partner_support_request", objectId: input?.requestId });
  const data = parseInput(linkSaleSchema, input, { posSaleId: "Transaksi toko" });
  return runService(ctx, opts, async (tx) => {
    const req = await loadRequest(tx, data.requestId, { forUpdate: true });
    const sale = await assertPartnerSparePartSale(tx, req.tenantId, data.posSaleId);
    const [row] = await tx.update(partnerSupportRequests).set({ relatedPosSaleId: sale.id, updatedAt: ctx.now }).where(eq(partnerSupportRequests.id, req.id)).returning();
    await auditRecord(tx, { ctx, objectType: "partner_support_request", objectId: req.id, action: "link_spare_part", before: { relatedPosSaleId: req.relatedPosSaleId }, after: { relatedPosSaleId: sale.id, posSaleNumber: sale.number }, rule: "US-P3-11 KP-3, BR-18" });
    return row!;
  });
}

// =====================================================================================================================
// Kueri
// =====================================================================================================================

/** Daftar permintaan: pengguna EQUA melihat semua mitra; pemilik mitra hanya tenantnya. */
export async function listSupportRequests(ctx: ActorContext, filter: { status?: string | null; tenantId?: string | null } = {}, opts: { tx?: Tx } = {}): Promise<SupportRequestView[]> {
  await authorize(ctx, "p3.support_request.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const own = await loadTenant(tx, ctx.tenantId);
  const conds = [];
  if (own?.kind === "partner") {
    if (filter.tenantId && filter.tenantId !== ctx.tenantId) await denyCrossTenant(ctx, "permintaan dukungan", "tenant", filter.tenantId, opts.tx);
    conds.push(eq(partnerSupportRequests.tenantId, ctx.tenantId));
  } else if (filter.tenantId) conds.push(eq(partnerSupportRequests.tenantId, filter.tenantId));
  if (filter.status && (enumValues("support_request_status") as string[]).includes(filter.status)) conds.push(eq(partnerSupportRequests.status, filter.status as SupportRequestRow["status"]));
  const rows = await tx
    .select()
    .from(partnerSupportRequests)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(sql`case when ${partnerSupportRequests.status} = 'submitted' then 0 when ${partnerSupportRequests.status} = 'responded' then 1 else 2 end`, desc(partnerSupportRequests.submittedAt))
    .limit(500);
  return decorate(tx, rows, ctx.now);
}

export async function getSupportRequest(ctx: ActorContext, id: string, opts: { tx?: Tx } = {}): Promise<SupportRequestView & { sale: { id: string; number: string | null; total: number; businessDate: string } | null }> {
  await authorize(ctx, "p3.support_request.read", { tx: opts.tx, objectType: "partner_support_request", objectId: id });
  const tx = opts.tx ?? getDb();
  const req = await loadRequest(tx, id);
  const own = await loadTenant(tx, ctx.tenantId);
  if (own?.kind === "partner" && req.tenantId !== ctx.tenantId) await denyCrossTenant(ctx, "permintaan dukungan", "partner_support_request", id, opts.tx);
  const [view] = await decorate(tx, [req], ctx.now);
  let sale = null;
  if (req.relatedPosSaleId) {
    const [s] = await tx.select({ id: posSales.id, number: posSales.number, total: posSales.total, businessDate: posSales.businessDate }).from(posSales).where(eq(posSales.id, req.relatedPosSaleId)).limit(1);
    sale = s ?? null;
  }
  return { ...view!, sale };
}

/** KP-3: kandidat penjualan toko harga mitra (90 hari terakhir) untuk dirujuk dari permintaan dukungan. */
export async function supportSaleCandidates(ctx: ActorContext, requestId: string, opts: { tx?: Tx } = {}): Promise<{ id: string; number: string | null; total: number; businessDate: string }[]> {
  await authorize(ctx, "p3.support_request.respond", { tx: opts.tx, objectType: "partner_support_request", objectId: requestId });
  const tx = opts.tx ?? getDb();
  const req = await loadRequest(tx, requestId);
  const own = await loadTenant(tx, ctx.tenantId);
  if (own?.kind !== "owner") return [];
  const custIds = (await partnerCustomersOf(tx, req.tenantId)).map((c) => c.id);
  if (!custIds.length) return [];
  const since = toBusinessDate(new Date(ctx.now.getTime() - 90 * 86_400_000));
  return tx
    .select({ id: posSales.id, number: posSales.number, total: posSales.total, businessDate: posSales.businessDate })
    .from(posSales)
    .where(and(inArray(posSales.customerId, custIds), eq(posSales.priceKind, "partner"), gte(posSales.businessDate, since)))
    .orderBy(desc(posSales.createdAt))
    .limit(50);
}

// =====================================================================================================================
// KP-2: SLA
// =====================================================================================================================

/** Job: permintaan belum ditanggapi melewati PAR-76 → ditandai & notifikasi pemilik EQUA (sekali per permintaan). */
export async function runSupportSlaCheck(now: Date, db?: Db): Promise<{ flagged: string[] }> {
  return withTx(
    async (tx) => {
      const equa = await ownerTenantId(tx);
      const rows = await tx
        .select()
        .from(partnerSupportRequests)
        .where(and(eq(partnerSupportRequests.status, "submitted"), lt(partnerSupportRequests.slaDueAt, now)))
        .orderBy(asc(partnerSupportRequests.submittedAt));
      const flagged: string[] = [];
      for (const r of rows) {
        if (!r.slaBreached) await tx.update(partnerSupportRequests).set({ slaBreached: true, updatedAt: now }).where(eq(partnerSupportRequests.id, r.id));
        const tenant = await loadTenant(tx, r.tenantId);
        const hours = Math.floor((now.getTime() - r.submittedAt.getTime()) / 3_600_000);
        const sent = await notifyOnce(tx, {
          event: "partner.support_sla",
          tenantId: equa,
          title: `Permintaan dukungan mitra ${tenant?.name ?? ""} belum ditanggapi ${hours} jam`,
          body: `${label("support_request_kind", r.kind)}: ${r.description.slice(0, 160)}. Lewat SLA tanggap (PAR-76) — tindak lanjut.`,
          objectType: "partner_support_request",
          objectId: r.id,
          valueText: `${hours} jam`,
          link: `/kemitraan/dukungan/${r.id}`,
          groupKey: `partner.support_sla:${r.id}`,
          now,
        });
        if (sent) flagged.push(r.id);
      }
      return { flagged };
    },
    db ? { db } : {},
  );
}

export type SupportSlaSummary = {
  month: string;
  total: number;
  responded: number;
  respondedOnTime: number;
  late: number;
  open: number;
  done: number;
  avgResponseHours: number | null;
  compliancePct: number | null;
  slaHours: number;
};

/** Ringkasan kepatuhan SLA dukungan per bulan (US-P3-11 KP-2 → laporan bulanan mitra). Tanpa otorisasi. */
export async function supportSlaSummary(tx: Tx, tenantId: string, month: string, now: Date): Promise<SupportSlaSummary> {
  const { from, to } = monthRange(month);
  const start = businessDateToUtcRange(from).start;
  const end = businessDateToUtcRange(to).end;
  const rows = await tx
    .select()
    .from(partnerSupportRequests)
    .where(and(eq(partnerSupportRequests.tenantId, tenantId), gte(partnerSupportRequests.submittedAt, start), lt(partnerSupportRequests.submittedAt, end)));
  const sla = await params.get(tx, "PAR-76", to);
  const views = rows.map((r) => viewOf(r, "", "", now));
  const responded = views.filter((v) => v.respondedAt);
  const onTime = responded.filter((v) => v.slaStatus === "on_time").length;
  const judged = views.filter((v) => v.slaStatus !== "open");
  return {
    month,
    total: views.length,
    responded: responded.length,
    respondedOnTime: onTime,
    late: views.filter((v) => v.slaStatus === "late").length,
    open: views.filter((v) => v.status !== "done").length,
    done: views.filter((v) => v.status === "done").length,
    avgResponseHours: responded.length ? Math.round((responded.reduce((s, v) => s + (v.responseHours ?? 0), 0) / responded.length) * 10) / 10 : null,
    compliancePct: judged.length ? Math.round((onTime / judged.length) * 1000) / 10 : null,
    slaHours: sla.support_response_hours,
  };
}

export function supportMonthOf(date: Date): string {
  return toBusinessDate(date).slice(0, 7);
}
