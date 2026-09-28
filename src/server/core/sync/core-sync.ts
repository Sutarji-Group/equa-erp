/**
 * Handler & penyedia sinkron inti (contoh + diagnostik; dipanggil `registerCoreAuth` saat bootstrap):
 * - perintah `core.ping` — uji kirim data dari perangkat ("Kirim data uji"); efeknya satu baris riwayat perangkat;
 * - pull `core.me` — pengguna, peran, lingkup (truk hari itu), perangkat;
 * - pull `core.device_users` — daftar pengguna yang boleh memakai perangkat (layar pilih pengguna offline).
 */
import "server-only";

import { z } from "zod";

import { label } from "@/lib/labels";

import { listDeviceUsers } from "../auth/field-login";
import { logDeviceUsage, publicDevice } from "../auth/devices";
import { registerPullProvider, registerSyncHandler } from "./registry";

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

  registerPullProvider("core.me", async ({ ctx, device, tx }) => ({
    userId: ctx.userId,
    employeeId: ctx.employeeId,
    roles: ctx.roles,
    roleLabels: ctx.roles.map((r) => label("role", r)),
    scope: ctx.scope,
    device: await publicDevice(tx, device),
  }));

  registerPullProvider("core.device_users", async ({ device, tx, now }) => listDeviceUsers(tx, device, now));
}
