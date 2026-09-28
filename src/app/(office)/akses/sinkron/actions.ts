"use server";

import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m10-access/action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import { acknowledgeIncident, resolveIncident, setMinAppVersion } from "@/server/modules/m10-access";

import { runAction, str } from "../_action";

export async function acknowledgeIncidentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  return runAction(async () => {
    await acknowledgeIncident(ctx, { incidentId: str(formData, "incidentId") ?? "", note: str(formData, "note") });
    revalidatePath("/akses/sinkron");
    return { ok: true, message: "Insiden ditanggapi; waktu tanggap tercatat." };
  });
}

export async function resolveIncidentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  return runAction(async () => {
    await resolveIncident(ctx, { incidentId: str(formData, "incidentId") ?? "", resolution: str(formData, "resolution") ?? "" });
    revalidatePath("/akses/sinkron");
    return { ok: true, message: "Insiden tercatat pulih." };
  });
}

export async function setMinVersionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  return runAction(async () => {
    const row = await setMinAppVersion(ctx, { version: str(formData, "version") ?? "", reason: str(formData, "reason") ?? "" });
    revalidatePath("/akses/sinkron");
    return { ok: true, message: `Versi minimal ${(row.value as { version: string }).version} berlaku mulai hari ini. Perangkat di bawahnya diminta memperbarui.` };
  });
}
