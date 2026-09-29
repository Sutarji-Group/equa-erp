import type { Metadata } from "next";
import Link from "next/link";

import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { formatTanggalJam } from "@/lib/time";
import { cn } from "@/lib/utils";
import * as p2 from "@/server/modules/p2-customer";
import { requireCustomer } from "@/server/modules/p2-customer/web";

import { markNotificationsReadAction } from "../actions";

export const metadata: Metadata = { title: "Notifikasi" };

/** Kotak notifikasi pelanggan (Dikonfirmasi, Berangkat, Selesai, pembayaran, keluhan, pengingat). */
export default async function NotifikasiPage() {
  const cctx = await requireCustomer({ next: "/app/notifikasi" });
  const rows = await p2.listMyNotifications(cctx);
  const unread = rows.filter((r) => !r.read).length;
  return (
    <CustomerShell title="Notifikasi" backHref="/app" unread={unread}>
      {unread > 0 ? (
        <form action={markNotificationsReadAction} className="mb-3">
          <button type="submit" className="text-sm text-primary underline">
            Tandai semua sudah dibaca
          </button>
        </form>
      ) : null}
      <CustomerCard testId="notifications">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada notifikasi.</p>
        ) : (
          <ul className="divide-y">
            {rows.map((n) => (
              <li key={n.id} className={cn("py-2.5", !n.read && "font-medium")}>
                <Link href={n.link ?? "/app"} className="block">
                  <span className="block text-sm">{n.title}</span>
                  {n.body ? <span className="block text-xs font-normal text-muted-foreground">{n.body}</span> : null}
                  <span className="block text-[11px] font-normal text-muted-foreground">{formatTanggalJam(n.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CustomerCard>
    </CustomerShell>
  );
}
