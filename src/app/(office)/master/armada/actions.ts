"use server";

import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m1-master/action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import * as m1 from "@/server/modules/m1-master";

import { attempt, int, str } from "../_lib/form";

const base = "/master/armada";

function truckInput(fd: FormData): m1.TruckInput {
  return {
    code: str(fd, "code") ?? "",
    plateNumber: str(fd, "plateNumber") ?? "",
    capacityL: int(fd, "capacityL") ?? undefined,
    defaultDriverEmployeeId: str(fd, "defaultDriverEmployeeId"),
    defaultHelperEmployeeId: str(fd, "defaultHelperEmployeeId"),
    gpsDeviceId: str(fd, "gpsDeviceId"),
    fieldDeviceId: str(fd, "fieldDeviceId"),
    dailyTripCapacity: int(fd, "dailyTripCapacity"),
    poolLocationId: str(fd, "poolLocationId"),
  };
}

export async function createTruckAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.createTruck(ctx, truckInput(fd)).then(() => undefined), "Truk didaftarkan.");
  revalidatePath(base);
  return res;
}

export async function updateTruckAction(truckId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.updateTruck(ctx, truckId, truckInput(fd)).then(() => undefined), "Data truk disimpan.");
  revalidatePath(base);
  return res;
}

export async function setTruckStatusAction(truckId: string, status: "active" | "maintenance" | "inactive", reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  let flagged = 0;
  const res = await attempt(async () => {
    const r = await m1.setTruckStatus(ctx, truckId, { status, reason });
    flagged = r.flaggedTrips.length;
  });
  revalidatePath(base);
  return res.ok ? { ...res, message: flagged ? `Status diubah; ${flagged} rit ditandai perlu dipindahkan.` : "Status truk diubah." } : res;
}
