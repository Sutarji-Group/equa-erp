import { Bell } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/shared/empty-state";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { formatTanggalJam } from "@/lib/time";
import { requireOfficeSession } from "@/server/core/auth/office";
import * as notifications from "@/server/core/notifications";

import { MarkAllReadButton, NotificationRowActions } from "./notification-actions";

export const metadata: Metadata = { title: "Notifikasi" };

const FILTERS = [
  { key: "perlu", label: "Perlu tindakan", status: ["new", "read"] as const },
  { key: "baru", label: "Belum dibaca", status: ["new"] as const },
  { key: "semua", label: "Semua", status: undefined },
];

/** Pusat notifikasi (Bab 6.3, US-M9-04): objek, nilai, tenggat, tautan tindakan; status maju, tidak dihapus. */
export default async function NotifikasiPage({ searchParams }: PageProps<"/notifikasi">) {
  const { ctx } = await requireOfficeSession();
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f.key === sp.tampil) ?? FILTERS[0]!;
  const rows = await notifications.list(ctx, { status: filter.status ? [...filter.status] : undefined, limit: 100 });
  const unread = await notifications.unreadCount(ctx);

  return (
    <>
      <PageHeader
        title="Notifikasi"
        description="Peristiwa yang perlu Anda tindak lanjuti. Notifikasi yang sudah ditindaklanjuti berubah status, tidak dihapus."
        actions={<MarkAllReadButton disabled={unread === 0} />}
      />
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Saring notifikasi">
        {FILTERS.map((f) => (
          <Button key={f.key} asChild size="sm" variant={f.key === filter.key ? "default" : "outline"}>
            <Link href={`/notifikasi?tampil=${f.key}`}>{f.label}</Link>
          </Button>
        ))}
      </nav>
      {rows.length === 0 ? (
        <EmptyState icon={Bell} title="Tidak ada notifikasi" description="Semua sudah ditindaklanjuti." />
      ) : (
        <ul className="grid gap-3">
          {rows.map((n) => (
            <li key={n.id} className="rounded-lg border bg-card p-4" data-status={n.status}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{n.title}</p>
                  {n.body ? <p className="text-sm text-muted-foreground">{n.body}</p> : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <StatusBadge enumName="notification_severity" value={n.severity} />
                  <StatusBadge enumName="notification_status" value={n.status} />
                </div>
              </div>
              <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
                <div>
                  <dt className="sr-only">Waktu</dt>
                  <dd>{formatTanggalJam(n.createdAt)}</dd>
                </div>
                {n.valueAmount != null ? (
                  <div>
                    <dt className="inline">Nilai: </dt>
                    <dd className="inline">
                      <MoneyText value={n.valueAmount} />
                    </dd>
                  </div>
                ) : n.valueText ? (
                  <div>
                    <dt className="inline">Nilai: </dt>
                    <dd className="inline">{n.valueText}</dd>
                  </div>
                ) : null}
                {n.deadlineAt ? (
                  <div>
                    <dt className="inline">Tenggat: </dt>
                    <dd className="inline">{formatTanggalJam(n.deadlineAt)}</dd>
                  </div>
                ) : null}
              </dl>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {n.link ? (
                  <Button asChild size="sm">
                    <Link href={n.link}>Buka</Link>
                  </Button>
                ) : null}
                <NotificationRowActions id={n.id} status={n.status} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
