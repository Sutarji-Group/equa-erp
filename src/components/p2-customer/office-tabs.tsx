/** Tab navigasi layar kantor aplikasi pelanggan (hanya tautan yang diizinkan pelaku). Server-safe. */
import Link from "next/link";

import { Button } from "@/components/ui/button";

export type OfficeTab = { href: string; label: string; show: boolean };

export function P2OfficeTabs({ tabs, current }: { tabs: OfficeTab[]; current: string }) {
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Aplikasi pelanggan">
      {tabs
        .filter((t) => t.show)
        .map((t) => (
          <Button key={t.href} asChild size="sm" variant={t.href === current ? "default" : "outline"}>
            <Link href={t.href} aria-current={t.href === current ? "page" : undefined}>
              {t.label}
            </Link>
          </Button>
        ))}
    </nav>
  );
}
