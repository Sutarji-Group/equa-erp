"use server";

import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m10-access/action-state";
import { formatTanggalJam } from "@/lib/time";
import { requireOfficeSession } from "@/server/core/auth/office";
import { blockDevice, issueActivationCode, registerDevice, requestWipe, updateDeviceAssignment } from "@/server/modules/m10-access";

import { bool, runAction, str } from "../_action";

/** Unit dari satu pilihan `jenis:id` → kolom perangkat. */
function unitFields(value: string | null): { truckId: string | null; outletId: string | null; waterSourceId: string | null } {
  const [type, id] = (value ?? "").split(":");
  return {
    truckId: type === "truck" ? (id ?? null) : null,
    outletId: type === "outlet" ? (id ?? null) : null,
    waterSourceId: type === "water_source" ? (id ?? null) : null,
  };
}

/** Daftarkan perangkat → kode aktivasi 8 karakter ditampilkan SEKALI (US-M10-02 KP-1). */
export async function registerDeviceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  return runAction(async () => {
    const r = await registerDevice(ctx, {
      deviceCode: str(formData, "deviceCode") ?? "",
      name: str(formData, "name") ?? "",
      kind: str(formData, "kind") === "tablet" ? "tablet" : "phone",
      isSpare: bool(formData, "isSpare"),
      holderEmployeeId: str(formData, "holderEmployeeId"),
      notes: str(formData, "notes"),
      ...unitFields(str(formData, "unit")),
    });
    revalidatePath("/akses/perangkat");
    return {
      ok: true,
      secret: {
        label: `Kode aktivasi perangkat ${r.device.deviceCode}`,
        value: r.displayCode,
        note: `Berlaku sampai ${formatTanggalJam(r.expiresAt)}. Masukkan di ponsel/tablet pada halaman Aktivasi perangkat. Kode tidak dapat dilihat lagi.`,
      },
    };
  });
}

export async function updateDeviceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const deviceId = str(formData, "deviceId") ?? "";
  return runAction(async () => {
    await updateDeviceAssignment(ctx, {
      deviceId,
      name: str(formData, "name") ?? undefined,
      ...unitFields(str(formData, "unit")),
      holderEmployeeId: str(formData, "holderEmployeeId"),
      isSpare: bool(formData, "isSpare"),
      notes: str(formData, "notes"),
      reason: str(formData, "reason") ?? "",
    });
    revalidatePath(`/akses/perangkat/${deviceId}`);
    return { ok: true, message: "Penetapan perangkat disimpan." };
  });
}

export async function blockDeviceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const deviceId = str(formData, "deviceId") ?? "";
  return runAction(async () => {
    await blockDevice(ctx, deviceId, str(formData, "reason") ?? "");
    revalidatePath(`/akses/perangkat/${deviceId}`);
    return { ok: true, message: "Perangkat diblokir: tidak dapat login dan tidak menerima data baru." };
  });
}

export async function wipeDeviceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const deviceId = str(formData, "deviceId") ?? "";
  return runAction(async () => {
    await requestWipe(ctx, deviceId, str(formData, "reason") ?? "");
    revalidatePath(`/akses/perangkat/${deviceId}`);
    return { ok: true, message: "Perintah hapus data dikirim; dijalankan saat perangkat menghubungi server berikutnya." };
  });
}

export async function newActivationCodeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const deviceId = str(formData, "deviceId") ?? "";
  return runAction(async () => {
    const r = await issueActivationCode(ctx, deviceId, { reason: str(formData, "reason") ?? undefined });
    revalidatePath(`/akses/perangkat/${deviceId}`);
    return { ok: true, secret: { label: "Kode aktivasi baru", value: r.displayCode, note: `Berlaku sampai ${formatTanggalJam(r.expiresAt)}. Sesi lama perangkat ini sudah diputus.` } };
  });
}
