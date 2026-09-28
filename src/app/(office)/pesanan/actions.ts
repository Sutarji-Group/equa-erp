"use server";

/**
 * Server Action layar Pesanan (M2). Tipis: sesi kantor → layanan modul (yang memanggil `authorize`) → revalidate.
 */
import { revalidatePath } from "next/cache";

import type { ActionState } from "@/components/m2-orders/action-state";
import type { EnumValue } from "@/lib/labels";
import { requireOfficeSession } from "@/server/core/auth/office";
import * as m1 from "@/server/modules/m1-master";
import * as m2 from "@/server/modules/m2-orders";

import { attempt, failure, int, str } from "./_lib/form";

function revalidateOrder(id?: string) {
  revalidatePath("/pesanan");
  revalidatePath("/jadwal");
  if (id) revalidatePath(`/pesanan/${id}`);
}

// =====================================================================================================================
// Layar pesanan baru (klien memanggil langsung)
// =====================================================================================================================

export type CustomerOption = {
  value: string;
  label: string;
  description?: string;
  code: string | null;
  creditStatus: string;
  isActive: boolean;
  notes: string | null;
  fixedReceiveTime: string | null;
  lastAddressId: string | null;
  addresses: { id: string; label: string; addressText: string; zoneCode: string | null }[];
};

/** Cari pelanggan (≥ 2 karakter, US-M2-01 KP-1). */
export async function searchCustomersAction(q: string): Promise<CustomerOption[]> {
  const { ctx } = await requireOfficeSession();
  const rows = await m1.searchCustomers(ctx, q, { limit: 12 });
  return rows.map((r) => ({
    value: r.id,
    label: r.code ? `${r.name} (${r.code})` : r.name,
    description: r.addresses.find((a) => a.id === r.lastAddressId)?.addressText ?? r.addresses[0]?.addressText,
    code: r.code,
    creditStatus: r.creditStatus,
    isActive: r.isActive,
    notes: r.notes,
    fixedReceiveTime: r.fixedReceiveTime?.slice(0, 5) ?? null,
    lastAddressId: r.lastAddressId,
    addresses: r.addresses.map((a) => ({ id: a.id, label: a.label, addressText: a.addressText, zoneCode: a.zoneCode })),
  }));
}

export type PreviewResult = { ok: true; preview: m2.OrderPreview } | { ok: false; error: string };

/** Pratinjau harga, tempo, dobel (US-M2-01 KP-2, US-M2-04, US-M2-05). */
export async function previewOrderAction(input: { customerId: string; addressId: string; requestedDate?: string | null; tankCount?: number; paymentMethod?: string }): Promise<PreviewResult> {
  const { ctx } = await requireOfficeSession();
  try {
    const preview = await m2.previewOrder(ctx, {
      customerId: input.customerId,
      addressId: input.addressId,
      requestedDate: input.requestedDate || null,
      tankCount: input.tankCount ?? 1,
      paymentMethod: (input.paymentMethod as m2.CreateOrderInput["paymentMethod"]) ?? "cash",
    });
    return { ok: true, preview };
  } catch (error) {
    return { ok: false, error: failure(error).error ?? "Gagal memuat pratinjau." };
  }
}

export type CustomerPanel = { ok: true; summary: m1.CustomerSummary } | { ok: false; error: string };

/** Panel pelanggan (US-M2-08 KP-1): 10 pesanan terakhir, piutang & batas tersisa, catatan, harga khusus. */
export async function customerPanelAction(customerId: string): Promise<CustomerPanel> {
  const { ctx } = await requireOfficeSession();
  try {
    return { ok: true, summary: await m1.getCustomerSummary(ctx, customerId) };
  } catch (error) {
    return { ok: false, error: failure(error).error ?? "Gagal memuat ringkasan pelanggan." };
  }
}

export type QuickCustomerResult =
  | { ok: true; customer: CustomerOption }
  | { ok: false; error: string; duplicates?: { customerId: string; name: string; reasonText: string }[] };

/** Pelanggan baru di layar yang sama (US-M2-01 KP-3): otomatis Tunai (BR-01). */
export async function quickCreateCustomerAction(input: {
  name: string;
  waPhone: string;
  segment: string;
  addressText: string;
  manualZoneId?: string | null;
  confirmDuplicate?: boolean;
}): Promise<QuickCustomerResult> {
  const { ctx } = await requireOfficeSession();
  try {
    const res = await m1.quickCreateCustomer(ctx, {
      name: input.name,
      waPhone: input.waPhone,
      segment: input.segment as EnumValue<"customer_segment">,
      addressText: input.addressText,
      manualZoneId: input.manualZoneId || null,
      manualZoneReason: input.manualZoneId ? "Dipilih saat input pesanan (koordinat dilengkapi kemudian)" : null,
      confirmDuplicate: input.confirmDuplicate,
    });
    if (res.status === "duplicates") {
      return {
        ok: false,
        error: "Ada pelanggan yang mirip. Pilih pelanggan yang ada, atau centang \"Tetap buat baru\" bila memang berbeda.",
        duplicates: res.candidates.map((c) => ({ customerId: c.customerId, name: c.name, reasonText: c.reasonText })),
      };
    }
    const a = res.addresses[0]!;
    revalidatePath("/master/pelanggan");
    return {
      ok: true,
      customer: {
        value: res.customer.id,
        label: res.customer.name,
        description: a.addressText,
        code: res.customer.code,
        creditStatus: res.customer.creditStatus,
        isActive: true,
        notes: null,
        fixedReceiveTime: null,
        lastAddressId: a.id,
        addresses: [{ id: a.id, label: a.label, addressText: a.addressText, zoneCode: null }],
      },
    };
  } catch (error) {
    return { ok: false, error: failure(error).error ?? "Gagal menyimpan pelanggan." };
  }
}

export type CreateOrderActionResult =
  | { status: "created"; orderId: string; number: string; totalAmount: number; tankCount: number; warnings: string[]; approvalNumbers: string[]; orderStatus: string }
  | { status: "duplicate"; existing: m2.DuplicateOrderView[] }
  | { status: "credit_blocked"; message: string; canRequestApproval: boolean; exposure: m2.CreditExposure }
  | { status: "cancelled_duplicate"; orderId: string; number: string }
  | { status: "error"; error: string; code?: string };

/** Simpan pesanan (US-M2-01..05). */
export async function createOrderAction(input: m2.CreateOrderInput): Promise<CreateOrderActionResult> {
  const { ctx } = await requireOfficeSession();
  try {
    const res = await m2.createOrder(ctx, input);
    revalidateOrder();
    if (res.status === "created") {
      return {
        status: "created",
        orderId: res.order.id,
        number: res.order.number,
        totalAmount: res.order.totalAmount,
        tankCount: res.order.tankCount,
        warnings: res.warnings,
        approvalNumbers: res.approvalNumbers,
        orderStatus: res.order.status,
      };
    }
    if (res.status === "duplicate") return { status: "duplicate", existing: res.existing };
    if (res.status === "cancelled_duplicate") return { status: "cancelled_duplicate", orderId: res.order.id, number: res.order.number };
    return { status: "credit_blocked", message: res.check.message, canRequestApproval: res.check.canRequestApproval, exposure: res.check.exposure };
  } catch (error) {
    const f = failure(error);
    return { status: "error", error: f.error ?? "Gagal menyimpan pesanan.", code: f.code };
  }
}

/** "Kirim konfirmasi WA" (US-M2-07): catat "konfirmasi dibuka" lalu kembalikan tautan. */
export async function sendWaAction(orderId: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  return attempt(async () => {
    const res = await m2.sendOrderConfirmation(ctx, orderId);
    revalidatePath(`/pesanan/${orderId}`);
    if (res.mode === "sent") return { message: "Konfirmasi terkirim otomatis lewat WhatsApp Business API." };
    if (res.mode === "failed") return { link: res.link, warnings: [`Pengiriman otomatis gagal (${res.error}); buka WhatsApp manual.`] };
    return { link: res.link, message: "WhatsApp dibuka dengan pesan terisi — kirim dari WhatsApp." };
  });
}

// =====================================================================================================================
// Rincian pesanan
// =====================================================================================================================

export async function cancelOrderAction(orderId: string, reasonCode: string | null, reasonText: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    await m2.cancelOrder(ctx, orderId, { reason: (reasonCode ?? "other") as EnumValue<"order_cancel_reason">, note: reasonText || null });
  }, "Pesanan dibatalkan.");
  revalidateOrder(orderId);
  return res;
}

export async function rescheduleAction(orderId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    const r = await m2.rescheduleOrder(ctx, orderId, { requestedDate: str(fd, "requestedDate") ?? "", requestedTime: str(fd, "requestedTime"), reason: str(fd, "reason") ?? "" });
    return { message: "Tanggal kirim diubah; rit kembali ke kolom Belum terjadwal.", warnings: r.warnings };
  });
  revalidateOrder(orderId);
  return res;
}

export async function changePaymentAction(orderId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    const r = await m2.changePaymentMethod(ctx, orderId, { paymentMethod: (str(fd, "paymentMethod") ?? "cash") as "cash", reason: str(fd, "reason") });
    if (r.status === "credit_blocked") return { error: `${r.check.message}${r.check.canRequestApproval ? " Gunakan \"Ajukan persetujuan pemilik\"." : ""}` };
    return { message: "Cara bayar diubah." };
  });
  revalidateOrder(orderId);
  return res;
}

export async function requestCreditApprovalAction(orderId: string, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    const a = await m2.requestCreditApproval(ctx, orderId, { reason });
    return { message: `Permintaan ${a.number} dikirim ke pemilik. Pesanan menunggu persetujuan.` };
  });
  revalidateOrder(orderId);
  return res;
}

export async function requestUnderpaymentApprovalAction(orderId: string, reason: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    const a = await m2.requestUnderpaymentApproval(ctx, orderId, { reason });
    return { message: `Permintaan ${a.number} dikirim ke pemilik.` };
  });
  revalidateOrder(orderId);
  return res;
}

export async function reconfirmAction(orderId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    const date = str(fd, "date");
    const time = str(fd, "time");
    const confirmedAt = date && time ? new Date(`${date}T${time}:00+07:00`) : ctx.now;
    await m2.reconfirmOrder(ctx, orderId, { confirmedAt, method: str(fd, "method") ?? "", note: str(fd, "note") });
  }, "Konfirmasi ulang tercatat; pesanan dapat dijadwalkan.");
  revalidateOrder(orderId);
  return res;
}

export async function updateNotesAction(orderId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    await m2.updateOrderNotes(ctx, orderId, { notes: str(fd, "notes") });
  }, "Catatan disimpan (ikut ke aplikasi sopir).");
  revalidateOrder(orderId);
  return res;
}

export async function refreshPriceAction(orderId: string, note: string): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    await m2.refreshOrderPrice(ctx, orderId, { note });
  }, "Harga pesanan diperbarui ke harga berlaku.");
  revalidateOrder(orderId);
  return res;
}

// =====================================================================================================================
// Template WA (pemilik)
// =====================================================================================================================

export async function updateTemplateAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const { ctx } = await requireOfficeSession();
  const res = await attempt(async () => {
    const tpl = await m2.updateOrderConfirmationTemplate(ctx, { body: str(fd, "body") ?? "", reason: str(fd, "reason") ?? "" });
    return { message: `Template konfirmasi versi ${tpl.version} berlaku.` };
  });
  revalidatePath("/pesanan");
  return { ...res, ok: res.ok && !res.error };
}

/** Nilai tangki dari formulir (untuk uji). */
export async function _tankCount(fd: FormData): Promise<number | null> {
  return int(fd, "tankCount");
}
