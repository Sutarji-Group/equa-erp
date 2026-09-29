import type { Metadata } from "next";
import Link from "next/link";

import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { Button } from "@/components/ui/button";
import { formatTanggalJam } from "@/lib/time";
import * as p2 from "@/server/modules/p2-customer";
import { requireCustomer } from "@/server/modules/p2-customer/web";

export const metadata: Metadata = { title: "Keluhan" };

/** Daftar keluhan pelanggan dengan status (US-P2-06 KP-2/KP-3). */
export default async function KeluhanPage() {
  const cctx = await requireCustomer({ next: "/app/keluhan" });
  const [rows, unread] = await Promise.all([p2.listMyComplaints(cctx), p2.unreadNotificationCount(cctx)]);
  return (
    <CustomerShell title="Keluhan" active="home" backHref="/app" unread={unread}>
      <Button asChild className="mb-4 w-full" size="lg">
        <Link href="/app/keluhan/baru">Ajukan keluhan</Link>
      </Button>
      <CustomerCard testId="complaints">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada keluhan.</p>
        ) : (
          <ul className="divide-y">
            {rows.map((c) => (
              <li key={c.id}>
                <Link href={`/app/keluhan/${c.id}`} className="flex items-center justify-between gap-2 py-2.5">
                  <span>
                    <span className="block font-medium">
                      {c.kindLabel}
                      {c.orderNumber ? ` · ${c.orderNumber}` : ""}
                    </span>
                    <span className="block text-xs text-muted-foreground">{formatTanggalJam(c.createdAt)}</span>
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{c.statusLabel}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CustomerCard>
    </CustomerShell>
  );
}
