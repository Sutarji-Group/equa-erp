"use server";

/**
 * Server Action aplikasi pelanggan (Tahap 2). Tipis: pelaku dari cookie sesi pelanggan → layanan P2 (kepemilikan data
 * diperiksa layanan). Galat layanan ditampilkan apa adanya (Bahasa Indonesia, tanpa kode teknis).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { DomainError } from "@/server/core/errors";
import * as p2 from "@/server/modules/p2-customer";
import { attemptCustomer, clearCustomerCookie, customerRequestMeta, customerToken, getCustomer, requireCustomer, setCustomerCookie, type CustomerActionState } from "@/server/modules/p2-customer/web";
import { withTx } from "@/server/core/db";

const str = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
};
const num = (fd: FormData, key: string) => {
  const v = str(fd, key);
  return v === "" ? undefined : Number(v);
};

// =====================================================================================================================
// Masuk / daftar (US-P2-01)
// =====================================================================================================================

export async function requestOtpAction(_prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const phone = str(fd, "phone");
  return attemptCustomer(async () => {
    const res = await p2.requestLoginOtp({ phone }, await customerRequestMeta());
    return {
      message: `Kode verifikasi dikirim ke WhatsApp ${res.phoneMasked}. Berlaku sampai ${res.expiresAt.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" })}.`,
      // `purpose` (nomor terdaftar/baru) TIDAK dikirim ke klien — cegah enumerasi nomor (US-P2-01 KP-1).
      data: { phone: res.phone, phoneMasked: res.phoneMasked, devCode: res.devCode ?? null },
    };
  });
}

export async function verifyOtpAction(_prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const phone = str(fd, "phone");
  const code = str(fd, "code");
  const next = str(fd, "lanjut");
  let target = "/app";
  const res = await attemptCustomer(async () => {
    const login = await p2.verifyLoginOtp({ phone, code }, await customerRequestMeta());
    await setCustomerCookie(login.token, login.expiresAt);
    target = login.next === "home" ? (next.startsWith("/app") ? next : "/app") : "/app/daftar";
  });
  if (res.ok) redirect(target);
  return res;
}

export async function completeRegistrationAction(_prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const cctx = await requireCustomer({ linked: false });
  const hasAddress = str(fd, "addressText") !== "" || str(fd, "lat") !== "";
  let done = false;
  const res = await attemptCustomer(async () => {
    const out = await p2.completeRegistration(cctx, {
      name: str(fd, "name"),
      consent: fd.get("consent") === "on",
      address: hasAddress ? { label: str(fd, "label") || "Rumah", addressText: str(fd, "addressText"), notes: str(fd, "notes") || null, lat: num(fd, "lat") as number, lng: num(fd, "lng") as number } : null,
    });
    if (out.status === "address_required") return { ok: false, error: "Nomor Anda belum terdaftar sebagai pelanggan EQUA. Tandai titik alamat kirim di peta dan tulis alamat lengkap untuk melanjutkan.", data: { needAddress: true } };
    if (out.status === "pending_review") return { message: "Nama tidak cocok dengan data pelanggan untuk nomor ini. Kantor EQUA akan memverifikasi dan memberi tahu Anda.", data: { pending: true } };
    done = true;
  });
  if (res.ok && done) redirect("/app");
  revalidatePath("/app/daftar");
  return res;
}

export async function logoutAction(): Promise<void> {
  const token = await customerToken();
  await withTx((tx) => p2.logoutCustomer(tx, token, new Date()));
  await clearCustomerCookie();
  redirect("/app/masuk");
}

// =====================================================================================================================
// Alamat & akun (US-P2-01 KP-3/KP-4/KP-5)
// =====================================================================================================================

export async function addAddressAction(_prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  const res = await attemptCustomer(async () => {
    await p2.addMyAddress(cctx, { label: str(fd, "label"), addressText: str(fd, "addressText"), notes: str(fd, "notes") || null, lat: num(fd, "lat") as number, lng: num(fd, "lng") as number });
  }, "Alamat disimpan. Zona & harga dihitung otomatis; titik dikunci kantor setelah pengiriman pertama.");
  revalidatePath("/app/akun");
  return res;
}

export async function updateAddressNotesAction(addressId: string, _prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  const res = await attemptCustomer(async () => {
    await p2.updateMyAddress(cctx, addressId, { notes: str(fd, "notes") || null });
  }, "Catatan akses disimpan.");
  revalidatePath("/app/akun");
  return res;
}

export async function deactivateAddressAction(addressId: string): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  const res = await attemptCustomer(async () => {
    await p2.deactivateMyAddress(cctx, addressId);
  }, "Alamat dihapus dari daftar.");
  revalidatePath("/app/akun");
  return res;
}

export async function startPhoneChangeAction(_prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  return attemptCustomer(async () => {
    const r = await p2.startPhoneChange(cctx, { newPhone: str(fd, "newPhone") });
    return { message: `Kode dikirim ke nomor LAMA ${r.phoneMasked}.`, data: { step: "old", devCode: r.devCode ?? null } };
  });
}

export async function confirmOldPhoneAction(_prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  return attemptCustomer(async () => {
    const r = await p2.confirmOldPhone(cctx, { code: str(fd, "code") });
    return { message: `Kode dikirim ke nomor BARU ${r.phoneMasked}.`, data: { step: "new", devCode: r.devCode ?? null } };
  });
}

export async function completePhoneChangeAction(_prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  const res = await attemptCustomer(async () => {
    const r = await p2.completePhoneChange(cctx, { code: str(fd, "code") });
    return { message: `Nomor WhatsApp diganti ke ${p2.maskPhone(r.newPhone)}.`, data: { step: "done" } };
  });
  revalidatePath("/app/akun");
  return res;
}

export async function deleteAccountAction(_prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const cctx = await requireCustomer({ linked: false });
  const res = await attemptCustomer(async () => {
    await p2.requestAccountDeletion(cctx, { confirm: str(fd, "confirm"), reason: str(fd, "reason") || null });
  });
  if (res.ok) {
    await clearCustomerCookie();
    redirect("/app/masuk?dihapus=1");
  }
  return res;
}

export async function refillReminderAction(enabled: boolean): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  const res = await attemptCustomer(async () => {
    await p2.setRefillReminder(cctx, { enabled });
  }, enabled ? "Pengingat isi ulang dinyalakan." : "Pengingat isi ulang dimatikan.");
  revalidatePath("/app/akun");
  revalidatePath("/app/langganan");
  return res;
}

export async function markNotificationsReadAction(): Promise<void> {
  const cctx = await getCustomer();
  if (cctx) await p2.markMyNotificationsRead(cctx);
  revalidatePath("/app", "layout");
}

// =====================================================================================================================
// Pesanan (US-P2-02, US-P2-05 KP-2)
// =====================================================================================================================

export async function placeOrderAction(_prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  let orderId = "";
  let payNow = false;
  const res = await attemptCustomer(async () => {
    const r = await p2.placeOrder(cctx, {
      addressId: str(fd, "addressId"),
      tankCount: Number(str(fd, "tankCount")),
      date: str(fd, "date"),
      slot: str(fd, "slot"),
      paymentMethod: str(fd, "paymentMethod") as p2.PaymentChoice,
      notes: str(fd, "notes") || null,
      clientRequestId: str(fd, "clientRequestId") || null,
    });
    orderId = r.orderId;
    payNow = r.paymentMethod === "digital";
  });
  if (res.ok && orderId) redirect(`/app/pesanan/${orderId}?baru=1${payNow ? "&bayar=1" : ""}`);
  return res;
}

export async function reorderAction(_prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  let orderId = "";
  const res = await attemptCustomer(async () => {
    const r = await p2.reorder(cctx, { orderId: str(fd, "orderId"), clientRequestId: str(fd, "clientRequestId") || null });
    orderId = r.orderId;
  });
  if (res.ok && orderId) redirect(`/app/pesanan/${orderId}?baru=1`);
  return res;
}

export async function cancelOrderAction(orderId: string, _prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  const res = await attemptCustomer(async () => {
    await p2.cancelMyOrder(cctx, orderId, { reason: str(fd, "reason") });
  }, "Pesanan dibatalkan.");
  revalidatePath(`/app/pesanan/${orderId}`);
  revalidatePath("/app/pesanan");
  return res;
}

export async function rateDeliveryAction(tripId: string, orderId: string, _prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  const res = await attemptCustomer(async () => {
    await p2.rateDelivery(cctx, tripId, { rating: Number(str(fd, "rating")), comment: str(fd, "comment") || null });
  }, "Terima kasih atas penilaian Anda.");
  revalidatePath(`/app/pesanan/${orderId}`);
  return res;
}

// =====================================================================================================================
// Pembayaran digital (US-P2-04 KP-3/KP-4) — verifikasi ulang OTP (8.6)
// =====================================================================================================================

function payQuery(fd: FormData): string {
  const q = new URLSearchParams();
  for (const k of ["target", "invoiceId", "orderId", "method"]) {
    const v = str(fd, k);
    if (v) q.set(k, v);
  }
  return q.toString();
}

export async function createPaymentAction(_prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  let intentId = "";
  let reverify = false;
  const res = await attemptCustomer(async () => {
    try {
      const intent = await p2.createPaymentIntent(cctx, {
        target: str(fd, "target") as "invoice" | "all_invoices" | "order",
        invoiceId: str(fd, "invoiceId") || null,
        orderId: str(fd, "orderId") || null,
        method: (str(fd, "method") || "qris_dynamic") as "qris_dynamic" | "virtual_account",
      });
      intentId = intent.id;
    } catch (error) {
      if (error instanceof DomainError && error.code === "REVERIFY_REQUIRED") {
        reverify = true;
        return;
      }
      throw error;
    }
  });
  if (reverify) redirect(`/app/bayar/verifikasi?${payQuery(fd)}`);
  if (res.ok && intentId) redirect(`/app/bayar/${intentId}`);
  return res;
}

export async function requestPaymentOtpAction(_prev: CustomerActionState): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  return attemptCustomer(async () => {
    const r = await p2.requestPaymentOtp(cctx);
    return { message: `Kode verifikasi dikirim ke WhatsApp ${r.phoneMasked}.`, data: { devCode: r.devCode ?? null } };
  });
}

export async function verifyPaymentOtpAction(_prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  const res = await attemptCustomer(async () => {
    await p2.verifyPaymentOtp(cctx, { code: str(fd, "code") });
  });
  if (!res.ok) return res;
  const fresh = await requireCustomer();
  let intentId = "";
  const created = await attemptCustomer(async () => {
    const intent = await p2.createPaymentIntent(fresh, {
      target: str(fd, "target") as "invoice" | "all_invoices" | "order",
      invoiceId: str(fd, "invoiceId") || null,
      orderId: str(fd, "orderId") || null,
      method: (str(fd, "method") || "qris_dynamic") as "qris_dynamic" | "virtual_account",
    });
    intentId = intent.id;
  });
  if (created.ok && intentId) redirect(`/app/bayar/${intentId}`);
  return created;
}

/** Hanya gerbang tiruan (dev/uji/E2E): simulasikan pemberitahuan Berhasil dari gerbang. */
export async function simulatePaymentAction(intentId: string): Promise<CustomerActionState> {
  await requireCustomer();
  const res = await attemptCustomer(async () => {
    const out = await p2.simulateMockPayment(intentId, "settlement");
    if (out.result !== "applied" && out.result !== "duplicate") throw new DomainError("SIMULATION_FAILED", "Simulasi pembayaran tidak diterapkan.");
  }, "Pembayaran berhasil (mode uji).");
  revalidatePath(`/app/bayar/${intentId}`);
  revalidatePath("/app/tagihan");
  return res;
}

// =====================================================================================================================
// Langganan (US-P2-05 KP-1)
// =====================================================================================================================

export async function saveSubscriptionAction(id: string | null, _prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  const pattern = str(fd, "pattern") as "weekly" | "interval";
  const res = await attemptCustomer(async () => {
    await p2.saveMySubscription(cctx, {
      id,
      addressId: str(fd, "addressId"),
      pattern,
      daysOfWeek: pattern === "weekly" ? fd.getAll("daysOfWeek").map((d) => Number(d)) : null,
      intervalDays: pattern === "interval" ? (num(fd, "intervalDays") ?? null) : null,
      tankCount: Number(str(fd, "tankCount")),
      slot: str(fd, "slot"),
      paymentMethod: (str(fd, "paymentMethod") || "cash") as "cash" | "transfer" | "credit",
      startDate: str(fd, "startDate"),
      endDate: str(fd, "endDate") || null,
    });
  }, id ? "Langganan diubah — berlaku untuk pesanan yang belum dibuat." : "Langganan dibuat.");
  revalidatePath("/app/langganan");
  return res;
}

export async function subscriptionStatusAction(id: string, status: "active" | "paused" | "ended"): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  const res = await attemptCustomer(async () => {
    await p2.setMySubscriptionStatus(cctx, id, { status });
  }, status === "paused" ? "Langganan dijeda." : status === "active" ? "Langganan aktif kembali." : "Langganan diakhiri.");
  revalidatePath("/app/langganan");
  return res;
}

// =====================================================================================================================
// Keluhan (US-P2-06 KP-2)
// =====================================================================================================================

export async function submitComplaintAction(_prev: CustomerActionState, fd: FormData): Promise<CustomerActionState> {
  const cctx = await requireCustomer();
  const photo = fd.get("photo");
  let id = "";
  const res = await attemptCustomer(async () => {
    const file = photo instanceof File && photo.size > 0 ? photo : null;
    const c = await p2.submitComplaint(cctx, {
      kind: str(fd, "kind") as "volume",
      description: str(fd, "description"),
      orderId: str(fd, "orderId") || null,
      tripId: str(fd, "tripId") || null,
      invoiceId: str(fd, "invoiceId") || null,
      photo: file ? { blob: Buffer.from(await file.arrayBuffer()), contentType: file.type, name: file.name } : null,
    });
    id = c.id;
  });
  if (res.ok && id) redirect(`/app/keluhan/${id}?baru=1`);
  return res;
}
