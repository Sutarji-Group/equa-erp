import type { Metadata } from "next";

import { P2ActionButton, P2ActionForm } from "@/components/p2-customer/action-form";
import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { formatTanggal, toBusinessDate } from "@/lib/time";
import { withTx } from "@/server/core/db";
import * as p2 from "@/server/modules/p2-customer";
import { requireCustomer } from "@/server/modules/p2-customer/web";

import { refillReminderAction, saveSubscriptionAction, subscriptionStatusAction } from "../actions";

export const metadata: Metadata = { title: "Langganan" };

const DAYS = [
  [1, "Sen"],
  [2, "Sel"],
  [3, "Rab"],
  [4, "Kam"],
  [5, "Jum"],
  [6, "Sab"],
  [7, "Min"],
] as const;

function SubscriptionFields({ addresses, slots, sub, today }: { addresses: p2.CustomerAddressView[]; slots: { key: string; label: string }[]; sub?: p2.SubscriptionView; today: string }) {
  return (
    <>
      <label className="grid gap-1 text-sm font-medium">
        Alamat
        <select name="addressId" defaultValue={sub?.address.id ?? addresses[0]?.id} className="h-11 rounded-md border border-input bg-background px-3 text-base">
          {addresses.filter((a) => a.orderable).map((a) => (
            <option key={a.id} value={a.id}>
              {a.label} — {a.addressText}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="grid gap-2 text-sm">
        <legend className="font-medium">Pola</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="pattern" value="weekly" defaultChecked={(sub?.pattern ?? "weekly") === "weekly"} /> Hari tertentu setiap minggu
        </label>
        <div className="flex flex-wrap gap-2 pl-6">
          {DAYS.map(([d, l]) => (
            <label key={d} className="flex items-center gap-1">
              <input type="checkbox" name="daysOfWeek" value={d} defaultChecked={sub?.daysOfWeek.includes(d)} /> {l}
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2">
          <input type="radio" name="pattern" value="interval" defaultChecked={sub?.pattern === "interval"} /> Setiap
          <input name="intervalDays" type="number" min={1} max={90} defaultValue={sub?.intervalDays ?? 7} className="h-9 w-16 rounded-md border border-input bg-background px-2" /> hari
        </label>
      </fieldset>
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-sm font-medium">
          Jumlah tangki
          <input name="tankCount" type="number" min={1} max={20} defaultValue={sub?.tankCount ?? 1} required className="h-11 rounded-md border border-input bg-background px-3 text-base" />
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Slot
          <select name="slot" defaultValue={sub?.slot ?? slots[0]?.key} className="h-11 rounded-md border border-input bg-background px-3 text-base">
            {slots.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="grid gap-1 text-sm font-medium">
        Cara bayar
        <select name="paymentMethod" defaultValue={sub?.paymentMethod === "credit" ? "credit" : sub?.paymentMethod === "transfer" ? "transfer" : "cash"} className="h-11 rounded-md border border-input bg-background px-3 text-base">
          <option value="cash">Tunai saat air datang</option>
          <option value="transfer">Transfer saat air datang</option>
          <option value="credit">Tempo (khusus pelanggan Tempo)</option>
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-sm font-medium">
          Mulai
          <input name="startDate" type="date" min={today} defaultValue={sub && sub.startDate >= today ? sub.startDate : today} required className="h-11 rounded-md border border-input bg-background px-3 text-base" />
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Berakhir (opsional)
          <input name="endDate" type="date" min={today} defaultValue={sub?.endDate ?? ""} className="h-11 rounded-md border border-input bg-background px-3 text-base" />
        </label>
      </div>
    </>
  );
}

/**
 * Langganan mandiri (US-P2-05 KP-1): pola hari/interval, jumlah, slot → pesanan berulang M2; ubah berlaku untuk pesanan
 * yang belum dibuat; jeda/aktifkan/akhiri. Pengingat isi ulang dapat dimatikan (KP-2). Kegagalan (kredit ditahan)
 * tampil dengan tindakan (KP-3).
 */
export default async function LanggananPage() {
  const cctx = await requireCustomer({ next: "/app/langganan" });
  const today = toBusinessDate(cctx.now);
  const [subs, addresses, refill, unread, days] = await Promise.all([
    p2.listMySubscriptions(cctx),
    p2.listMyAddresses(cctx),
    p2.myRefillReminder(cctx),
    p2.unreadNotificationCount(cctx),
    withTx((tx) => p2.slotAvailability(tx, { tenantId: cctx.tenantId, now: cctx.now, days: 2 })),
  ]);
  const slots = (days[1] ?? days[0])?.slots.map((s) => ({ key: s.key, label: s.label })) ?? [];
  return (
    <CustomerShell title="Langganan" active="home" backHref="/app" unread={unread}>
      {subs.map((s) => (
        <CustomerCard key={s.id} title={`${s.patternText} · ${s.tankCount} tangki`} testId="subscription">
          <p className="text-sm text-muted-foreground">
            {s.address.label} · {s.slotText ?? "tanpa slot"} · {s.paymentLabel} · <strong>{s.statusLabel}</strong>
          </p>
          {s.nextDates.length ? <p className="text-sm">Berikutnya: {s.nextDates.map((d) => formatTanggal(d)).join(", ")}</p> : null}
          {s.failures.map((f) => (
            <p key={f.id} className="mt-2 rounded-md border border-warning bg-warning/10 p-2 text-sm">
              Pesanan {formatTanggal(f.targetDate)} belum dapat dibuat. {f.message}
            </p>
          ))}
          {s.status !== "ended" ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {s.status === "active" ? <P2ActionButton action={subscriptionStatusAction.bind(null, s.id, "paused")} label="Jeda" /> : <P2ActionButton action={subscriptionStatusAction.bind(null, s.id, "active")} label="Aktifkan lagi" />}
              <P2ActionButton action={subscriptionStatusAction.bind(null, s.id, "ended")} label="Akhiri" variant="destructive" />
            </div>
          ) : null}
          {s.status !== "ended" ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-primary">Ubah pola</summary>
              <P2ActionForm action={saveSubscriptionAction.bind(null, s.id)} submitLabel="Simpan perubahan" className="mt-2" resetOnSuccess={false}>
                <SubscriptionFields addresses={addresses} slots={slots} sub={s} today={today} />
              </P2ActionForm>
            </details>
          ) : null}
        </CustomerCard>
      ))}

      <CustomerCard title="Buat langganan baru">
        <P2ActionForm action={saveSubscriptionAction.bind(null, null)} submitLabel="Buat langganan" testId="subscription-form">
          <SubscriptionFields addresses={addresses} slots={slots} today={today} />
          <p className="text-xs text-muted-foreground">Pesanan langganan dibuat otomatis 2 hari sebelum tanggal kirim dan tetap melalui pemeriksaan tempo/tagihan.</p>
        </P2ActionForm>
      </CustomerCard>

      <CustomerCard title="Pengingat isi ulang">
        <p className="mb-2 text-sm text-muted-foreground">
          {refill.estimate.available && refill.estimate.expectedDate
            ? `Rata-rata Anda memesan setiap ${refill.estimate.avgIntervalDays} hari; pengingat dikirim 2 hari sebelum ${formatTanggal(refill.estimate.expectedDate)}.`
            : "Pengingat aktif setelah ada beberapa pesanan selesai."}
        </p>
        <P2ActionButton action={refillReminderAction.bind(null, !refill.enabled)} label={refill.enabled ? "Matikan pengingat" : "Nyalakan pengingat"} testId="refill-toggle" />
      </CustomerCard>
    </CustomerShell>
  );
}
