import type { Metadata } from "next";
import type { ReactNode } from "react";

import { OutletActionForm } from "@/components/m6-pos/office-form";
import { LinkTabs, SignedNumber } from "@/components/m6-pos/office-ui";
import { FormTextarea, hrefWith, MonthInput, StoreFilter } from "@/components/m7-store/office";
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
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate } from "@/server/core/context";
import { can } from "@/server/core/rbac";
import * as m7 from "@/server/modules/m7-store";

import { storeReturnAction } from "../actions";

export const metadata: Metadata = { title: "Laporan toko" };

type Tab = "performa" | "mitra" | "diskon" | "transfer" | "opname" | "retur";
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Laporan toko (US-M7-07, US-M7-01 KP-3, US-M7-06 KP-3, US-M7-05 KP-5): barang laris/mati & margin per barang (pemilik),
 * pembelian bulanan pelanggan mitra, diskon per transaksi, transfer internal per depot, riwayat selisih opname, dan
 * retur barang setelah shift ditutup (Admin Keuangan).
 */
export default async function StoreReportsPage({ searchParams }: { searchParams: Promise<{ tab?: string; toko?: string; bulan?: string; q?: string }> }) {
  const { ctx } = await requirePermission(["m7.report.read", "m7.product_performance.read"]);
  const sp = await searchParams;
  const canPerformance = can(ctx, "m7.product_performance.read");
  const canReturn = can(ctx, "m7.pos_sale.correct");
  const canReport = can(ctx, "m7.report.read") || canPerformance;
  const tabs = [
    ...(canPerformance ? [{ key: "performa", label: "Laris/mati & margin" }] : []),
    { key: "mitra", label: "Pembelian mitra" },
    { key: "diskon", label: "Diskon" },
    { key: "transfer", label: "Transfer internal" },
    { key: "opname", label: "Riwayat opname" },
    ...(canReturn || canReport ? [{ key: "retur", label: "Retur pelanggan" }] : []),
  ] as { key: Tab; label: string }[];
  const tab: Tab = tabs.some((t) => t.key === sp.tab) ? (sp.tab as Tab) : tabs[0]!.key;
  const stores = await m7.listStoreOutlets(ctx);
  const storeId = stores.some((s) => s.id === sp.toko) ? sp.toko! : (stores[0]?.id ?? null);
  const month = sp.bulan && MONTH_RE.test(sp.bulan) ? sp.bulan : m7.monthLabel(ctxBusinessDate(ctx));
  const base = { tab, toko: storeId, bulan: month };
  const exp = (key: string, extra: Record<string, string | null | undefined> = {}) => ({
    excel: hrefWith(`/api/export/${key}`, { format: "xlsx", outletId: storeId, month, ...extra }),
    pdf: hrefWith(`/api/export/${key}`, { format: "pdf", outletId: storeId, month, ...extra }),
  });

  let body: ReactNode = null;
  if (tab === "performa") {
    const r = await m7.productPerformance(ctx, { outletId: storeId, month });
    const revenue = r.rows.reduce((s, x) => s + x.revenue, 0);
    const cogs = r.rows.reduce((s, x) => s + x.cogs, 0);
    const e = exp("m7.product_performance");
    body = (
      <>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile label="Omzet bersih" value={<MoneyText value={revenue} />} />
          <KpiTile label="HPP" value={<MoneyText value={cogs} />} />
          <KpiTile label="Margin kotor" value={<MoneyText value={revenue - cogs} />} hint={revenue ? `${Math.round(((revenue - cogs) / revenue) * 1000) / 10}%` : undefined} />
          <KpiTile label="Barang mati" value={r.rows.filter((x) => x.group === "dead").length} hint={`Tanpa penjualan ≥ ${r.deadDays} hari (PAR-66)`} tone={r.rows.some((x) => x.group === "dead") ? "warning" : undefined} />
        </div>
        <SectionCard title={`Per barang — ${month}`} description={`Laris = ${r.fastPercent}% teratas menurut omzet. Omzet setelah diskon & retur; HPP rata-rata tertimbang saat jual.`} actions={<ExportButtons excelHref={e.excel} pdfHref={e.pdf} disabled={!r.rows.length} />} flush>
          {r.rows.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="laporan-performa">
                <TableHeader>
                  <TableRow>
                    <TableHead>Barang</TableHead>
                    <TableHead>Kelompok</TableHead>
                    <TableHead className="text-right">Terjual</TableHead>
                    <TableHead className="text-right">Omzet</TableHead>
                    <TableHead className="text-right">HPP</TableHead>
                    <TableHead className="text-right">Margin</TableHead>
                    <TableHead className="text-right">Margin %</TableHead>
                    <TableHead>Penjualan terakhir</TableHead>
                    <TableHead className="text-right">Saldo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.rows.map((x) => (
                    <TableRow key={x.productId}>
                      <TableCell>
                        {x.name}
                        <span className="block text-xs text-muted-foreground">{x.code}</span>
                      </TableCell>
                      <TableCell>
                        <ToneBadge tone={x.group === "fast" ? "success" : x.group === "dead" ? "danger" : "muted"}>{x.groupLabel}</ToneBadge>
                      </TableCell>
                      <TableCell className="text-right">
                        {x.soldQty.toLocaleString("id-ID")} {x.unit}
                      </TableCell>
                      <TableCell className="text-right">{formatRupiah(x.revenue)}</TableCell>
                      <TableCell className="text-right">{formatRupiah(x.cogs)}</TableCell>
                      <TableCell className="text-right">
                        <SignedNumber value={x.grossMargin} money />
                      </TableCell>
                      <TableCell className="text-right">{x.marginPct !== null ? `${x.marginPct}%` : "—"}</TableCell>
                      <TableCell className="text-sm">
                        {x.lastSaleDate ? formatTanggal(x.lastSaleDate) : "—"}
                        {x.daysWithoutSale ? <span className="block text-xs text-muted-foreground">{x.daysWithoutSale} hari lalu</span> : null}
                      </TableCell>
                      <TableCell className="text-right">{x.balance.toLocaleString("id-ID")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Belum ada data" compact />
          )}
        </SectionCard>
      </>
    );
  } else if (tab === "mitra") {
    const r = await m7.partnerPurchases(ctx, { outletId: storeId, month });
    const e = exp("m7.partner_purchases");
    body = (
      <SectionCard title={`Pembelian per pelanggan — ${month}`} description="Pelanggan tercatat (mitra & bernama). Penjualan umum tanpa pelanggan tidak termasuk." actions={<ExportButtons excelHref={e.excel} pdfHref={e.pdf} disabled={!r.rows.length} />} flush>
        {r.rows.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="laporan-mitra">
              <TableHeader>
                <TableRow>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead className="text-right">Transaksi</TableHead>
                  <TableHead className="text-right">Tunai</TableHead>
                  <TableHead className="text-right">QRIS</TableHead>
                  <TableHead className="text-right">Tempo</TableHead>
                  <TableHead className="text-right">Diskon</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.rows.map((x) => (
                  <TableRow key={x.customerId}>
                    <TableCell>
                      {x.name}
                      <span className="block text-xs text-muted-foreground">
                        {x.code ?? "—"}
                        {x.isStorePartner ? " · mitra toko" : ""}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{x.transactions}</TableCell>
                    <TableCell className="text-right">{formatRupiah(x.cash)}</TableCell>
                    <TableCell className="text-right">{formatRupiah(x.qris)}</TableCell>
                    <TableCell className="text-right">{formatRupiah(x.credit)}</TableCell>
                    <TableCell className="text-right">{x.discount ? formatRupiah(x.discount) : "—"}</TableCell>
                    <TableCell className="text-right font-medium">{formatRupiah(x.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada pembelian pelanggan tercatat" compact />
        )}
      </SectionCard>
    );
  } else if (tab === "diskon") {
    const r = await m7.discountReport(ctx, { outletId: storeId, month });
    const e = exp("m7.discounts");
    body = (
      <>
        <div className="grid gap-3 sm:grid-cols-3">
          <KpiTile label="Transaksi berdiskon" value={r.totals.count} />
          <KpiTile label="Total diskon" value={<MoneyText value={r.totals.amount} />} />
          <KpiTile label="Di atas batas (persetujuan)" value={r.totals.overLimitCount} tone={r.totals.overLimitCount ? "warning" : undefined} />
        </div>
        <SectionCard title={`Diskon per transaksi — ${month}`} actions={<ExportButtons excelHref={e.excel} pdfHref={e.pdf} disabled={!r.rows.length} />} flush>
          {r.rows.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="laporan-diskon">
                <TableHeader>
                  <TableRow>
                    <TableHead>Waktu</TableHead>
                    <TableHead>Nomor</TableHead>
                    <TableHead>Pelanggan · kasir</TableHead>
                    <TableHead className="text-right">Subtotal</TableHead>
                    <TableHead className="text-right">Diskon</TableHead>
                    <TableHead>Alasan</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.rows.map((x) => (
                    <TableRow key={x.saleId}>
                      <TableCell className="text-sm whitespace-nowrap">{formatTanggalJam(x.soldAt)}</TableCell>
                      <TableCell>{x.number ?? x.localNumber}</TableCell>
                      <TableCell className="text-sm">
                        {x.customerName ?? "Umum"}
                        <span className="block text-xs text-muted-foreground">{x.cashierName ?? "—"}</span>
                      </TableCell>
                      <TableCell className="text-right">{formatRupiah(x.subtotal)}</TableCell>
                      <TableCell className="text-right">
                        {formatRupiah(x.discountAmount)}
                        {x.subtotal ? <span className="block text-xs text-muted-foreground">{Math.round((x.discountAmount / x.subtotal) * 1000) / 10}%</span> : null}
                      </TableCell>
                      <TableCell className="text-sm">{x.reason ?? "—"}</TableCell>
                      <TableCell>
                        <StatusBadge enumName="pos_sale_status" value={x.status} />
                        {x.approvalStatus ? <span className="block text-xs text-muted-foreground">Persetujuan: {label("approval_status", x.approvalStatus)}</span> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Tidak ada diskon bulan ini" compact />
          )}
        </SectionCard>
      </>
    );
  } else if (tab === "transfer") {
    const r = await m7.transferReport(ctx, { month });
    const e = exp("m7.internal_transfers", { outletId: null });
    body = (
      <>
        <SectionCard title={`Per depot — ${month}`} description="Bahan (tutup, tisu, galon kosong) dari toko ke depot sendiri, dinilai harga mitra. Bukan penjualan." actions={<ExportButtons excelHref={e.excel} pdfHref={e.pdf} disabled={!r.rows.length} />} flush>
          {r.byDepot.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="transfer-per-depot">
                <TableHeader>
                  <TableRow>
                    <TableHead>Depot</TableHead>
                    <TableHead className="text-right">Transfer</TableHead>
                    <TableHead className="text-right">Nilai</TableHead>
                    <TableHead className="text-right">Dengan selisih</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.byDepot.map((x) => (
                    <TableRow key={x.outletId}>
                      <TableCell>{x.outletName}</TableCell>
                      <TableCell className="text-right">{x.transfers}</TableCell>
                      <TableCell className="text-right">{formatRupiah(x.totalValue)}</TableCell>
                      <TableCell className={`text-right ${x.differences ? "text-destructive" : ""}`}>{x.differences || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="Belum ada transfer bulan ini" compact />
          )}
        </SectionCard>
        {r.rows.length ? (
          <SectionCard title="Rincian transfer">
            <ul className="grid gap-2 text-sm" data-testid="rincian-transfer">
              {r.rows.map((t) => (
                <li key={t.id} className="rounded-md border p-3">
                  <p className="font-medium">
                    {t.number ?? t.localNumber} · {t.fromOutletName} → {t.toOutletName} · {formatTanggal(t.businessDate)}{" "}
                    <StatusBadge enumName="internal_transfer_status" value={t.status} />
                  </p>
                  <p className="text-muted-foreground">
                    {t.lines
                      .map((l) => `${l.name} ${l.quantitySent}${l.quantityReceived !== null && l.quantityReceived !== l.quantitySent ? ` (diterima ${l.quantityReceived})` : ""} ${l.unit}`)
                      .join(", ")}{" "}
                    · {formatRupiah(t.lines.reduce((s, l) => s + l.lineValue, 0))}
                  </p>
                </li>
              ))}
            </ul>
          </SectionCard>
        ) : null}
      </>
    );
  } else if (tab === "opname") {
    const rows = await m7.stockCountHistory(ctx, { outletId: storeId, fromMonth: month, toMonth: month });
    const e = exp("m7.stock_counts", { month: null, fromMonth: month, toMonth: month });
    body = (
      <SectionCard title={`Selisih opname — ${month}`} actions={<ExportButtons excelHref={e.excel} pdfHref={e.pdf} disabled={!rows.length} />} flush>
        {rows.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="riwayat-selisih">
              <TableHeader>
                <TableRow>
                  <TableHead>Barang</TableHead>
                  <TableHead className="text-right">Fisik</TableHead>
                  <TableHead className="text-right">Sistem</TableHead>
                  <TableHead className="text-right">Selisih</TableHead>
                  <TableHead className="text-right">Nilai</TableHead>
                  <TableHead>Alasan</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((x) => (
                  <TableRow key={`${x.stockCountId}-${x.productId}`}>
                    <TableCell>
                      {x.name}
                      <span className="block text-xs text-muted-foreground">{x.code}</span>
                    </TableCell>
                    <TableCell className="text-right">{x.physicalQty}</TableCell>
                    <TableCell className="text-right">{x.systemQty}</TableCell>
                    <TableCell className="text-right">
                      <SignedNumber value={x.differenceQty} />
                    </TableCell>
                    <TableCell className="text-right">
                      <SignedNumber value={x.differenceValue} money />
                    </TableCell>
                    <TableCell className="text-sm">{x.reason ? label("stock_adjust_reason", x.reason) : "—"}</TableCell>
                    <TableCell>
                      <StatusBadge enumName="stock_count_status" value={x.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="Belum ada opname bulan ini" compact />
        )}
      </SectionCard>
    );
  } else {
    const r = await m7.storeSalesForReturn(ctx, { outletId: storeId, q: sp.q ?? null });
    body = (
      <SectionCard
        title="Retur barang dari pelanggan"
        description="Untuk transaksi yang shift-nya sudah ditutup (hari yang sama: kasir memakai void di POS). Stok kembali dengan HPP saat jual; nota kredit (tempo) atau pengembalian dana (tunai/QRIS) diteruskan ke piutang. Di atas PAR-21 perlu persetujuan pemilik."
      >
        <div className="grid gap-4">
          <form action="/toko/laporan" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="tab" value="retur" />
            {storeId ? <input type="hidden" name="toko" value={storeId} /> : null}
            <label className="grid gap-1 text-xs font-medium">
              Cari nomor / pelanggan
              <input name="q" defaultValue={sp.q ?? ""} className="h-9 rounded-md border bg-background px-2 text-sm" />
            </label>
            <button type="submit" className="h-9 rounded-md border bg-background px-3 text-sm font-medium hover:bg-accent">
              Cari
            </button>
          </form>
          {r.rows.length ? (
            <ul className="grid gap-3" data-testid="transaksi-retur">
              {r.rows.map((s) => (
                <li key={s.id} className="rounded-md border p-3 text-sm">
                  <p className="font-medium">
                    {s.number ?? s.localNumber} · {formatTanggalJam(s.soldAt)} · {s.customerName ?? "Umum"} · {label("payment_method", s.paymentMethod)} · {formatRupiah(s.total)}
                  </p>
                  <p className="text-muted-foreground">{s.lines.map((l) => `${l.name} ${l.quantity}${l.returned ? ` (diretur ${l.returned})` : ""}`).join(", ")}</p>
                  {s.shiftOpen ? (
                    <p className="mt-1 text-xs text-warning-foreground">Shift masih terbuka — retur lewat void di POS.</p>
                  ) : canReturn && s.lines.some((l) => l.returnable > 0) ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer font-medium text-primary">Catat retur</summary>
                      <OutletActionForm action={storeReturnAction.bind(null, s.id)} submitLabel="Simpan retur" className="mt-2 max-w-xl">
                        <div className="grid gap-2 sm:grid-cols-2">
                          {s.lines
                            .filter((l) => l.returnable > 0)
                            .map((l) => (
                              <label key={l.productId} className="grid gap-1 text-sm">
                                {l.name} (maks. {l.returnable})
                                <input name={`ret_${l.productId}`} inputMode="numeric" className="h-9 rounded-md border bg-background px-2" />
                              </label>
                            ))}
                        </div>
                        <FormTextarea label="Alasan" name="reason" required />
                      </OutletActionForm>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Tidak ada transaksi" description="Transaksi Sah 30 hari terakhir tampil di sini." compact />
          )}
        </div>
      </SectionCard>
    );
  }

  return (
    <div className="grid gap-6">
      <PageHeader title="Laporan toko" description="Laporan bulanan toko — dapat diekspor Excel/PDF." />
      <LinkTabs label="Jenis laporan" tabs={tabs} active={tab} hrefFor={(key) => hrefWith("/toko/laporan", { ...base, tab: key })} />
      {tab !== "retur" ? (
        <StoreFilter action="/toko/laporan" stores={tab === "transfer" ? [] : stores} storeId={tab === "transfer" ? null : storeId} hidden={{ tab }}>
          <MonthInput value={month} />
        </StoreFilter>
      ) : null}
      {body}
    </div>
  );
}
