"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

export type PortalNavItem = { href: string; label: string };

/** Menu portal mitra (gulir horizontal di ponsel; aktif sesuai jalur). */
export function PortalNav({ items }: { items: PortalNavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Menu portal mitra" className="-mx-4 overflow-x-auto px-4">
      <ul className="flex min-w-max gap-1">
        {items.map((item) => {
          const active = item.href === "/mitra" ? pathname === "/mitra" : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors",
                  active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
