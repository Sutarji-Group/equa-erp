import type { Metadata } from "next";

import { M11ActionForm } from "@/components/m11-accounting/action-form";
import { Amount, FilterForm, FilterSelect, FormInput, FormSelect, FormTextarea, exportHref, hrefWith, periodLabel, periodOptions } from "@/components/m11-accounting/ui";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { monthOf } from "@/lib/time";
import { ctxBusinessDate } from "@/server/core/context";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m11 from "@/server/modules/m11-accounting";

import { saveExportTemplateAction, setTaxSchemeAction } from "../actions";

export const metadata: Metadata = { title: "Pajak" };

type Search = Promise<{ periode?: string }>;

/**
 * Pajak PT non-PKP & pemantauan PKP (US-M11-08): tanpa PPN (BR-29), omzet bruto bulanan per lini + estimasi PPh final
 * (informasi), skema lain dari konsultan, ekspor ke format konsultan lewat template terkonfigurasi, pemantauan batas PKP
 * 12 bulan berjalan (80%/90%) dengan proyeksi.
 */
export default async function TaxPage({ searchParams }: { searchParams: Search }) {
  const { ctx } = await requirePermission("m11.tax.read");
  const sp = await searchParams;
  const current = monthOf(ctxBusinessDate(ctx));
  const period = sp.periode || current;
  const [ov, templates] = await Promise.all([m11.taxOverview(ctx, { period }), m11.listExportTemplates(ctx)]);
  const from = `${period.slice(0, 4)}-01`;
  const report = await m11.monthlyRevenueReport(ctx, { fromPeriod: from, toPeriod: period });
  const pkp = ov.pkp;
  const activeTemplates = templates.filter((t) => t.isActive);

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Pajak"
        description="PT non-PKP: sistem tidak memungut PPN dan tidak menerbitkan faktur pajak (BR-29). Estimasi PPh hanya informasi; skema ditetapkan konsultan pajak."
        actions={<ExportButtons excelHref={exportHref("m11.revenue_tax", "xlsx", { from, to: period })} pdfHref={exportHref("m11.revenue_tax", "pdf", { from, to: period })} />}
      />
      <SectionCard>
        <FilterForm action="/akuntansi/pajak">
          <FilterSelect name="periode" value={period} label="Periode" options={periodOptions(current, 24)} />
        </FilterForm>
      </SectionCard>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label={`Omzet bruto ${periodLabel(period)}`} value={<MoneyText value={ov.total} />} hint="Pendapatan luar; transfer internal dikecualikan" />
        <KpiTile label="Estimasi PPh" value={ov.pphEstimate !== null ? <MoneyText value={ov.pphEstimate} /> : "—"} hint={`${ov.schemeLabel}${ov.ratePercent !== null ? ` · ${ov.ratePercent.toLocaleString("id-ID")}%` : ""}`} />
        <KpiTile label="Omzet 12 bulan berjalan" value={<MoneyText value={pkp.total} />} hint={`${pkp.percent.toLocaleString("id-ID")}% dari batas PKP ${formatRupiah(pkp.threshold)}`} tone={pkp.level ? (pkp.level >= 90 ? "danger" : "warning") : "success"} />
        <KpiTile label="Retensi pembukuan" value={`${ov.retentionYears} tahun`} hint="Bukti & jurnal tidak dapat dihapus (BR-31)" />
      </div>

      <SectionCard
        title="Pemantauan batas PKP"
        description={`Omzet ${pkp.fromPeriod} s.d. ${pkp.toPeriod}. Peringatan ke pemilik & Admin Keuangan pada ${pkp.warnPercents.join("% dan ")}%.`}
      >
        <div className="grid gap-2" data-testid="pemantauan-pkp">
          <Progress value={Math.min(100, pkp.percent)} aria-label="Persentase omzet terhadap batas PKP" />
          <p className="text-sm">
            {pkp.percent.toLocaleString("id-ID")}% dari batas {formatRupiah(pkp.threshold)}
            {pkp.level ? <ToneBadge tone={pkp.level >= 90 ? "danger" : "warning"} className="ml-2">Peringatan {pkp.level}%</ToneBadge> : null}
          </p>
          <p className="text-sm text-muted-foreground">
            Rata-rata 3 bulan terakhir {formatRupiah(pkp.avg3)}.{" "}
            {pkp.projectedPeriod ? `Proyeksi batas PKP tercapai pada ${periodLabel(pkp.projectedPeriod)}.` : "Dengan rata-rata ini batas PKP belum tercapai dalam 5 tahun."}
          </p>
        </div>
      </SectionCard>

      <SectionCard title={`Omzet bruto bulanan per lini — ${period.slice(0, 4)}`} flush>
        <div className="overflow-x-auto">
          <Table data-testid="tabel-omzet">
            <TableHeader>
              <TableRow>
                <TableHead>Periode</TableHead>
                {(["L1", "L2", "L3", "L4", "L5"] as const).map((pc) => (
                  <TableHead key={pc} className="text-right">
                    {label("profit_center", pc)}
                  </TableHead>
                ))}
                <TableHead className="text-right">Omzet bruto</TableHead>
                <TableHead className="text-right">Estimasi PPh</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.map((r) => (
                <TableRow key={r.period}>
                  <TableCell>{periodLabel(r.period)}</TableCell>
                  {(["L1", "L2", "L3", "L4", "L5"] as const).map((pc) => (
                    <TableCell key={pc} className="text-right">
                      <Amount value={r[pc]} />
                    </TableCell>
                  ))}
                  <TableCell className="text-right">
                    <Amount value={r.total} strong />
                  </TableCell>
                  <TableCell className="text-right">{r.pphEstimate !== null ? formatRupiah(r.pphEstimate) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <SectionCard title="Ekspor ke format konsultan" description="Format ditetapkan lewat template (dapat diubah tanpa rilis aplikasi). Setiap unduhan tercatat di log ekspor." flush>
        <div className="overflow-x-auto">
          <Table data-testid="template-ekspor">
            <TableHeader>
              <TableRow>
                <TableHead>Template</TableHead>
                <TableHead>Isi</TableHead>
                <TableHead>Versi</TableHead>
                <TableHead>Kolom</TableHead>
                <TableHead>Unduh {periodLabel(period)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeTemplates.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    {t.name}
                    <span className="block font-mono text-xs text-muted-foreground">{t.key}</span>
                  </TableCell>
                  <TableCell>{t.target === "journals" ? "Jurnal" : t.target === "ledger" ? "Buku besar / neraca saldo" : "Omzet bruto"}</TableCell>
                  <TableCell>v{t.version}</TableCell>
                  <TableCell className="max-w-80 text-xs">{(t.columnMapping as { header: string }[]).map((c) => c.header).join(", ")}</TableCell>
                  <TableCell>
                    <a href={hrefWith("/akuntansi/pajak/ekspor", { template: t.key, periode: period })} className="text-sm text-primary hover:underline" download>
                      Unduh ({t.format.toUpperCase()})
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        {can(ctx, "m11.tax.update") ? (
          <SectionCard title="Skema pajak" description={`Berlaku saat ini: ${ov.schemeLabel}. Perubahan berlaku mulai tanggal yang dipilih (keputusan konsultan pajak).`}>
            <M11ActionForm action={setTaxSchemeAction} submitLabel="Simpan skema" testId="skema-pajak">
              <div className="grid gap-3 sm:grid-cols-3">
                <FormSelect label="Skema" name="scheme" options={enumOptions("tax_scheme")} required emptyLabel="Pilih" />
                <FormInput label="Tarif (% omzet, skema lain)" name="ratePercent" inputMode="decimal" />
                <FormInput label="Berlaku mulai" name="effectiveFrom" type="date" required defaultValue={ctxBusinessDate(ctx)} />
              </div>
              <FormInput label="Catatan (keputusan konsultan)" name="notes" required />
            </M11ActionForm>
          </SectionCard>
        ) : null}
        {can(ctx, "m11.export_template.update") ? (
          <SectionCard title="Ubah / tambah template ekspor" description={`Kolom per baris: "Judul=kolom". Kolom jurnal: ${m11.EXPORT_FIELDS.journals.map((f) => f.field).join(", ")}.`}>
            <M11ActionForm action={saveExportTemplateAction} submitLabel="Simpan template" testId="template-baru">
              <div className="grid gap-3 sm:grid-cols-2">
                <FormInput label="Kunci" name="key" required placeholder="journals-consultant" />
                <FormInput label="Nama" name="name" required />
                <FormSelect
                  label="Isi"
                  name="target"
                  options={[
                    { value: "journals", label: "Jurnal" },
                    { value: "ledger", label: "Buku besar / neraca saldo" },
                    { value: "revenue", label: "Omzet bruto" },
                  ]}
                  defaultValue="journals"
                />
                <FormSelect
                  label="Format"
                  name="format"
                  options={[
                    { value: "xlsx", label: "Excel" },
                    { value: "csv", label: "CSV" },
                    { value: "pdf", label: "PDF" },
                  ]}
                  defaultValue="xlsx"
                />
              </div>
              <FormTextarea label="Kolom" name="columns" required rows={5} defaultValue={"Tanggal=journalDate\nNo. Jurnal=number\nKode Akun=accountCode\nDebit=debit\nKredit=credit"} />
              <FormInput label="Alasan perubahan" name="reason" required />
            </M11ActionForm>
          </SectionCard>
        ) : null}
      </div>
    </div>
  );
}
