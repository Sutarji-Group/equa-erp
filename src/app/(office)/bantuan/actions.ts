"use server";

import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m10-access/action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import { toUserMessage } from "@/server/core/errors";
import { createSupportTicket } from "@/server/core/support";
import { answerSupportTicket, closeSupportTicket } from "@/server/modules/m10-access";

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

// --- Tambahan M10: helpdesk (US-M10-07 KP-3; PAR-87) ---

/** Tim IT menjawab laporan (Diterima → Dijawab); pelapor diberi tahu. */
export async function answerTicketAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  try {
    await answerSupportTicket(ctx, { ticketId: String(formData.get("ticketId") ?? ""), answer: String(formData.get("answer") ?? "") });
  } catch (error) {
    return { error: toUserMessage(error) };
  }
  revalidatePath("/bantuan");
  return { ok: true, message: "Jawaban terkirim ke pelapor." };
}

/** Pelapor (atau tim IT) menandai laporan Selesai (Dijawab → Selesai). */
export async function closeTicketAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  try {
    await closeSupportTicket(ctx, { ticketId: String(formData.get("ticketId") ?? "") });
  } catch (error) {
    return { error: toUserMessage(error) };
  }
  revalidatePath("/bantuan");
  return { ok: true, message: "Laporan ditandai selesai." };
}
