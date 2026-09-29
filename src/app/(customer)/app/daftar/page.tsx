import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { P2ActionForm } from "@/components/p2-customer/action-form";
import { AddressFields } from "@/components/p2-customer/address-fields";
import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { withTx } from "@/server/core/db";
import * as params from "@/server/core/params";
import { customerBusinessDate } from "@/server/modules/p2-customer";
import { requireCustomer } from "@/server/modules/p2-customer/web";

import { completeRegistrationAction, logoutAction } from "../actions";

export const metadata: Metadata = { title: "Lengkapi pendaftaran" };

/**
 * Lengkapi pendaftaran (US-P2-01 KP-2/KP-3/KP-5): persetujuan penggunaan data pribadi (UU PDP) + nama; nomor lama →
 * tertaut setelah konfirmasi nama; nomor baru → alamat kirim dengan titik peta (pelanggan baru Tunai).
 */
export default async function DaftarPage() {
  const cctx = await requireCustomer({ linked: false });
  if (cctx.status === "linked" && cctx.customerId && cctx.consentGiven) redirect("/app");
  const rules = await withTx((tx) => params.get(tx, "p2.customer_app_rules", customerBusinessDate(cctx), { tenantId: cctx.tenantId }));

  if (cctx.status === "pending_review") {
    return (
      <CustomerShell title="Menunggu verifikasi" hideNav>
        <CustomerCard testId="pending-review">
          <p className="text-sm">
            Terima kasih, {cctx.displayName ?? "Pelanggan"}. Nama yang Anda isi belum cocok dengan data pelanggan untuk nomor ini, jadi akun belum kami hubungkan otomatis. Kantor EQUA akan menghubungi Anda untuk verifikasi dan memberi tahu lewat WhatsApp.
          </p>
          <p className="mt-2 text-sm">Butuh air segera? Telepon kantor EQUA: {rules.office_phone}.</p>
        </CustomerCard>
        <form action={logoutAction}>
          <button className="text-sm text-muted-foreground underline" type="submit">
            Keluar
          </button>
        </form>
      </CustomerShell>
    );
  }

  return (
    <CustomerShell title="Lengkapi pendaftaran" hideNav>
      <CustomerCard>
        <P2ActionForm action={completeRegistrationAction} submitLabel="Simpan & mulai pesan" resetOnSuccess={false} fullWidth testId="registration-form">
          <label className="grid gap-1 text-sm font-medium">
            Nama sesuai data pelanggan
            <input name="name" required minLength={2} maxLength={150} defaultValue={cctx.displayName ?? ""} className="h-11 rounded-md border border-input bg-background px-3 text-base" />
            <span className="text-xs font-normal text-muted-foreground">Bila nomor Anda sudah terdaftar, nama dicocokkan dengan data pelanggan EQUA sebelum akun dihubungkan.</span>
          </label>
          <details className="rounded-md border p-3 text-sm" open>
            <summary className="cursor-pointer font-medium">Alamat kirim (wajib untuk pelanggan baru)</summary>
            <div className="mt-3">
              <AddressFields required={false} />
            </div>
          </details>
          <div className="rounded-md border bg-muted/40 p-3 text-xs leading-relaxed" data-testid="pdp-consent-text">
            <p className="mb-1 font-semibold">Persetujuan penggunaan data pribadi (UU PDP) — versi {rules.consent_version}</p>
            <p>
              EQUA memakai nomor WhatsApp, nama, alamat, titik lokasi, riwayat pesanan, dan pembayaran Anda hanya untuk melayani pengiriman air, penagihan, dan pemberitahuan layanan. Data tidak dijual atau dibagikan kepada pihak lain di luar keperluan layanan (mis. gerbang pembayaran). Anda dapat meminta penghapusan akun kapan saja dari menu Akun; data pelanggan dianonimkan setelah tidak ada tagihan terbuka.
            </p>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="consent" required className="mt-1 size-5" />
            <span>Saya menyetujui penggunaan data pribadi di atas.</span>
          </label>
        </P2ActionForm>
      </CustomerCard>
    </CustomerShell>
  );
}
