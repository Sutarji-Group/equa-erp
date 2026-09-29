/**
 * Kerangka aplikasi pelanggan (PWA, ponsel dulu): kepala dengan tombol kembali & lonceng notifikasi, isi selebar
 * ponsel, bilah navigasi bawah (Beranda, Pesan, Pesanan, Tagihan, Akun). Server-safe (tanpa 'use client').
 * Istilah pelanggan (bukan istilah internal seperti "rit", NFR-15 Tahap 2).
 */
import { Bell, ChevronLeft, Droplets, House, ListOrdered, ReceiptText, UserRound } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type CustomerNavKey = "home" | "order" | "orders" | "billing" | "account";

const NAV: { key: CustomerNavKey; href: string; label: string; icon: typeof House }[] = [
  { key: "home", href: "/app", label: "Beranda", icon: House },
  { key: "order", href: "/app/pesan", label: "Pesan", icon: Droplets },
  { key: "orders", href: "/app/pesanan", label: "Pesanan", icon: ListOrdered },
  { key: "billing", href: "/app/tagihan", label: "Tagihan", icon: ReceiptText },
  { key: "account", href: "/app/akun", label: "Akun", icon: UserRound },
];

export function CustomerShell({
  title,
  backHref,
  active,
  unread = 0,
  children,
  hideNav,
}: {
  title: string;
  backHref?: string;
  active?: CustomerNavKey;
  unread?: number;
  children: ReactNode;
  hideNav?: boolean;
}) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-background">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b bg-primary px-3 py-3 text-primary-foreground">
        {backHref ? (
          <Link href={backHref} className="-ml-1 rounded-md p-1 hover:bg-white/10" aria-label="Kembali">
            <ChevronLeft className="size-6" aria-hidden />
          </Link>
        ) : (
          <Droplets className="size-6" aria-hidden />
        )}
        <h1 className="flex-1 truncate text-lg font-semibold">{title}</h1>
        {!hideNav ? (
          <Link href="/app/notifikasi" className="relative rounded-md p-1 hover:bg-white/10" aria-label={unread ? `Notifikasi, ${unread} belum dibaca` : "Notifikasi"}>
            <Bell className="size-6" aria-hidden />
            {unread > 0 ? (
              <span className="absolute -top-0.5 -right-0.5 grid min-w-5 place-items-center rounded-full bg-destructive px-1 text-xs font-semibold text-white">{unread > 99 ? "99+" : unread}</span>
            ) : null}
          </Link>
        ) : null}
      </header>
      <main className={cn("flex-1 px-4 py-4", !hideNav && "pb-24")}>{children}</main>
      {!hideNav ? (
        <nav className="fixed inset-x-0 bottom-0 z-20 border-t bg-background" aria-label="Menu aplikasi">
          <ul className="mx-auto grid max-w-md grid-cols-5">
            {NAV.map((item) => {
              const Icon = item.icon;
              const on = item.key === active;
              return (
                <li key={item.key}>
                  <Link href={item.href} aria-current={on ? "page" : undefined} className={cn("flex flex-col items-center gap-0.5 py-2 text-xs", on ? "font-semibold text-primary" : "text-muted-foreground")}>
                    <Icon className="size-5" aria-hidden />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}

/** Kartu sederhana untuk blok isi aplikasi pelanggan. */
export function CustomerCard({ title, children, action, className, testId }: { title?: string; children: ReactNode; action?: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={cn("mb-4 rounded-xl border bg-card p-4 shadow-xs", className)} data-testid={testId}>
      {title || action ? (
        <div className="mb-2 flex items-center justify-between gap-2">
          {title ? <h2 className="text-base font-semibold">{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}
