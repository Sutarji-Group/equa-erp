"use server";

import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m10-access/action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import { recordBackupStatus, requestAnonymization, resubmitAnonymization } from "@/server/modules/m10-access";

import { int, runAction, str, wibDateTime } from "../_action";

/** Admin sistem mencatat permintaan anonimisasi (US-M10-06 KP-2). */
export async function requestAnonymizationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  return runAction(async () => {
    const [type, id] = (str(formData, "subject") ?? "").split(":");
    const r = await requestAnonymization(ctx, { subjectType: type === "employee" ? "employee" : "customer", subjectId: id ?? "", reason: str(formData, "reason") ?? "" });
    revalidatePath("/akses/data-pribadi");
    return r.deferredReason
      ? { ok: true, message: `Permintaan dicatat tetapi DITUNDA: ${r.deferredReason} Beri tahu pemohon.` }
      : { ok: true, message: `Permintaan ${r.approval?.number ?? ""} diajukan ke pemilik. Anonimisasi dijalankan setelah disetujui.` };
  });
}

export async function resubmitAnonymizationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  return runAction(async () => {
    const r = await resubmitAnonymization(ctx, str(formData, "requestId") ?? "");
    revalidatePath("/akses/data-pribadi");
    return r.deferredReason ? { error: `Masih ditunda: ${r.deferredReason}` } : { ok: true, message: `Diajukan ulang ke pemilik (${r.approval?.number ?? ""}).` };
  });
}

/** Admin sistem mencatat hasil cadangan / uji pemulihan (US-M10-06 KP-4). */
export async function recordBackupAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  return runAction(async () => {
    const kind = str(formData, "kind");
    await recordBackupStatus(ctx, {
      kind: (kind === "monthly" || kind === "restore_test" ? kind : "daily") as "daily" | "monthly" | "restore_test",
      status: str(formData, "status") === "failed" ? "failed" : "success",
      startedAt: wibDateTime(formData, "startedAt") ?? new Date(),
      finishedAt: wibDateTime(formData, "finishedAt"),
      location: str(formData, "location"),
      rpoMinutes: int(formData, "rpoMinutes"),
      rtoMinutes: int(formData, "rtoMinutes"),
      notes: str(formData, "notes"),
    });
    revalidatePath("/akses/data-pribadi");
    return { ok: true, message: "Hasil dicatat." };
  });
}
