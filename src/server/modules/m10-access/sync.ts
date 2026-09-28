/**
 * M10 — sinkron lapangan (docs/ARCHITECTURE.md §7).
 *
 * - Pull `m10.support_tickets` (semua pengguna lapangan): laporan kendala milik pengguna beserta status
 *   Diterima → Dijawab → Selesai dan jawabannya — status terlihat pelapor walau offline (US-M10-07 KP-3).
 * - Perintah `m10.support_ticket.close` — pelapor menandai laporan yang sudah dijawab sebagai Selesai (offline,
 *   idempoten: laporan yang sudah Selesai dianggap berhasil). Pembuatan laporan dari perangkat memakai perintah inti
 *   `core.support.report`.
 */
import "server-only";

import { z } from "zod";

import { registerPullProvider, registerSyncHandler } from "@/server/core/sync";

import { closeSupportTicket, myTicketsForField } from "./service/support";

export function registerSync(): void {
  registerPullProvider("m10.support_tickets", async ({ ctx, tx }) => myTicketsForField(tx, ctx));

  registerSyncHandler("m10.support_ticket.close", {
    permission: "m10.support_ticket.create",
    description: "Pelapor menandai laporan kendala yang sudah dijawab sebagai selesai.",
    schema: z.object({ ticketId: z.uuid({ error: "Laporan tidak valid." }), note: z.string().trim().max(500).nullable().optional() }).strict(),
    labels: { ticketId: "Laporan", note: "Catatan" },
    handle: async (ctx, payload, { tx }) => {
      const row = await closeSupportTicket(ctx, { ticketId: payload.ticketId, note: payload.note ?? null }, { tx });
      return { objectType: "support_ticket", objectId: row.id, result: { status: row.status } };
    },
  });
}
