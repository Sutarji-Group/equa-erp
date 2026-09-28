import type { Metadata } from "next";
import Link from "next/link";

import { OutletActionForm } from "@/components/m6-pos/office-form";
import { FormTextarea, hrefWith, StoreFilter } from "@/components/m7-store/office";
import { SignedNumber } from "@/components/m6-pos/office-ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m7 from "@/server/modules/m7-store";

import { prepareOpeningStockAction } from "../actions";

export const metadata: Metadata = { title: "Opname toko" };

/**
 * Opname toko (US-M7-05): opname bulanan dihitung kasir di POS (jumlah sistem tersembunyi), Admin Keuangan memeriksa
 * & mengajukan penyesuaian beralasan → persetujuan pemilik; riwayat selisih per barang per bulan; stok awal cut-over.
 */
export default async function StockCountsPage({ searchParams }: { searchParams: Promise<{ toko?: string }> }) {
  const { ctx } = await requirePermission("m7.stock_count.read");
  const sp = await searchParams;
  const stores = await m7.listStoreOutlets(ctx);
  const storeId = stores.some((s) => s.id === sp.toko) ? sp.toko! : (stores[0]?.id ?? null);
  const { outlet, rows } = await m7.listStoreStockCounts(ctx, { outletId: storeId });
  const canOpening = can(ctx, "m7.stock_count.create") && can(ctx, "m7.stock.read");
  const hasCutover = rows.some((r) => r.kind === "cutover" && r.status !== "rejected");
  const items = canOpening && outlet && !hasCutover ? (await m7.listStoreItems(ctx, { outletId: outlet.id })).items.filter((i) => i.status === "active") : [];
  const currentMonth = m7.monthLabel(ctxBusinessDate(ctx));
  const thisMonthDone = rows.some((r) => r.kind === "monthly_store" && r.periodLabel === currentMonth);

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Opname toko"
        description={outlet ? `${outlet.code} · ${outlet.name} — opname bulanan dihitung kasir bersama Admin Keuangan.` : "Belum ada toko aktif dalam lingkup Anda."}
        actions={<ExportButtons excelHref={hrefWith("/api/export/m7.stock_counts", { format: "xlsx", outletId: outlet?.id })} pdfHref={hrefWith("/api/export/m7.stock_counts", { format: "pdf", outletId: outlet?.id })} disabled={!rows.length} />}
      />
      <StoreFilter action="/toko/opname" stores={stores} storeId={storeId} />
      {outlet && !thisMonthDone ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" role="status">
          Opname bulan {currentMonth} belum dimulai. Kasir memulai hitung dari POS toko (menu Stok &amp; opname → Opname).
        </p>
      ) : null}
      <SectionCard title="Riwayat opname" flush>
        {rows.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-opname">
              <TableHeader>
                <TableRow>
                  <TableHead>Periode</TableHead>
                  <TableHead>Jenis</TableHead>
                  <TableHead className="text-right">Barang dihitung</TableHead>
                  <TableHead className="text-right">Barang selisih</TableHead>
                  <TableHead className="text-right">Nilai selisih</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Mulai</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link href={`/toko/opname/${r.id}`} className="font-medium text-primary hover:underline">
                        {r.periodLabel}
                      </Link>
                    </TableCell>
                    <TableCell>{label("stock_count_kind", r.kind)}</TableCell>
                    <TableCell className="text-right">{r.lineCount}</TableCell>
                    <TableCell className="text-right">{r.differenceCount || "—"}</TableCell>
                    <TableCell className="text-right">
                      <SignedNumber value={r.differenceValue} money />
                    </TableCell>
                    <TableCell>
                      <StatusBadge enumName="stock_count_status" value={r.status} />
                      {r.kind === "cutover" && r.status === "counting" ? <span className="block text-xs text-warning-foreground">Menunggu tanda tangan pemilik</span> : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatTanggalJam(r.startedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada opname" compact />
        )}
      </SectionCard>
      {canOpening && outlet && !hasCutover ? (
        <SectionCard
          title="Stok awal cut-over"
          description="Isi hasil opname fisik saat mulai memakai sistem beserta harga beli terakhir (menjadi harga pokok awal). Berlaku setelah ditandatangani pemilik."
          actions={<ToneBadge tone="warning">Sekali saat cut-over</ToneBadge>}
        >
          <OutletActionForm action={prepareOpeningStockAction} submitLabel="Siapkan stok awal" testId="form-stok-awal">
            <input type="hidden" name="outletId" value={outlet.id} />
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Barang</TableHead>
                    <TableHead>Jumlah fisik</TableHead>
                    <TableHead>Harga beli terakhir (Rp)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell>
                        {i.name}
                        <span className="block text-xs text-muted-foreground">
                          {i.code} · {i.unit}
                        </span>
                      </TableCell>
                      <TableCell>
                        <input name={`qty_${i.id}`} inputMode="numeric" aria-label={`Jumlah ${i.name}`} className="h-9 w-28 rounded-md border bg-background px-2" />
                      </TableCell>
                      <TableCell>
                        <input name={`cost_${i.id}`} inputMode="numeric" aria-label={`Harga beli ${i.name}`} defaultValue={i.lastUnitCost ?? ""} className="h-9 w-36 rounded-md border bg-background px-2" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <FormTextarea label="Catatan" name="notes" />
          </OutletActionForm>
        </SectionCard>
      ) : null}
    </div>
  );
}
