import type { Metadata } from "next";

import { ReasonActionButton } from "@/components/m1-master/action-buttons";
import { ActionForm } from "@/components/m1-master/action-form";
import { CheckField, FormGrid, SelectField, TextField } from "@/components/m1-master/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label, type ProductLine } from "@/lib/labels";
import { formatTanggal } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { getDb } from "@/server/core/db";
import { can } from "@/server/core/rbac";
import * as m1 from "@/server/modules/m1-master";

import { createProductAction, proposeFuelAction, proposeProductPriceAction, setProductActiveAction } from "./actions";

export const metadata: Metadata = { title: "Produk & harga" };

const LINES: ProductLine[] = ["truck_water", "depot", "store"];

/**
 * Produk & harga tiga lini (US-M1-02): harga berlaku hari ini, komponen BBM (KP-2), jalur baku Admin Keuangan →
 * pemilik atau keputusan langsung pemilik (KP-3), riwayat harga yang tidak dapat dihapus (katalog 7.9.4), nonaktif
 * produk (KP-6).
 */
export default async function ProdukPage() {
  const { ctx } = await requirePermission("m1.product.read");
  const canPriceRead = can(ctx, "m1.price.read");
  const [products, fuel, history, outlets] = await Promise.all([
    m1.listProducts(ctx, { includeInactive: true }),
    canPriceRead ? m1.currentFuelComponent(ctx) : Promise.resolve(null),
    canPriceRead ? m1.priceHistory(getDb(), ctx.tenantId, { limit: 60 }) : Promise.resolve([]),
    can(ctx, "m1.outlet.read") ? m1.listOutlets(ctx) : Promise.resolve([]),
  ]);
  const canCreate = can(ctx, "m1.product.create");
  const canDeactivate = can(ctx, "m1.product.deactivate");
  const priceMode = can(ctx, "m1.price.set") ? "owner" : can(ctx, "m1.price.request") ? "request" : null;
  const pricedProducts = products.filter((p) => p.line !== "truck_water" && p.status === "active");
  const pending = history.filter((h) => h.status === "pending");

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Produk & harga"
        description="Harga hanya dari master (BR-15/BR-19): berlaku per tanggal, riwayat tersimpan."
        actions={canPriceRead ? <ExportButtons excelHref="/api/export/m1.price_history?format=xlsx" pdfHref="/api/export/m1.price_history?format=pdf" /> : null}
      />

      {LINES.map((line) => {
        const rows = products.filter((p) => p.line === line);
        return (
          <SectionCard key={line} title={label("product_line", line)} description={line === "truck_water" ? "Harga per rit = tarif zona alamat kirim + komponen BBM, atau harga khusus pelanggan (lihat Zona tarif)." : line === "store" ? "Harga umum & mitra; barang baru diusulkan kasir di POS toko (M7)." : "Harga tunggal per tenant (boleh khusus outlet)."}>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Produk</TableHead>
                    <TableHead className="hidden sm:table-cell">Satuan</TableHead>
                    {line !== "truck_water" ? <TableHead className="text-right">Harga berlaku</TableHead> : null}
                    <TableHead>Status</TableHead>
                    {canDeactivate ? <TableHead className="text-right">Aksi</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="font-medium">{p.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {p.code}
                          {p.isInternalTransfer ? " · transfer internal (BR-33)" : ""}
                          {p.pendingPrices ? ` · ${p.pendingPrices} usulan harga menunggu` : ""}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">{p.unit}</TableCell>
                      {line !== "truck_water" ? (
                        <TableCell className="text-right">
                          {p.prices.map((x) => (
                            <div key={x.kind} className="text-sm">
                              <span className="text-muted-foreground">{label("price_kind", x.kind)}:</span> {x.price !== null ? <MoneyText value={x.price} /> : "—"}
                            </div>
                          ))}
                        </TableCell>
                      ) : null}
                      <TableCell>
                        <StatusBadge enumName="product_status" value={p.status} tone={p.status === "active" ? "success" : "muted"} />
                      </TableCell>
                      {canDeactivate ? (
                        <TableCell className="text-right">
                          {p.status === "active" ? (
                            <ReasonActionButton label="Nonaktifkan" title={`Nonaktifkan ${p.name}?`} description="Produk nonaktif tidak muncul di POS/pesanan; riwayat tetap tersimpan." action={setProductActiveAction.bind(null, p.id, false)} destructive />
                          ) : p.status === "inactive" ? (
                            <ReasonActionButton label="Aktifkan" title={`Aktifkan ${p.name}?`} action={setProductActiveAction.bind(null, p.id, true)} />
                          ) : null}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </SectionCard>
        );
      })}

      {canPriceRead ? (
        <SectionCard title="Komponen BBM" description="Satu nilai rupiah per rit untuk seluruh zona, berlaku per tanggal (PTB-03).">
          <div className="grid gap-4" id="bbm">
            <p className="text-sm">
              Berlaku hari ini: <span className="font-semibold">{fuel ? <MoneyText value={fuel.amountPerTrip} /> : "belum ditetapkan"}</span>
              {fuel ? <span className="text-muted-foreground"> sejak {formatTanggal(fuel.effectiveFrom, { weekday: false })}</span> : null}
            </p>
            {priceMode ? (
              <ActionForm action={proposeFuelAction} submitLabel={priceMode === "owner" ? "Tetapkan komponen BBM" : "Ajukan komponen BBM"} variant="outline">
                <FormGrid>
                  <TextField label="Komponen BBM per rit (Rp)" name="amountPerTrip" inputMode="numeric" required />
                  <TextField label="Berlaku mulai" name="effectiveFrom" type="date" required hint={priceMode === "owner" ? "Keputusan langsung pemilik (6.2b)." : "Paling cepat besok; lewat tenggat → harga lama tetap."} />
                </FormGrid>
                <TextField label="Alasan" name="reason" required />
              </ActionForm>
            ) : null}
          </div>
        </SectionCard>
      ) : null}

      {priceMode ? (
        <SectionCard title={priceMode === "owner" ? "Tetapkan harga produk" : "Ajukan harga produk"} description={priceMode === "owner" ? "Keputusan langsung pemilik: tanpa persetujuan, alasan & tanggal wajib, diberitahukan ke Admin Keuangan & Dispatcher." : "Jalur baku: harga aktif setelah disetujui pemilik sebelum tanggal berlaku."}>
          <ActionForm action={proposeProductPriceAction} submitLabel={priceMode === "owner" ? "Tetapkan harga" : "Ajukan harga"}>
            <FormGrid>
              <SelectField label="Produk" name="productId" required placeholder="— Pilih produk —" options={pricedProducts.map((p) => ({ value: p.id, label: `${p.name} (${label("product_line", p.line)})` }))} />
              <SelectField
                label="Jenis harga"
                name="kind"
                options={[
                  { value: "standard", label: "Harga standar (depot)" },
                  { value: "general", label: "Harga umum (toko)" },
                  { value: "partner", label: "Harga mitra (toko)" },
                ]}
              />
              <TextField label="Harga (Rp)" name="price" inputMode="numeric" required />
              <TextField label="Berlaku mulai" name="effectiveFrom" type="date" required />
              <SelectField label="Khusus outlet (opsional)" name="outletId" placeholder="— Semua outlet —" options={outlets.map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` }))} />
              <TextField label="Alasan" name="reason" required />
            </FormGrid>
          </ActionForm>
        </SectionCard>
      ) : null}

      {canCreate ? (
        <SectionCard title="Produk baru (depot / air truk)" description="Barang toko baru diusulkan kasir lewat POS toko dan disetujui Admin Keuangan (M7).">
          <ActionForm action={createProductAction} submitLabel="Buat produk">
            <FormGrid>
              <TextField label="Kode" name="code" required placeholder="ISI-ULANG-5L" />
              <TextField label="Nama" name="name" required />
              <SelectField
                label="Lini"
                name="line"
                options={[
                  { value: "depot", label: "Produk depot" },
                  { value: "truck_water", label: "Air truk" },
                ]}
              />
              <TextField label="Satuan" name="unit" required placeholder="galon / pcs / rit" />
              <TextField label="Kategori" name="category" placeholder="isi_ulang / jasa / bahan_habis_pakai" />
              <TextField label="Ukuran galon (L)" name="gallonSizeL" inputMode="numeric" placeholder="19" />
            </FormGrid>
            <div className="flex flex-wrap gap-4">
              <CheckField label="Bahan habis pakai (resep & stok depot)" name="isConsumable" />
              <CheckField label="Air truk — transfer internal (BR-33)" name="isInternalTransfer" />
              <CheckField label="Sembunyikan dari kisi POS" name="hideFromPos" />
            </div>
          </ActionForm>
        </SectionCard>
      ) : null}

      {canPriceRead ? (
        <SectionCard title="Riwayat harga" description={pending.length ? `${pending.length} usulan menunggu persetujuan pemilik (Persetujuan).` : "Semua perubahan tarif zona, BBM, produk, dan harga khusus — tidak dapat dihapus."}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Berlaku</TableHead>
                  <TableHead>Jenis</TableHead>
                  <TableHead>Objek</TableHead>
                  <TableHead className="text-right">Harga</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Alasan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((h) => (
                  <TableRow key={`${h.kind}-${h.id}`}>
                    <TableCell className="whitespace-nowrap">{formatTanggal(h.effectiveFrom, { weekday: false })}</TableCell>
                    <TableCell>
                      {h.kindLabel}
                      {h.ownerDirect ? <ToneBadge tone="info" className="ml-1">Pemilik</ToneBadge> : null}
                    </TableCell>
                    <TableCell>
                      <div>{h.subject}</div>
                      <div className="text-xs text-muted-foreground">{h.detail}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={h.price} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge enumName="price_status" value={h.status} tone={h.status === "active" ? "success" : h.status === "pending" ? "warning" : "muted"} />
                    </TableCell>
                    <TableCell className="hidden max-w-xs truncate md:table-cell">{h.reason ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
