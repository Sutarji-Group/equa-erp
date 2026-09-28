/**
 * M2 — handler jenis persetujuan (PRD 6.2a; registri `src/server/core/approvals/registry.ts`).
 *
 * - `credit_order` (Pesanan tempo di luar kontrol kredit, US-M2-05): disetujui → pesanan Baru (dapat dijadwalkan),
 *   eksposur & batas saat keputusan dicatat pada pesanan (KP-5), batas pelanggan TIDAK berubah (KP-4); ditolak →
 *   pesanan Baru tetapi tidak dapat dijadwalkan sampai cara bayar diubah ke tunai/dibatalkan; lewat tenggat ("sebelum
 *   jadwal terbit") → pesanan tetap tunai (cara bayar menjadi tunai) + pemberitahuan ke Dispatcher untuk mengabari
 *   pelanggan (atau menggeser ke H+1).
 * - `second_underpayment_order` (PTB-18): disetujui → pesanan dapat dijadwalkan; ditolak / lewat tenggat → pesanan tidak
 *   dapat dijadwalkan (tetap sampai lunas).
 *
 * `ctx` handler = pelaku KEPUTUSAN (pemilik) — tidak memanggil layanan ber-`authorize` izin harian (SOD-08): menulis
 * langsung dengan `tx` + `audit.record`.
 */
import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { approvalRequests, orders, trips } from "@/db/schema";
import { formatRupiah } from "@/lib/money";

import { registerApprovalHandler, type ApprovalHandlerArgs } from "@/server/core/approvals";
import { record as auditRecord } from "@/server/core/audit";
import type { Tx } from "@/server/core/db";
import { emit } from "@/server/core/events";
import { notify } from "@/server/core/notifications";

import { isTripOpen, orderTrips, type OrderRow } from "./service/common";
import { computeCreditExposure } from "./service/credit";
import { recomputeOrderStatus } from "./service/lifecycle";

async function loadOrderForApproval(tx: Tx, id: string): Promise<OrderRow | null> {
  const rows = await tx.select().from(orders).where(eq(orders.id, id)).for("update").limit(1);
  return rows[0] ?? null;
}

/** Masih ada persetujuan lain yang menunggu untuk pesanan ini? */
async function otherOpenApproval(tx: Tx, order: OrderRow, exceptId: string): Promise<boolean> {
  const ids = [order.creditApprovalRequestId, order.underpaymentApprovalRequestId].filter((x): x is string => !!x && x !== exceptId);
  if (!ids.length) return false;
  const rows = await tx.select({ id: approvalRequests.id }).from(approvalRequests).where(and(inArray(approvalRequests.id, ids), eq(approvalRequests.status, "submitted")));
  return rows.length > 0;
}

/** Keluar dari "Menunggu persetujuan" (bila tidak ada persetujuan lain yang menunggu), lalu hitung ulang status. */
async function leaveAwaiting(args: ApprovalHandlerArgs, order: OrderRow, reason: string, rule: string) {
  const { tx, ctx, request } = args;
  if (order.status !== "awaiting_approval" || (await otherOpenApproval(tx, order, request.id))) return;
  await tx.update(orders).set({ status: "new", updatedAt: ctx.now }).where(eq(orders.id, order.id));
  await auditRecord(tx, { ctx, objectType: "order", objectId: order.id, action: "status", before: { status: "awaiting_approval" }, after: { status: "new" }, reason, rule });
  await emit(tx, "order.status_changed", { orderId: order.id, number: order.number, customerId: order.customerId, from: "awaiting_approval", to: "new", reason, cancelReason: null }, { ctx, objectType: "order", objectId: order.id });
  await recomputeOrderStatus(tx, ctx, order.id, { reason, rule });
}

async function recordDecisionExposure(args: ApprovalHandlerArgs, order: OrderRow) {
  const { tx, ctx } = args;
  const openTotal = (await orderTrips(tx, order.id)).filter(isTripOpen).reduce((s, t) => s + t.price, 0);
  const exposure = await computeCreditExposure(tx, order.customerId, { extraAmount: openTotal, excludeOrderId: order.id });
  await tx.update(orders).set({ creditExposureAtDecision: exposure.exposure, creditLimitAtDecision: exposure.creditLimit, updatedAt: ctx.now }).where(eq(orders.id, order.id));
  return exposure;
}

export function registerApprovals(): void {
  registerApprovalHandler("credit_order", {
    onApproved: async (args) => {
      const order = await loadOrderForApproval(args.tx, args.request.objectId);
      if (!order || order.status === "cancelled") return { skipped: true };
      const exposure = await recordDecisionExposure(args, order);
      await auditRecord(args.tx, {
        ctx: args.ctx,
        objectType: "order",
        objectId: order.id,
        action: "credit_approved",
        after: { approval: args.request.number, exposureAtDecision: exposure.exposure, creditLimitAtDecision: exposure.creditLimit },
        reason: args.reason,
        rule: "US-M2-05 KP-4/KP-5",
      });
      await leaveAwaiting(args, order, `Tempo disetujui pemilik (${args.request.number}) — hanya untuk pesanan ini`, "US-M2-05 KP-4");
      return { exposure: exposure.exposure, creditLimit: exposure.creditLimit };
    },
    onRejected: async (args) => {
      const order = await loadOrderForApproval(args.tx, args.request.objectId);
      if (!order || order.status === "cancelled") return { skipped: true };
      const exposure = await recordDecisionExposure(args, order);
      await auditRecord(args.tx, {
        ctx: args.ctx,
        objectType: "order",
        objectId: order.id,
        action: "credit_rejected",
        after: { approval: args.request.number, exposureAtDecision: exposure.exposure, creditLimitAtDecision: exposure.creditLimit },
        reason: args.reason,
        rule: "US-M2-05 KP-5",
      });
      await leaveAwaiting(args, order, `Tempo ditolak pemilik (${args.request.number}): ubah ke tunai atau batalkan`, "US-M2-05 KP-3");
      return { exposure: exposure.exposure, creditLimit: exposure.creditLimit };
    },
    onExpired: async (args) => {
      const { tx, ctx } = args;
      const order = await loadOrderForApproval(tx, args.request.objectId);
      if (!order || order.status === "cancelled" || order.paymentMethod !== "credit") return { skipped: true };
      const open = (await orderTrips(tx, order.id)).filter(isTripOpen);
      if (open.length) await tx.update(trips).set({ paymentMethod: "cash", updatedAt: ctx.now }).where(inArray(trips.id, open.map((t) => t.id)));
      await tx.update(orders).set({ paymentMethod: "cash", updatedAt: ctx.now }).where(eq(orders.id, order.id));
      await auditRecord(tx, {
        ctx,
        objectType: "order",
        objectId: order.id,
        action: "update",
        before: { paymentMethod: "credit" },
        after: { paymentMethod: "cash" },
        reason: `Persetujuan tempo ${args.request.number} lewat tenggat — pesanan tetap tunai (6.2a)`,
        rule: "6.2a",
      });
      await leaveAwaiting(args, { ...order, paymentMethod: "cash" }, `Persetujuan tempo lewat tenggat — tunai`, "6.2a");
      await notify(tx, {
        event: "approval.decided",
        tenantId: order.tenantId,
        recipients: { roles: ["dispatcher"] },
        title: `Tempo ${order.number} lewat tenggat: pesanan menjadi tunai`,
        body: `Kabari pelanggan: kirim tunai ${formatRupiah(order.totalAmount)} sesuai jadwal, atau jadwalkan ulang ke H+1 bila pelanggan tetap ingin tempo.`,
        objectType: "order",
        objectId: order.id,
        link: `/pesanan/${order.id}`,
        now: ctx.now,
      });
      return { paymentMethod: "cash" };
    },
    onCancelled: async (args) => {
      const order = await loadOrderForApproval(args.tx, args.request.objectId);
      if (!order || order.status === "cancelled") return;
      await leaveAwaiting(args, order, `Pengajuan tempo ${args.request.number} dibatalkan`, "US-M2-05 KP-3");
    },
  });

  registerApprovalHandler("second_underpayment_order", {
    onApproved: async (args) => {
      const order = await loadOrderForApproval(args.tx, args.request.objectId);
      if (!order || order.status === "cancelled") return { skipped: true };
      await auditRecord(args.tx, { ctx: args.ctx, objectType: "order", objectId: order.id, action: "underpayment_approved", after: { approval: args.request.number }, reason: args.reason, rule: "PTB-18" });
      await leaveAwaiting(args, order, `Pesanan saat kurang bayar kedua disetujui pemilik (${args.request.number})`, "PTB-18");
      return { schedulable: true };
    },
    onRejected: async (args) => {
      const order = await loadOrderForApproval(args.tx, args.request.objectId);
      if (!order || order.status === "cancelled") return { skipped: true };
      await leaveAwaiting(args, order, `Ditolak pemilik (${args.request.number}): dijadwalkan setelah kurang bayar lunas`, "PTB-18");
      return { schedulable: false };
    },
    onExpired: async (args) => {
      const order = await loadOrderForApproval(args.tx, args.request.objectId);
      if (!order || order.status === "cancelled") return { skipped: true };
      await leaveAwaiting(args, order, `Persetujuan ${args.request.number} lewat tenggat — pesanan tidak dapat dijadwalkan sampai lunas`, "6.2a");
      return { schedulable: false };
    },
    onCancelled: async (args) => {
      const order = await loadOrderForApproval(args.tx, args.request.objectId);
      if (!order || order.status === "cancelled") return;
      await leaveAwaiting(args, order, `Pengajuan ${args.request.number} dibatalkan`, "PTB-18");
    },
  });
}
