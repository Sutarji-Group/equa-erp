"use server";

/**
 * Server Action layar kantor aplikasi pelanggan (P2): kotak keluhan, pesanan aplikasi, akun pelanggan, aktivasi.
 * Otorisasi & SoD di layanan (`authorize`); galat tampil apa adanya.
 */
import { revalidatePath } from "next/cache";

import type { P2ActionState } from "@/components/p2-customer/action-state";
import { requireOfficeSession } from "@/server/core/auth/office";
import { toUserMessage } from "@/server/core/errors";
import * as p2 from "@/server/modules/p2-customer";

const str = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
};

async function attempt(fn: () => Promise<unknown>, message: string): Promise<P2ActionState> {
  try {
    await fn();
    return { ok: true, message };
  } catch (error) {
    return { ok: false, error: toUserMessage(error) };
  }
}

function refresh(id?: string) {
  revalidatePath("/keluhan");
  if (id) revalidatePath(`/keluhan/${id}`);
}

// --- Keluhan (US-P2-06 KP-2/KP-3) -----------------------------------------------------------------------------------

export async function respondComplaintAction(id: string, _prev: P2ActionState, fd: FormData): Promise<P2ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => p2.respondComplaint(ctx, id, { response: str(fd, "response") }), "Tanggapan terkirim ke pelanggan.");
  refresh(id);
  return res;
}

export async function resolveComplaintAction(id: string, _prev: P2ActionState, fd: FormData): Promise<P2ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => p2.resolveComplaint(ctx, id, { resolution: str(fd, "resolution") }), "Keluhan ditutup dengan penyelesaian tercatat.");
  refresh(id);
  return res;
}

export async function reassignComplaintAction(id: string, _prev: P2ActionState, fd: FormData): Promise<P2ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => p2.reassignComplaint(ctx, id, { box: str(fd, "box") as p2.ComplaintBox, note: str(fd, "note") }), "Keluhan dipindah kotak.");
  refresh(id);
  return res;
}

export async function disputeFromComplaintAction(id: string, _prev: P2ActionState, fd: FormData): Promise<P2ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => p2.disputeInvoiceFromComplaint(ctx, id, { invoiceId: str(fd, "invoiceId"), note: str(fd, "note") }), "Faktur ditandai bersengketa (7.5.6); keputusan di pemilik.");
  refresh(id);
  revalidatePath("/piutang");
  return res;
}

// --- Pesanan aplikasi (US-P2-02 KP-4) --------------------------------------------------------------------------------

export async function confirmAppOrderAction(orderId: string, _prev: P2ActionState, fd: FormData): Promise<P2ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => p2.confirmAppOrder(ctx, orderId, { note: str(fd, "note") || null }), "Pesanan dikonfirmasi; pelanggan diberi tahu.");
  revalidatePath("/keluhan/pesanan-aplikasi");
  revalidatePath("/pesanan");
  return res;
}

export async function rejectAppOrderAction(orderId: string, _prev: P2ActionState, fd: FormData): Promise<P2ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => p2.rejectAppOrder(ctx, orderId, { reason: str(fd, "reason") }), "Pesanan ditolak; alasan tampil ke pelanggan.");
  revalidatePath("/keluhan/pesanan-aplikasi");
  revalidatePath("/pesanan");
  return res;
}

// --- Akun pelanggan (US-P2-01 KP-2/KP-4) & aktivasi (D-02) -----------------------------------------------------------

export async function verifyAccountAction(requestId: string, _prev: P2ActionState, fd: FormData): Promise<P2ActionState> {
  const { ctx } = await requireOfficeSession();
  const decision = str(fd, "decision");
  const note = str(fd, "note");
  const res = await attempt(async () => {
    if (decision === "link") await p2.verifyAccount(ctx, { decision: "link", requestId, customerId: str(fd, "customerId"), note });
    else if (decision === "new_customer") await p2.verifyAccount(ctx, { decision: "new_customer", requestId, addressText: str(fd, "addressText"), note });
    else await p2.verifyAccount(ctx, { decision: "reject", requestId, note });
  }, decision === "reject" ? "Akun ditolak & dinonaktifkan." : "Akun terverifikasi; pelanggan diberi tahu.");
  revalidatePath("/keluhan/akun");
  return res;
}

export async function officeChangePhoneAction(accountId: string, _prev: P2ActionState, fd: FormData): Promise<P2ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => p2.officeChangePhone(ctx, { accountId, newPhone: str(fd, "newPhone"), reason: str(fd, "reason") }), "Nomor WhatsApp akun diganti; sesi lama dicabut.");
  revalidatePath("/keluhan/akun");
  return res;
}

export async function setAppEnabledAction(enabled: boolean, _prev: P2ActionState, fd: FormData): Promise<P2ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(() => p2.setCustomerAppEnabled(ctx, { enabled, reason: str(fd, "reason") }), enabled ? "Aplikasi pelanggan diaktifkan." : "Aplikasi pelanggan dinonaktifkan.");
  revalidatePath("/keluhan", "layout");
  return res;
}
