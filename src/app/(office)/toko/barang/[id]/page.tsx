import type { Metadata } from "next";
import Link from "next/link";

import { DateInput, hrefWith, StoreFilter } from "@/components/m7-store/office";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KeyValueList } from "@/components/shared/key-value-list";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import * as m7 from "@/server/modules/m7-store";

export const metadata: Metadata = { title: "Rincian barang toko" };

const SOURCE_LINK: Record<string, (id: string) => string> = {
  purchase_receipt: (id) => `/toko/pembelian/${id}`,
  stock_count: (id) => `/toko/opname/${id}`,
};

/** Rincian barang toko: harga berlaku & riwayat harga (tidak dapat dihapus), kartu stok per rentang, usulan menunggu. */
export default async function StoreItemDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ toko?: string; dari?: string; sampai?: string }> }) {
  const { ctx } = await requirePermission("m7.stock.read");
  const { id } = await params;
  const sp = await searchParams;
  const stores = await m7.listStoreOutlets(ctx);
  const storeId = stores.some((s) => s.id === sp.toko) ? sp.toko! : (stores[0]?.id ?? null);
  const d = await m7.getStoreItem(ctx, id, { outletId: storeId, from: sp.dari ?? null, to: sp.sampai ?? null });
  const p = d.product;
  const productPrices = d.history.filter((h) => h.kind === "product_price");
  const exportQuery = { outletId: d.outlet?.id, productId: p.id, from: d.range.from, to: d.range.to };

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={p.name} />
      <PageHeader
        title={p.name}
        backHref={hrefWith("/toko/barang", { toko: storeId })}
        backLabel="Barang & stok toko"
        meta={
          <>
            <span>{p.code}</span>
            <StatusBadge enumName="product_status" value={p.status} />
            {d.reorder ? <StatusBadge enumName="reorder_status" value={d.reorder.status} /> : null}
          </>
        }
      />
      <SectionCard title="Ringkasan">
        <KeyValueList
          columns={3}
          items={[
            { label: "Toko", value: d.outlet ? `${d.outlet.code} · ${d.outlet.name}` : "—" },
            { label: "Satuan", value: p.unit },
            { label: "Kategori", value: p.category },
            { label: "Barcode", value: p.barcode },
            { label: "Stok minimum", value: p.minStock ?? "—" },
            { label: "Saldo", value: d.balance ? `${d.balance.quantity.toLocaleString("id-ID")} ${p.unit}` : `0 ${p.unit}` },
            { label: "HPP rata-rata", value: d.balance?.avgCost ? formatRupiah(d.balance.avgCost) : "—" },
            { label: "Nilai stok", value: formatRupiah(d.balance?.totalValue ?? 0) },
            { label: "Harga umum", value: d.prices.general !== undefined ? formatRupiah(d.prices.general) : "—" },
            { label: "Harga mitra", value: d.prices.partner !== undefined ? formatRupiah(d.prices.partner) : "—" },
          ]}
        />
      </SectionCard>
      {d.pendingApprovals.length ? (
        <SectionCard title="Usulan menunggu persetujuan">
          <ul className="grid gap-2 text-sm">
            {d.pendingApprovals.map((a) => (
              <li key={a.id} className="rounded-md border p-3">
                <span className="font-medium">{label("approval_type", a.type)}</span> — {a.reason}{" "}
                <Link href="/persetujuan" className="text-primary hover:underline">
                  Kotak persetujuan
                </Link>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
      <SectionCard title="Riwayat harga jual" description="Setiap perubahan harga tercatat dengan tanggal berlaku; harga lama tidak dihapus.">
        {productPrices.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="riwayat-harga">
              <TableHeader>
                <TableRow>
                  <TableHead>Jenis</TableHead>
                  <TableHead className="text-right">Harga</TableHead>
                  <TableHead>Berlaku mulai</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Alasan</TableHead>
                  <TableHead>Dicatat</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {productPrices.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell>
                      {h.kindLabel}
                      <span className="block text-xs text-muted-foreground">{h.detail}</span>
                    </TableCell>
                    <TableCell className="text-right">{formatRupiah(h.price)}</TableCell>
                    <TableCell>{formatTanggal(h.effectiveFrom)}</TableCell>
                    <TableCell>
                      <StatusBadge enumName="price_status" value={h.status} />
                    </TableCell>
                    <TableCell className="text-sm">{h.reason ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatTanggalJam(h.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada harga" compact />
        )}
      </SectionCard>
      <SectionCard
        title="Kartu stok"
        description={`Saldo awal ${formatTanggal(d.range.from)}: ${d.card.opening.toLocaleString("id-ID")} ${p.unit}`}
        actions={<ExportButtons excelHref={hrefWith("/api/export/m7.stock_card", { format: "xlsx", ...exportQuery })} pdfHref={hrefWith("/api/export/m7.stock_card", { format: "pdf", ...exportQuery })} />}
      >
        <div className="grid gap-4">
          <StoreFilter action={`/toko/barang/${p.id}`} stores={stores} storeId={storeId}>
            <DateInput name="dari" value={d.range.from} label="Dari" />
            <DateInput name="sampai" value={d.range.to} label="Sampai" />
          </StoreFilter>
          {d.card.rows.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="kartu-stok">
                <TableHeader>
                  <TableRow>
                    <TableHead>Waktu</TableHead>
                    <TableHead>Jenis</TableHead>
                    <TableHead className="text-right">Masuk</TableHead>
                    <TableHead className="text-right">Keluar</TableHead>
                    <TableHead className="text-right">Saldo</TableHead>
                    <TableHead className="text-right">Harga pokok</TableHead>
                    <TableHead className="text-right">HPP rata-rata</TableHead>
                    <TableHead>Keterangan</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.card.rows.map((r) => {
                    const link = r.sourceObjectType && r.sourceObjectId ? SOURCE_LINK[r.sourceObjectType]?.(r.sourceObjectId) : undefined;
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="text-sm whitespace-nowrap">{formatTanggalJam(r.occurredAt)}</TableCell>
                        <TableCell>{label("stock_movement_kind", r.kind)}</TableCell>
                        <TableCell className="text-right">{r.quantity > 0 ? r.quantity.toLocaleString("id-ID") : ""}</TableCell>
                        <TableCell className="text-right">{r.quantity < 0 ? (-r.quantity).toLocaleString("id-ID") : ""}</TableCell>
                        <TableCell className="text-right font-medium">{r.balanceAfter.toLocaleString("id-ID")}</TableCell>
                        <TableCell className="text-right">{r.unitCost !== null ? formatRupiah(r.unitCost) : "—"}</TableCell>
                        <TableCell className="text-right">{r.avgCostAfter !== null ? formatRupiah(r.avgCostAfter) : "—"}</TableCell>
                        <TableCell className="text-sm">
                          {link ? (
                            <Link href={link} className="text-primary hover:underline">
                              {r.note ?? "Lihat dokumen"}
                            </Link>
                          ) : (
                            (r.note ?? "—")
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Tidak ada mutasi pada rentang ini" compact />
          )}
        </div>
      </SectionCard>
    </div>
  );
}
