import type { Metadata } from "next";

import { OtpStep } from "@/components/p2-customer/otp-login";
import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { requireCustomer } from "@/server/modules/p2-customer/web";

import { requestPaymentOtpAction, verifyPaymentOtpAction } from "../../actions";

export const metadata: Metadata = { title: "Verifikasi pembayaran" };

/** Verifikasi ulang OTP sebelum membuat kode bayar (8.6: sesi 30 hari, verifikasi ulang untuk pembayaran). */
export default async function VerifikasiBayarPage({ searchParams }: PageProps<"/app/bayar/verifikasi">) {
  await requireCustomer({ next: "/app/tagihan" });
  const sp = await searchParams;
  const hidden: Record<string, string> = {};
  for (const k of ["target", "invoiceId", "orderId", "method"]) {
    const v = sp[k];
    if (typeof v === "string" && v) hidden[k] = v;
  }
  return (
    <CustomerShell title="Verifikasi pembayaran" active="billing" backHref="/app/tagihan">
      <CustomerCard>
        <p className="mb-3 text-sm">Demi keamanan, masukkan kode yang kami kirim ke WhatsApp Anda sebelum membayar.</p>
        <OtpStep requestAction={requestPaymentOtpAction} submitAction={verifyPaymentOtpAction} hidden={hidden} submitLabel="Verifikasi & lanjut bayar" testId="payment-reverify" />
      </CustomerCard>
    </CustomerShell>
  );
}
