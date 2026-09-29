import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { OtpLogin } from "@/components/p2-customer/otp-login";
import { getCustomer } from "@/server/modules/p2-customer/web";

import { requestOtpAction, verifyOtpAction } from "../actions";

export const metadata: Metadata = { title: "Masuk" };

/** Masuk / daftar dengan nomor WhatsApp + OTP, tanpa kata sandi (US-P2-01 KP-1). */
export default async function MasukPage({ searchParams }: PageProps<"/app/masuk">) {
  const sp = await searchParams;
  if (await getCustomer()) redirect("/app");
  const next = typeof sp.lanjut === "string" && sp.lanjut.startsWith("/app") ? sp.lanjut : undefined;
  return (
    <CustomerShell title="Masuk EQUA" hideNav>
      {sp.dihapus ? (
        <p role="status" className="mb-4 rounded-md border bg-card p-3 text-sm">
          Akun Anda sudah dihapus dari aplikasi. Data pelanggan dianonimkan sesuai UU PDP setelah disetujui kantor.
        </p>
      ) : null}
      <CustomerCard>
        <p className="mb-4 text-sm text-muted-foreground">
          Masukkan nomor WhatsApp yang biasa Anda pakai memesan air EQUA. Kami kirim kode 6 angka lewat WhatsApp — tidak perlu kata sandi.
        </p>
        <OtpLogin requestAction={requestOtpAction} verifyAction={verifyOtpAction} next={next} />
      </CustomerCard>
      <p className="text-center text-xs text-muted-foreground">Butuh bantuan? Hubungi kantor EQUA lewat telepon/WhatsApp.</p>
    </CustomerShell>
  );
}
