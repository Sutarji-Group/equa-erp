"use client";

import { CircleHelp, Droplets, KeyRound, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Settings, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { createContext, Fragment, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { ApprovalCountBadge } from "./approval-count-badge";
import { NotificationBell, type NotificationPreview } from "./notification-bell";
import { buildBreadcrumbs, filterNavByPermissions, hasPermission } from "./nav/registry";
import { SidebarNav } from "./nav/sidebar-nav";
import { UploadGuard } from "./upload-guard";
import { usePersistentFlag } from "./use-persistent-flag";

export type OfficeShellUser = {
  /** Nama tampilan pengguna. */
  name: string;
  /** Label peran aktif (Indonesia), mis. `["Pemilik"]` — pakai `label("role", code)`. */
  roleLabels: readonly string[];
};

export type OfficeShellCounts = {
  /** Permintaan persetujuan menunggu keputusan pengguna. */
  approvals?: number;
  /** Bagian dari `approvals` yang lewat tenggat. */
  approvalsOverdue?: number;
  /** Notifikasi belum dibaca. */
  notifications?: number;
  /** Item "Perlu tindakan" di kotak masuk. */
  inbox?: number;
};

export type OfficeShellProps = {
  user: OfficeShellUser;
  /** String izin pengguna (`<modul>.<sumberdaya>.<aksi>`), untuk menyaring menu. */
  permissions: readonly string[];
  counts?: OfficeShellCounts;
  /** Feature flag aktif (item registri ber-`flag`). */
  enabledFlags?: readonly string[];
  /** Pratinjau notifikasi terbaru untuk lonceng. */
  notifications?: readonly NotificationPreview[];
  /** Slot pencarian global di topbar. */
  searchSlot?: ReactNode;
  /**
   * Aksi keluar: URL (form POST) atau Server Action. Bawaan `"/keluar"`.
   * Agen auth menghubungkan ini ke penghapusan sesi.
   */
  signOutAction?: string | ((formData: FormData) => void | Promise<void>);
  /** Lencana lingkungan (mis. "Data demo") di samping logo. */
  environmentLabel?: string;
  children: ReactNode;
};

type BreadcrumbOverride = { setLabel: (label: string | null) => void };
const BreadcrumbOverrideContext = createContext<BreadcrumbOverride | null>(null);

/**
 * Timpa label halaman terakhir di breadcrumb (mis. nomor pesanan pada `/pesanan/[id]`).
 * Render di halaman: `<OfficeBreadcrumbLabel label="P-26-000123" />`.
 */
export function OfficeBreadcrumbLabel({ label }: { label: string }) {
  const ctx = useContext(BreadcrumbOverrideContext);
  useEffect(() => {
    ctx?.setLabel(label);
    return () => ctx?.setLabel(null);
  }, [ctx, label]);
  return null;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : "")).toUpperCase();
}

function Brand({ collapsed, environmentLabel }: { collapsed?: boolean; environmentLabel?: string }) {
  return (
    <Link href="/beranda" className="flex min-w-0 items-center gap-2 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Droplets className="size-4" aria-hidden />
      </span>
      {collapsed ? <span className="sr-only">EQUA</span> : <span className="truncate text-base font-bold tracking-tight">EQUA</span>}
      {environmentLabel && !collapsed ? (
        <span className="rounded bg-warning px-1.5 py-0.5 text-[10px] font-semibold text-warning-foreground uppercase">
          {environmentLabel}
        </span>
      ) : null}
    </Link>
  );
}

function ThemeMenuItem() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <DropdownMenuItem onSelect={() => setTheme(dark ? "light" : "dark")}>
      {dark ? <Sun aria-hidden /> : <Moon aria-hidden />}
      {dark ? "Mode terang" : "Mode gelap"}
    </DropdownMenuItem>
  );
}

function UserMenu({ user, signOutAction }: { user: OfficeShellUser; signOutAction: OfficeShellProps["signOutAction"] }) {
  const roles = user.roleLabels.join(", ");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 gap-2 px-1.5 sm:px-2" aria-label={`Menu pengguna: ${user.name}`}>
          <Avatar className="size-7">
            <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">{initials(user.name)}</AvatarFallback>
          </Avatar>
          <span className="hidden max-w-40 flex-col items-start leading-tight lg:flex">
            <span className="max-w-40 truncate text-sm font-medium">{user.name}</span>
            <span className="max-w-40 truncate text-xs font-normal text-muted-foreground">{roles}</span>
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <p className="truncate font-medium">{user.name}</p>
          <p className="truncate text-xs text-muted-foreground">{roles || "—"}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/pengaturan/notifikasi">
            <Settings aria-hidden />
            Pengaturan notifikasi
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/akun/kata-sandi">
            <KeyRound aria-hidden />
            Ubah kata sandi
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/bantuan">
            <CircleHelp aria-hidden />
            Bantuan
          </Link>
        </DropdownMenuItem>
        <ThemeMenuItem />
        <DropdownMenuSeparator />
        <form action={signOutAction} method="post">
          <DropdownMenuItem asChild variant="destructive">
            <button type="submit" className="w-full">
              <LogOut aria-hidden />
              Keluar
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Kerangka web kantor: sidebar dapat diciutkan (desktop) / sheet (ponsel), topbar (pencarian, lonceng notifikasi,
 * kotak persetujuan, menu pengguna), breadcrumb dari registri navigasi, dan area konten responsif.
 * Menu disaring dengan `filterNavByPermissions(permissions)`. Belum terhubung ke auth: layout `(office)` yang memberi
 * `user`, `permissions`, `counts`.
 */
export function OfficeShell({
  user,
  permissions,
  counts,
  enabledFlags,
  notifications,
  searchSlot,
  signOutAction = "/keluar",
  environmentLabel,
  children,
}: OfficeShellProps) {
  const pathname = usePathname() ?? "/";
  const [collapsed, setCollapsed] = usePersistentFlag("equa.sidebar.collapsed", false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [labelOverride, setLabelOverride] = useState<string | null>(null);
  const override = useMemo<BreadcrumbOverride>(() => ({ setLabel: setLabelOverride }), []);

  const groups = useMemo(
    () => filterNavByPermissions(permissions, { enabledFlags }),
    [permissions, enabledFlags],
  );
  const crumbs = buildBreadcrumbs(pathname, { currentLabel: labelOverride ?? undefined });
  const navCounts = { approvals: counts?.approvals, notifications: counts?.notifications, inbox: counts?.inbox };
  const canSeeApprovals = hasPermission(permissions, "m10.approval.read");

  return (
    <BreadcrumbOverrideContext.Provider value={override}>
      <div data-slot="office-shell" className="flex min-h-dvh w-full">
        <a
          href="#konten"
          className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium shadow focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Lewati ke konten
        </a>

        {/* Sidebar desktop */}
        <aside
          data-collapsed={collapsed || undefined}
          className={cn(
            "sticky top-0 hidden h-dvh shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:flex",
            collapsed ? "w-16" : "w-64",
          )}
        >
          <div className={cn("flex h-14 shrink-0 items-center border-b", collapsed ? "justify-center px-2" : "px-4")}>
            <Brand collapsed={collapsed} environmentLabel={environmentLabel} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SidebarNav groups={groups} pathname={pathname} counts={navCounts} collapsed={collapsed} />
          </div>
          <div className={cn("shrink-0 border-t p-2", collapsed && "flex justify-center")}>
            <Button
              variant="ghost"
              size={collapsed ? "icon" : "sm"}
              className={cn(!collapsed && "w-full justify-start")}
              onClick={() => setCollapsed(!collapsed)}
              aria-label={collapsed ? "Bentangkan menu" : "Ciutkan menu"}
              aria-expanded={!collapsed}
            >
              {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
              {collapsed ? null : "Ciutkan menu"}
            </Button>
          </div>
        </aside>

        {/* Sheet ponsel */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="w-72 gap-0 bg-sidebar p-0 text-sidebar-foreground">
            <SheetHeader className="h-14 flex-row items-center border-b px-4 py-0">
              <SheetTitle className="sr-only">Menu</SheetTitle>
              <SheetDescription className="sr-only">Navigasi web kantor EQUA</SheetDescription>
              <Brand environmentLabel={environmentLabel} />
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SidebarNav groups={groups} pathname={pathname} counts={navCounts} onNavigate={() => setMobileOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-4">
            <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen(true)} aria-label="Buka menu">
              <Menu aria-hidden />
            </Button>
            <Breadcrumb className="min-w-0 flex-1">
              <BreadcrumbList className="flex-nowrap">
                {crumbs.map((c, i) => {
                  const last = i === crumbs.length - 1;
                  return (
                    <Fragment key={`${c.label}-${i}`}>
                      <BreadcrumbItem className={cn(!last && "hidden sm:inline-flex", last && "min-w-0")}>
                        {last ? (
                          <BreadcrumbPage className="truncate">{c.label}</BreadcrumbPage>
                        ) : c.href ? (
                          <BreadcrumbLink asChild>
                            <Link href={c.href}>{c.label}</Link>
                          </BreadcrumbLink>
                        ) : (
                          <span>{c.label}</span>
                        )}
                      </BreadcrumbItem>
                      {!last ? <BreadcrumbSeparator className="hidden sm:inline-flex" /> : null}
                    </Fragment>
                  );
                })}
              </BreadcrumbList>
            </Breadcrumb>
            {searchSlot ? <div className="hidden min-w-0 sm:block sm:w-56 lg:w-72">{searchSlot}</div> : null}
            {canSeeApprovals ? (
              <ApprovalCountBadge count={counts?.approvals ?? 0} overdueCount={counts?.approvalsOverdue ?? 0} />
            ) : null}
            <NotificationBell count={counts?.notifications ?? 0} items={notifications} />
            <UserMenu user={user} signOutAction={signOutAction} />
          </header>
          <main id="konten" className="mx-auto flex w-full max-w-screen-2xl min-w-0 flex-1 flex-col gap-6 p-4 md:p-6">
            <UploadGuard />
            {children}
          </main>
        </div>
      </div>
    </BreadcrumbOverrideContext.Provider>
  );
}
