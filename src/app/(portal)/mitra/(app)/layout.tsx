import { LogOut } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { PortalNav, type PortalNavItem } from "@/components/p3-partner/portal-nav";
import { ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/server/core/db";
import * as p3 from "@/server/modules/p3-partner";

import { requirePortalSession } from "../_session";

export const dynamic = "force-dynamic";

/**
 * Kerangka portal pemilik mitra (RL-7 US-P3-10; Tahap 3 di balik flag `phase3.partner_portal`): identitas tenant,
 * menu, keluar. Setiap halaman memanggil layanan P3 dengan pelaku portal — data selalu tenant sendiri (NFR-30).
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const { user, tenant } = await requirePortalSession();
  const db = getDb();
  const terms = await p3.partnerTerms(db);
  const phase3 = await p3.portalEnabled(db, tenant.id);
  const items: PortalNavItem[] = [
    { href: "/mitra", label: "Beranda" },
    { href: "/mitra/penjualan", label: "Penjualan" },
    { href: "/mitra/pasokan", label: "Pasokan & neraca air" },
    { href: "/mitra/tagihan", label: "Tagihan" },
    { href: "/mitra/laporan-bulanan", label: "Laporan bulanan" },
    { href: "/mitra/dukungan", label: "Dukungan teknis" },
    ...(phase3
      ? [
          { href: "/mitra/pesanan", label: "Pesan air & spare part" },
          { href: "/mitra/mutu", label: "Mutu" },
          { href: "/mitra/pengaturan", label: "Pengaturan POS" },
          { href: "/mitra/sanksi", label: "Sanksi" },
        ]
      : []),
  ];
  return (
    <div className="flex min-h-full flex-1 flex-col bg-muted/30">
      <header className="border-b bg-background">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted-foreground">Portal {terms.partner}</p>
            <p className="truncate text-base font-semibold" data-testid="portal-tenant">
              {tenant.name}
            </p>
          </div>
          {tenant.readOnly ? <ToneBadge tone="warning">Mode baca-saja</ToneBadge> : null}
          {!tenant.isActive ? <ToneBadge tone="muted">Kemitraan berakhir</ToneBadge> : null}
          <span className="hidden text-sm text-muted-foreground sm:inline">{user.name}</span>
          <Button asChild variant="ghost" size="sm">
            <Link href="/akun/kata-sandi">Ubah kata sandi</Link>
          </Button>
          <form action="/mitra/keluar" method="post">
            <Button type="submit" variant="outline" size="sm">
              <LogOut aria-hidden /> Keluar
            </Button>
          </form>
        </div>
        <div className="mx-auto w-full max-w-6xl px-4 pb-2">
          <PortalNav items={items} />
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-6xl flex-1 gap-6 px-4 py-6">{children}</main>
      <footer className="border-t bg-background py-3 text-center text-xs text-muted-foreground">
        Data outlet Anda hanya terlihat oleh Anda dan EQUA sesuai hak baca di perjanjian.
      </footer>
    </div>
  );
}
