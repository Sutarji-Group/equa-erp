"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { formatBadgeCount } from "../badge-count";
import { isNavItemActive, type NavBadgeKey, type NavGroup, type NavItem } from "./registry";

export type NavCounts = Partial<Record<NavBadgeKey, number>>;

export type SidebarNavProps = {
  /** Grup yang sudah disaring izin (`filterNavByPermissions`). */
  groups: readonly NavGroup[];
  pathname: string;
  counts?: NavCounts;
  /** Mode ikon saja (sidebar diciutkan). */
  collapsed?: boolean;
  /** Dipanggil saat tautan diklik (menutup sheet di ponsel). */
  onNavigate?: () => void;
};

function ItemBadge({ count, collapsed }: { count?: number; collapsed?: boolean }) {
  const badge = formatBadgeCount(count ?? 0);
  if (!badge) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] leading-none font-semibold text-primary-foreground",
        collapsed ? "absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px]" : "ml-auto",
      )}
    >
      {badge}
    </span>
  );
}

function NavLink({
  item,
  active,
  count,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  count?: number;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const badge = formatBadgeCount(count ?? 0);
  const link = (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? `${item.label}${badge ? `, ${count}` : ""}` : undefined}
      data-active={active || undefined}
      className={cn(
        "relative flex items-center gap-3 rounded-md text-sm text-sidebar-foreground/85 transition-colors outline-none",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/60",
        "data-[active]:bg-sidebar-accent data-[active]:font-semibold data-[active]:text-sidebar-accent-foreground",
        collapsed ? "size-10 justify-center" : "h-9 px-2.5",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {collapsed ? null : <span className="truncate">{item.label}</span>}
      <ItemBadge count={count} collapsed={collapsed} />
    </Link>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

/** Menu navigasi web kantor dari registri (grup dapat dilipat; mode ikon saat diciutkan). */
export function SidebarNav({ groups, pathname, counts, collapsed, onNavigate }: SidebarNavProps) {
  const activeGroupId = groups.find((g) => g.items.some((it) => isNavItemActive(it, pathname)))?.id;
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const isOpen = (id: string) => openGroups[id] ?? (id === "home" || id === activeGroupId || groups.length <= 3);

  if (collapsed) {
    return (
      <nav aria-label="Menu utama" className="flex flex-col items-center gap-1 py-2">
        {groups.map((group, gi) => (
          <div key={group.id} className="flex flex-col items-center gap-1">
            {gi > 0 ? <span aria-hidden className="my-1 h-px w-8 bg-sidebar-border" /> : null}
            {group.items.map((item) => (
              <NavLink
                key={item.id}
                item={item}
                active={isNavItemActive(item, pathname)}
                count={item.badgeKey ? counts?.[item.badgeKey] : undefined}
                collapsed
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label="Menu utama" className="flex flex-col gap-1 px-2 py-2">
      {groups.map((group) =>
        group.id === "home" ? (
          <div key={group.id} className="flex flex-col gap-0.5 pb-1">
            {group.items.map((item) => (
              <NavLink
                key={item.id}
                item={item}
                active={isNavItemActive(item, pathname)}
                count={item.badgeKey ? counts?.[item.badgeKey] : undefined}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ) : (
          <Collapsible
            key={group.id}
            open={isOpen(group.id)}
            onOpenChange={(open) => setOpenGroups((prev) => ({ ...prev, [group.id]: open }))}
          >
            <CollapsibleTrigger className="group/trigger flex h-8 w-full items-center justify-between rounded-md px-2.5 text-xs font-semibold tracking-wide text-sidebar-foreground/60 uppercase outline-none hover:text-sidebar-foreground focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/60">
              {group.label}
              <ChevronDown className="size-3.5 transition-transform group-data-[state=closed]/trigger:-rotate-90" aria-hidden />
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-0.5 pb-1">
              {group.items.map((item) => (
                <NavLink
                  key={item.id}
                  item={item}
                  active={isNavItemActive(item, pathname)}
                  count={item.badgeKey ? counts?.[item.badgeKey] : undefined}
                  onNavigate={onNavigate}
                />
              ))}
            </CollapsibleContent>
          </Collapsible>
        ),
      )}
    </nav>
  );
}
