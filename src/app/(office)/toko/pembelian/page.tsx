import type { Metadata } from "next";
import Link from "next/link";

import { OutletActionForm } from "@/components/m6-pos/office-form";
import { DateInput, FormInput, FormSelect, FormTextarea, hrefWith, SelectInput, StoreFilter } from "@/components/m7-store/office";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, formatTanggal, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m7 from "@/server/modules/m7-store";

import { openingPayableAction } from "../actions";

export const metadata: Metadata = { title: "Nota pembelian toko" };

/**
 * Nota pembelian toko (US-M7-02, US-M7-08 KP-3): penerimaan barang dicatat kasir dari POS (foto nota wajib; nota
 * pengganti menunggu diterima Admin Keuangan), koreksi/retur lewat rincian nota, saldo awal utang saat cut-over.
 */
export default async function PurchasesPage({ searchParams }: { searchParams: Promise<{ toko?: string; pemasok?: string; status?: string; dari?: string; sampai?: string }> }) {
  const { ctx } = await requirePermission("m7.purchase_receipt.read");
  const sp = await searchParams;
  const today = ctxBusinessDate(ctx);
  const from = sp.dari && isBusinessDate(sp.dari) ? sp.dari : addDays(today, -60);
  const to = sp.sampai && isBusinessDate(sp.sampai) ? sp.sampai : today;
  const stores = await m7.listStoreOutlets(ctx);
  const storeId = stores.some((s) => s.id === sp.toko) ? sp.toko! : (stores[0]?.id ?? null);
  const status = sp.status && ["pending_acceptance", "received", "reversed"].includes(sp.status) ? sp.status : null;
  const rows = await m7.listPurchaseReceipts(ctx, { outletId: storeId, supplierId: sp.pemasok ?? null, status, from: status === "pending_acceptance" ? null : from, to });
  const suppliers = await m7.listSuppliers(ctx, { includeInactive: true });
  const canOpening = can(ctx, "m7.opening_payable.create");
  const total = rows.filter((r) => !r.reversalOfId && r.status === "received").reduce((s, r) => s + r.totalAmount, 0);
  const exportQuery = { outletId: storeId, supplierId: sp.pemasok, from, to };

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Nota pembelian toko"
        description="Penerimaan barang dari pemasok. Kasir mencatat di POS toko dengan foto nota; stok bertambah saat disimpan."
        actions={<ExportButtons excelHref={hrefWith("/api/export/m7.purchases", { format: "xlsx", ...exportQuery })} pdfHref={hrefWith("/api/export/m7.purchases", { format: "pdf", ...exportQuery })} disabled={!rows.length} />}
      />
      <StoreFilter action="/toko/pembelian" stores={stores} storeId={storeId}>
        <SelectInput name="pemasok" value={sp.pemasok} label="Pemasok" emptyLabel="Semua pemasok" options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
        <SelectInput name="status" value={status} label="Status" emptyLabel="Semua status" options={enumOptions("purchase_receipt_status")} />
        <DateInput name="dari" value={from} label="Dari" />
        <DateInput name="sampai" value={to} label="Sampai" />
      </StoreFilter>
      <SectionCard title={`Nota ${formatTanggal(from)} – ${formatTanggal(to)}`} description={`Total nota diterima: ${formatRupiah(total)}`} flush>
        {rows.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-nota">
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Nomor</TableHead>
                  <TableHead>Pemasok · nota</TableHead>
                  <TableHead className="text-right">Baris</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Sisa utang</TableHead>
                  <TableHead>Jatuh tempo</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">{formatTanggal(r.businessDate)}</TableCell>
                    <TableCell>
                      <Link href={`/toko/pembelian/${r.id}`} className="font-medium text-primary hover:underline">
                        {r.number ?? r.localNumber ?? "—"}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.supplierName}
                      <span className="block text-xs text-muted-foreground">
                        {r.isSubstituteNote ? "Nota pengganti" : (r.supplierNoteNumber ?? "—")}
                        {r.supplierNoteDate ? ` · ${formatTanggal(r.supplierNoteDate)}` : ""}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{r.lineCount}</TableCell>
                    <TableCell className={`text-right ${r.totalAmount < 0 ? "text-destructive" : ""}`}>{formatRupiah(r.totalAmount)}</TableCell>
                    <TableCell className="text-right">{r.outstanding ? formatRupiah(r.outstanding) : "—"}</TableCell>
                    <TableCell>{r.dueDate && !r.reversalOfId ? formatTanggal(r.dueDate) : "—"}</TableCell>
                    <TableCell>
                      {r.reversalOfId ? <ToneBadge tone="muted">{r.totalAmount < 0 ? "Retur/pembalik" : "Koreksi"}</ToneBadge> : <StatusBadge enumName="purchase_receipt_status" value={r.status} />}
                      {r.isOpeningPayable ? <span className="block text-xs text-muted-foreground">Saldo awal</span> : null}
                      {!r.reversalOfId && r.status === "received" ? <StatusBadge enumName="payable_status" value={r.paymentStatus} dot={false} className="mt-1" /> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada nota pada filter ini" compact />
        )}
      </SectionCard>
      {canOpening ? (
        <SectionCard title="Saldo awal utang pemasok (cut-over)" description="Nota yang belum lunas saat mulai memakai sistem. Masuk daftar utang & umur utang seperti nota biasa (US-M7-08 KP-3).">
          <OutletActionForm action={openingPayableAction} submitLabel="Catat saldo awal" testId="form-saldo-awal-utang" className="max-w-2xl">
            {storeId ? <input type="hidden" name="outletId" value={storeId} /> : null}
            <FormSelect label="Pemasok" name="supplierId" required emptyLabel="— pilih pemasok —" options={suppliers.filter((s) => s.status === "active").map((s) => ({ value: s.id, label: s.name }))} />
            <div className="grid gap-3 sm:grid-cols-2">
              <FormInput label="Nomor nota pemasok" name="supplierNoteNumber" required />
              <FormInput label="Sisa utang (Rp)" name="amount" inputMode="numeric" required />
              <FormInput label="Tanggal nota" name="supplierNoteDate" type="date" required max={today} />
              <FormInput label="Jatuh tempo" name="dueDate" type="date" hint="Kosong = tanggal nota + tempo pemasok (PAR-67)." />
            </div>
            <FormInput label="Foto nota (opsional)" name="photo" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" />
            <FormTextarea label="Catatan" name="notes" />
          </OutletActionForm>
        </SectionCard>
      ) : null}
    </div>
  );
}
