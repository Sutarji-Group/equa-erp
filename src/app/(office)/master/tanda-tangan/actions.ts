"use server";

import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m1-master/action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import * as m1 from "@/server/modules/m1-master";

import { attempt, str } from "../_lib/form";

/** Pemilik menandatangani ringkasan data awal satu kelompok (NFR-34; kelompok pelanggan → Tempo migrasi, 6.2b). */
export async function signSignoffAction(signoffId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => m1.signDataSignoff(ctx, signoffId, { note: str(fd, "note") ?? undefined }).then(() => undefined), "Ringkasan data awal ditandatangani.");
  revalidatePath("/master/tanda-tangan");
  revalidatePath("/master/impor");
  return res;
}
