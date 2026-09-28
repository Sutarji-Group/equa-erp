"use server";

/**
 * Server Action pesanan berulang / langganan (M2, US-M2-06).
 */
import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m2-orders/action-state";
import type { EnumValue } from "@/lib/labels";
import { requireOfficeSession } from "@/server/core/auth/office";
import * as m2 from "@/server/modules/m2-orders";

import { attempt } from "../pesanan/_lib/form";

function refresh() {
  revalidatePath("/langganan");
  revalidatePath("/pesanan");
  revalidatePath("/jadwal");
}

export async function saveRecurringAction(id: string | null, input: m2.RecurringInput): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    if (id) await m2.updateRecurringOrder(ctx, id, input);
    else await m2.createRecurringOrder(ctx, input);
  }, id ? "Pola langganan diubah (pesanan yang sudah dibuat tidak berubah)." : "Pola langganan dibuat.");
  refresh();
  return res;
}

export async function recurringStatusAction(id: string, status: EnumValue<"recurring_status">, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    await m2.setRecurringStatus(ctx, id, { status, reason });
  }, "Status langganan diubah.");
  refresh();
  return res;
}

export async function resolveFailureAction(id: string, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    await m2.resolveRecurringFailure(ctx, id, { note: reason });
  }, "Kegagalan ditandai sudah ditindaklanjuti.");
  refresh();
  return res;
}

export async function runGenerationAction(): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    const r = await m2.runRecurringGenerationNow(ctx);
    return {
      message: `Pembangkitan selesai: ${r.created} pesanan dibuat, ${r.failed} gagal, ${r.skipped} sudah ada.`,
      warnings: r.errors,
    };
  });
  refresh();
  return res;
}
