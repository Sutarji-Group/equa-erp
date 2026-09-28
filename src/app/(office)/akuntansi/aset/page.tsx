import type { Metadata } from "next";
import Link from "next/link";

import { M11ActionForm } from "@/components/m11-accounting/action-form";
import { M11ActionButton } from "@/components/m11-accounting/action-buttons";
import { Amount, FilterForm, FilterSelect, FormInput, FormSelect, PROFIT_CENTER_OPTIONS, exportHref, periodLabel, periodOptions } from "@/components/m11-accounting/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, monthOf } from "@/lib/time";
import { ctxBusinessDate } from "@/server/core/context";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m11 from "@/server/modules/m11-accounting";

import { createAssetAction, importAssetsAction, runDepreciationAction, signAssetsAction } from "../actions";

export const metadata: Metadata = { title: "Aset tetap" };

type Search = Promise<{ periode?: string }>;

/**
 * Aset tetap & penyusutan (US-M11-05): daftar aset & akumulasi per periode (akuntan & pajak), impor template akuntan/
 * notaris dengan tanda tangan pemilik (NFR-34), tambah aset dari nota/jurnal, penyusutan otomatis per pusat laba.
 * Aset pribadi yang disewakan ke PT (K15) tidak masuk daftar — sewanya jurnal berulang.
 */
export default async function AssetsPage({ searchParams }: { searchParams: Search }) {
  const { ctx } = await requirePermission("m11.fixed_asset.read");
  const sp = await searchParams;
  const current = monthOf(ctxBusinessDate(ctx));
  const period = sp.periode || current;
  const [reg, options, periods] = await Promise.all([m11.assetRegister(ctx, { period }), m11.formOptions(ctx), m11.listPeriods(ctx)]);
  const periodRow = periods.find((p) => p.period === period && p.id);
  const canCreate = can(ctx, "m11.fixed_asset.create");
  const canImport = can(ctx, "m11.fixed_asset.import");
  const canSign = can(ctx, "m11.fixed_asset.sign");

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Aset tetap"
        description="Nilai & umur ditetapkan akuntan dan notaris (K15, BR-34); penyusutan bulanan diposting otomatis (hari pertama tutup periode) per pusat laba pemakai."
        actions={
          <div className="flex flex-wrap gap-2">
            {periodRow?.id && can(ctx, "m11.fixed_asset.update") && (periodRow.status === "open" || periodRow.status === "reopened") ? (
              <M11ActionButton label={`Posting penyusutan ${periodLabel(period)}`} action={runDepreciationAction.bind(null, periodRow.id)} testId="posting-penyusutan" />
            ) : null}
            <ExportButtons excelHref={exportHref("m11.assets", "xlsx", { period })} pdfHref={exportHref("m11.assets", "pdf", { period })} />
          </div>
        }
      />

      {reg.pendingSignoff ? (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Daftar aset impor menunggu tanda tangan pemilik: {reg.pendingSignoff.title}. Aset baru disusutkan setelah ditandatangani (NFR-34).
            </span>
            {canSign ? <M11ActionButton label="Tandatangani daftar aset" variant="default" action={signAssetsAction.bind(null, reg.pendingSignoff.id)} testId="tandatangani-aset" /> : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Nilai perolehan" value={<MoneyText value={reg.totals.cost} />} hint={`${reg.rows.length} aset`} />
        <KpiTile label="Akumulasi penyusutan" value={<MoneyText value={reg.totals.accumulated} />} hint={`s.d. ${periodLabel(period)}`} />
        <KpiTile label="Nilai buku" value={<MoneyText value={reg.totals.bookValue} />} />
        <KpiTile label={`Penyusutan ${periodLabel(period)}`} value={<MoneyText value={reg.totals.depreciation} />} />
      </div>

      <SectionCard
        title={`Daftar aset & akumulasi — ${periodLabel(period)}`}
        flush
        actions={
          <FilterForm action="/akuntansi/aset">
            <FilterSelect name="periode" value={period} label="Periode" options={periodOptions(current, 24)} />
          </FilterForm>
        }
      >
        {reg.rows.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-aset">
              <TableHeader>
                <TableRow>
                  <TableHead>Kode</TableHead>
                  <TableHead>Nama</TableHead>
                  <TableHead>Kategori</TableHead>
                  <TableHead>Pusat laba</TableHead>
                  <TableHead>Perolehan</TableHead>
                  <TableHead className="text-right">Nilai</TableHead>
                  <TableHead className="text-right">Akumulasi</TableHead>
                  <TableHead className="text-right">Nilai buku</TableHead>
                  <TableHead className="text-right">Penyusutan periode</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reg.rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link href={`/akuntansi/aset/${r.id}`} className="font-mono text-primary hover:underline">
                        {r.code}
                      </Link>
                    </TableCell>
                    <TableCell>{r.name}</TableCell>
                    <TableCell>{label("asset_category", r.category)}</TableCell>
                    <TableCell>{r.profitCenter}</TableCell>
                    <TableCell className="text-sm">
                      {formatTanggal(r.acquisitionDate, { weekday: false })}
                      <span className="block text-xs text-muted-foreground">
                        {r.usefulLifeMonths} bln · {label("depreciation_method", r.method)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={r.cost} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={r.accumulated} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={r.bookValue} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={r.depreciationThisPeriod} />
                    </TableCell>
                    <TableCell className="space-x-1">
                      <ToneBadge tone={r.status === "active" ? "success" : "muted"}>{label("asset_status", r.status)}</ToneBadge>
                      {!r.signed ? <ToneBadge tone="warning">Belum ditandatangani</ToneBadge> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={5}>Jumlah</TableCell>
                  <TableCell className="text-right">{formatRupiah(reg.totals.cost)}</TableCell>
                  <TableCell className="text-right">{formatRupiah(reg.totals.accumulated)}</TableCell>
                  <TableCell className="text-right">{formatRupiah(reg.totals.bookValue)}</TableCell>
                  <TableCell className="text-right">{formatRupiah(reg.totals.depreciation)}</TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada aset tetap" description="Impor daftar aset dari akuntan & notaris, atau tambahkan dari nota pembelian." compact />
        )}
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        {canImport ? (
          <SectionCard title="Impor daftar aset (template)" description="Kolom: Kode, Nama, Kategori, Tanggal perolehan, Nilai perolehan, Nilai sisa, Umur (bulan), Pusat laba, Kode outlet, Kode truk, Akumulasi penyusutan.">
            <M11ActionForm
              action={importAssetsAction}
              submitLabel="Pratinjau"
              variant="outline"
              resetOnSuccess={false}
              testId="impor-aset"
              extraButtons={
                <button type="submit" name="mode" value="commit" className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
                  Simpan impor
                </button>
              }
            >
              <FormInput label="Berkas (CSV/Excel)" name="file" type="file" accept=".csv,.xlsx" required />
            </M11ActionForm>
          </SectionCard>
        ) : null}
        {canCreate ? (
          <SectionCard title="Tambah aset (nota / jurnal manual)" description="Aset milik pribadi yang disewakan ke PT tidak dicatat di sini (K15).">
            <M11ActionForm action={createAssetAction} submitLabel="Tambah aset" testId="tambah-aset">
              <div className="grid gap-3 sm:grid-cols-2">
                <FormInput label="Kode aset" name="code" required />
                <FormInput label="Nama" name="name" required />
                <FormSelect label="Kategori" name="category" options={enumOptions("asset_category")} required emptyLabel="Pilih" />
                <FormInput label="Tanggal perolehan" name="acquisitionDate" type="date" required />
                <FormInput label="Nilai perolehan (Rp)" name="acquisitionCost" inputMode="numeric" required />
                <FormInput label="Nilai sisa (Rp)" name="residualValue" inputMode="numeric" defaultValue={0} />
                <FormInput label="Umur ekonomis (bulan)" name="usefulLifeMonths" type="number" min="1" hint="Ditetapkan akuntan (PAR-63)." />
                <FormSelect label="Pusat laba (bawaan menurut kategori)" name="profitCenter" options={PROFIT_CENTER_OPTIONS} emptyLabel="Bawaan" />
                <FormSelect label="Outlet (peralatan depot)" name="outletId" options={options.outlets.map((o) => ({ value: o.id, label: o.name }))} emptyLabel="—" />
                <FormSelect label="Truk" name="truckId" options={options.trucks.map((t) => ({ value: t.id, label: t.code }))} emptyLabel="—" />
                <FormSelect label="Sumber air" name="waterSourceId" options={options.waterSources.map((w) => ({ value: w.id, label: w.name }))} emptyLabel="—" />
                <FormSelect
                  label="Kepemilikan"
                  name="ownership"
                  options={[
                    { value: "company", label: "Milik PT" },
                    { value: "leased", label: "Milik pribadi disewakan ke PT (K15)" },
                  ]}
                  defaultValue="company"
                />
                <FormInput label="ID jurnal perolehan (opsional)" name="acquisitionJournalId" className="sm:col-span-2" />
              </div>
            </M11ActionForm>
          </SectionCard>
        ) : null}
      </div>
    </div>
  );
}
