import type { Metadata } from "next";
import Link from "next/link";

import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { Button } from "@/components/ui/button";
import { formatRupiah } from "@/lib/money";
import { formatTanggal } from "@/lib/time";
import * as p2 from "@/server/modules/p2-customer";
import { requireCustomer } from "@/server/modules/p2-customer/web";

export const metadata: Metadata = { title: "Pesanan saya" };

/** Riwayat pesanan 24 bulan dengan status akhir (US-P2-04 KP-1); ekspor PDF tercatat (KP-5). */
export default async function PesananPage({ searchParams }: PageProps<"/app/pesanan">) {
  const cctx = await requireCustomer({ next: "/app/pesanan" });
  const sp = await searchParams;
  const tab = sp.tampil === "selesai" ? "done" : sp.tampil === "semua" ? null : "active";
  const [rows, unread] = await Promise.all([p2.listMyOrders(cctx, { status: tab }), p2.unreadNotificationCount(cctx)]);
  return (
    <CustomerShell title="Pesanan saya" active="orders" unread={unread}>
      <nav className="mb-3 flex gap-2" aria-label="Tampilan pesanan">
        {[
          { key: "aktif", label: "Berjalan", on: tab === "active" },
          { key: "selesai", label: "Selesai/batal", on: tab === "done" },
          { key: "semua", label: "Semua", on: tab === null },
        ].map((t) => (
          <Button key={t.key} asChild size="sm" variant={t.on ? "default" : "outline"}>
            <Link href={`/app/pesanan?tampil=${t.key}`} aria-current={t.on ? "page" : undefined}>
              {t.label}
            </Link>
          </Button>
        ))}
      </nav>
      <CustomerCard testId="order-history">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada pesanan.</p>
        ) : (
          <ul className="divide-y">
            {rows.map((o) => (
              <li key={o.id}>
                <Link href={`/app/pesanan/${o.id}`} className="flex items-center justify-between gap-2 py-2.5">
                  <span>
                    <span className="block font-medium">{o.number}</span>
                    <span className="block text-xs text-muted-foreground">
                      {formatTanggal(o.requestedDate)} · {o.tankCount} tangki · {formatRupiah(o.total)}
                    </span>
                    <span className="block text-xs text-muted-foreground">{o.paymentLabel}</span>
                  </span>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{o.statusLabel}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CustomerCard>
      <Button asChild variant="outline" size="sm">
        <a href="/api/customer/riwayat" download>
          Unduh riwayat (PDF)
        </a>
      </Button>
    </CustomerShell>
  );
}
