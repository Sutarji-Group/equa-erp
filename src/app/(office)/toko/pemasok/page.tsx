import type { Metadata } from "next";
import Link from "next/link";

import { OutletActionForm } from "@/components/m6-pos/office-form";
import { FormInput, FormTextarea, hrefWith } from "@/components/m7-store/office";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRupiah } from "@/lib/money";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m7 from "@/server/modules/m7-store";

import { setSupplierActiveAction, updateSupplierAction } from "../actions";

export const metadata: Metadata = { title: "Pemasok toko" };

/**
 * Master pemasok toko (7.7.3): pemasok baru diusulkan kasir dari POS dan berlaku setelah disetujui Admin Keuangan;
 * kontak & tempo bayar diubah Admin Keuangan; pemasok tidak dihapus — dinonaktifkan beralasan.
 */
export default async function SuppliersPage({ searchParams }: { searchParams: Promise<{ nonaktif?: string }> }) {
  const { ctx } = await requirePermission("m7.supplier.read");
  const sp = await searchParams;
  const includeInactive = sp.nonaktif === "1";
  const rows = await m7.listSuppliers(ctx, { includeInactive });
  const canUpdate = can(ctx, "m7.supplier.update");
  const canToggle = can(ctx, "m7.supplier.deactivate");
  const canPayables = can(ctx, "m7.supplier_payable.read");
  const pending = rows.filter((r) => r.status === "pending_approval");

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Pemasok toko"
        description="Pemasok baru diusulkan kasir dari POS toko; berlaku setelah disetujui Admin Keuangan. Tempo bayar kosong = 30 hari (PAR-67)."
        actions={
          <>
            <Link href={hrefWith("/toko/pemasok", { nonaktif: includeInactive ? null : "1" })} className="text-sm font-medium text-primary hover:underline">
              {includeInactive ? "Sembunyikan nonaktif" : "Tampilkan nonaktif"}
            </Link>
            <ExportButtons excelHref="/api/export/m7.suppliers?format=xlsx" pdfHref="/api/export/m7.suppliers?format=pdf" disabled={!rows.length} />
          </>
        }
      />
      {pending.length ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" role="status">
          {pending.length} pemasok baru menunggu persetujuan:{" "}
          <Link href="/persetujuan" className="font-medium text-primary hover:underline">
            buka kotak persetujuan
          </Link>
          .
        </p>
      ) : null}
      <SectionCard title="Daftar pemasok" flush>
        {rows.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-pemasok">
              <TableHeader>
                <TableRow>
                  <TableHead>Pemasok</TableHead>
                  <TableHead>Kontak</TableHead>
                  <TableHead className="text-right">Tempo</TableHead>
                  {canPayables ? <TableHead className="text-right">Utang</TableHead> : null}
                  <TableHead>Status</TableHead>
                  {canUpdate || canToggle ? <TableHead>Ubah</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow key={s.id} className="align-top">
                    <TableCell>
                      <span className="font-medium">{s.name}</span>
                      {s.address ? <span className="block text-xs text-muted-foreground">{s.address}</span> : null}
                      {s.deactivationReason ? <span className="block text-xs text-muted-foreground">Nonaktif: {s.deactivationReason}</span> : null}
                    </TableCell>
                    <TableCell className="text-sm">
                      {s.contactName ?? "—"}
                      {s.phone ? <span className="block text-xs text-muted-foreground">{s.phone}</span> : null}
                    </TableCell>
                    <TableCell className="text-right">{s.paymentTermDays !== null ? `${s.paymentTermDays} hari` : "Bawaan"}</TableCell>
                    {canPayables ? (
                      <TableCell className="text-right">
                        {s.outstanding ? (
                          <Link href={hrefWith("/toko/utang", { pemasok: s.id })} className="text-primary hover:underline">
                            {formatRupiah(s.outstanding)}
                          </Link>
                        ) : (
                          "—"
                        )}
                        {s.overdueAmount ? <span className="block text-xs text-destructive">{formatRupiah(s.overdueAmount)} lewat tempo</span> : null}
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <StatusBadge enumName="supplier_status" value={s.status} />
                    </TableCell>
                    {canUpdate || canToggle ? (
                      <TableCell className="min-w-64">
                        {s.status === "pending_approval" ? (
                          <span className="text-xs text-muted-foreground">Putuskan di kotak persetujuan</span>
                        ) : (
                          <details>
                            <summary className="cursor-pointer text-sm font-medium text-primary">Ubah pemasok</summary>
                            <div className="mt-3 grid gap-4">
                              {canUpdate ? (
                                <OutletActionForm action={updateSupplierAction.bind(null, s.id)} submitLabel="Simpan">
                                  <FormInput label="Nama kontak" name="contactName" defaultValue={s.contactName} />
                                  <FormInput label="Telepon" name="phone" defaultValue={s.phone} />
                                  <FormInput label="Alamat" name="address" defaultValue={s.address} />
                                  <FormInput label="Tempo bayar (hari)" name="paymentTermDays" inputMode="numeric" defaultValue={s.paymentTermDays} hint="Kosongkan untuk bawaan PAR-67." />
                                  <FormTextarea label="Catatan" name="notes" defaultValue={s.notes} />
                                </OutletActionForm>
                              ) : null}
                              {canToggle ? (
                                <OutletActionForm action={setSupplierActiveAction.bind(null, s.id, s.status !== "active")} submitLabel={s.status === "active" ? "Nonaktifkan" : "Aktifkan kembali"} variant={s.status === "active" ? "destructive" : "outline"}>
                                  <FormInput label="Alasan" name="reason" required />
                                </OutletActionForm>
                              ) : null}
                            </div>
                          </details>
                        )}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada pemasok" description="Kasir mengusulkan pemasok baru dari POS toko (menu Usulan)." compact />
        )}
      </SectionCard>
    </div>
  );
}
