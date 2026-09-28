import type { Metadata } from "next";
import Link from "next/link";

import { OutletActionForm } from "@/components/m6-pos/office-form";
import { SignedNumber } from "@/components/m6-pos/office-ui";
import { FormTextarea } from "@/components/m7-store/office";
import { EmptyState } from "@/components/shared/empty-state";
import { KeyValueList } from "@/components/shared/key-value-list";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m7 from "@/server/modules/m7-store";

import { signOpeningStockAction, submitCountAction } from "../../actions";

export const metadata: Metadata = { title: "Rincian opname toko" };

/**
 * Rincian opname toko: fisik vs sistem PADA SAAT dihitung (US-M7-05 KP-3), selisih & nilainya, alasan per barang,
 * pengajuan penyesuaian (Admin Keuangan ≠ penghitung) → persetujuan pemilik; stok awal cut-over → tanda tangan pemilik.
 */
export default async function StockCountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requirePermission("m7.stock_count.read");
  const { id } = await params;
  const d = await m7.getStoreStockCount(ctx, id);
  const c = d.count;
  const diffs = d.lines.filter((l) => l.differenceQty !== 0);
  const totalValue = diffs.reduce((s, l) => s + (l.differenceValue ?? 0), 0);
  const canSubmit = c.kind === "monthly_store" && c.status === "counting" && can(ctx, "m7.stock_adjustment.request") && ctx.roles.includes("finance_admin");
  const canSign = c.kind === "cutover" && c.status === "counting" && can(ctx, "m1.data_signoff.sign");
  const reasonOptions = enumOptions("stock_adjust_reason");

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={c.periodLabel} />
      <PageHeader
        title={`${label("stock_count_kind", c.kind)} ${c.periodLabel}`}
        backHref="/toko/opname"
        backLabel="Opname toko"
        description={`${d.outlet.name} · mulai ${formatTanggalJam(c.startedAt)}`}
        meta={<StatusBadge enumName="stock_count_status" value={c.status} />}
      />
      <SectionCard title="Ringkasan">
        <KeyValueList
          columns={3}
          items={[
            { label: "Dihitung oleh", value: d.countedByName },
            { label: "Diperiksa/diajukan oleh", value: d.coCounterName },
            { label: "Barang dihitung", value: d.lines.length },
            { label: "Barang selisih", value: diffs.length },
            { label: "Nilai selisih", value: <SignedNumber value={totalValue} money /> },
            { label: "Persetujuan", value: d.approval ? `${label("approval_status", d.approval.status)}${d.approval.decisionReason ? ` — ${d.approval.decisionReason}` : ""}` : "—" },
            ...(d.signoff ? [{ label: "Tanda tangan pemilik", value: d.signoff.status === "signed" ? `Ditandatangani ${d.signoff.signedAt ? formatTanggalJam(d.signoff.signedAt) : ""}` : "Menunggu" }] : []),
            { label: "Catatan", value: c.notes, full: true },
          ]}
        />
        {d.approval && d.approval.status === "submitted" ? (
          <p className="mt-3 text-sm">
            Menunggu keputusan pemilik di{" "}
            <Link href="/persetujuan" className="font-medium text-primary hover:underline">
              kotak persetujuan
            </Link>
            .
          </p>
        ) : null}
      </SectionCard>
      <SectionCard title="Lembar hitung" flush>
        {d.lines.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="lembar-opname">
              <TableHeader>
                <TableRow>
                  <TableHead>Barang</TableHead>
                  <TableHead className="text-right">Fisik</TableHead>
                  <TableHead className="text-right">Sistem saat hitung</TableHead>
                  <TableHead className="text-right">Selisih</TableHead>
                  <TableHead className="text-right">Nilai</TableHead>
                  <TableHead>Alasan</TableHead>
                  <TableHead>Dihitung</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      {l.name}
                      <span className="block text-xs text-muted-foreground">
                        {l.code} · {l.unit}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{l.physicalQty.toLocaleString("id-ID")}</TableCell>
                    <TableCell className="text-right">{c.kind === "cutover" ? "—" : l.systemQtyAtCount.toLocaleString("id-ID")}</TableCell>
                    <TableCell className="text-right">{c.kind === "cutover" ? "—" : <SignedNumber value={l.differenceQty} />}</TableCell>
                    <TableCell className="text-right">{c.kind === "cutover" ? (l.unitCost !== null ? formatRupiah(l.unitCost) : "—") : <SignedNumber value={l.differenceValue ?? 0} money />}</TableCell>
                    <TableCell className="text-sm">
                      {l.reason ? label("stock_adjust_reason", l.reason) : "—"}
                      {l.reasonNote ? <span className="block text-xs text-muted-foreground">{l.reasonNote}</span> : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatTanggalJam(l.countedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Lembar hitung masih kosong" description="Kasir mengisi hitungan dari POS toko." compact />
        )}
      </SectionCard>
      {canSubmit ? (
        <SectionCard title="Ajukan penyesuaian" description="Periksa hitungan bersama kasir, pilih alasan untuk setiap selisih, lalu ajukan ke pemilik. Penghitung tidak boleh mengajukan hitungannya sendiri.">
          <OutletActionForm action={submitCountAction.bind(null, c.id)} submitLabel={diffs.length ? "Ajukan ke pemilik" : "Selesaikan opname (tanpa selisih)"} testId="form-ajukan-opname">
            {diffs.length ? (
              <div className="grid gap-3">
                {diffs.map((l) => (
                  <fieldset key={l.id} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_12rem_1fr] sm:items-end">
                    <legend className="sr-only">{l.name}</legend>
                    <p className="text-sm font-medium">
                      {l.name} <SignedNumber value={l.differenceQty} /> ({formatRupiah(l.differenceValue ?? 0)})
                    </p>
                    <label className="grid gap-1 text-sm">
                      Alasan
                      <select name={`reason_${l.productId}`} defaultValue={l.reason ?? ""} required className="h-10 rounded-md border bg-background px-2">
                        <option value="">— pilih —</option>
                        {reasonOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-sm">
                      Keterangan
                      <input name={`note_${l.productId}`} defaultValue={l.reasonNote ?? ""} className="h-10 rounded-md border bg-background px-2" />
                    </label>
                  </fieldset>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Tidak ada selisih — opname langsung selesai.</p>
            )}
            <FormTextarea label="Catatan" name="notes" />
          </OutletActionForm>
        </SectionCard>
      ) : null}
      {canSign ? (
        <SectionCard title="Tanda tangan stok awal" description="Setelah ditandatangani, saldo di atas menjadi stok awal kartu stok dengan harga beli terakhir sebagai harga pokok awal.">
          <OutletActionForm action={signOpeningStockAction.bind(null, c.id)} submitLabel="Tandatangani stok awal" testId="form-ttd-stok-awal">
            <FormTextarea label="Catatan" name="note" />
          </OutletActionForm>
        </SectionCard>
      ) : null}
    </div>
  );
}
