import type { Metadata } from "next";
import Link from "next/link";

import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { Button } from "@/components/ui/button";
import { formatRupiah } from "@/lib/money";
import { formatTanggal } from "@/lib/time";
import * as p2 from "@/server/modules/p2-customer";
import { requireCustomer } from "@/server/modules/p2-customer/web";

export const metadata: Metadata = { title: "Beranda" };

/** Beranda pelanggan: pesan air, pesanan berjalan, pengingat isi ulang, tagihan terbuka. */
export default async function BerandaPage() {
  const cctx = await requireCustomer();
  const [profile, active, unread, refill, billing] = await Promise.all([
    p2.getMyProfile(cctx),
    p2.listMyOrders(cctx, { status: "active" }),
    p2.unreadNotificationCount(cctx),
    p2.myRefillReminder(cctx),
    p2.myBilling(cctx),
  ]);
  const last = (await p2.listMyOrders(cctx, { status: "done" })).find((o) => o.status === "completed");
  return (
    <CustomerShell title="EQUA" active="home" unread={unread}>
      <p className="mb-4 text-lg">
        Halo, <strong>{profile.customer?.name ?? profile.displayName}</strong>
      </p>
      <div className="mb-4 grid grid-cols-2 gap-2">
        <Button asChild size="lg" className="h-14 text-base">
          <Link href="/app/pesan">Pesan air</Link>
        </Button>
        {last ? (
          <Button asChild size="lg" variant="outline" className="h-14 text-base">
            <Link href={`/app/pesan/ulang?dari=${last.id}`}>Pesan ulang</Link>
          </Button>
        ) : (
          <Button asChild size="lg" variant="outline" className="h-14 text-base">
            <Link href="/app/langganan">Langganan</Link>
          </Button>
        )}
      </div>

      {billing.onHold ? (
        <CustomerCard className="border-warning bg-warning/10" title="Status kredit Ditahan">
          <p className="text-sm">{billing.holdMessage}</p>
          <Link href="/app/tagihan" className="mt-2 inline-block text-sm font-medium text-primary underline">
            Lihat tagihan
          </Link>
        </CustomerCard>
      ) : null}

      <CustomerCard title="Pesanan berjalan" action={<Link className="text-sm text-primary" href="/app/pesanan">Semua</Link>} testId="active-orders">
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada pesanan berjalan.</p>
        ) : (
          <ul className="divide-y">
            {active.slice(0, 5).map((o) => (
              <li key={o.id}>
                <Link href={`/app/pesanan/${o.id}`} className="flex items-center justify-between gap-2 py-2">
                  <span>
                    <span className="block font-medium">{o.number}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatTanggal(o.requestedDate)} · {o.tankCount} tangki
                    </span>
                  </span>
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{o.statusLabel}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CustomerCard>

      {refill.enabled && refill.estimate.available && !refill.estimate.suppressedReason && refill.estimate.expectedDate ? (
        <CustomerCard title="Pengingat isi ulang">
          <p className="text-sm">
            Biasanya Anda memesan sekitar <strong>{formatTanggal(refill.estimate.expectedDate)}</strong> (rata-rata setiap {refill.estimate.avgIntervalDays} hari).
          </p>
        </CustomerCard>
      ) : null}

      <CustomerCard title="Tagihan">
        <p className="text-sm">
          Sisa tagihan: <strong>{formatRupiah(billing.totalOutstanding)}</strong> ({billing.openInvoices.length} faktur terbuka)
        </p>
        <Link href="/app/tagihan" className="mt-1 inline-block text-sm text-primary underline">
          Lihat & bayar
        </Link>
      </CustomerCard>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <Button asChild variant="outline">
          <Link href="/app/langganan">Langganan</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/app/keluhan">Keluhan</Link>
        </Button>
      </div>
    </CustomerShell>
  );
}
