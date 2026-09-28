import type { Metadata } from "next";
import Link from "next/link";

import { M11ActionForm } from "@/components/m11-accounting/action-form";
import { Amount, FormInput, FormSelect, JournalLink } from "@/components/m11-accounting/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { KeyValueList } from "@/components/shared/key-value-list";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal } from "@/lib/time";
import { ctxBusinessDate } from "@/server/core/context";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m11 from "@/server/modules/m11-accounting";

import { disposeAssetAction, updateEstimateAction } from "../../actions";

export const metadata: Metadata = { title: "Rincian aset" };

/** Rincian aset tetap + riwayat penyusutan per periode, ubah umur/nilai (akuntan) & pelepasan (US-M11-05 KP-2/KP-4). */
export default async function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requirePermission("m11.fixed_asset.read");
  const { id } = await params;
  const [d, options] = await Promise.all([m11.assetDetail(ctx, id), m11.formOptions(ctx)]);
  const a = d.asset;
  const active = a.status === "active";
  const cashAccounts = options.accounts.filter((x) => x.type === "asset");

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={a.code} />
      <PageHeader
        title={`${a.code} ${a.name}`}
        backHref="/akuntansi/aset"
        backLabel="Aset tetap"
        meta={
          <span className="flex flex-wrap gap-1">
            <ToneBadge tone={active ? "success" : "muted"}>{label("asset_status", a.status)}</ToneBadge>
            {!d.signed ? <ToneBadge tone="warning">Belum ditandatangani pemilik</ToneBadge> : null}
          </span>
        }
      />
      <SectionCard title="Data aset">
        <KeyValueList
          columns={3}
          items={[
            { label: "Kategori", value: label("asset_category", a.category) },
            { label: "Pusat laba pemakai", value: label("profit_center", a.profitCenter), hint: d.refs.outlet ?? d.refs.truck ?? d.refs.waterSource ?? undefined },
            { label: "Tanggal perolehan", value: formatTanggal(a.acquisitionDate) },
            { label: "Nilai perolehan", value: formatRupiah(a.acquisitionCost) },
            { label: "Nilai sisa", value: formatRupiah(a.residualValue) },
            { label: "Umur & metode", value: `${a.usefulLifeMonths} bulan · ${label("depreciation_method", a.depreciationMethod)}` },
            { label: "Akumulasi penyusutan", value: formatRupiah(d.accumulated), hint: d.extras?.openingAccumulated ? `Termasuk saldo cut-over ${formatRupiah(d.extras.openingAccumulated)}` : undefined },
            { label: "Nilai buku", value: formatRupiah(active ? d.bookValue : 0) },
            { label: "Asal", value: a.source === "import" ? "Impor daftar aset (akuntan/notaris)" : a.source === "manual_journal" ? "Jurnal manual" : "Pembelian (nota)" },
            ...(a.status === "disposed"
              ? [
                  { label: "Dilepas", value: a.disposedAt ? formatTanggal(a.disposedAt) : "—", hint: `Hasil ${formatRupiah(a.disposalProceeds ?? 0)}` },
                  { label: "Laba/rugi pelepasan", value: formatRupiah(a.disposalGainLoss ?? 0) },
                ]
              : []),
          ]}
        />
      </SectionCard>

      <SectionCard title="Riwayat penyusutan" flush>
        {d.entries.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="riwayat-penyusutan">
              <TableHeader>
                <TableRow>
                  <TableHead>Periode</TableHead>
                  <TableHead>Jurnal</TableHead>
                  <TableHead className="text-right">Penyusutan</TableHead>
                  <TableHead className="text-right">Akumulasi</TableHead>
                  <TableHead className="text-right">Nilai buku</TableHead>
                  <TableHead>Jenis</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.entries.map(({ e, period, journalNumber }) => (
                  <TableRow key={e.id}>
                    <TableCell>{period}</TableCell>
                    <TableCell>{e.journalId && journalNumber ? <JournalLink id={e.journalId} number={journalNumber} /> : "—"}</TableCell>
                    <TableCell className="text-right">
                      <Amount value={e.amount} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={e.accumulatedAfter} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Amount value={e.bookValueAfter} />
                    </TableCell>
                    <TableCell>{e.isAdjustment ? <ToneBadge tone="warning">Penyesuaian</ToneBadge> : "Bulanan"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada penyusutan" compact />
        )}
      </SectionCard>

      {active && can(ctx, "m11.fixed_asset.update") ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <SectionCard title="Ubah umur / nilai (keputusan akuntan)" description="Penyusutan dihitung ulang; selisih dibukukan sebagai jurnal penyesuaian berjejak.">
            <M11ActionForm action={updateEstimateAction} submitLabel="Simpan & hitung ulang" testId="ubah-umur">
              <input type="hidden" name="assetId" value={a.id} />
              <div className="grid gap-3 sm:grid-cols-3">
                <FormInput label="Umur (bulan)" name="usefulLifeMonths" type="number" min="1" defaultValue={a.usefulLifeMonths} />
                <FormInput label="Nilai sisa (Rp)" name="residualValue" inputMode="numeric" defaultValue={a.residualValue} />
                {a.source === "import" ? <FormInput label="Nilai perolehan (Rp)" name="acquisitionCost" inputMode="numeric" defaultValue={a.acquisitionCost} /> : null}
              </div>
              <FormInput label="Alasan (keputusan akuntan)" name="reason" required />
            </M11ActionForm>
          </SectionCard>
          {can(ctx, "m11.fixed_asset.dispose") ? (
            <SectionCard title="Lepas / jual aset" description="Nilai perolehan & akumulasi dikeluarkan; laba/rugi pelepasan dihitung otomatis.">
              <M11ActionForm action={disposeAssetAction} submitLabel="Lepas aset" variant="destructive" testId="lepas-aset">
                <input type="hidden" name="assetId" value={a.id} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormInput label="Tanggal" name="date" type="date" required defaultValue={ctxBusinessDate(ctx)} />
                  <FormInput label="Hasil penjualan (Rp)" name="proceeds" inputMode="numeric" defaultValue={0} />
                  <FormSelect label="Akun penerimaan" name="proceedsAccountId" options={cashAccounts.map((x) => ({ value: x.id, label: `${x.code} ${x.name}` }))} emptyLabel="—" className="sm:col-span-2" />
                </div>
                <FormInput label="Alasan" name="reason" required />
              </M11ActionForm>
            </SectionCard>
          ) : null}
        </div>
      ) : null}
      <Link href="/akuntansi/aset" className="text-sm text-primary hover:underline">
        Kembali ke daftar aset
      </Link>
    </div>
  );
}
