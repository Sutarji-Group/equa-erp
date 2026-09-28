"use server";

import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m1-master/action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import * as m1 from "@/server/modules/m1-master";

import { attempt, coord, int, str } from "../_lib/form";

const base = "/master/pool";

function poolInput(fd: FormData): m1.PoolInput {
  const p = coord(fd);
  return { code: str(fd, "code") ?? "", name: str(fd, "name") ?? "", address: str(fd, "address"), lat: p.lat ?? Number.NaN, lng: p.lng ?? Number.NaN, geofenceRadiusM: int(fd, "geofenceRadiusM") };
}

export async function createPoolAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.createPool(ctx, poolInput(fd)).then(() => undefined), "Pool/garasi dibuat.");
  revalidatePath(base);
  return res;
}

export async function updatePoolAction(poolId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.updatePool(ctx, poolId, poolInput(fd)).then(() => undefined), "Pool/garasi disimpan.");
  revalidatePath(base);
  return res;
}

export async function setPoolActiveAction(poolId: string, active: boolean, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.setPoolActive(ctx, poolId, { active, reason }).then(() => undefined), active ? "Pool diaktifkan." : "Pool dinonaktifkan.");
  revalidatePath(base);
  return res;
}
