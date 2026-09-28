/**
 * M2 — konfirmasi pesanan lewat WhatsApp (US-M2-07 S; NFR-20, K21, PTB-60).
 *
 * Template "Konfirmasi pesanan" dikelola pemilik (versi baru, versi lama dinonaktifkan — tanpa hapus). Tombol membuka
 * WhatsApp dengan pesan terisi ke nomor pelanggan; sistem mencatat "konfirmasi dibuka" (waktu, pelaku) tanpa klaim
 * terkirim/terbaca. Bila penyedia WhatsApp Business API aktif (`WA_PROVIDER=cloud_api`), pesan terkirim otomatis
 * lewat antarmuka `WhatsAppProvider` yang sama — alur Dispatcher tidak berubah.
 */
import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { customers, employees, waMessageLogs, waTemplates } from "@/db/schema";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal } from "@/lib/time";

import { record as auditRecord } from "@/server/core/audit";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb, type Tx } from "@/server/core/db";
import { DomainError, NotFoundError, ValidationError } from "@/server/core/errors";
import * as params from "@/server/core/params";
import { authorize, runService } from "@/server/core/rbac";
import { buildWaLink, formatWaNumber, getWhatsAppProvider, recordWaOpened, renderTemplate, type WhatsAppProvider } from "@/server/core/wa";

import { loadOrder } from "./common";

type TemplateRow = typeof waTemplates.$inferSelect;

/** Template konfirmasi pesanan aktif terbaru tenant. */
export async function activeOrderTemplate(tx: Tx, tenantId: string): Promise<TemplateRow | null> {
  const rows = await tx
    .select()
    .from(waTemplates)
    .where(and(eq(waTemplates.tenantId, tenantId), eq(waTemplates.kind, "order_confirmation"), eq(waTemplates.isActive, true)))
    .orderBy(desc(waTemplates.version))
    .limit(1);
  return rows[0] ?? null;
}

export type OrderConfirmationMessage = { phone: string; phoneDisplay: string; text: string; link: string; templateId: string | null; missing: string[] };

/** Pesan konfirmasi terisi (nomor, tanggal/jam, tangki, harga, cara bayar, kontak EQUA — KP-1). */
export async function buildOrderConfirmation(tx: Tx, ctx: ActorContext, orderId: string): Promise<OrderConfirmationMessage> {
  const order = await loadOrder(tx, ctx, orderId);
  const customer = (await tx.select().from(customers).where(eq(customers.id, order.customerId)).limit(1))[0];
  if (!customer) throw new NotFoundError("Pelanggan tidak ditemukan.");
  if (!customer.waPhone) throw new DomainError("NO_WA", "Pelanggan belum punya nomor WA. Lengkapi di Data master > Pelanggan.");
  const template = await activeOrderTemplate(tx, order.tenantId);
  if (!template) throw new DomainError("NO_TEMPLATE", "Template konfirmasi pesanan belum ada. Minta pemilik membuatnya di Pesanan > Template WA.");
  const identity = await params.get(tx, "company.identity", ctxBusinessDate(ctx));
  let contact = identity.phone;
  if (!contact && ctx.employeeId) contact = (await tx.select({ phone: employees.phone }).from(employees).where(eq(employees.id, ctx.employeeId)).limit(1))[0]?.phone ?? null;
  const { text, missing } = renderTemplate(template.body, {
    nama_pelanggan: customer.name,
    nomor_pesanan: order.number,
    tanggal_kirim: formatTanggal(order.requestedDate),
    jam_kirim: order.requestedTime ? `pukul ${order.requestedTime.slice(0, 5).replace(":", ".")}` : "",
    jumlah_tangki: order.tankCount,
    harga_per_rit: formatRupiah(order.pricePerTrip),
    total: formatRupiah(order.totalAmount),
    cara_bayar: label("payment_method", order.paymentMethod),
    kontak_equa: contact ? formatWaNumber(contact) : identity.name,
    nama_usaha: identity.name,
  });
  return { phone: customer.waPhone, phoneDisplay: formatWaNumber(customer.waPhone), text, link: buildWaLink(customer.waPhone, text), templateId: template.id, missing: missing.filter((m) => m !== "jam_kirim") };
}

/** Pratinjau pesan (tanpa mencatat). */
export async function previewOrderConfirmation(ctx: ActorContext, orderId: string, opts: { tx?: Tx } = {}): Promise<OrderConfirmationMessage> {
  await authorize(ctx, "m2.order.send_wa", { tx: opts.tx, objectType: "order", objectId: orderId });
  return buildOrderConfirmation(opts.tx ?? getDb(), ctx, orderId);
}

export type SendConfirmationResult = { mode: "link"; link: string; logId: string } | { mode: "sent"; logId: string } | { mode: "failed"; link: string; logId: string; error: string };

/**
 * "Kirim konfirmasi WA" (US-M2-07): mode tautan → catat "konfirmasi dibuka" (KP-2) dan kembalikan tautan wa.me; mode
 * Business API → kirim otomatis lewat penyedia (KP-3), gagal → tautan cadangan.
 */
export async function sendOrderConfirmation(ctx: ActorContext, orderId: string, opts: { tx?: Tx; provider?: WhatsAppProvider } = {}): Promise<SendConfirmationResult> {
  await authorize(ctx, "m2.order.send_wa", { tx: opts.tx, objectType: "order", objectId: orderId });
  const provider = opts.provider ?? getWhatsAppProvider();
  return runService(ctx, opts, async (tx) => {
    const msg = await buildOrderConfirmation(tx, ctx, orderId);
    const order = await loadOrder(tx, ctx, orderId);
    if (provider.kind === "link") {
      const log = await recordWaOpened(tx, ctx, { kind: "order_confirmation", toPhone: msg.phone, renderedText: msg.text, templateId: msg.templateId, customerId: order.customerId, objectType: "order", objectId: order.id });
      await auditRecord(tx, { ctx, objectType: "order", objectId: order.id, action: "wa_opened", after: { waMessageLogId: log.id, provider: "link" }, rule: "US-M2-07 KP-2" });
      return { mode: "link" as const, link: msg.link, logId: log.id };
    }
    const res = await provider.send({ to: msg.phone, text: msg.text, kind: "order_confirmation" });
    const sent = res.mode === "cloud_api" && res.status === "sent";
    const [log] = await tx
      .insert(waMessageLogs)
      .values({
        tenantId: order.tenantId,
        kind: "order_confirmation",
        templateId: msg.templateId,
        customerId: order.customerId,
        toPhone: msg.phone,
        renderedText: msg.text,
        objectType: "order",
        objectId: order.id,
        provider: "cloud_api",
        status: sent ? "sent" : "failed",
        openedAt: ctx.now,
        openedBy: ctx.userId,
        providerMessageId: res.mode === "cloud_api" && res.status === "sent" ? res.providerMessageId : null,
        sentAt: sent ? ctx.now : null,
        error: res.mode === "cloud_api" && res.status === "failed" ? res.error : null,
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "order", objectId: order.id, action: sent ? "wa_sent" : "wa_failed", after: { waMessageLogId: log!.id, provider: "cloud_api" }, rule: "US-M2-07 KP-3" });
    if (sent) return { mode: "sent" as const, logId: log!.id };
    return { mode: "failed" as const, link: res.mode === "cloud_api" && res.status === "failed" ? res.fallbackLink : msg.link, logId: log!.id, error: res.mode === "cloud_api" && res.status === "failed" ? res.error : "Gagal mengirim" };
  });
}

// =====================================================================================================================
// Template (dikelola pemilik)
// =====================================================================================================================

export const ORDER_TEMPLATE_VARIABLES = [
  "nama_pelanggan",
  "nomor_pesanan",
  "tanggal_kirim",
  "jam_kirim",
  "jumlah_tangki",
  "harga_per_rit",
  "total",
  "cara_bayar",
  "kontak_equa",
  "nama_usaha",
] as const;

/** Template konfirmasi pesanan aktif (baca). */
export async function getOrderConfirmationTemplate(ctx: ActorContext, opts: { tx?: Tx } = {}): Promise<TemplateRow | null> {
  await authorize(ctx, "m1.wa_template.read", { tx: opts.tx });
  return activeOrderTemplate(opts.tx ?? getDb(), ctx.tenantId);
}

/**
 * Pemilik mengubah template konfirmasi pesanan (US-M2-07 KP-1): versi baru, versi lama dinonaktifkan (tidak dihapus).
 * Wajib memuat nomor pesanan, tanggal kirim, jumlah tangki, harga, cara bayar, kontak.
 */
export async function updateOrderConfirmationTemplate(ctx: ActorContext, input: { body: string; reason: string }, opts: { tx?: Tx } = {}): Promise<TemplateRow> {
  await authorize(ctx, "m1.wa_template.update", { tx: opts.tx });
  const body = (input.body ?? "").trim();
  const reason = (input.reason ?? "").trim();
  if (body.length < 20) throw ValidationError.field("body", "Isi template terlalu pendek (minimal 20 karakter).");
  if (reason.length < 3) throw ValidationError.field("reason", "Alasan perubahan template wajib diisi.");
  const required = ["nomor_pesanan", "tanggal_kirim", "jumlah_tangki", "harga_per_rit", "cara_bayar", "kontak_equa"];
  const missing = required.filter((v) => !body.includes(`{{${v}}}`));
  if (missing.length) throw ValidationError.field("body", `Template wajib memuat: ${missing.map((m) => `{{${m}}}`).join(", ")} (US-M2-07 KP-1).`);
  return runService(ctx, opts, async (tx) => {
    const current = await activeOrderTemplate(tx, ctx.tenantId);
    const latest = await tx
      .select({ version: waTemplates.version })
      .from(waTemplates)
      .where(and(eq(waTemplates.tenantId, ctx.tenantId), eq(waTemplates.kind, "order_confirmation")))
      .orderBy(desc(waTemplates.version))
      .limit(1);
    if (current) {
      await tx.update(waTemplates).set({ isActive: false, deactivatedAt: ctx.now, deactivatedBy: ctx.userId, deactivationReason: `Diganti versi baru: ${reason}`, updatedAt: ctx.now }).where(eq(waTemplates.id, current.id));
    }
    const variables = [...new Set([...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!))];
    const [row] = await tx
      .insert(waTemplates)
      .values({ tenantId: ctx.tenantId, kind: "order_confirmation", name: current?.name ?? "Konfirmasi pesanan", body, variables, version: (latest[0]?.version ?? 0) + 1, createdBy: ctx.userId })
      .returning();
    await auditRecord(tx, { ctx, objectType: "wa_template", objectId: row!.id, action: "update", before: current ? { version: current.version, body: current.body } : null, after: { version: row!.version, body }, reason, rule: "US-M2-07 KP-1" });
    return row!;
  });
}

/** Riwayat "konfirmasi dibuka" pesanan. */
export async function orderWaLogs(tx: Tx, orderId: string) {
  return tx.select().from(waMessageLogs).where(and(eq(waMessageLogs.objectType, "order"), eq(waMessageLogs.objectId, orderId))).orderBy(desc(waMessageLogs.createdAt));
}

