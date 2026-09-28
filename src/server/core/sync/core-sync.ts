/**
 * Handler & penyedia sinkron inti (contoh + diagnostik; dipanggil `registerCoreAuth` saat bootstrap):
 * - perintah `core.ping` — uji kirim data dari perangkat ("Kirim data uji"); efeknya satu baris riwayat perangkat;
 * - pull `core.me` — pengguna, peran, lingkup (truk hari itu), perangkat;
 * - pull `core.device_users` — daftar pengguna yang boleh memakai perangkat (layar pilih pengguna offline);
 * - perintah `core.support.report` — laporan kendala aplikasi dari perangkat (US-M10-07 KP-3), bekerja offline;
 * - sumber urutan nomor lokal perangkat `pos_sale`, `purchase_receipt`, `internal_transfer` (`deviceSeq` di pull).
 */
import "server-only";

import { eq, max } from "drizzle-orm";
import { z } from "zod";

import { internalTransfers, posSales, purchaseReceipts } from "@/db/schema";

import { label } from "@/lib/labels";

import { listDeviceUsers } from "../auth/field-login";
import { createSupportTicket, supportTicketSchema } from "../support";
import { logDeviceUsage, publicDevice } from "../auth/devices";
import { registerDeviceSeqScope, registerPullProvider, registerSyncHandler } from "./registry";

let registered = false;

export function registerCoreSync(): void {
  if (registered) return;
  registered = true;

  registerSyncHandler("core.ping", {
    permission: null,
    description: "Uji kirim data dari perangkat (diagnostik sinkron).",
    schema: z.object({ note: z.string().trim().max(200).optional() }).strict(),
    labels: { note: "Catatan" },
    handle: async (ctx, payload, { tx, command, device, clockSkewFlagged }) => {
      await logDeviceUsage(tx, {
        tenantId: device.tenantId,
        deviceId: device.id,
        userId: ctx.userId,
        event: "ping",
        occurredAt: command.deviceTime,
        details: { commandId: command.id, note: payload.note ?? null, clockSkewFlagged },
      });
      return {
        objectType: "device",
        objectId: device.id,
        result: { pong: true, receivedAt: ctx.now.toISOString(), businessDate: command.businessDate },
      };
    },
  });

  registerSyncHandler("core.support.report", {
    permission: "m10.support_ticket.create",
    description: "Laporan kendala aplikasi / masukan lapangan dari perangkat.",
    schema: supportTicketSchema,
    labels: { subject: "Judul", description: "Uraian" },
    handle: async (ctx, payload, { tx }) => {
      const ticket = await createSupportTicket(ctx, payload, { tx });
      return { objectType: "support_ticket", objectId: ticket.id };
    },
  });

  registerPullProvider("core.me", async ({ ctx, device, tx }) => ({
    userId: ctx.userId,
    employeeId: ctx.employeeId,
    roles: ctx.roles,
    roleLabels: ctx.roles.map((r) => label("role", r)),
    scope: ctx.scope,
    device: await publicDevice(tx, device),
  }));

  registerPullProvider("core.device_users", async ({ device, tx, now }) => listDeviceUsers(tx, device, now));

  // Batas bawah urutan nomor lokal perangkat (src/lib/local-number.ts; nextDeviceSeq di klien).
  registerDeviceSeqScope("pos_sale", async (tx, deviceId) => {
    const [row] = await tx.select({ v: max(posSales.deviceSeq) }).from(posSales).where(eq(posSales.deviceId, deviceId));
    return Number(row?.v ?? 0);
  });
  registerDeviceSeqScope("purchase_receipt", async (tx, deviceId) => {
    const [row] = await tx.select({ v: max(purchaseReceipts.deviceSeq) }).from(purchaseReceipts).where(eq(purchaseReceipts.deviceId, deviceId));
    return Number(row?.v ?? 0);
  });
  registerDeviceSeqScope("internal_transfer", async (tx, deviceId) => {
    const [row] = await tx.select({ v: max(internalTransfers.deviceSeq) }).from(internalTransfers).where(eq(internalTransfers.deviceId, deviceId));
    return Number(row?.v ?? 0);
  });
}
