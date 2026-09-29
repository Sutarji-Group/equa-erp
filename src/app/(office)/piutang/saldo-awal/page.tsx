import type { Metadata } from "next";
import Link from "next/link";

import { M5ActionForm } from "@/components/m5-receivables/action-form";
import { FormInput, FormSelect, FormTextarea, InvoiceStatusBadge, hrefWith } from "@/components/m5-receivables/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumValues, label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m5 from "@/server/modules/m5-receivables";

import { createOpeningAction, requestOpeningAdjustmentAction, signOpeningAction } from "../actions";

export const metadata: Metadata = { title: "Saldo awal piutang" };

/** Pilihan lini asal faktur saldo awal (B-37) — bawaan air truk. */
const LINE_OPTIONS = enumValues("receivable_line").map((v) => ({ value: v, label: label("receivable_line", v) }));

/**
 * Saldo awal piutang saat cut-over (US-M5-07): faktur saldo awal per pelanggan (tanggal, keterangan, jumlah, jatuh
 * tempo, bukti konfirmasi pelanggan) bertanda "saldo awal" — tanpa jurnal penjualan (neraca awal M11); total
 * ditandatangani pemilik sebelum dipakai (NFR-34); sesudahnya hanya koreksi berjejak dengan persetujuan pemilik.
 */
export default async function OpeningBalancesPage() {
  const { ctx } = await requirePermission("m5.opening_balance.read");
  const [b, customers] = await Promise.all([m5.openingBoard(ctx), m5.customerOptions(ctx)]);
  const today = ctxBusinessDate(ctx);
  const signed = b.signoff?.status === "signed";
  const canCreate = can(ctx, "m5.opening_balance.create");
  const canSign = can(ctx, "m5.opening_balance.sign");
  const openInvoices = b.summary.invoices.filter((i) => i.outstandingAmount > 0);
  const maxDate = b.cutover ?? today;

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Saldo awal piutang"
        description={`Piutang berjalan per faktur yang sudah dikonfirmasi pelanggan pada tanggal cut-over${b.cutover ? ` (${formatTanggal(b.cutover, { weekday: false })})` : ""}. Tidak menghasilkan jurnal penjualan — masuk neraca awal akuntansi.`}
        actions={<ExportButtons excelHref={hrefWith("/api/export/m5.opening_balances", { format: "xlsx" })} pdfHref={hrefWith("/api/export/m5.opening_balances", { format: "pdf" })} disabled={!b.summary.invoices.length} />}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Total saldo awal" value={<span data-testid="total-saldo-awal"><MoneyText value={b.summary.total} /></span>} hint={`${b.summary.count} faktur · ${b.summary.customers.length} pelanggan`} />
        <KpiTile
          label="Tanda tangan pemilik (NFR-34)"
          value={b.signoff ? label("signoff_status", b.signoff.status) : "Belum ada"}
          hint={signed && b.signoff?.signedAt ? `Ditandatangani ${formatTanggalJam(b.signoff.signedAt)}` : "Faktur saldo awal ikut umur, pengingat, dan penahanan setelah ditandatangani"}
          tone={signed ? "success" : "warning"}
        />
        <KpiTile label="Koreksi setelah tanda tangan" value={String(b.adjustments)} hint="Lewat persetujuan pemilik (PAR-62)" />
      </div>

      {!signed && canSign && b.signoff ? (
        <SectionCard title="Tanda tangani total saldo awal piutang" description="Periksa total per pelanggan di bawah. Setelah ditandatangani, perubahan hanya lewat koreksi berjejak.">
          <M5ActionForm action={signOpeningAction} submitLabel={`Tanda tangani ${formatRupiah(b.summary.total)}`} testId="form-tanda-tangan-saldo-awal">
            <input type="hidden" name="expectedTotal" value={b.summary.total} />
            <FormTextarea label="Catatan (opsional)" name="note" />
          </M5ActionForm>
        </SectionCard>
      ) : null}

      {canCreate ? (
        !signed ? (
          <SectionCard title="Input faktur saldo awal" description="Satu baris per faktur yang dikonfirmasi pelanggan. Bukti konfirmasi wajib dilampirkan.">
            <M5ActionForm action={createOpeningAction} submitLabel="Simpan saldo awal" testId="form-saldo-awal" className="max-w-3xl">
              <FormSelect label="Pelanggan" name="customerId" required emptyLabel="— pilih pelanggan —" options={customers.map((c) => ({ value: c.id, label: c.code ? `${c.name} (${c.code})` : c.name }))} />
              <FormSelect label="Lini piutang" name="line" required defaultValue="truck" options={LINE_OPTIONS} hint="Lini asal nota kertas — dipakai umur piutang per lini." />
              <div className="grid gap-3 sm:grid-cols-3">
                <FormInput label="Tanggal faktur" name="issueDate" type="date" max={maxDate} required />
                <FormInput label="Jatuh tempo" name="dueDate" type="date" required />
                <FormInput label="Jumlah (Rp)" name="amount" inputMode="numeric" required />
              </div>
              <FormInput label="Keterangan" name="description" required placeholder="Mis. nota kertas no. 0457, rit Juli" />
              <FormInput label="Bukti konfirmasi pelanggan" name="confirmation" type="file" accept="application/pdf,image/jpeg,image/png" required hint="Surat/foto konfirmasi saldo dari pelanggan (maks. 4 MB; foto dikompres otomatis)." />
            </M5ActionForm>
          </SectionCard>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <SectionCard title="Koreksi: tambah faktur saldo awal" description="Diajukan ke pemilik; berlaku setelah disetujui (PAR-62).">
              <M5ActionForm action={requestOpeningAdjustmentAction} submitLabel="Ajukan koreksi" testId="form-koreksi-tambah">
                <input type="hidden" name="action" value="add" />
                <FormSelect label="Pelanggan" name="customerId" required emptyLabel="— pilih pelanggan —" options={customers.map((c) => ({ value: c.id, label: c.code ? `${c.name} (${c.code})` : c.name }))} />
                <FormSelect label="Lini piutang" name="line" required defaultValue="truck" options={LINE_OPTIONS} hint="Lini asal nota kertas — dipakai umur piutang per lini." />
                <div className="grid gap-3 sm:grid-cols-3">
                  <FormInput label="Tanggal faktur" name="issueDate" type="date" max={maxDate} required />
                  <FormInput label="Jatuh tempo" name="dueDate" type="date" required />
                  <FormInput label="Jumlah (Rp)" name="amount" inputMode="numeric" required />
                </div>
                <FormInput label="Keterangan" name="description" required />
                <FormInput label="Bukti konfirmasi pelanggan" name="confirmation" type="file" accept="application/pdf,image/jpeg,image/png" required />
                <FormTextarea label="Alasan koreksi" name="reason" required />
              </M5ActionForm>
            </SectionCard>
            <SectionCard title="Koreksi: kurangi faktur saldo awal" description="Nota kredit atas faktur saldo awal setelah disetujui pemilik.">
              {openInvoices.length ? (
                <M5ActionForm action={requestOpeningAdjustmentAction} submitLabel="Ajukan koreksi" testId="form-koreksi-kurang">
                  <input type="hidden" name="action" value="reduce" />
                  <FormSelect label="Faktur saldo awal" name="invoiceId" required emptyLabel="— pilih faktur —" options={openInvoices.map((i) => ({ value: i.id, label: `${i.number} · ${i.customerName} (sisa ${formatRupiah(i.outstandingAmount)})` }))} />
                  <FormInput label="Jumlah dikurangi (Rp)" name="amount" inputMode="numeric" required />
                  <FormTextarea label="Alasan koreksi" name="reason" required />
                </M5ActionForm>
              ) : (
                <EmptyState title="Tidak ada faktur saldo awal bersisa" compact />
              )}
            </SectionCard>
          </div>
        )
      ) : null}

      <SectionCard title="Per pelanggan" flush>
        {b.summary.customers.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="saldo-awal-pelanggan">
              <TableHeader>
                <TableRow>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead className="text-right">Faktur</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {b.summary.customers.map((c) => (
                  <TableRow key={c.customerId}>
                    <TableCell className="text-sm">
                      {c.name} {c.code ? <span className="text-xs text-muted-foreground">({c.code})</span> : null}
                    </TableCell>
                    <TableCell className="text-right">{c.count}</TableCell>
                    <TableCell className="text-right font-medium">{formatRupiah(c.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada saldo awal piutang" description="Admin Keuangan menginput faktur saldo awal per pelanggan sebelum go-live." compact />
        )}
      </SectionCard>

      <SectionCard title="Faktur saldo awal" flush>
        {b.summary.invoices.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="faktur-saldo-awal">
              <TableHeader>
                <TableRow>
                  <TableHead>Nomor</TableHead>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead>Lini</TableHead>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Jatuh tempo</TableHead>
                  <TableHead>Keterangan</TableHead>
                  <TableHead className="text-right">Nilai</TableHead>
                  <TableHead className="text-right">Sisa</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {b.summary.invoices.map((i) => (
                  <TableRow key={i.id} className="align-top">
                    <TableCell>
                      <Link href={`/piutang/faktur/${i.id}`} className="font-medium text-primary hover:underline">
                        {i.number}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">{i.customerName}</TableCell>
                    <TableCell className="text-sm">{label("receivable_line", i.openingLine ?? "truck")}</TableCell>
                    <TableCell>{formatTanggal(i.issueDate, { weekday: false })}</TableCell>
                    <TableCell>{formatTanggal(i.dueDate, { weekday: false })}</TableCell>
                    <TableCell className="min-w-48 text-sm">{i.description}</TableCell>
                    <TableCell className="text-right">{formatRupiah(i.amount)}</TableCell>
                    <TableCell className="text-right">{formatRupiah(i.outstandingAmount)}</TableCell>
                    <TableCell>
                      <InvoiceStatusBadge status={i.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada faktur saldo awal" compact />
        )}
      </SectionCard>

      {b.history.length ? (
        <SectionCard title="Riwayat ringkasan & tanda tangan" flush>
          <ul className="divide-y text-sm">
            {b.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-6 py-2">
                <span>
                  {formatTanggalJam(h.createdAt)} · total {formatRupiah(Number((h.summary as { total?: number }).total ?? 0))}
                </span>
                <StatusBadge enumName="signoff_status" value={h.status} />
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
