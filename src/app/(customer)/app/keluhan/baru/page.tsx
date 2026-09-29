import type { Metadata } from "next";

import { P2ActionForm } from "@/components/p2-customer/action-form";
import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { PhotoField } from "@/components/p2-customer/photo-field";
import { enumOptions } from "@/lib/labels";
import { formatTanggal } from "@/lib/time";
import * as p2 from "@/server/modules/p2-customer";
import { requireCustomer } from "@/server/modules/p2-customer/web";

import { submitComplaintAction } from "../../actions";

export const metadata: Metadata = { title: "Ajukan keluhan" };

/**
 * Ajukan keluhan (US-P2-06 KP-2): jenis (volume, keterlambatan, sikap, tagihan, lainnya), cerita, foto, terkait
 * pesanan; operasional → Dispatcher, tagihan → Admin Keuangan; tanggapan pertama ≤ 24 jam layanan.
 */
export default async function KeluhanBaruPage({ searchParams }: PageProps<"/app/keluhan/baru">) {
  const cctx = await requireCustomer({ next: "/app/keluhan/baru" });
  const sp = await searchParams;
  const orders = (await p2.listMyOrders(cctx)).slice(0, 30);
  const preset = typeof sp.pesanan === "string" ? sp.pesanan : "";
  return (
    <CustomerShell title="Ajukan keluhan" active="home" backHref="/app/keluhan">
      <CustomerCard>
        <P2ActionForm action={submitComplaintAction} submitLabel="Kirim keluhan" fullWidth resetOnSuccess={false} testId="complaint-form">
          <label className="grid gap-1 text-sm font-medium">
            Jenis keluhan
            <select name="kind" required className="h-11 rounded-md border border-input bg-background px-3 text-base">
              {enumOptions("complaint_kind").map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Terkait pesanan (opsional)
            <select name="orderId" defaultValue={preset} className="h-11 rounded-md border border-input bg-background px-3 text-base">
              <option value="">— Tidak terkait pesanan —</option>
              {orders.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.number} · {formatTanggal(o.requestedDate)} · {o.statusLabel}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Ceritakan keluhan Anda
            <textarea name="description" rows={4} required minLength={10} maxLength={2000} className="rounded-md border border-input bg-background px-3 py-2 text-base" />
          </label>
          <PhotoField />
          <p className="text-xs text-muted-foreground">Keluhan tidak dapat dihapus dan akan ditanggapi paling lambat 24 jam layanan.</p>
        </P2ActionForm>
      </CustomerCard>
    </CustomerShell>
  );
}
