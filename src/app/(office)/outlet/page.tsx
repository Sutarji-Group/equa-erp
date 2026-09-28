import type { Metadata } from "next";
import Link from "next/link";

import { OutletActionForm, Field } from "@/components/m6-pos/office-form";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRupiah } from "@/lib/money";
import { formatJam, formatTanggal, formatTanggalJam, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m6 from "@/server/modules/m6-pos";

import { resolveConflictAction } from "./actions";

export const metadata: Metadata = { title: "Pemantauan outlet" };

/**
 * Pemantauan outlet (M6/M7 kantor): per depot/toko hari ini — shift & kas berjalan (PAR-02), penjualan & galon, QRIS,
 * void (jumlah & nilai per hari, US-M6-03 KP-3), pasokan air menunggu, stok air & kapasitas, opname minggu ini,
 * konflik shift & pembalik yang perlu dibuat Admin Keuangan. Berlingkup tenant (NFR-30).
 */
export default async function OutletPage({ searchParams }: { searchParams: Promise<{ tanggal?: string }> }) {
  const { ctx } = await requirePermission("m6.outlet.read");
  const sp = await searchParams;
  const date = sp.tanggal && isBusinessDate(sp.tanggal) ? sp.tanggal : undefined;
  const { date: day, rows } = await m6.listOutletsOverview(ctx, { date });
  const conflicts = await m6.listShiftConflicts(ctx);
  const canResolve = can(ctx, "m6.shift_conflict.resolve");
  const totals = rows.reduce(
    (a, r) => ({ sales: a.sales + r.today.salesTotal, gallons: a.gallons + r.today.gallons, qris: a.qris + r.today.qrisSales, voids: a.voids + r.today.voidCount }),
    { sales: 0, gallons: 0, qris: 0, voids: 0 },
  );
  const reversals = rows.reduce((a, r) => a + r.pendingReversals, 0);

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Pemantauan outlet"
        description={`Depot & toko tenant Anda — ${formatTanggal(day)}. Angka berjalan; shift yang belum ditutup dapat berubah.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <form className="flex items-center gap-2" action="/outlet">
              <input type="date" name="tanggal" defaultValue={day} className="h-9 rounded-md border px-2 text-sm" aria-label="Tanggal" />
              <button type="submit" className="h-9 rounded-md border px-3 text-sm">
                Tampilkan
              </button>
            </form>
            <ExportButtons excelHref={`/api/export/m6.outlet_daily?format=xlsx&from=${day}&to=${day}`} pdfHref={`/api/export/m6.outlet_daily?format=pdf&from=${day}&to=${day}`} />
          </div>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Penjualan outlet" value={<MoneyText value={totals.sales} />} unclosed={rows.some((r) => r.openShift)} />
        <KpiTile label="Galon terjual" value={`${totals.gallons.toLocaleString("id-ID")} galon`} />
        <KpiTile label="QRIS (bukan kas fisik)" value={<MoneyText value={totals.qris} />} />
        <KpiTile label="Void hari ini" value={totals.voids} tone={totals.voids ? "warning" : undefined} hint={reversals ? `${reversals} void disetujui menunggu pembalik` : undefined} />
      </div>
      <SectionCard title="Outlet" description="Klik nama outlet untuk rincian shift, transaksi, stok bahan, pasokan air, opname, dan pengaturan.">
        <div className="overflow-x-auto">
          <Table data-testid="tabel-outlet">
            <TableHeader>
              <TableRow>
                <TableHead>Outlet</TableHead>
                <TableHead>Shift</TableHead>
                <TableHead className="text-right">Kas berjalan</TableHead>
                <TableHead className="text-right">Penjualan</TableHead>
                <TableHead className="text-right">Galon</TableHead>
                <TableHead className="text-right">QRIS</TableHead>
                <TableHead className="text-right">Void</TableHead>
                <TableHead>Air & pasokan</TableHead>
                <TableHead>Opname minggu ini</TableHead>
                <TableHead>Tindak lanjut</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.outlet.id}>
                  <TableCell>
                    <Link href={`/outlet/${r.outlet.id}`} className="font-medium text-primary hover:underline">
                      {r.outlet.code} · {r.outlet.name}
                    </Link>
                    <div>
                      <StatusBadge enumName="outlet_kind" value={r.outlet.kind} dot={false} />
                    </div>
                  </TableCell>
                  <TableCell>
                    {r.openShift ? (
                      <span>
                        <ToneBadge tone={r.openShift.syncConflict ? "danger" : "success"}>{r.openShift.syncConflict ? "Konflik" : "Terbuka"}</ToneBadge>
                        <span className="block text-xs text-muted-foreground">
                          {r.openShift.operatorName ?? "—"} · {formatJam(r.openShift.openedAt)}
                        </span>
                      </span>
                    ) : (
                      <ToneBadge tone="muted">Tidak ada</ToneBadge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {r.openShift ? (
                      <span className={r.openShift.overLimit ? "font-semibold text-destructive" : undefined}>
                        {formatRupiah(r.openShift.runningCash)}
                        {r.openShift.overLimit ? <span className="block text-xs">&gt; {formatRupiah(r.cashLimit)}</span> : null}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right">{formatRupiah(r.today.salesTotal)}</TableCell>
                  <TableCell className="text-right">{r.today.gallons}</TableCell>
                  <TableCell className="text-right">{formatRupiah(r.today.qrisSales)}</TableCell>
                  <TableCell className="text-right">
                    <span className={r.today.voidCount > r.voidDailyCount ? "font-semibold text-destructive" : undefined}>
                      {r.today.voidCount} · {formatRupiah(r.today.voidAmount)}
                    </span>
                    {r.today.voidPending ? <span className="block text-xs text-warning-foreground">{r.today.voidPending} menunggu persetujuan</span> : null}
                  </TableCell>
                  <TableCell>
                    {r.waterStockL !== null ? (
                      <span className={r.overCapacity ? "text-destructive" : undefined}>
                        {r.waterStockL.toLocaleString("id-ID")} L{r.overCapacity ? " (melebihi kapasitas)" : ""}
                      </span>
                    ) : (
                      "—"
                    )}
                    {r.pendingSupplies ? <span className="block text-xs text-warning-foreground">{r.pendingSupplies} pasokan belum dikonfirmasi</span> : null}
                  </TableCell>
                  <TableCell>
                    {r.outlet.kind === "depot" ? (
                      r.stockCountThisWeek === "none" ? (
                        <ToneBadge tone="warning">Belum</ToneBadge>
                      ) : (
                        <StatusBadge enumName="stock_count_status" value={r.stockCountThisWeek} />
                      )
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {[r.openConflicts ? `${r.openConflicts} konflik shift` : null, r.pendingReversals ? `${r.pendingReversals} pembalik` : null, r.lateDeposits ? `${r.lateDeposits} setoran terlambat` : null]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
      {conflicts.length ? (
        <SectionCard title="Konflik shift (perangkat cadangan)" description="Shift dibuka offline saat shift lain masih terbuka. Data lapangan tetap sah — cocokkan lalu tandai ditinjau.">
          <ul className="grid gap-3" data-testid="konflik-shift">
            {conflicts.map((c) => (
              <li key={c.shift.id} className="rounded-md border p-3 text-sm">
                <p className="font-medium">
                  <Link href={`/outlet/shift/${c.shift.id}`} className="text-primary hover:underline">
                    {c.outletName} · {formatTanggalJam(c.shift.openedAt)}
                  </Link>{" "}
                  · {c.operatorName ?? "—"}
                </p>
                <p className="text-muted-foreground">{c.shift.syncConflictNote}</p>
                {canResolve ? (
                  <OutletActionForm action={resolveConflictAction.bind(null, c.shift.id)} submitLabel="Tandai sudah ditinjau" variant="outline" className="mt-2">
                    <Field label="Catatan peninjauan" name="note" required />
                  </OutletActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
