"use server";

import { revalidatePath } from "next/cache";

import { requireOfficeSession } from "@/server/core/auth/office";
import { toUserMessage } from "@/server/core/errors";
import * as notifications from "@/server/core/notifications";

export type NotificationActionResult = { error?: string } | undefined;

/** Tandai dibaca / ditindaklanjuti (status maju saja; notifikasi tidak pernah dihapus). */
export async function advanceNotificationAction(id: string, to: "read" | "actioned"): Promise<NotificationActionResult> {
  const { ctx } = await requireOfficeSession();
  try {
    if (to === "read") await notifications.markRead(ctx, id);
    else await notifications.markActioned(ctx, id);
  } catch (error) {
    return { error: toUserMessage(error) };
  }
  revalidatePath("/notifikasi");
  return undefined;
}

export async function markAllReadAction(): Promise<NotificationActionResult> {
  const { ctx } = await requireOfficeSession();
  try {
    await notifications.markAllRead(ctx);
  } catch (error) {
    return { error: toUserMessage(error) };
  }
  revalidatePath("/notifikasi");
  return undefined;
}
