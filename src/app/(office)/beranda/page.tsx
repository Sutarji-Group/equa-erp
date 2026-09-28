import { Bell, CheckCheck, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { KpiTile } from "@/components/shared/kpi-tile";
import { filterNavByPermissions } from "@/components/shared/nav/registry";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { formatTanggal, nowWib } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { requireOfficeSession } from "@/server/core/auth/office";
import * as notifications from "@/server/core/notifications";
import { can, ROLE_CATALOG } from "@/server/core/rbac";

export const metadata: Metadata = { title: "Beranda" };

function greetingFor(hour: number): string {
  if (hour < 11) return "Selamat pagi";
  if (hour < 15) return "Selamat siang";
  if (hour < 18) return "Selamat sore";
  return "Selamat malam";
}

function today() {
  const wib = nowWib();
  return { greeting: greetingFor(wib.hour), date: formatTanggal(wib.businessDate) };
}

/** Beranda per peran: sapaan, ringkasan tugas (persetujuan, notifikasi), pintasan sesuai izin. */
export default async function BerandaPage({ searchParams }: PageProps<"/beranda">) {
  const { ctx, user, permissions } = await requireOfficeSession();
  const sp = await searchParams;
  const { greeting, date } = today();

  const canApprovals = can(ctx, "m10.approval.read");
  const inbox = canApprovals ? await approvals.listInbox(ctx) : [];
  const decidable = inbox.filter((i) => i.canDecide);
  const overdue = decidable.filter((i) => i.isOverdue).length;
  const unread = await notifications.unreadCount(ctx);

  const groups = filterNavByPermissions(permissions)
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.hidden && i.href !== "/beranda" && !i.href.includes("[")) }))
    .filter((g) => g.items.length > 0);
  const focus = user.roles.map((r) => ROLE_CATALOG[r]?.description).filter(Boolean);

  return (
    <>
      <PageHeader title={`${greeting}, ${user.name}`} description={`${date} · ${user.roleLabels.join(", ")}`} />
      {sp.ditolak ? (
        <p role="alert" className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          Anda tidak memiliki akses ke halaman itu. Hak akses hanya lewat peran; hubungi admin sistem bila tugas Anda memerlukannya.
        </p>
      ) : null}
      {focus.length ? <p className="mb-6 max-w-3xl text-sm text-muted-foreground">Fokus peran Anda: {focus.join(" ")}</p> : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {canApprovals ? (
          <KpiTile
            label="Persetujuan menunggu Anda"
            value={decidable.length}
            hint={overdue ? `${overdue} lewat tenggat` : "Tidak ada yang lewat tenggat"}
            tone={overdue ? "danger" : decidable.length ? "warning" : "success"}
            href="/persetujuan"
            hrefLabel="Buka kotak persetujuan"
            icon={CheckCheck}
          />
        ) : null}
        <KpiTile
          label="Notifikasi belum dibaca"
          value={unread}
          tone={unread ? "warning" : "success"}
          href="/notifikasi"
          hrefLabel="Buka notifikasi"
          icon={Bell}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((group) => (
          <SectionCard key={group.id} title={group.label}>
            <ul className="grid gap-1">
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.id}>
                    <Link href={item.href} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                      <Icon className="size-4 text-muted-foreground" aria-hidden />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </SectionCard>
        ))}
      </div>
    </>
  );
}
