"use server";

/**
 * Server Action kantor M3: pencatatan darurat "dicatat kantor" (Admin Keuangan, Bab 6.1) dan konfirmasi kendala sopir
 * (Dispatcher, US-M3-06 KP-3). Otorisasi & aturan di lapisan layanan (`@/server/modules/m3-driver`).
 */
import { revalidatePath } from "next/cache";

import type { M3ActionState } from "@/components/m3-driver/office-action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import { withTx } from "@/server/core/db";
import { toUserMessage } from "@/server/core/errors";
import * as m3 from "@/server/modules/m3-driver";

function str(fd: FormData, name: string): string | null {
  const v = fd.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function num(fd: FormData, name: string): number | null {
  const v = str(fd, name);
  if (v === null) return null;
  const n = Number(v.replace(/[^0-9]/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function attempt(fn: () => Promise<unknown>, message: string, paths: string[]): Promise<M3ActionState> {
  try {
    await fn();
    for (const p of paths) revalidatePath(p);
    return { ok: true, message };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

/** Unggah bukti (opsional) + jalankan pencatatan dalam SATU transaksi. */
async function withEvidence(fd: FormData, fn: (tx: Parameters<Parameters<typeof withTx>[0]>[0], evidenceId: string | null) => Promise<unknown>, ctx: Awaited<ReturnType<typeof requireOfficeSession>>["ctx"]) {
  const file = fd.get("evidence");
  return withTx(async (tx) => {
    let evidenceId: string | null = null;
    if (file instanceof File && file.size > 0) {
      const att = await m3.uploadOfficeEvidence(ctx, { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type || "image/jpeg", name: file.name }, { tx });
      evidenceId = att.id;
    }
    return fn(tx, evidenceId);
  });
}

function paymentFrom(fd: FormData) {
  const method = str(fd, "method") ?? "cash";
  if (method === "internal") return { method: "none" as const };
  if (method === "credit") return { method: "credit" as const, cashReceivedIfRejected: num(fd, "amount") ?? 0 };
  const amount = num(fd, "amount") ?? 0;
  const reasonCode = str(fd, "underpaymentReason");
  const reasonText = str(fd, "underpaymentNote");
  return method === "transfer"
    ? { method: "transfer" as const, transferAmount: amount, underpaymentReasonCode: reasonCode, underpaymentReasonText: reasonText }
    : { method: "cash" as const, cashReceived: amount, underpaymentReasonCode: reasonCode, underpaymentReasonText: reasonText };
}

export async function officeCompleteAction(tripId: string, _prev: M3ActionState, fd: FormData): Promise<M3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    () =>
      withEvidence(
        fd,
        (tx, evidenceId) =>
          m3.officeCompleteTrip(
            ctx,
            {
              tripId,
              reason: str(fd, "reason") ?? "",
              occurredTime: str(fd, "occurredTime") ?? "",
              recipientName: str(fd, "recipientName") ?? "",
              deliveredVolumeL: num(fd, "deliveredVolumeL") ?? 0,
              partialVolumeReason: str(fd, "partialVolumeReason"),
              partialVolumeNote: str(fd, "partialVolumeNote"),
              evidenceAttachmentId: evidenceId,
              payment: paymentFrom(fd),
            },
            { tx },
          ),
        ctx,
      ),
    "Rit dicatat Selesai atas nama sopir (dicatat kantor). Pemilik diberi tahu.",
    ["/sopir-kantor/dicatat-kantor", "/sopir-kantor/laporan"],
  );
}

export async function officeFailAction(tripId: string, _prev: M3ActionState, fd: FormData): Promise<M3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    () =>
      withEvidence(
        fd,
        (tx, evidenceId) =>
          m3.officeFailTrip(
            ctx,
            {
              tripId,
              reason: str(fd, "reason") ?? "",
              occurredTime: str(fd, "occurredTime") ?? "",
              failReason: str(fd, "failReason") ?? "",
              note: str(fd, "note"),
              loadedWaterDisposition: str(fd, "loadedWaterDisposition") ?? "",
              evidenceAttachmentId: evidenceId,
            },
            { tx },
          ),
        ctx,
      ),
    "Rit dicatat Gagal atas nama sopir (dicatat kantor). Pemilik diberi tahu.",
    ["/sopir-kantor/dicatat-kantor", "/sopir-kantor/laporan"],
  );
}

export async function confirmIncidentAction(incidentId: string, _prev: M3ActionState, fd: FormData): Promise<M3ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(
    () => m3.confirmIncident(ctx, { incidentId, setTruckMaintenance: fd.get("setTruckMaintenance") === "on", note: str(fd, "note") ?? "" }),
    "Kendala dikonfirmasi.",
    ["/sopir-kantor/kendala"],
  );
}
