import type { Metadata } from "next";
import Link from "next/link";

import { PeriodStatusBadge, periodLabel } from "@/components/m11-accounting/ui";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { allNavItems } from "@/components/shared/nav/registry";
import { monthOf } from "@/lib/time";
import { ctxBusinessDate } from "@/server/core/context";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m11 from "@/server/modules/m11-accounting";

export const metadata: Metadata = { title: "Akuntansi" };

/** Ringkasan Akuntansi & Pajak (M11): status periode berjalan, daftar tunggu, laba bulan berjalan, pemantauan PKP. */
export default async function AccountingHomePage() {
  const { ctx } = await requirePermission(["m11.journal.read", "m11.financial_report.read", "m11.period.read"]);
  const period = monthOf(ctxBusinessDate(ctx));
  const [queue, periods, statements, tax] = await Promise.all([
    can(ctx, "m11.journal_queue.read") ? m11.listJournalQueue(ctx, { status: "pending" }) : Promise.resolve([]),
    can(ctx, "m11.period.read") ? m11.listPeriods(ctx) : Promise.resolve([]),
    can(ctx, "m11.financial_report.read") ? m11.getStatements(ctx, { period }) : Promise.resolve(null),
    can(ctx, "m11.tax.read") ? m11.taxOverview(ctx, { period }) : Promise.resolve(null),
  ]);
  const open = periods.filter((p) => p.status === "open" || p.status === "reopened").slice(0, 3);
  const allowed = (perm: string | readonly string[] | null) => perm === null || (typeof perm === "string" ? can(ctx, perm) : perm.some((x) => can(ctx, x)));
  const links = allNavItems().filter((i) => i.href.startsWith("/akuntansi/") && !i.hidden && allowed(i.permission));

  return (
    <div className="grid gap-6">
      <PageHeader title="Akuntansi & Pajak" description="Jurnal otomatis dari seluruh transaksi operasional; tutup buku hanya soal memeriksa, bukan mencatat." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Daftar tunggu jurnal" value={String(queue.length)} tone={queue.length ? "danger" : "success"} href="/akuntansi/jurnal?antrean=1" hrefLabel="Lihat" />
        {statements ? <KpiTile label={`Laba konsolidasi ${periodLabel(period)}`} value={<MoneyText value={statements.profitLoss.consolidated.net} />} hint={statements.status === "final" ? "Final" : "Sementara"} href="/akuntansi/laporan" hrefLabel="Laporan" /> : null}
        {tax ? <KpiTile label="Omzet 12 bulan vs batas PKP" value={`${tax.pkp.percent.toLocaleString("id-ID")}%`} tone={tax.pkp.level ? "warning" : "success"} href="/akuntansi/pajak" hrefLabel="Pajak" /> : null}
        <KpiTile label="Periode terbuka" value={String(open.length)} hint={open.map((p) => p.period).join(", ")} href="/akuntansi/periode" hrefLabel="Periode" />
      </div>
      {open.length ? (
        <SectionCard title="Periode terbuka">
          <ul className="grid gap-2 text-sm">
            {open.map((p) => (
              <li key={p.period} className="flex flex-wrap items-center gap-2">
                <Link href={`/akuntansi/periode/${p.id ?? p.period}`} className="text-primary hover:underline">
                  {periodLabel(p.period)}
                </Link>
                <PeriodStatusBadge status={p.status} late={p.closedLate} />
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
      <SectionCard title="Menu akuntansi">
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {links.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="block rounded-md border px-3 py-2 text-sm hover:bg-accent">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
