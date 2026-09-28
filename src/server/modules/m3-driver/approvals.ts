/**
 * M3 — handler jenis persetujuan `field_payment_to_credit` (6.2a "Ubah cara bayar tunai → tempo di lapangan";
 * pemohon Sopir/kernet pengganti, penyetuju DISPATCHER, tenggat "saat di lokasi", lewat tenggat → kurang bayar).
 *
 * Keputusan tidak mengubah pembayaran secara langsung: perangkat membaca keputusan lewat pull `m3.today` lalu mencatat
 * Selesai dengan tempo (disetujui) atau kurang bayar (ditolak/lewat tenggat/luring, US-M3-04 KP-2/KP-4). Bila rit sudah
 * dicatat kurang bayar sebelum keputusan tiba lalu disetujui, Admin Keuangan diberi tahu agar mengonversinya menjadi
 * tempo setelah pemeriksaan batas (US-M3-04 KP-4). `ctx` handler = Dispatcher (bukan pemohon) — tidak memanggil layanan
 * lapangan; tulis langsung dengan `tx` + audit.
 */
import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { tripPayments, trips } from "@/db/schema";
import { formatRupiah } from "@/lib/money";

import { registerApprovalHandler, type ApprovalHandlerArgs } from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import { notify } from "@/server/core/notifications";

async function touchTrip(args: ApprovalHandlerArgs): Promise<{ tripNumber: string | null; paid: boolean; paymentMethod: string | null }> {
  const { tx, request, ctx } = args;
  const trip = (await tx.select({ id: trips.id, number: trips.number }).from(trips).where(eq(trips.id, request.objectId)).limit(1))[0];
  if (!trip) return { tripNumber: null, paid: false, paymentMethod: null };
  // Perubahan keputusan → data pull `m3.today` perangkat berubah (kursor).
  await tx.update(trips).set({ updatedAt: ctx.now }).where(eq(trips.id, trip.id));
  const pay = (await tx
    .select({ method: tripPayments.method })
    .from(tripPayments)
    .where(and(eq(tripPayments.tripId, trip.id), isNull(tripPayments.reversalOfId), isNull(tripPayments.reversedAt)))
    .limit(1))[0];
  return { tripNumber: trip.number, paid: !!pay, paymentMethod: pay?.method ?? null };
}

export function registerApprovals(): void {
  registerApprovalHandler("field_payment_to_credit", {
    onApproved: async (args) => {
      const { tx, request, ctx } = args;
      const t = await touchTrip(args);
      await auditRecord(tx, {
        ctx,
        objectType: "trip",
        objectId: request.objectId,
        action: "field_credit_approved",
        after: { approvalId: request.id, number: request.number, alreadyRecorded: t.paid },
        reason: args.reason,
        rule: "PTB-19",
      });
      if (t.paid && t.paymentMethod !== "credit") {
        // Rit sudah dicatat kurang bayar sebelum keputusan (luring/menunggu) → Admin Keuangan dapat mengonversi ke tempo.
        await notify(tx, {
          event: "field_credit.decided",
          tenantId: request.tenantId,
          title: `Tempo disetujui setelah rit ${t.tripNumber ?? ""} dicatat kurang bayar`,
          body: `Permintaan ${request.number} (${formatRupiah(request.amount ?? 0)}) disetujui Dispatcher, tetapi pembayaran rit sudah dicatat. Konversi kurang bayar menjadi tempo setelah pemeriksaan batas (US-M3-04 KP-4).`,
          objectType: "trip",
          objectId: request.objectId,
          valueAmount: request.amount ?? null,
          now: ctx.now,
        });
        return { effect: "already_recorded_as_underpayment", tripNumber: t.tripNumber };
      }
      return { effect: "credit_allowed_on_device", tripNumber: t.tripNumber };
    },
    onRejected: async (args) => {
      const t = await touchTrip(args);
      await auditRecord(args.tx, {
        ctx: args.ctx,
        objectType: "trip",
        objectId: args.request.objectId,
        action: "field_credit_rejected",
        after: { approvalId: args.request.id, number: args.request.number },
        reason: args.reason,
        rule: "PTB-19",
      });
      return { effect: "record_as_underpayment", tripNumber: t.tripNumber };
    },
    onExpired: async (args) => {
      const t = await touchTrip(args);
      return { effect: "record_as_underpayment", reason: "Lewat tenggat \"saat di lokasi\" — dicatat sebagai kurang bayar (US-M3-04 KP-2).", tripNumber: t.tripNumber };
    },
    onCancelled: async (args) => {
      await touchTrip(args);
      return { effect: "cancelled" };
    },
  });
}
