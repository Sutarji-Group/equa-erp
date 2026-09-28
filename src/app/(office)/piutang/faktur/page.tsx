import type { Metadata } from "next";
import Link from "next/link";

import { BucketBadge, DisputeBadge, FilterCheckbox, FilterDate, FilterForm, FilterSelect, FilterText, InvoiceStatusBadge, PiiExportForm } from "@/components/m5-receivables/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, isEnumValue, label, type InvoiceKind, type InvoiceStatus } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m5 from "@/server/modules/m5-receivables";

export const metadata: Metadata = { title: "Faktur piutang" };

type Search = { q?: string; status?: string; jenis?: string; pelanggan?: string; lewat?: string; sengketa?: string; transfer?: string; dari?: string; sampai?: string };

/**
 * Daftar faktur piutang (US-M5-01): faktur kirim per rit, penjualan tempo toko, kurang bayar H+0, faktur bulanan,
 * saldo awal, piutang sementara transfer. Faktur tidak dapat dihapus — koreksi lewat nota kredit (KP-6).
 */
export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { ctx } = await requirePermission("m5.invoice.read");
  const sp = await searchParams;
  const status: InvoiceStatus | "unpaid" | null = sp.status === "unpaid" ? "unpaid" : sp.status && isEnumValue("invoice_status", sp.status) ? (sp.status as InvoiceStatus) : null;
  const kind = sp.jenis && isEnumValue("invoice_kind", sp.jenis) ? (sp.jenis as InvoiceKind) : null;
  const from = sp.dari && isBusinessDate(sp.dari) ? sp.dari : null;
  const to = sp.sampai && isBusinessDate(sp.sampai) ? sp.sampai : null;
  const [rows, customers] = await Promise.all([
    m5.listInvoices(ctx, {
      q: sp.q ?? null,
      status,
      kind,
      customerId: sp.pelanggan || null,
      overdue: sp.lewat === "1",
      disputed: sp.sengketa === "1",
      pendingTransfer: sp.transfer === "1",
      from,
      to,
    }),
    m5.customerOptions(ctx),
  ]);
  const outstanding = rows.reduce((s, r) => s + r.outstandingAmount, 0);
  const canExport = can(ctx, "m5.invoice.export");
  const canCard = can(ctx, "m5.aging.read");

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Faktur"
        description="Faktur terbentuk otomatis: rit tempo Selesai (per rit), penjualan tempo toko (per transaksi), kurang bayar lapangan (jatuh tempo H+0), dan faktur bulanan. Tanpa PPN."
      />
      <FilterForm action="/piutang/faktur" testId="filter-faktur">
        <FilterText name="q" value={sp.q} label="Cari" placeholder="Nomor faktur / pelanggan" />
        <FilterSelect
          name="status"
          value={status}
          label="Status"
          emptyLabel="Semua status"
          options={[{ value: "unpaid", label: "Belum lunas" }, ...enumOptions("invoice_status")]}
        />
        <FilterSelect name="jenis" value={kind} label="Jenis" emptyLabel="Semua jenis" options={enumOptions("invoice_kind")} />
        <FilterSelect name="pelanggan" value={sp.pelanggan} label="Pelanggan" emptyLabel="Semua pelanggan" options={customers.map((c) => ({ value: c.id, label: c.code ? `${c.name} (${c.code})` : c.name }))} />
        <FilterDate name="dari" value={from} label="Tanggal dari" />
        <FilterDate name="sampai" value={to} label="Sampai" />
        <FilterCheckbox name="lewat" checked={sp.lewat === "1"} label="Lewat tempo" />
        <FilterCheckbox name="sengketa" checked={sp.sengketa === "1"} label="Bersengketa" />
        <FilterCheckbox name="transfer" checked={sp.transfer === "1"} label="Transfer belum diterima" />
      </FilterForm>

      <SectionCard
        title={`${rows.length} faktur · sisa ${formatRupiah(outstanding)}`}
        actions={
          canExport ? (
            <PiiExportForm
              reportKey="m5.invoices"
              filters={{ status: status ?? undefined, kind: kind ?? undefined, customerId: sp.pelanggan, from: from ?? undefined, to: to ?? undefined, overdue: sp.lewat === "1" ? "1" : undefined }}
              testId="ekspor-faktur"
            />
          ) : null
        }
        flush
      >
        {rows.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="daftar-faktur">
              <TableHeader>
                <TableRow>
                  <TableHead>Nomor</TableHead>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Jatuh tempo</TableHead>
                  <TableHead className="text-right">Nilai</TableHead>
                  <TableHead className="text-right">Sisa</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Umur</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className="align-top">
                    <TableCell>
                      <Link href={`/piutang/faktur/${r.id}`} className="font-medium text-primary hover:underline">
                        {r.number}
                      </Link>
                      <span className="block text-xs text-muted-foreground">{label("invoice_kind", r.kind)}</span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {canCard ? (
                        <Link href={`/piutang/pelanggan/${r.customerId}`} className="hover:underline">
                          {r.customerName}
                        </Link>
                      ) : (
                        r.customerName
                      )}
                      {r.customerCode ? <span className="block text-xs text-muted-foreground">{r.customerCode}</span> : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatTanggal(r.issueDate, { weekday: false })}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatTanggal(r.dueDate, { weekday: false })}</TableCell>
                    <TableCell className="text-right">{formatRupiah(r.amount)}</TableCell>
                    <TableCell className="text-right font-medium">{formatRupiah(r.outstandingAmount)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <InvoiceStatusBadge status={r.status} />
                        <DisputeBadge status={r.disputeStatus} />
                        {r.pendingTransferId ? <ToneBadge tone="danger">Transfer belum diterima</ToneBadge> : null}
                        {r.isOpeningBalance ? <ToneBadge tone="muted">Saldo awal</ToneBadge> : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      {r.outstandingAmount > 0 ? (
                        <>
                          <BucketBadge bucket={r.bucket} />
                          {r.daysPastDue > 0 ? <span className="block text-xs text-destructive">{r.daysPastDue} hari lewat</span> : null}
                        </>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada faktur untuk saringan ini" description="Ubah saringan atau kosongkan pencarian." compact />
        )}
      </SectionCard>
    </div>
  );
}
