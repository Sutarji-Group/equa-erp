import type { Metadata } from "next";
import Link from "next/link";

import { SharedDemo } from "./_demos/shared-demo";

export const metadata: Metadata = { title: "Komponen bersama" };

const PAGES = [
  { href: "/ui-kit/kantor", label: "Kerangka web kantor (OfficeShell)" },
  { href: "/ui-kit/lapangan", label: "Aplikasi lapangan (FieldShell, tombol besar, PIN, foto, tanda tangan)" },
  { href: "/ui-kit/pos", label: "POS depot/toko (PosShell, kisi produk, keranjang, pembayaran)" },
  { href: "/ui-kit/auth", label: "Halaman masuk & perangkat" },
];

export default function UiKitPage() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-8 p-4 md:p-8">
      <header className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">Hanya lingkungan pengembangan</p>
        <h1 className="text-3xl font-bold tracking-tight">UI kit EQUA</h1>
        <p className="text-muted-foreground">
          Komponen di <code>src/components/shared</code>, <code>field</code>, <code>pos</code>, dan <code>auth</code>. Data contoh, tidak
          tersimpan.
        </p>
        <nav aria-label="Halaman demo" className="flex flex-wrap gap-2">
          {PAGES.map((p) => (
            <Link key={p.href} href={p.href} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
              {p.label}
            </Link>
          ))}
        </nav>
      </header>
      <SharedDemo />
    </div>
  );
}
