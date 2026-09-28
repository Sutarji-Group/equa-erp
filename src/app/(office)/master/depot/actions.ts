"use server";

import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m1-master/action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import * as m1 from "@/server/modules/m1-master";

import { attempt, coord, int, str } from "../_lib/form";

const base = "/master/depot";

function outletInput(fd: FormData): m1.OutletInput {
  const p = coord(fd);
  return {
    code: str(fd, "code") ?? "",
    name: str(fd, "name") ?? "",
    kind: (str(fd, "kind") ?? "depot") as "depot" | "store",
    address: str(fd, "address"),
    lat: p.lat,
    lng: p.lng,
    geofenceRadiusM: int(fd, "geofenceRadiusM"),
    storageCapacityL: int(fd, "storageCapacityL"),
    defaultOperatorEmployeeId: str(fd, "defaultOperatorEmployeeId"),
    phone: str(fd, "phone"),
  };
}

export async function createOutletAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.createOutlet(ctx, outletInput(fd)).then(() => undefined), "Outlet dibuat.");
  revalidatePath(base);
  return res;
}

export async function updateOutletAction(outletId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.updateOutlet(ctx, outletId, outletInput(fd)).then(() => undefined), "Data outlet disimpan.");
  revalidatePath(base);
  return res;
}

export async function setOutletActiveAction(outletId: string, active: boolean, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.setOutletActive(ctx, outletId, { active, reason }).then(() => undefined), active ? "Outlet diaktifkan." : "Outlet dinonaktifkan.");
  revalidatePath(base);
  return res;
}
