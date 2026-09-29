import type { Metadata } from "next";
import Link from "next/link";

import { MonthFilter } from "@/components/p3-partner/fields";
import { EmptyState } from "@/components/shared/empty-state";
import { KeyValueList } from "@/components/shared/key-value-list";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import * as notifications from "@/server/core/notifications";
import * as p3 from "@/server/modules/p3-partner";

import { requirePortalSession } from "../_session";

export const metadata: Metadata = { title: "Beranda mitra" };

const num = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? "—" : n.toLocaleString("id-ID", { maximumFractionDigits: digits }));

/**
 * Beranda portal (RL-7 US-P3-10 KP-2; Tahap 3 US-P3-06 KP-4): ringkasan bulan (omzet, galon, void, selisih shift),
 * neraca air versi mitra, tagihan terbuka, kepatuhan SLA dukungan, kontrak & hak baca EQUA (US-P3-02 KP-2); bila
 * portal Tahap 3 aktif: skor mutu per outlet & sanksi — angka yang sama dengan dashboard EQUA.
 */
export default async function PortalHomePage({ searchParams }: { searchParams: Promise<{ bulan?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await requirePortalSession();
  const home = await p3.portalHome(ctx, { month: sp.bulan ?? null });
  const dash = home.phase3 ? await p3.portalDashboard(ctx, { month: home.month }) : null;
  const inbox = await notifications.list(ctx, { limit: 5 });

  return (
    <>
      <PageHeader title={`Beranda ${home.terms.partner}`} description="Data yang sama dengan yang dipakai EQUA untuk tagihan dan pembinaan." />
      <MonthFilter month={home.month} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="ringkasan-mitra">
        <KpiTile label="Penjualan" value={<MoneyText value={home.summary.salesTotal} />} hint={`${num(home.summary.transactions, 0)} transaksi`} href="/mitra/penjualan" hrefLabel="Rincian" />
        <KpiTile label="Galon terjual" value={num(home.summary.gallons, 0)} hint={`${num(home.summary.voidCount, 0)} void`} />
        <KpiTile label="Selisih kas shift" value={<MoneyText value={home.summary.cashDifference} />} tone={home.summary.cashDifference ? "warning" : "neutral"} />
        <KpiTile label="Sisa tagihan EQUA" value={<MoneyText value={home.invoices.outstanding} />} tone={home.invoices.overdue ? "danger" : "neutral"} hint={home.invoices.overdue ? "ada tagihan lewat jatuh tempo" : undefined} href="/mitra/tagihan" hrefLabel="Tagihan" />
      </div>

      <SectionCard title="Neraca air bulan ini" description="Galon terjual × 19 L dibandingkan air yang diterima dari truk EQUA (+ stok awal & sumber lain yang Anda catat).">
        {home.waterBalance.length === 0 ? (
          <EmptyState title="Belum ada data neraca air" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="neraca-air-mitra">
              <TableHeader>
                <TableRow>
                  <TableHead>Outlet</TableHead>
                  <TableHead className="text-right">Air dari EQUA</TableHead>
                  <TableHead className="text-right">Tersedia</TableHead>
                  <TableHead className="text-right">Terjual (L)</TableHead>
                  <TableHead className="text-right">Kelebihan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {home.waterBalance.map((b) => (
                  <TableRow key={b.outletId}>
                    <TableCell>{b.outletName}</TableCell>
                    <TableCell className="text-right">{num(b.receivedFromEquaL, 0)} L</TableCell>
                    <TableCell className="text-right">{num(b.availableL, 0)} L</TableCell>
                    <TableCell className="text-right">
                      {num(b.soldL, 0)} L ({num(b.gallonsSold, 0)} galon)
                    </TableCell>
                    <TableCell className="text-right">
                      <ToneBadge tone={b.exceeded ? "danger" : "success"}>{num(b.excessPct)}%</ToneBadge>
                      <div className="text-xs text-muted-foreground">toleransi {num(b.tolerancePct)}%</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {dash ? (
        <SectionCard title="Skor mutu & status kemitraan" description="Skor mutu bulanan = gabungan daftar periksa harian, audit pembina, dan uji air.">
          <div className="grid gap-2">
            {dash.outlets.map((o) => (
              <div key={o.outletId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{o.outletName}</span>
                <span className="text-muted-foreground">{num(o.gallonsPerDay)} galon/hari</span>
                {o.score === null ? <ToneBadge tone="muted">Skor belum ada</ToneBadge> : <ToneBadge tone={o.belowThreshold ? "danger" : "success"}>Skor {num(o.score)}</ToneBadge>}
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {dash.activeSanctions.length ? (
                dash.activeSanctions.map((s) => (
                  <Link key={s.id} href="/mitra/sanksi">
                    <ToneBadge tone="danger">{label("sanction_level", s.level)}</ToneBadge>
                  </Link>
                ))
              ) : (
                <ToneBadge tone="success">Tanpa sanksi</ToneBadge>
              )}
              {dash.nextEvaluationDate ? <span className="text-muted-foreground">Evaluasi berikutnya {formatTanggal(dash.nextEvaluationDate)}</span> : null}
            </div>
          </div>
        </SectionCard>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Kontrak">
          {home.contract ? (
            <KeyValueList
              columns={2}
              items={[
                { label: "Nomor", value: home.contract.number },
                { label: "Status", value: <StatusBadge enumName="partner_contract_status" value={home.contract.status} /> },
                { label: "Opsi", value: label("partner_option", home.contract.option) },
                { label: "Masa", value: `${formatTanggal(home.contract.startDate)} – ${formatTanggal(home.contract.endDate)}` },
                { label: "Langganan sistem/outlet", value: <MoneyText value={home.contract.subscriptionFeePerOutlet} /> },
                { label: "Batas kredit", value: <MoneyText value={home.contract.creditLimit} /> },
              ]}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Kontrak belum tercatat. Hubungi Admin Keuangan EQUA.</p>
          )}
          <div className="mt-3 text-sm">
            <p className="font-medium">Outlet</p>
            <ul className="mt-1 grid gap-1">
              {home.outlets.map((o) => (
                <li key={o.id}>
                  {o.code} — {o.name} {o.activatedOn ? <span className="text-muted-foreground">(aktif sejak {formatTanggal(o.activatedOn)})</span> : <ToneBadge tone="warning">Onboarding</ToneBadge>}
                </li>
              ))}
            </ul>
          </div>
        </SectionCard>
        <SectionCard title="Hak baca EQUA atas data Anda" description="Sesuai perjanjian kemitraan. EQUA tidak melihat data pengguna atau kas kecil mitra.">
          <ul className="list-inside list-disc text-sm" data-testid="hak-baca-equa">
            {home.readRights.map((r) => (
              <li key={r.key}>{r.label}</li>
            ))}
          </ul>
        </SectionCard>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Dukungan teknis bulan ini" actions={<Link href="/mitra/dukungan" className="text-sm text-primary hover:underline">Ajukan / lihat</Link>}>
          <KeyValueList
            columns={2}
            items={[
              { label: "Permintaan", value: String(home.sla.total) },
              { label: "Ditanggapi tepat waktu", value: String(home.sla.respondedOnTime) },
              { label: "Lewat 48 jam", value: String(home.sla.late) },
              { label: "Rata-rata waktu tanggap", value: home.sla.avgResponseHours === null ? "—" : `${num(home.sla.avgResponseHours)} jam` },
            ]}
          />
        </SectionCard>
        <SectionCard title="Pemberitahuan">
          {inbox.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada pemberitahuan.</p>
          ) : (
            <ul className="grid gap-2 text-sm">
              {inbox.map((n) => (
                <li key={n.id}>
                  <span className="font-medium">{n.title}</span>
                  <div className="text-xs text-muted-foreground">{formatTanggalJam(n.createdAt)}</div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </>
  );
}
