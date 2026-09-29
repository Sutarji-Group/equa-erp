import "server-only";

import { Inbox, Landmark, LayoutDashboard, Wallet } from "lucide-react";

import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import type { ActorContext } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m9 from "@/server/modules/m9-reports";

/**
 * Blok ringkas "Hari ini" di /beranda untuk pelaku yang berhak H+0 (pemilik, Admin Keuangan): omzet luar, selisih kas,
 * butir kotak masuk — tautan ke /laporan/hari-ini & /kotak-masuk (US-M9-01, US-M9-04). Galat tidak menggagalkan beranda.
 */
export async function OwnerTodayBlock({ ctx }: { ctx: ActorContext }) {
  if (!can(ctx, "m9.daily_summary.read")) return null;
  let dash: m9.DailyDashboard;
  let inbox: { count: number; overdue: number } | null = null;
  let pkp: Awaited<ReturnType<typeof m9.pkpDashboard>> = null;
  try {
    dash = await m9.getDailyDashboard(ctx, {});
    if (can(ctx, "m9.inbox.read")) inbox = await m9.inboxBadgeCount(ctx);
    // Status batas PKP (US-M11-08 KP-4, B-54) — angka M11 `pkpStatus`, sama dengan Akuntansi › Pajak.
    if (can(ctx, "m9.monthly_report.read")) pkp = await m9.pkpDashboard(ctx);
  } catch {
    return null;
  }
  const unclosed = dash.unclosed ? "Belum ditutup — angka dapat berubah" : undefined;
  return (
    <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="beranda-h0">
      <KpiTile label="Omzet luar hari ini" value={<MoneyText value={dash.data.revenue.external} />} unclosed={unclosed} href="/laporan/hari-ini" hrefLabel="Buka H+0" icon={LayoutDashboard} />
      <KpiTile
        label="Selisih kas hari ini"
        value={<MoneyText value={dash.data.cash.discrepancy} signed />}
        tone={dash.pendingDiscrepancies.length ? "danger" : dash.data.cash.discrepancy ? "warning" : "success"}
        hint={dash.pendingDiscrepancies.length ? `${dash.pendingDiscrepancies.length} menunggu keputusan pemilik` : undefined}
        icon={Wallet}
      />
      {pkp ? (
        <KpiTile
          label="Batas PKP (12 bulan berjalan)"
          value={`${pkp.percent.toLocaleString("id-ID")}%`}
          tone={pkp.level !== null ? (pkp.level >= Math.max(...pkp.warnPercents) ? "danger" : "warning") : "success"}
          hint={pkp.projectedPeriod ? `Proyeksi tercapai ${pkp.projectedPeriod}` : "Belum diproyeksikan tercapai"}
          href="/laporan/bulanan#pkp"
          hrefLabel="Buka pemantauan PKP"
          icon={Landmark}
        />
      ) : null}
      {inbox ? (
        <KpiTile label="Kotak masuk — perlu tindakan" value={inbox.count} tone={inbox.overdue ? "danger" : inbox.count ? "warning" : "success"} hint={inbox.overdue ? `${inbox.overdue} lewat tenggat` : undefined} href="/kotak-masuk" hrefLabel="Buka kotak masuk" icon={Inbox} />
      ) : null}
    </div>
  );
}
