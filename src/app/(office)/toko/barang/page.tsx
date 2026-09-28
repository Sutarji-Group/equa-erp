import type { Metadata } from "next";
import Link from "next/link";

import { hrefWith, StoreFilter } from "@/components/m7-store/office";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m7 from "@/server/modules/m7-store";

export const metadata: Metadata = { title: "Barang & stok toko" };

/**
 * Barang & stok toko (US-M7-02 KP-3, US-M7-03): saldo real-time per barang, harga umum & mitra yang berlaku, HPP
 * rata-rata tertimbang, stok minimum, pemasok & harga beli terakhir, usulan kasir yang menunggu persetujuan.
 */
export default async function StoreItemsPage({ searchParams }: { searchParams: Promise<{ toko?: string; nonaktif?: string }> }) {
  const { ctx } = await requirePermission("m7.stock.read");
  const sp = await searchParams;
  const stores = await m7.listStoreOutlets(ctx);
  const storeId = stores.some((s) => s.id === sp.toko) ? sp.toko! : (stores[0]?.id ?? null);
  const includeInactive = sp.nonaktif === "1";
  const { outlet, items } = await m7.listStoreItems(ctx, { outletId: storeId, includeInactive });
  const overview = outlet ? await m7.storeOverview(ctx, { outletId: outlet.id }) : null;
  const pending = await m7.pendingStoreApprovals(ctx);
  const canPayables = can(ctx, "m7.supplier_payable.read");
  const below = items.filter((i) => i.belowMinimum && i.status === "active");

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Barang & stok toko"
        description={outlet ? `${outlet.code} · ${outlet.name} — saldo berjalan dari kartu stok (penerimaan, penjualan, transfer, opname).` : "Belum ada toko aktif dalam lingkup Anda."}
        actions={
          <ExportButtons
            excelHref={hrefWith("/api/export/m7.items", { format: "xlsx", outletId: outlet?.id })}
            pdfHref={hrefWith("/api/export/m7.items", { format: "pdf", outletId: outlet?.id })}
            disabled={!items.length}
          />
        }
      />
      <StoreFilter action="/toko/barang" stores={stores} storeId={storeId}>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" name="nonaktif" value="1" defaultChecked={includeInactive} /> Tampilkan barang nonaktif
        </label>
      </StoreFilter>
      {overview ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile label="Nilai stok (HPP)" value={<MoneyText value={overview.stockValue} />} hint={`${overview.itemsInStock} barang bersaldo`} />
          <KpiTile label="Perlu dipesan ulang" value={overview.reorderOpen} tone={overview.reorderOpen ? "warning" : undefined} href="/toko/pesan-ulang" hrefLabel="Lihat daftar" />
          <KpiTile label="Nota pengganti menunggu" value={overview.substitutePending} tone={overview.substitutePending ? "warning" : undefined} href="/toko/pembelian?status=pending_acceptance" hrefLabel="Tinjau" />
          {canPayables ? (
            <KpiTile label="Utang pemasok" value={<MoneyText value={overview.payableTotal} />} tone={overview.payableOverdue ? "danger" : undefined} hint={overview.payableOverdue ? `${formatRupiah(overview.payableOverdue)} lewat jatuh tempo` : "Tidak ada yang lewat jatuh tempo"} href="/toko/utang" hrefLabel="Buka utang" />
          ) : (
            <KpiTile label="Usulan menunggu" value={overview.pendingProposals} />
          )}
        </div>
      ) : null}
      {pending.length ? (
        <SectionCard title="Usulan kasir menunggu persetujuan" description="Barang baru, harga jual, dan pemasok baru berlaku setelah disetujui Admin Keuangan (kotak persetujuan).">
          <ul className="grid gap-2 text-sm" data-testid="usulan-menunggu">
            {pending.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                <span>
                  <span className="font-medium">{label("approval_type", a.type)}</span> — {a.reason}
                  <span className="block text-xs text-muted-foreground">Diajukan {formatTanggalJam(a.createdAt)}</span>
                </span>
                {a.canDecide ? (
                  <Link href="/persetujuan" className="text-sm font-medium text-primary hover:underline">
                    Putuskan
                  </Link>
                ) : (
                  <ToneBadge tone="warning">Menunggu</ToneBadge>
                )}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
      {below.length ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" role="status">
          {below.length} barang di bawah/sama dengan stok minimum: {below.map((b) => b.name).join(", ")}.
        </p>
      ) : null}
      <SectionCard title="Daftar barang" flush>
        {items.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-barang-toko">
              <TableHeader>
                <TableRow>
                  <TableHead>Barang</TableHead>
                  <TableHead className="text-right">Harga umum</TableHead>
                  <TableHead className="text-right">Harga mitra</TableHead>
                  <TableHead className="text-right">Saldo</TableHead>
                  <TableHead className="text-right">Min.</TableHead>
                  <TableHead className="text-right">HPP rata-rata</TableHead>
                  <TableHead className="text-right">Nilai stok</TableHead>
                  <TableHead>Pemasok terakhir</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>
                      <Link href={hrefWith(`/toko/barang/${i.id}`, { toko: storeId })} className="font-medium text-primary hover:underline">
                        {i.name}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {i.code}
                        {i.category ? ` · ${i.category}` : ""} · {i.unit}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{i.prices.general !== undefined ? formatRupiah(i.prices.general) : "—"}</TableCell>
                    <TableCell className="text-right">{i.prices.partner !== undefined ? formatRupiah(i.prices.partner) : "—"}</TableCell>
                    <TableCell className={`text-right ${i.belowMinimum ? "font-semibold text-destructive" : ""}`}>{i.balance.toLocaleString("id-ID")}</TableCell>
                    <TableCell className="text-right">{i.minStock ?? "—"}</TableCell>
                    <TableCell className="text-right">{i.avgCost ? formatRupiah(i.avgCost) : "—"}</TableCell>
                    <TableCell className="text-right">{formatRupiah(i.stockValue)}</TableCell>
                    <TableCell className="text-sm">
                      {i.lastSupplierName ?? "—"}
                      {i.lastUnitCost !== null ? <span className="block text-xs text-muted-foreground">{formatRupiah(i.lastUnitCost)}</span> : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge enumName="product_status" value={i.status} />
                      {i.pendingPrices ? <span className="block text-xs text-warning-foreground">{i.pendingPrices} harga menunggu</span> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada barang toko" description="Kasir mengusulkan barang baru dari POS toko (menu Usulan); berlaku setelah disetujui Admin Keuangan." compact />
        )}
      </SectionCard>
    </div>
  );
}
