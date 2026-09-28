"use server";

import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m1-master/action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import { withTx } from "@/server/core/db";
import { put } from "@/server/core/storage";
import * as m1 from "@/server/modules/m1-master";

import { attempt, coord, int, str } from "../_lib/form";

const base = "/master/sumber-air";

function sourceInput(fd: FormData): m1.WaterSourceInput {
  const p = coord(fd);
  return {
    code: str(fd, "code") ?? "",
    name: str(fd, "name") ?? "",
    address: str(fd, "address"),
    lat: p.lat ?? Number.NaN,
    lng: p.lng ?? Number.NaN,
    geofenceRadiusM: int(fd, "geofenceRadiusM"),
    dailyCapacityL: int(fd, "dailyCapacityL") ?? undefined,
  };
}

export async function createSourceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.createWaterSource(ctx, sourceInput(fd)).then(() => undefined), "Sumber air dibuat.");
  revalidatePath(base);
  return res;
}

export async function updateSourceAction(sourceId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.updateWaterSource(ctx, sourceId, sourceInput(fd)).then(() => undefined), "Sumber air disimpan.");
  revalidatePath(base);
  return res;
}

export async function setSourceActiveAction(sourceId: string, active: boolean, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.setWaterSourceActive(ctx, sourceId, { active, reason }).then(() => undefined), active ? "Sumber air diaktifkan." : "Sumber air dinonaktifkan.");
  revalidatePath(base);
  return res;
}

/** Tambah meter + foto angka awal cut-over (US-M1-04 KP-2). */
export async function addMeterAction(sourceId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    const file = fd.get("photo");
    let photoId: string | null = null;
    if (file instanceof File && file.size > 0) {
      const buf = Buffer.from(await file.arrayBuffer());
      const att = await withTx((tx) => put(tx, ctx, { blob: buf, contentType: file.type, kind: "meter_photo", originalName: file.name }));
      photoId = att.id;
    }
    await m1.addWaterMeter(ctx, sourceId, {
      code: str(fd, "code") ?? "",
      name: str(fd, "name"),
      unit: (str(fd, "unit") ?? "liter") as "liter" | "cubic_meter",
      initialReadingL: int(fd, "initialReadingL") ?? Number.NaN,
      installedAt: str(fd, "installedAt"),
      initialPhotoAttachmentId: photoId,
    });
  }, "Meter ditambahkan.");
  revalidatePath(base);
  return res;
}

export async function deactivateMeterAction(meterId: string, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.deactivateWaterMeter(ctx, meterId, reason).then(() => undefined), "Meter dinonaktifkan.");
  revalidatePath(base);
  return res;
}
