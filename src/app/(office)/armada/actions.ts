"use server";

/**
 * Server Action layar armada M12: tinjauan kejadian (pemilik: terima alasan / tindak lanjut / selesai; pemilik &
 * Dispatcher: minta keterangan sopir — tugas ke aplikasi M3) dan GPS ponsel cadangan paksa (admin sistem).
 * Otorisasi & aturan di lapisan layanan (`@/server/modules/m12-fleet`).
 */
import { revalidatePath } from "next/cache";

import type { M12ActionState } from "@/components/m12-fleet/action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import { toUserMessage } from "@/server/core/errors";
import * as m12 from "@/server/modules/m12-fleet";

function str(fd: FormData, name: string): string | null {
  const v = fd.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

async function attempt(fn: () => Promise<unknown>, message: string, paths: string[]): Promise<M12ActionState> {
  try {
    await fn();
    for (const p of paths) revalidatePath(p);
    return { ok: true, message };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

const MESSAGES = {
  accepted: "Alasan diterima — kejadian Selesai.",
  request_explanation: "Permintaan keterangan dikirim ke aplikasi sopir.",
  follow_up: "Ditandai tindak lanjut di luar sistem.",
} as const;

export async function reviewEventAction(eventId: string, decision: keyof typeof MESSAGES, _state: M12ActionState, fd: FormData): Promise<M12ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => m12.reviewFleetEvent(ctx, { fleetEventId: eventId, decision, note: str(fd, "note") }), MESSAGES[decision], ["/armada/kejadian", `/armada/kejadian/${eventId}`]);
}

export async function closeEventAction(eventId: string, _state: M12ActionState, fd: FormData): Promise<M12ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(() => m12.closeFleetEvent(ctx, { fleetEventId: eventId, note: str(fd, "note") ?? "" }), "Kejadian ditandai Selesai.", ["/armada/kejadian", `/armada/kejadian/${eventId}`]);
}

export async function phoneTrackingAction(truckId: string, enabled: boolean, _state: M12ActionState, fd: FormData): Promise<M12ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    () => m12.setPhoneTracking(ctx, { truckId, enabled, reason: str(fd, "reason") ?? "" }),
    enabled ? "GPS ponsel cadangan diaktifkan untuk truk ini." : "GPS ponsel cadangan dimatikan.",
    ["/armada/perangkat", "/armada/peta"],
  );
}
