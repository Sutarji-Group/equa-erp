/**
 * M10 — helpdesk laporan kendala & masukan lapangan (US-M10-07 KP-3; BRD 12.5; PAR-87).
 *
 * Pembuatan laporan ada di core (`createSupportTicket`, web `/bantuan` & perintah sinkron `core.support.report`). Modul
 * ini menambah: daftar helpdesk (admin sistem/pemilik), jawaban (Diterima → Dijawab), penutupan (Dijawab → Selesai oleh
 * pelapor atau tim IT), status terlihat pelapor di aplikasi lapangan (pull `m10.support_tickets`), dan job pengingat
 * laporan yang belum dijawab melewati PAR-87 → notifikasi `support.feedback_unanswered` ke admin sistem (peran yang
 * dipakai manajer proyek IT di Tahap 1).
 */
import "server-only";

import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { z } from "zod";

import { notifications, supportTickets } from "@/db/schema";
import { formatTanggalJam } from "@/lib/time";
import { record as auditRecord } from "@/server/core/audit";
import type { ActorContext } from "@/server/core/context";
import { getDb, withTx, type Db, type Tx } from "@/server/core/db";
import { ConflictError, ForbiddenError, NotFoundError, parseInput } from "@/server/core/errors";
import { notify } from "@/server/core/notifications";
import { authorize, can, runService } from "@/server/core/rbac";

import { userNames } from "./shared";

export type TicketRow = typeof supportTickets.$inferSelect;
export type TicketView = TicketRow & { reporterName: string; answeredByName: string | null; overdue: boolean };

/** Kotak helpdesk: semua laporan tenant (admin sistem, pemilik). */
export async function listSupportTickets(ctx: ActorContext, filter: { status?: TicketRow["status"] | "open" } = {}, opts: { tx?: Tx } = {}): Promise<TicketView[]> {
  await authorize(ctx, "m10.support_ticket.read", { tx: opts.tx });
  const tx = opts.tx ?? getDb();
  const where = [eq(supportTickets.tenantId, ctx.tenantId)];
  if (filter.status === "open") where.push(inArray(supportTickets.status, ["received", "answered"]));
  else if (filter.status) where.push(eq(supportTickets.status, filter.status));
  const rows = await tx.select().from(supportTickets).where(and(...where)).orderBy(desc(supportTickets.createdAt)).limit(200);
  const names = await userNames(tx, rows.flatMap((r) => [r.reporterUserId, r.answeredBy]));
  return rows.map((r) => ({
    ...r,
    reporterName: names.get(r.reporterUserId) ?? "—",
    answeredByName: r.answeredBy ? (names.get(r.answeredBy) ?? null) : null,
    overdue: r.status === "received" && !!r.dueAt && r.dueAt < ctx.now,
  }));
}

const answerSchema = z.object({
  ticketId: z.uuid(),
  answer: z.string().trim().min(5, { error: "Jawaban minimal 5 karakter." }).max(4000),
});

/** Tim IT menjawab laporan (Diterima → Dijawab); pelapor diberi tahu. */
export async function answerSupportTicket(ctx: ActorContext, input: z.input<typeof answerSchema>, opts: { tx?: Tx } = {}): Promise<TicketRow> {
  await authorize(ctx, "m10.support_ticket.answer", { tx: opts.tx, objectType: "support_ticket", objectId: input.ticketId });
  const data = parseInput(answerSchema, input, { answer: "Jawaban" });
  return runService(ctx, opts, async (tx) => {
    const row = await loadTicket(tx, ctx, data.ticketId);
    if (row.status === "done") throw new ConflictError("TICKET_DONE", "Laporan sudah selesai.");
    const [updated] = await tx
      .update(supportTickets)
      .set({ status: "answered", answer: data.answer, answeredBy: ctx.userId, answeredAt: ctx.now, updatedAt: ctx.now })
      .where(eq(supportTickets.id, row.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "support_ticket", objectId: row.id, action: "update", before: { status: row.status }, after: { status: "answered" } });
    await notify(tx, {
      event: "support.ticket_answered",
      tenantId: ctx.tenantId,
      recipients: { userIds: [row.reporterUserId] },
      title: `Laporan "${row.subject}" dijawab tim IT`,
      body: data.answer.slice(0, 300),
      objectType: "support_ticket",
      objectId: row.id,
      link: "/bantuan",
      now: ctx.now,
    });
    return updated!;
  });
}

async function loadTicket(tx: Tx, ctx: ActorContext, id: string): Promise<TicketRow> {
  const rows = await tx.select().from(supportTickets).where(eq(supportTickets.id, id)).limit(1);
  const row = rows[0];
  if (!row || row.tenantId !== ctx.tenantId) throw new NotFoundError("Laporan tidak ditemukan.");
  return row;
}

/**
 * Tandai laporan Selesai: pelapor (miliknya sendiri) atau tim IT. Idempoten — laporan yang sudah Selesai dikembalikan
 * apa adanya (aman untuk perintah sinkron yang terkirim ulang).
 */
export async function closeSupportTicket(ctx: ActorContext, input: { ticketId: string; note?: string | null }, opts: { tx?: Tx } = {}): Promise<TicketRow> {
  await authorize(ctx, "m10.support_ticket.create", { tx: opts.tx, objectType: "support_ticket", objectId: input.ticketId });
  return runService(ctx, opts, async (tx) => {
    const row = await loadTicket(tx, ctx, input.ticketId);
    const isHelpdesk = can(ctx, "m10.support_ticket.answer");
    if (row.reporterUserId !== ctx.userId && !isHelpdesk) {
      throw new ForbiddenError("Hanya pelapor atau tim IT yang dapat menandai laporan ini selesai.", { rule: "RBAC", objectType: "support_ticket", objectId: row.id });
    }
    if (row.status === "done") return row;
    if (row.status === "received" && !isHelpdesk) throw new ConflictError("TICKET_NOT_ANSWERED", "Laporan belum dijawab tim IT.");
    const [updated] = await tx
      .update(supportTickets)
      .set({ status: "done", doneAt: ctx.now, updatedAt: ctx.now })
      .where(eq(supportTickets.id, row.id))
      .returning();
    await auditRecord(tx, { ctx, objectType: "support_ticket", objectId: row.id, action: "close", before: { status: row.status }, after: { status: "done" }, reason: input.note ?? null });
    return updated!;
  });
}

/** Laporan pelapor untuk aplikasi lapangan (pull): status & jawaban terlihat pelapor. */
export async function myTicketsForField(tx: Tx, ctx: ActorContext) {
  if (!ctx.userId) return [];
  const rows = await tx
    .select()
    .from(supportTickets)
    .where(and(eq(supportTickets.tenantId, ctx.tenantId), eq(supportTickets.reporterUserId, ctx.userId)))
    .orderBy(desc(supportTickets.createdAt))
    .limit(20);
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    category: r.category,
    status: r.status,
    answer: r.answer,
    createdAt: r.createdAt.toISOString(),
    answeredAt: r.answeredAt?.toISOString() ?? null,
    dueAt: r.dueAt?.toISOString() ?? null,
  }));
}

/** Job harian: laporan belum dijawab melewati PAR-87 → notifikasi admin sistem (sekali per laporan). */
export async function remindUnansweredTickets(now: Date = new Date(), db?: Db): Promise<{ reminded: number }> {
  return withTx(
    async (tx) => {
      const due = await tx
        .select()
        .from(supportTickets)
        .where(and(eq(supportTickets.status, "received"), lte(supportTickets.dueAt, now)));
      let reminded = 0;
      for (const t of due) {
        const already = await tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(and(eq(notifications.event, "support.feedback_unanswered"), eq(notifications.objectId, t.id)))
          .limit(1);
        if (already[0]) continue;
        await notify(tx, {
          event: "support.feedback_unanswered",
          tenantId: t.tenantId,
          title: `Laporan lapangan belum dijawab: ${t.subject}`,
          body: `Tenggat jawaban ${t.dueAt ? formatTanggalJam(t.dueAt) : "-"} (PAR-87) terlewati.`,
          objectType: "support_ticket",
          objectId: t.id,
          link: "/bantuan#helpdesk",
          now,
        });
        reminded++;
      }
      return { reminded };
    },
    { db },
  );
}
