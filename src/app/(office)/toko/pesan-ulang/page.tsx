import type { Metadata } from "next";
import Link from "next/link";

import { hrefWith, StoreFilter } from "@/components/m7-store/office";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRupiah } from "@/lib/money";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import * as m7 from "@/server/modules/m7-store";

export const metadata: Metadata = { title: "Daftar pesan ulang" };

/**
 * Daftar pesan ulang (US-M7-03): barang yang saldonya ≤ stok minimum masuk otomatis dengan rata-rata penjualan harian
 * dan pemasok terakhir; kasir menandai "sudah dipesan" di POS; baris selesai saat barang diterima.
 */
export default async function ReorderPage({ searchParams }: { searchParams: Promise<{ toko?: string; selesai?: string }> }) {
  const { ctx } = await requirePermission("m7.reorder.read");
  const sp = await searchParams;
  const stores = await m7.listStoreOutlets(ctx);
  const storeId = stores.some((s) => s.id === sp.toko) ? sp.toko! : (stores[0]?.id ?? null);
  const showClosed = sp.selesai === "1";
  const { outlet, rows } = await m7.getReorderList(ctx, { outletId: storeId, includeClosedDays: showClosed ? 30 : undefined });

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Daftar pesan ulang"
        description={outlet ? `${outlet.code} · ${outlet.name} — barang yang saldonya mencapai stok minimum.` : "Belum ada toko aktif dalam lingkup Anda."}
        actions={
          <ExportButtons
            excelHref={hrefWith("/api/export/m7.reorder", { format: "xlsx", outletId: outlet?.id })}
            pdfHref={hrefWith("/api/export/m7.reorder", { format: "pdf", outletId: outlet?.id })}
            disabled={!rows.length}
          />
        }
      />
      <StoreFilter action="/toko/pesan-ulang" stores={stores} storeId={storeId}>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" name="selesai" value="1" defaultChecked={showClosed} /> Tampilkan yang selesai (30 hari)
        </label>
      </StoreFilter>
      <SectionCard title="Barang perlu dipesan" flush>
        {rows.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-pesan-ulang">
              <TableHeader>
                <TableRow>
                  <TableHead>Barang</TableHead>
                  <TableHead className="text-right">Saldo</TableHead>
                  <TableHead className="text-right">Min.</TableHead>
                  <TableHead className="text-right">Rata-rata jual/hari</TableHead>
                  <TableHead>Pemasok terakhir</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Masuk daftar</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link href={hrefWith(`/toko/barang/${r.productId}`, { toko: storeId })} className="font-medium text-primary hover:underline">
                        {r.name}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {r.code} · {r.unit}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-semibold text-destructive">{r.balance.toLocaleString("id-ID")}</TableCell>
                    <TableCell className="text-right">{r.minStock ?? "—"}</TableCell>
                    <TableCell className="text-right">{r.avgDailySales.toLocaleString("id-ID")}</TableCell>
                    <TableCell className="text-sm">
                      {r.lastSupplierName ?? "—"}
                      {r.lastUnitCost !== null ? <span className="block text-xs text-muted-foreground">{formatRupiah(r.lastUnitCost)}</span> : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge enumName="reorder_status" value={r.status} />
                      {r.orderedAt ? (
                        <span className="block text-xs text-muted-foreground">
                          {r.orderedSupplierName ? `ke ${r.orderedSupplierName} · ` : ""}
                          {formatTanggalJam(r.orderedAt)}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatTanggalJam(r.triggeredAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Tidak ada barang yang perlu dipesan" description="Barang masuk daftar otomatis saat saldonya mencapai stok minimum." compact />
        )}
      </SectionCard>
    </div>
  );
}
