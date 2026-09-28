"use server";

import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m10-access/action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import { markAccessReviewed } from "@/server/modules/m10-access";

import { runAction, str } from "../_action";

/** Pemilik menandai tinjauan hak akses kuartal ini "ditinjau" (US-M10-01 KP-6). */
export async function markReviewedAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  return runAction(async () => {
    const quarter = str(formData, "quarter") ?? "";
    await markAccessReviewed(ctx, { quarter, notes: str(formData, "notes") });
    revalidatePath("/akses/tinjauan");
    return { ok: true, message: `Tinjauan ${quarter} ditandai ditinjau.` };
  });
}
