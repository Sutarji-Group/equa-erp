import type { Metadata } from "next";

import { Field, OutletActionForm } from "@/components/m6-pos/office-form";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTanggal } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m6 from "@/server/modules/m6-pos";

import { createTenantAction } from "../actions";

export const metadata: Metadata = { title: "Tenant & paket POS" };

/**
 * Tenant & paket POS (US-M6-07): daftar tenant (EQUA + mitra) dan pembuatan tenant mitra baru dengan salinan katalog
 * standar EQUA (produk depot, harga standar, resep bahan). Data tiap tenant terisolasi (NFR-30); pengguna & perangkat
 * mitra dibuat lewat Akses & perangkat (M10).
 */
export default async function TenantPage() {
  const { ctx } = await requirePermission("m10.tenant.read");
  const rows = await m6.listTenants(ctx);
  const canCreate = can(ctx, "m10.tenant.create");

  return (
    <div className="grid gap-6">
      <PageHeader title="Tenant & paket POS" backHref="/outlet" backLabel="Pemantauan outlet" description="Paket POS depot untuk mitra memakai mesin yang sama; data tiap tenant terpisah penuh." />
      <SectionCard title="Tenant terdaftar">
        <div className="overflow-x-auto">
          <Table data-testid="tabel-tenant">
            <TableHeader>
              <TableRow>
                <TableHead>Kode</TableHead>
                <TableHead>Nama</TableHead>
                <TableHead>Jenis</TableHead>
                <TableHead className="text-right">Outlet</TableHead>
                <TableHead className="text-right">Produk</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Dibuat</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.code}</TableCell>
                  <TableCell>{t.name}</TableCell>
                  <TableCell>
                    <StatusBadge enumName="tenant_kind" value={t.kind} dot={false} />
                  </TableCell>
                  <TableCell className="text-right">{t.outletCount}</TableCell>
                  <TableCell className="text-right">{t.productCount}</TableCell>
                  <TableCell>
                    {!t.isActive ? <ToneBadge tone="muted">Nonaktif</ToneBadge> : t.readOnly ? <ToneBadge tone="warning">Baca saja</ToneBadge> : <ToneBadge tone="success">Aktif</ToneBadge>}
                  </TableCell>
                  <TableCell>{formatTanggal(t.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
      {canCreate ? (
        <SectionCard title="Tenant mitra baru" description="Membuat tenant, depot pertama, dan (opsional) menyalin katalog standar EQUA. Harga dapat diubah mitra sendiri setelahnya.">
          <OutletActionForm action={createTenantAction} submitLabel="Buat tenant mitra" testId="form-tenant" className="max-w-xl">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Kode tenant" name="code" required placeholder="MITRA01" hint="Huruf dan angka, maksimal 10." />
              <Field label="Nama usaha" name="name" required />
              <Field label="Kode depot" name="outletCode" required placeholder="M01" />
              <Field label="Nama depot" name="outletName" required />
              <Field label="Alamat depot" name="outletAddress" />
              <Field label="Kapasitas tangki (liter)" name="storageCapacityL" inputMode="numeric" />
            </div>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" name="copyStandardCatalog" value="on" defaultChecked className="size-4" /> Salin katalog standar EQUA (produk depot, harga standar, resep bahan)
            </label>
            <Field label="Alasan / nomor kontrak" name="reason" required />
          </OutletActionForm>
        </SectionCard>
      ) : null}
    </div>
  );
}
