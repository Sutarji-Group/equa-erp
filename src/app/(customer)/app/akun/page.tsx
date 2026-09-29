import type { Metadata } from "next";

import { P2ActionButton, P2ActionForm } from "@/components/p2-customer/action-form";
import { AddressFields } from "@/components/p2-customer/address-fields";
import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { PhoneChange } from "@/components/p2-customer/phone-change";
import { PushSubscribe } from "@/components/p2-customer/push-subscribe";
import { serverEnv } from "@/lib/env";
import { formatTanggalJam } from "@/lib/time";
import { formatWaNumber } from "@/server/core/wa";
import * as p2 from "@/server/modules/p2-customer";
import { requireCustomer } from "@/server/modules/p2-customer/web";

import {
  addAddressAction,
  completePhoneChangeAction,
  confirmOldPhoneAction,
  deactivateAddressAction,
  deleteAccountAction,
  logoutAction,
  refillReminderAction,
  startPhoneChangeAction,
  updateAddressNotesAction,
} from "../actions";

export const metadata: Metadata = { title: "Akun" };

/**
 * Akun pelanggan (US-P2-01 KP-3/KP-4/KP-5): profil & status kredit, alamat kirim (titik peta + catatan akses, belum
 * dikunci sampai pengiriman pertama), ganti nomor WA, notifikasi push, pengingat isi ulang, persetujuan UU PDP, hapus
 * akun, keluar.
 */
export default async function AkunPage() {
  const cctx = await requireCustomer({ next: "/app/akun" });
  const [profile, addresses, refill, unread] = await Promise.all([p2.getMyProfile(cctx), p2.listMyAddresses(cctx), p2.myRefillReminder(cctx), p2.unreadNotificationCount(cctx)]);
  const vapid = serverEnv().VAPID_PUBLIC_KEY ?? null;
  return (
    <CustomerShell title="Akun" active="account" unread={unread}>
      <CustomerCard title="Profil" testId="profile">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Nama</dt>
          <dd>{profile.customer?.name ?? profile.displayName}</dd>
          <dt className="text-muted-foreground">WhatsApp</dt>
          <dd>{formatWaNumber(profile.phone)}</dd>
          <dt className="text-muted-foreground">Status kredit</dt>
          <dd>{profile.customer?.creditStatusLabel ?? "—"}</dd>
          <dt className="text-muted-foreground">Segmen</dt>
          <dd>{profile.customer?.segment ?? "—"}</dd>
          <dt className="text-muted-foreground">Persetujuan data</dt>
          <dd>{profile.consentAt ? `${formatTanggalJam(profile.consentAt)} (versi ${profile.consentVersion})` : "—"}</dd>
        </dl>
      </CustomerCard>

      <CustomerCard title="Alamat kirim" testId="addresses">
        <span id="alamat" />
        <ul className="mb-3 grid gap-2">
          {addresses.map((a) => (
            <li key={a.id} className="rounded-lg border p-3 text-sm">
              <p className="font-medium">
                {a.label} {a.locked ? <span className="text-xs font-normal text-muted-foreground">(titik dikunci kantor)</span> : <span className="text-xs font-normal text-muted-foreground">(belum dikunci)</span>}
              </p>
              <p className="text-muted-foreground">{a.addressText}</p>
              <p>{a.zoneName ? `Zona ${a.zoneCode} · ` : ""}{a.priceText}</p>
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-primary">Catatan akses / hapus</summary>
                <P2ActionForm action={updateAddressNotesAction.bind(null, a.id)} submitLabel="Simpan catatan" size="sm" className="mt-2" resetOnSuccess={false}>
                  <textarea name="notes" rows={2} defaultValue={a.notes ?? ""} className="rounded-md border border-input bg-background px-2 py-1 text-sm" />
                </P2ActionForm>
                {addresses.length > 1 ? (
                  <div className="mt-2">
                    <P2ActionButton action={deactivateAddressAction.bind(null, a.id)} label="Hapus alamat dari daftar" variant="destructive" />
                  </div>
                ) : null}
              </details>
            </li>
          ))}
        </ul>
        <details>
          <summary className="cursor-pointer text-sm font-medium text-primary">+ Tambah alamat</summary>
          <P2ActionForm action={addAddressAction} submitLabel="Simpan alamat" className="mt-3" testId="add-address">
            <AddressFields defaultLabel="" />
          </P2ActionForm>
        </details>
      </CustomerCard>

      <CustomerCard title="Notifikasi">
        <p className="mb-2 text-sm text-muted-foreground">Pemberitahuan Dikonfirmasi, Berangkat, dan Selesai dikirim lewat WhatsApp dan di aplikasi.</p>
        <PushSubscribe vapidPublicKey={vapid} />
        <div className="mt-3">
          <P2ActionButton action={refillReminderAction.bind(null, !refill.enabled)} label={refill.enabled ? "Matikan pengingat isi ulang" : "Nyalakan pengingat isi ulang"} />
        </div>
      </CustomerCard>

      <CustomerCard title="Ganti nomor WhatsApp">
        <PhoneChange start={startPhoneChangeAction} confirmOld={confirmOldPhoneAction} complete={completePhoneChangeAction} />
      </CustomerCard>

      <CustomerCard title="Hapus akun">
        <details>
          <summary className="cursor-pointer text-sm text-destructive">Saya ingin menghapus akun aplikasi</summary>
          <p className="mt-2 text-xs text-muted-foreground">
            Akun dinonaktifkan dan Anda keluar dari semua perangkat. Data pribadi pelanggan dianonimkan setelah disetujui kantor (UU PDP); bila masih ada tagihan, anonimisasi menunggu sampai lunas. Riwayat transaksi tetap disimpan untuk pembukuan.
          </p>
          <P2ActionForm action={deleteAccountAction} submitLabel="Hapus akun" variant="destructive" className="mt-2" testId="delete-account">
            <input name="reason" placeholder="Alasan (opsional)" maxLength={300} className="h-10 rounded-md border border-input bg-background px-3 text-sm" />
            <input name="confirm" required placeholder="Ketik HAPUS" className="h-10 rounded-md border border-input bg-background px-3 text-sm" />
          </P2ActionForm>
        </details>
      </CustomerCard>

      <form action={logoutAction}>
        <button type="submit" className="w-full rounded-md border bg-card py-3 text-sm font-medium">
          Keluar
        </button>
      </form>
    </CustomerShell>
  );
}
