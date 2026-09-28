"use server";

import { revalidatePath } from "next/cache";

import { requireOfficeSession } from "@/server/core/auth/office";
import { toUserMessage } from "@/server/core/errors";
import { createSupportTicket } from "@/server/core/support";

export type TicketResult = { error?: string; ok?: boolean } | undefined;

/** Kirim laporan kendala aplikasi / masukan (US-M10-07 KP-3). */
export async function submitTicketAction(input: { category: "app_issue" | "feedback"; subject: string; description: string; userAgent?: string }): Promise<TicketResult> {
  const { ctx } = await requireOfficeSession();
  try {
    await createSupportTicket(ctx, {
      category: input.category,
      subject: input.subject,
      description: input.description,
      appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
      syncStatus: { channel: "web", userAgent: input.userAgent?.slice(0, 300) ?? null },
    });
  } catch (error) {
    return { error: toUserMessage(error) };
  }
  revalidatePath("/bantuan");
  return { ok: true };
}
