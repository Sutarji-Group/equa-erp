"use server";

/**
 * Server Action kotak masuk pemilik (/kotak-masuk, US-M9-04 KP-2): setujui / tolak (alasan wajib) / minta keterangan
 * (catatan wajib) / tandai selesai — layanan M9 meneruskan ke modul pemilik objek (persetujuan inti, M4, M8, M12).
 */
import { revalidatePath } from "next/cache";

import type { ReportActionState } from "@/components/m9-reports/action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import { toUserMessage } from "@/server/core/errors";
import * as m9 from "@/server/modules/m9-reports";

type Kind = "approval" | "discrepancy" | "failed_trip" | "gps" | "water_loss" | "info";
type Action = "approve" | "reject" | "request_explanation" | "done";

export async function inboxAction(itemKind: Kind, itemId: string, action: Action, note?: string): Promise<ReportActionState> {
  const { ctx } = await requireOfficeSession();
  try {
    const r = await m9.actOnInboxItem(ctx, { itemKind, itemId, action, note: note ?? null });
    for (const p of ["/kotak-masuk", "/laporan/hari-ini", "/persetujuan", "/beranda"]) revalidatePath(p);
    return { ok: true, message: r.message };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}
