import type { Metadata } from "next";

import { Field, OutletActionForm } from "@/components/m6-pos/office-form";
import { SignedNumber } from "@/components/m6-pos/office-ui";
import { EmptyState } from "@/components/shared/empty-state";
import { KeyValueList } from "@/components/shared/key-value-list";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatJam, formatTanggal, formatTanggalJam } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m6 from "@/server/modules/m6-pos";

import { resolveConflictAction, reverseSaleAction } from "../../actions";

export const metadata: Metadata = { title: "Rincian shift" };

/**
 * Rincian shift POS: angka per cara bayar, void, setoran (akhir + sebagian), hitung stok awal/akhir, status sinkron
 * (US-M6-06 KP-3: setoran tidak diterima sebelum semua transaksi shift tersinkron), dan pembalik oleh Admin Keuangan.
 */
export default async function ShiftDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requirePermission("m6.outlet.read");
  const { id } = await params;
  const d = await m6.getShiftDetail(ctx, id);
  const s = d.shift;
  const f = d.figures;
  const closed = s.status === "closed";
  const canReverse = can(ctx, "m6.pos_sale.correct");
  const canResolve = can(ctx, "m6.shift_conflict.resolve");
  const summary = (s.summary ?? {}) as { stock?: { productId: string; name: string; expectedUsage: number | null }[] };
  const usage = (summary.stock ?? []).filter((u) => u.expectedUsage);

  return (
    <div className="grid gap-6">
      <PageHeader
        title={`Shift ${d.outlet.code} · ${formatTanggal(s.businessDate)}`}
        backHref={`/outlet/${d.outlet.id}?tab=shift`}
        backLabel={d.outlet.name}
        description={`${d.operatorName ?? "—"} · dibuka ${formatTanggalJam(s.openedAt)}${s.closedAt ? ` · ditutup ${formatTanggalJam(s.closedAt)}` : ""}`}
        meta={
          <>
            <StatusBadge enumName="shift_status" value={s.status} />
            <StatusBadge enumName="shift_deposit_status" value={s.depositStatus} />
            {s.syncConflict ? <ToneBadge tone={s.conflictResolvedAt ? "muted" : "danger"}>Konflik{s.conflictResolvedAt ? " (ditinjau)" : ""}</ToneBadge> : null}
          </>
        }
      />

      {!d.sync.fullySynced ? (
        <Alert role="alert" data-testid="menunggu-sinkron">
          <AlertDescription>
            Menunggu sinkron: {d.sync.missingSaleIds.length} transaksi dan {d.sync.missingVoidIds.length} void yang dilaporkan perangkat saat tutup shift belum
            diterima server. Setoran shift ini belum boleh diterima Kasir Kantor.
          </AlertDescription>
        </Alert>
      ) : null}

      {s.syncConflict && !s.conflictResolvedAt ? (
        <SectionCard title="Konflik shift" description={s.syncConflictNote ?? "Shift dibuka saat shift lain di outlet masih terbuka."}>
          {canResolve ? (
            <OutletActionForm action={resolveConflictAction.bind(null, s.id)} submitLabel="Tandai sudah ditinjau" variant="outline">
              <Field label="Catatan peninjauan" name="note" required />
            </OutletActionForm>
          ) : (
            <p className="text-sm text-muted-foreground">Admin Keuangan akan meninjau konflik ini.</p>
          )}
        </SectionCard>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Penjualan dihitung" value={<MoneyText value={f.salesTotal} />} unclosed={!closed} hint={`${f.countedCount} transaksi · ${f.gallonsSold} galon`} />
        <KpiTile label="Tunai" value={<MoneyText value={f.cashSales} />} hint={`Kas di laci seharusnya ${formatRupiah(f.expectedDrawer)}`} />
        <KpiTile label="QRIS" value={<MoneyText value={f.qrisSales} />} hint={`${f.qrisCount} transaksi — bukan kas fisik`} />
        <KpiTile label="Void" value={`${f.voidCount} · ${formatRupiah(f.voidAmount)}`} tone={f.voidPendingCount ? "warning" : undefined} hint={f.voidPendingCount ? `${f.voidPendingCount} menunggu (${formatRupiah(f.voidPendingAmount)})` : undefined} />
      </div>

      <SectionCard title="Kas & setoran">
        <KeyValueList
          columns={3}
          items={[
            { label: "Kas awal tetap", value: formatRupiah(s.openingCashFixed), hint: s.openingCashCounted !== null && s.openingCashCounted !== s.openingCashFixed ? `Dihitung ${formatRupiah(s.openingCashCounted)}` : undefined },
            { label: "Tunai seharusnya", value: formatRupiah(closed && s.expectedCash !== null ? s.expectedCash : f.expectedCash) },
            { label: "Setor sebagian", value: formatRupiah(s.partialDepositTotal) },
            { label: "Kas dihitung saat tutup", value: s.closingCashCounted === null ? null : formatRupiah(s.closingCashCounted) },
            { label: "Selisih kas", value: <SignedNumber value={s.cashDifference} money />, hint: s.cashDifferenceReason ?? undefined },
            { label: "Setoran akhir", value: s.depositAmount === null ? formatRupiah(f.depositAmount) : formatRupiah(s.depositAmount), hint: s.depositedAt ? `Diserahkan ${formatTanggalJam(s.depositedAt)}` : undefined },
          ]}
        />
        {d.deposits.length ? (
          <ul className="mt-4 grid gap-2 text-sm" data-testid="daftar-setoran">
            {d.deposits.map((dep) => (
              <li key={dep.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                <span>
                  {dep.number} · {dep.isPartial ? "Setor sebagian" : "Setoran akhir shift"} · {formatRupiah(dep.expectedCash)}
                </span>
                <StatusBadge enumName="deposit_status" value={dep.status} />
              </li>
            ))}
          </ul>
        ) : null}
      </SectionCard>

      <SectionCard title="Transaksi shift" description="Nomor lokal perangkat dipertahankan di samping nomor resmi.">
        {d.sales.length ? (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-transaksi-shift">
              <TableHeader>
                <TableRow>
                  <TableHead>Nomor</TableHead>
                  <TableHead>Jam</TableHead>
                  <TableHead>Rincian</TableHead>
                  <TableHead>Cara bayar</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Status</TableHead>
                  {canReverse && closed ? <TableHead>Tindakan</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.sales.map((sale) => (
                  <TableRow key={sale.id}>
                    <TableCell>
                      <span className="font-medium">{sale.number ?? "—"}</span>
                      <span className="block text-xs text-muted-foreground">{sale.localNumber}</span>
                    </TableCell>
                    <TableCell>{formatJam(sale.soldAt)}</TableCell>
                    <TableCell className="text-xs">
                      {sale.lines.map((l) => `${l.productName} × ${l.quantity}`).join(", ")}
                      {sale.voidReason ? (
                        <span className="block text-muted-foreground">
                          Void: {label("void_reason", sale.voidReason)}
                          {sale.voidNote ? ` — ${sale.voidNote}` : ""}
                          {sale.approval ? ` · persetujuan ${sale.approval.number} (${label("approval_status", sale.approval.status)})` : ""}
                        </span>
                      ) : null}
                      {sale.reversalReason ? <span className="block text-muted-foreground">{sale.reversalReason}</span> : null}
                    </TableCell>
                    <TableCell>{label("payment_method", sale.paymentMethod)}</TableCell>
                    <TableCell className="text-right">{sale.isReversal ? <SignedNumber value={sale.total} money /> : formatRupiah(sale.total)}</TableCell>
                    <TableCell>
                      {sale.isReversal ? <ToneBadge tone="info">Pembalik</ToneBadge> : <StatusBadge enumName="pos_sale_status" value={sale.status} />}
                      {!sale.counted && !sale.isReversal ? <span className="block text-xs text-muted-foreground">tidak dihitung</span> : null}
                    </TableCell>
                    {canReverse && closed ? (
                      <TableCell>
                        {!sale.isReversal && sale.status !== "voided" && !sale.reversalReason ? (
                          <OutletActionForm action={reverseSaleAction.bind(null, sale.id, s.id)} submitLabel="Buat pembalik" variant="outline">
                            <Field label="Alasan" name="reason" required />
                          </OutletActionForm>
                        ) : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState compact title="Belum ada transaksi tersinkron" />
        )}
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <SectionCard title="Penjualan per produk">
          {f.byProduct.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produk</TableHead>
                  <TableHead className="text-right">Jumlah</TableHead>
                  <TableHead className="text-right">Nilai</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {f.byProduct.map((p) => (
                  <TableRow key={p.productId}>
                    <TableCell>{p.name}</TableCell>
                    <TableCell className="text-right">
                      {p.quantity} {p.unit}
                    </TableCell>
                    <TableCell className="text-right">{formatRupiah(p.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState compact title="Belum ada penjualan" />
          )}
        </SectionCard>
        <SectionCard title="Hitung stok bahan" description="Awal & akhir shift; selisih di atas toleransi wajib beralasan.">
          {d.stock.length ? (
            <Table data-testid="tabel-stok-shift">
              <TableHeader>
                <TableRow>
                  <TableHead>Bahan</TableHead>
                  <TableHead>Saat</TableHead>
                  <TableHead className="text-right">Sistem</TableHead>
                  <TableHead className="text-right">Fisik</TableHead>
                  <TableHead className="text-right">Selisih</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.stock.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      {c.productName}
                      {c.reason ? <span className="block text-xs text-muted-foreground">{c.reason}</span> : null}
                    </TableCell>
                    <TableCell>{label("shift_stock_phase", c.phase)}</TableCell>
                    <TableCell className="text-right">{c.systemQty}</TableCell>
                    <TableCell className="text-right">{c.physicalQty ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <SignedNumber value={c.difference} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState compact title="Belum ada hitung stok" />
          )}
          {usage.length ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Pemakaian bahan seharusnya (resep × penjualan, diposting saat tutup): {usage.map((u) => `${u.name} ${u.expectedUsage}`).join(", ")}
            </p>
          ) : null}
        </SectionCard>
      </div>
    </div>
  );
}
