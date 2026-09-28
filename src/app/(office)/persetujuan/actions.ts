"use server";

import { revalidatePath } from "next/cache";

import * as approvals from "@/server/core/approvals";
import { requireOfficeSession } from "@/server/core/auth/office";
import { toUserMessage } from "@/server/core/errors";

export type DecideResult = { error?: string } | undefined;

/**
 * Putuskan permintaan persetujuan (US-M10-04 KP-3): setujui (alasan opsional) atau tolak (alasan wajib). Pemohon
 * tidak pernah dapat memutuskan permintaannya sendiri (FR-M10-03) — ditolak di layanan.
 */
export async function decideApprovalAction(id: string, decision: "approve" | "reject", reason?: string): Promise<DecideResult> {
  const { ctx } = await requireOfficeSession();
  try {
    await approvals.decide(ctx, id, decision, reason ?? null);
  } catch (error) {
    return { error: toUserMessage(error) };
  }
  revalidatePath("/persetujuan");
  return undefined;
}
