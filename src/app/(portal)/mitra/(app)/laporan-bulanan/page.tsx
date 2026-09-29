import type { Metadata } from "next";

import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KeyValueList } from "@/components/shared/key-value-list";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { formatTanggalJam } from "@/lib/time";
import * as p3 from "@/server/modules/p3-partner";

import { requirePortalSession } from "../../_session";

export const metadata: Metadata = { title: "Laporan bulanan" };

const num = (n: number | null | undefined, digits = 0) => (n === null || n === undefined ? "—" : n.toLocaleString("id-ID", { maximumFractionDigits: digits }));

/**
 * Laporan bulanan mitra (RL-7 US-P3-10 KP-3, kewajiban EQUA BRD 9.8): terbit otomatis tanggal 5 untuk bulan lalu,
 * isinya tidak berubah setelah terbit (snapshot), dapat diunduh PDF/Excel (US-M9-03). Memuat ringkasan kepatuhan SLA
 * dukungan teknis (US-P3-11 KP-2).
 */
export default async function PortalMonthlyReportsPage({ searchParams }: { searchParams: Promise<{ periode?: string }> }) {
  const sp = await searchParams;
  const { ctx } = await requirePortalSession();
  const reports = await p3.portalMonthlyReports(ctx);

  return (
    <>
      <PageHeader title="Laporan bulanan" description="Terbit otomatis setiap tanggal 5 untuk bulan sebelumnya. Isi laporan yang sudah terbit tidak berubah." />
      {reports.length === 0 ? (
        <EmptyState title="Belum ada laporan bulanan" description="Laporan pertama terbit tanggal 5 bulan depan." />
      ) : (
        <div className="grid gap-4" data-testid="daftar-laporan-bulanan">
          {reports.map((r) => {
            const d = r.data as unknown as p3.PartnerMonthlyReportData;
            const q = `period=${r.period}`;
            return (
              <SectionCard
                key={r.id}
                title={`Laporan ${r.period}`}
                description={r.publishedAt ? `Terbit ${formatTanggalJam(r.publishedAt)}` : undefined}
                className={sp.periode === r.period ? "ring-2 ring-primary/40" : undefined}
                actions={<ExportButtons pdfHref={`/api/export/p3.partner_monthly?format=pdf&${q}`} excelHref={`/api/export/p3.partner_monthly?format=xlsx&${q}`} />}
              >
                <KeyValueList
                  columns={3}
                  items={[
                    { label: "Penjualan", value: <MoneyText value={d.totals.salesTotal} /> },
                    { label: "Galon terjual", value: num(d.totals.gallons) },
                    { label: "Void", value: num(d.totals.voidCount) },
                    { label: "Pasokan air diterima", value: `${num(d.totals.supplyReceivedL)} L` },
                    { label: "Tagihan terbit", value: <MoneyText value={d.totals.invoiced} /> },
                    { label: "Dibayar", value: <MoneyText value={d.totals.paid} /> },
                    { label: "Sisa tagihan", value: <MoneyText value={d.totals.outstanding} /> },
                    { label: "Permintaan dukungan", value: `${d.sla.total} (tepat waktu ${d.sla.respondedOnTime}, lewat 48 jam ${d.sla.late})` },
                    { label: "Kepatuhan SLA dukungan", value: d.sla.compliancePct === null ? "—" : `${num(d.sla.compliancePct, 1)}%` },
                  ]}
                />
                {d.waterBalance.length ? (
                  <ul className="mt-3 grid gap-1 text-sm">
                    {d.waterBalance.map((b) => (
                      <li key={b.outletId} className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">Neraca air {b.outletName}:</span>
                        <span>
                          {num(b.soldL)} L terjual vs {num(b.availableL)} L tersedia
                        </span>
                        <ToneBadge tone={b.exceeded ? "danger" : "success"}>
                          kelebihan {num(b.excessPct, 1)}% (toleransi {num(b.tolerancePct, 1)}%)
                        </ToneBadge>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </SectionCard>
            );
          })}
        </div>
      )}
    </>
  );
}
