/**
 * Laporan kendala aplikasi & masukan lapangan (US-M10-07 KP-3; BRD 12.5): status Diterima → Dijawab → Selesai,
 * terlihat pelapor; tenggat jawaban PAR-87 (minggu). Laporan menyertakan versi aplikasi & status sinkron otomatis.
 * Dari web (`/bantuan`) atau dari perangkat lapangan (perintah sinkron `core.support.report`, bekerja offline).
 */
import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { supportTickets } from "@/db/schema";

import { record as auditRecord } from "./audit";
import { ctxBusinessDate, requireUserId, type ActorContext } from "./context";
import { getDb, type Tx } from "./db";
import { parseInput } from "./errors";
import { get as getParam } from "./params-read";
import { authorize, runService } from "./rbac/authorize";

export type SupportTicketRow = typeof supportTickets.$inferSelect;

export const supportTicketSchema = z.object({
  category: z.enum(["app_issue", "feedback"], { error: "Pilih jenis laporan." }).default("app_issue"),
  subject: z.string().trim().min(5, { error: "Judul minimal 5 karakter." }).max(150),
  description: z.string().trim().min(10, { error: "Ceritakan kendalanya minimal 10 karakter." }).max(4000),
  appVersion: z.string().trim().max(40).nullable().optional(),
  syncStatus: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type SupportTicketInput = z.input<typeof supportTicketSchema>;

/** Buat laporan kendala/masukan (semua peran, izin `m10.support_ticket.create`). */
export async function createSupportTicket(ctx: ActorContext, input: SupportTicketInput, opts: { tx?: Tx } = {}): Promise<SupportTicketRow> {
  await authorize(ctx, "m10.support_ticket.create", { tx: opts.tx, objectType: "support_ticket" });
  const data = parseInput(supportTicketSchema, input, { subject: "Judul", description: "Uraian" });
  const reporter = requireUserId(ctx);
  return runService(ctx, opts, async (tx) => {
    const { max_weeks } = await getParam(tx, "PAR-87", ctxBusinessDate(ctx));
    const [row] = await tx
      .insert(supportTickets)
      .values({
        tenantId: ctx.tenantId,
        category: data.category,
        reporterUserId: reporter,
        deviceId: ctx.deviceId,
        subject: data.subject,
        description: data.description,
        appVersion: data.appVersion ?? null,
        syncStatus: data.syncStatus ?? null,
        dueAt: new Date(ctx.now.getTime() + max_weeks * 7 * 86_400_000),
      })
      .returning();
    await auditRecord(tx, { ctx, objectType: "support_ticket", objectId: row!.id, action: "create", after: { subject: row!.subject, category: row!.category } });
    return row!;
  });
}

/** Laporan milik pelapor (terbaru dulu) — status terlihat pelapor. */
export async function listMySupportTickets(ctx: ActorContext, opts: { tx?: Tx; limit?: number } = {}): Promise<SupportTicketRow[]> {
  if (!ctx.userId) return [];
  return (opts.tx ?? getDb())
    .select()
    .from(supportTickets)
    .where(and(eq(supportTickets.tenantId, ctx.tenantId), eq(supportTickets.reporterUserId, ctx.userId)))
    .orderBy(desc(supportTickets.createdAt))
    .limit(Math.min(opts.limit ?? 20, 100));
}
