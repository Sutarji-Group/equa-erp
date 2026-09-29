/**
 * P3 — akses lampiran lintas tenant yang DIPERJANJIKAN (NFR-30): pengguna EQUA membuka foto/berkas milik tenant mitra
 * (foto permintaan dukungan, foto daftar periksa mutu, foto audit, sertifikat uji air) dan pemilik mitra membuka bukti
 * kirim rit untuk pelanggan mitranya (tanda tangan penerima) — tanpa melonggarkan `readAttachment` inti (yang menolak
 * lampiran tenant lain). Setiap akses diotorisasi per objek; selain itu ditolak & tercatat.
 */
import "server-only";

import { eq } from "drizzle-orm";

import { attachments, customers, partnerAudits, partnerSupportRequests, partnerSurveys, qualityChecklists, qualityTests, trips } from "@/db/schema";

import { systemContext, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { ForbiddenError, NotFoundError } from "@/server/core/errors";
import { can, recordDenial } from "@/server/core/rbac";
import { readAttachment } from "@/server/core/storage";

import { loadTenant } from "./common";

async function deny(ctx: ActorContext, id: string): Promise<never> {
  const error = new ForbiddenError("Anda tidak berhak membuka berkas ini (NFR-30).", { rule: "NFR-30", objectType: "attachment", objectId: id });
  await recordDenial(ctx, error);
  throw error;
}

/** Tenant pemilik objek lampiran P3 (null bila objek bukan milik P3). */
async function objectTenant(tx: Tx, objectType: string | null, objectId: string | null): Promise<{ tenantId: string; permission: string[] } | null> {
  if (!objectType || !objectId) return null;
  if (objectType === "partner_support_request") {
    const [r] = await tx.select({ tenantId: partnerSupportRequests.tenantId }).from(partnerSupportRequests).where(eq(partnerSupportRequests.id, objectId)).limit(1);
    return r ? { tenantId: r.tenantId, permission: ["p3.support_request.read"] } : null;
  }
  if (objectType === "quality_checklist") {
    const [r] = await tx.select({ tenantId: qualityChecklists.tenantId }).from(qualityChecklists).where(eq(qualityChecklists.id, objectId)).limit(1);
    return r ? { tenantId: r.tenantId, permission: ["p3.quality_checklist.read"] } : null;
  }
  if (objectType === "partner_audit") {
    const [r] = await tx.select({ tenantId: partnerAudits.tenantId }).from(partnerAudits).where(eq(partnerAudits.id, objectId)).limit(1);
    return r ? { tenantId: r.tenantId, permission: ["p3.quality_checklist.read", "p3.partner_score.read", "p3.partner_audit.create"] } : null;
  }
  if (objectType === "quality_test") {
    const [r] = await tx.select({ tenantId: qualityTests.tenantId }).from(qualityTests).where(eq(qualityTests.id, objectId)).limit(1);
    return r ? { tenantId: r.tenantId, permission: ["p3.quality_checklist.read", "p3.partner_score.read", "p3.partner_quality_test.create"] } : null;
  }
  if (objectType === "partner_survey") {
    const [r] = await tx.select({ prospectId: partnerSurveys.prospectId }).from(partnerSurveys).where(eq(partnerSurveys.id, objectId)).limit(1);
    return r ? { tenantId: "", permission: ["p3.partner_prospect.create", "p3.partner.read"] } : null;
  }
  return null;
}

/** Pengguna EQUA membuka lampiran objek P3 (termasuk milik tenant mitra) sesuai izin baca objek itu. */
export async function readPartnerAttachmentForEqua(ctx: ActorContext, id: string): Promise<{ row: typeof attachments.$inferSelect; body: Buffer }> {
  const db = getDb();
  const own = await loadTenant(db, ctx.tenantId);
  if (own?.kind !== "owner") return deny(ctx, id);
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  if (!row) throw new NotFoundError("Berkas tidak ditemukan.");
  let target = await objectTenant(db, row.objectType, row.objectId);
  // Sertifikat uji air outlet mitra diunggah sebelum objek uji tertaut: cari uji yang merujuknya.
  if (!target) {
    const [q] = await db.select({ id: qualityTests.id, tenantId: qualityTests.tenantId }).from(qualityTests).where(eq(qualityTests.certificateAttachmentId, id)).limit(1);
    if (q) target = { tenantId: q.tenantId, permission: ["p3.quality_checklist.read", "p3.partner_score.read", "p3.partner_quality_test.create"] };
  }
  if (!target || !target.permission.some((p) => can(ctx, p))) return deny(ctx, id);
  return readAttachment(systemContext({ tenantId: row.tenantId ?? ctx.tenantId, now: ctx.now }), id, db);
}

/**
 * Pemilik mitra membuka lampiran: objek P3 tenant sendiri, atau bukti kirim (tanda tangan) rit pelanggan mitranya
 * (US-P3-03 KP-4). Selain itu ditolak & tercatat (US-P3-10 KP-4).
 */
export async function readPartnerAttachmentForPortal(ctx: ActorContext, id: string): Promise<{ row: typeof attachments.$inferSelect; body: Buffer }> {
  const db = getDb();
  const own = await loadTenant(db, ctx.tenantId);
  if (own?.kind !== "partner" || !can(ctx, "p3.partner_report.read")) return deny(ctx, id);
  const [row] = await db.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  if (!row) throw new NotFoundError("Berkas tidak ditemukan.");
  const target = await objectTenant(db, row.objectType, row.objectId);
  if (target && target.tenantId === ctx.tenantId) return readAttachment(systemContext({ tenantId: ctx.tenantId, now: ctx.now }), id, db);
  // Tanda tangan penerima pada rit pelanggan mitra ini.
  const [trip] = await db
    .select({ id: trips.id, partnerTenantId: customers.partnerTenantId })
    .from(trips)
    .innerJoin(customers, eq(customers.id, trips.customerId))
    .where(eq(trips.signatureAttachmentId, id))
    .limit(1);
  if (trip && trip.partnerTenantId === ctx.tenantId) return readAttachment(systemContext({ tenantId: row.tenantId ?? ctx.tenantId, now: ctx.now }), id, db);
  return deny(ctx, id);
}
