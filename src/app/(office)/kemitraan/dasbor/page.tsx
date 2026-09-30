import type { Metadata } from "next";
import Link from "next/link";

import { MonthFilter } from "@/components/p3-partner/fields";
import { Phase3Disabled } from "@/components/p3-partner/phase3-disabled";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatTanggal } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as p3 from "@/server/modules/p3-partner";

import { phase3Enabled } from "../_data";

export const metadata: Metadata = { title: "Dashboard kemitraan" };

const num = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? "—" : n.toLocaleString("id-ID", { maximumFractionDigits: digits }));
const RISK_TONE = { low: "success", medium: "warning", high: "danger" } as const;

/**
 * Dashboard kemitraan (Tahap 3 US-P3-06): KP-1 kinerja per mitra/outlet per bulan (omzet, galon/hari, air dibeli,
 * neraca air merah > PAR-79, spare part, tagihan, skor, sanksi, evaluasi), KP-2 portofolio pembina (peringkat risiko,
 * jadwal audit, temuan terbuka), KP-3 ekonomi kemitraan untuk pemilik (pendapatan EQUA vs ilustrasi 9.7, komitmen
 * kapasitas vs ruang K22), KP-5 ekspor Excel/PDF.
 */
export default async function PartnerDashboardPage({ searchParams }: { searchParams: Promise<{ bulan?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await requirePermission(["p3.partner.read", "p3.partner_score.read"]);
  if (!(await phase3Enabled(ctx.tenantId))) {
    return (
      <div className="grid gap-6">
        <PageHeader title="Dashboard kemitraan" />
        <Phase3Disabled what="Dashboard kinerja mitra & portofolio pembina" />
      </div>
    );
  }
  const month = sp.bulan ?? null;
  const dash = can(ctx, "p3.partner.read") ? await p3.partnerDashboard(ctx, { month }) : null;
  const portfolio = can(ctx, "p3.partner_score.read") ? await p3.coachPortfolio(ctx, { month }) : null;
  const economics = can(ctx, "p3.partner_economics.read") ? await p3.partnershipEconomics(ctx, { month }) : null;
  const m = dash?.month ?? portfolio?.month ?? economics?.month ?? "";
  const rows = dash?.rows ?? [];
  const totals = rows.reduce(
    (s, r) => ({ sales: s.sales + r.salesTotal, gallons: s.gallons + r.gallons, waterL: s.waterL + r.waterL, overdue: s.overdue + r.invoices.overdue, red: s.red + (r.waterBalanceExceeded ? 1 : 0) }),
    { sales: 0, gallons: 0, waterL: 0, overdue: 0, red: 0 },
  );

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Dashboard kemitraan"
        description="Setiap mitra dalam satu layar — omzet, air dibeli, neraca air, mutu, tagihan — agar mitra yang memakai sumber lain atau menunggak terlihat tanpa audit lapangan."
        actions={<ExportButtons excelHref={`/api/export/p3.partner_dashboard?format=xlsx&month=${m}`} pdfHref={`/api/export/p3.partner_dashboard?format=pdf&month=${m}`} />}
      />
      <MonthFilter month={m} />

      {dash ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <KpiTile label="Omzet POS mitra" value={<MoneyText value={totals.sales} />} />
            <KpiTile label="Galon terjual" value={num(totals.gallons, 0)} />
            <KpiTile label="Air dibeli dari EQUA" value={`${num(totals.waterL, 0)} L`} href={`/kemitraan/pasokan?bulan=${m}`} hrefLabel="Pasokan" />
            <KpiTile label="Neraca air merah" value={String(totals.red)} tone={totals.red ? "danger" : "neutral"} hint={`toleransi PAR-79 ${num(dash.tolerancePct)}%`} />
            <KpiTile label="Tagihan lewat tempo" value={<MoneyText value={totals.overdue} />} tone={totals.overdue ? "danger" : "neutral"} href="/kemitraan/langganan" hrefLabel="Tagihan" />
          </div>
          <SectionCard title={`Kinerja per mitra — ${m}`}>
            {rows.length === 0 ? (
              <EmptyState title="Belum ada mitra" compact />
            ) : (
              <div className="overflow-x-auto">
                <Table data-testid="tabel-dasbor-mitra">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mitra / outlet</TableHead>
                      <TableHead className="text-right">Omzet POS</TableHead>
                      <TableHead className="text-right">Galon/hari</TableHead>
                      <TableHead className="text-right">Air dibeli</TableHead>
                      <TableHead className="text-right">Neraca air</TableHead>
                      <TableHead className="text-right">Spare part</TableHead>
                      <TableHead className="text-right">Tagihan (terbit/dibayar/lewat tempo)</TableHead>
                      <TableHead className="text-right">Skor mutu</TableHead>
                      <TableHead>Sanksi · evaluasi</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.flatMap((r) => [
                      <TableRow key={r.tenant.id} className="bg-muted/40">
                        <TableCell className="font-medium">
                          <Link href={`/kemitraan/mitra/${r.tenant.id}`} className="text-primary hover:underline">
                            {r.tenant.name}
                          </Link>
                          {!r.tenant.isActive ? <ToneBadge tone="muted" className="ml-1">Nonaktif</ToneBadge> : r.tenant.readOnly ? <ToneBadge tone="warning" className="ml-1">Baca-saja</ToneBadge> : null}
                        </TableCell>
                        <TableCell className="text-right">
                          <MoneyText value={r.salesTotal} />
                        </TableCell>
                        <TableCell className="text-right">—</TableCell>
                        <TableCell className="text-right">
                          {num(r.waterTrips, 0)} rit · {num(r.waterL, 0)} L
                        </TableCell>
                        <TableCell className="text-right">{r.waterBalanceExceeded ? <ToneBadge tone="danger">Merah</ToneBadge> : <ToneBadge tone="success">Wajar</ToneBadge>}</TableCell>
                        <TableCell className="text-right">
                          <MoneyText value={r.sparePartAmount} />
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          <MoneyText value={r.invoices.issued} /> / <MoneyText value={r.invoices.paid} /> /{" "}
                          <span className={r.invoices.overdue ? "text-destructive" : ""}>
                            <MoneyText value={r.invoices.overdue} />
                          </span>
                          {r.invoices.maxOverdueDays ? <div>{r.invoices.maxOverdueDays} hari</div> : null}
                        </TableCell>
                        <TableCell className="text-right">—</TableCell>
                        <TableCell className="text-xs">
                          {r.activeSanctions.length ? r.activeSanctions.map((s) => <ToneBadge key={s.id} tone="danger" className="mr-1">{label("sanction_level", s.level)}</ToneBadge>) : "Tanpa sanksi"}
                          <div>{r.nextEvaluationDate ? `evaluasi ${formatTanggal(r.nextEvaluationDate)}` : ""}</div>
                        </TableCell>
                      </TableRow>,
                      ...r.outlets.map((o) => (
                        <TableRow key={`${r.tenant.id}:${o.outletId}`}>
                          <TableCell className="pl-6 text-sm">{o.outletName}</TableCell>
                          <TableCell className="text-right text-sm">
                            <MoneyText value={o.salesTotal} />
                          </TableCell>
                          <TableCell className="text-right text-sm">{num(o.gallonsPerDay)}</TableCell>
                          <TableCell className="text-right text-sm">{o.balance ? `${num(o.balance.receivedFromEquaL, 0)} L` : "—"}</TableCell>
                          <TableCell className="text-right text-sm">{o.balance ? <ToneBadge tone={o.balance.exceeded ? "danger" : "neutral"}>{num(o.balance.excessPct)}%</ToneBadge> : "—"}</TableCell>
                          <TableCell />
                          <TableCell />
                          <TableCell className="text-right text-sm">{o.score === null ? "—" : <ToneBadge tone={o.belowThreshold ? "danger" : "success"}>{num(o.score)}</ToneBadge>}</TableCell>
                          <TableCell />
                        </TableRow>
                      )),
                    ])}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>
        </>
      ) : null}

      {portfolio ? (
        <SectionCard
          title="Portofolio pembina wilayah"
          description="Peringkat risiko dari neraca air, tunggakan, skor mutu, temuan audit terbuka, dan sanksi berlaku."
          actions={<ExportButtons excelHref={`/api/export/p3.coach_portfolio?format=xlsx&month=${m}`} pdfHref={`/api/export/p3.coach_portfolio?format=pdf&month=${m}`} />}
        >
          {portfolio.rows.length === 0 ? (
            <EmptyState title="Belum ada mitra aktif" compact />
          ) : (
            <ul className="grid gap-2" data-testid="portofolio-pembina">
              {portfolio.rows.map((r) => (
                <li key={r.metrics.tenant.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
                  <ToneBadge tone={RISK_TONE[r.risk]}>{label("partner_risk_level", r.risk)}</ToneBadge>
                  <Link href={`/kemitraan/mitra/${r.metrics.tenant.id}`} className="font-medium text-primary hover:underline">
                    {r.metrics.tenant.name}
                  </Link>
                  <span className="text-muted-foreground">{r.reasons.length ? r.reasons.join(" · ") : "Tidak ada penanda risiko"}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {r.nextAudit ? `audit ${formatTanggal(r.nextAudit)}` : "belum ada audit terjadwal"} · {r.openFindings} temuan terbuka
                  </span>
                </li>
              ))}
            </ul>
          )}
          {portfolio.upcomingAudits.length ? (
            <div className="mt-4">
              <h3 className="mb-2 text-sm font-medium">Jadwal audit & kunjungan</h3>
              <ul className="grid gap-1 text-sm">
                {portfolio.upcomingAudits.map((a) => (
                  <li key={a.id}>
                    <Link href={`/kemitraan/mutu?audit=${a.id}`} className="text-primary hover:underline">
                      {formatTanggal(a.scheduledDate)}
                    </Link>{" "}
                    · {a.tenantName} — {a.outletName}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {economics ? (
        <SectionCard
          title="Ekonomi kemitraan"
          description="Pendapatan EQUA per mitra (air, spare part, langganan, royalti) dibandingkan ilustrasi 9.7; komitmen kapasitas air mitra dibandingkan ruang kapasitas K22."
          actions={<ExportButtons excelHref={`/api/export/p3.partnership_economics?format=xlsx&month=${m}`} pdfHref={`/api/export/p3.partnership_economics?format=pdf&month=${m}`} />}
        >
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <KpiTile label="Komitmen kapasitas mitra" value={`${num(economics.capacity.committedTrips)} rit/bulan`} hint={`${economics.capacity.activePartners} mitra berkontrak`} />
            <KpiTile label="Ruang kapasitas K22" value={`${num(economics.capacity.roomTrips)} rit/bulan`} tone={economics.capacity.committedTrips > economics.capacity.roomTrips ? "danger" : "neutral"} />
            <KpiTile label="Rit mitra terealisasi" value={`${num(economics.capacity.actualTrips, 0)} rit`} />
          </div>
          <div className="overflow-x-auto">
            <Table data-testid="tabel-ekonomi-kemitraan">
              <TableHeader>
                <TableRow>
                  <TableHead>Mitra</TableHead>
                  <TableHead className="text-right">Air</TableHead>
                  <TableHead className="text-right">Spare part</TableHead>
                  <TableHead className="text-right">Langganan & fee</TableHead>
                  <TableHead className="text-right">Royalti</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Ilustrasi</TableHead>
                  <TableHead className="text-right">Selisih</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {economics.rows.map((r) => (
                  <TableRow key={r.tenant.id}>
                    <TableCell>{r.tenant.name}</TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={r.revenue.water} />
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={r.revenue.sparePart} />
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={r.revenue.subscription} />
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={r.revenue.royalty} />
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      <MoneyText value={r.total} />
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={r.illustration} />
                    </TableCell>
                    <TableCell className="text-right">{r.gapPct === null ? "—" : <ToneBadge tone={r.gapPct < 0 ? "warning" : "success"}>{num(r.gapPct)}%</ToneBadge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
