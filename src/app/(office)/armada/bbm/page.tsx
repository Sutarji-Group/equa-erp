import type { Metadata } from "next";
import Link from "next/link";

import { formatDistance } from "@/components/m12-fleet/ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, monthOf, toBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m12 from "@/server/modules/m12-fleet";

export const metadata: Metadata = { title: "BBM & zona" };

/**
 * Estimasi biaya BBM per rit & pemeriksaan zona (US-M12-07, S — RL-6): jarak GPS × konsumsi × harga BBM (PAR-53,
 * ditetapkan pemilik) per rit, per truk (vs BBM nyata dari pengeluaran rit M3) dan per zona; alamat yang jarak GPS
 * aktualnya masuk zona lain beserta selisih tarif. Tidak ada penyesuaian otomatis (zona hanya lewat US-M1-05).
 */
export default async function BbmPage({ searchParams }: PageProps<"/armada/bbm">) {
  const { ctx } = await requirePermission("m12.fuel_estimate.read");
  const sp = await searchParams;
  const month = typeof sp.bulan === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.bulan) ? sp.bulan : monthOf(toBusinessDate(ctx.now));
  const tab = sp.tampil === "zona" ? "zona" : "bbm";
  const [fuel, zones] = await Promise.all([m12.fuelMonthly(ctx, { month }), tab === "zona" ? m12.zoneCheck(ctx) : null]);
  const canParams = can(ctx, "m10.parameter.update") || can(ctx, "m10.parameter.read");

  return (
    <div className="grid gap-6">
      <PageHeader
        title="BBM & zona"
        description="Estimasi biaya BBM per rit dari jarak GPS, dibanding BBM nyata; pemeriksaan zona tarif dari jarak aktual. Informasi — tidak menyesuaikan otomatis."
        actions={
          <form method="get" className="flex items-center gap-2">
            <input type="hidden" name="tampil" value={tab} />
            <input type="month" name="bulan" defaultValue={month} aria-label="Bulan" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" />
            <Button type="submit" variant="outline" size="sm">
              Tampilkan
            </Button>
          </form>
        }
      />

      <nav className="flex flex-wrap gap-2" aria-label="Tampilan">
        <Button asChild size="sm" variant={tab === "bbm" ? "default" : "outline"}>
          <Link href={`/armada/bbm?bulan=${month}`}>Biaya BBM per rit</Link>
        </Button>
        <Button asChild size="sm" variant={tab === "zona" ? "default" : "outline"}>
          <Link href={`/armada/bbm?tampil=zona&bulan=${month}`}>Pemeriksaan zona</Link>
        </Button>
      </nav>

      {!fuel.configured ? (
        <Alert>
          <AlertTitle>Konsumsi & harga BBM belum ditetapkan</AlertTitle>
          <AlertDescription>
            Estimasi biaya BBM dihitung setelah pemilik menetapkan PAR-53 (konsumsi L/km dan harga per liter).
            {canParams ? (
              <>
                {" "}
                <Link href="/pengaturan/parameter" className="text-primary underline">
                  Buka parameter
                </Link>
                .
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {tab === "bbm" ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile label="Rit berestimasi" value={String(fuel.totals.trips)} hint={fuel.configured ? `${fuel.consumptionLPerKm?.toLocaleString("id-ID")} L/km × ${formatRupiah(fuel.pricePerL ?? 0)}/L` : "PAR-53 belum ditetapkan"} />
            <KpiTile label="Jarak" value={formatDistance(fuel.totals.distanceM)} />
            <KpiTile label="Estimasi biaya BBM" value={<MoneyText value={fuel.totals.estimatedCost} />} />
            <KpiTile label="BBM nyata − estimasi" value={<MoneyText value={fuel.totals.difference} />} hint={`BBM nyata ${formatRupiah(fuel.totals.actualFuel)} (pengeluaran rit)`} tone={fuel.totals.difference > 0 ? "warning" : undefined} />
          </div>

          <SectionCard title="Per truk" description="Selisih hanya ditampilkan — tidak menyesuaikan otomatis." actions={<ExportButtons excelHref={`/api/export/m12.fuel_trucks?format=xlsx&month=${month}`} pdfHref={`/api/export/m12.fuel_trucks?format=pdf&month=${month}`} />} flush>
            {fuel.byTruck.length === 0 ? (
              <EmptyState compact title="Belum ada estimasi atau BBM nyata bulan ini" />
            ) : (
              <div className="overflow-x-auto">
                <Table data-testid="bbm-truk">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Truk</TableHead>
                      <TableHead className="text-right">Rit</TableHead>
                      <TableHead className="text-right">Jarak</TableHead>
                      <TableHead className="text-right">BBM (L)</TableHead>
                      <TableHead className="text-right">Estimasi</TableHead>
                      <TableHead className="text-right">BBM nyata</TableHead>
                      <TableHead className="text-right">Selisih</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fuel.byTruck.map((r) => (
                      <TableRow key={r.truckId}>
                        <TableCell className="font-medium">{r.truckCode}</TableCell>
                        <TableCell className="text-right">{r.trips}</TableCell>
                        <TableCell className="text-right">{formatDistance(r.distanceM)}</TableCell>
                        <TableCell className="text-right">{r.liters.toLocaleString("id-ID")}</TableCell>
                        <TableCell className="text-right">{formatRupiah(r.estimatedCost)}</TableCell>
                        <TableCell className="text-right">{formatRupiah(r.actualFuel)}</TableCell>
                        <TableCell className="text-right">{formatRupiah(r.difference, { signed: true })}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>

          <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
            <SectionCard title="Per zona" actions={<ExportButtons excelHref={`/api/export/m12.fuel_zones?format=xlsx&month=${month}`} />} flush>
              {fuel.byZone.length === 0 ? (
                <EmptyState compact title="Belum ada" />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Zona</TableHead>
                        <TableHead className="text-right">Rit</TableHead>
                        <TableHead className="text-right">Rata-rata/rit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fuel.byZone.map((z) => (
                        <TableRow key={z.zoneId ?? "-"}>
                          <TableCell>{z.zoneCode}</TableCell>
                          <TableCell className="text-right">{z.trips}</TableCell>
                          <TableCell className="text-right">{formatRupiah(z.avgCostPerTrip)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </SectionCard>
            <SectionCard title="Per rit" actions={<ExportButtons excelHref={`/api/export/m12.fuel_monthly?format=xlsx&month=${month}`} pdfHref={`/api/export/m12.fuel_monthly?format=pdf&month=${month}`} />} flush>
              {fuel.trips.length === 0 ? (
                <EmptyState compact title="Belum ada estimasi per rit" />
              ) : (
                <div className="max-h-[480px] overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tanggal</TableHead>
                        <TableHead>Rit</TableHead>
                        <TableHead>Truk</TableHead>
                        <TableHead>Zona</TableHead>
                        <TableHead className="text-right">Jarak</TableHead>
                        <TableHead className="text-right">Estimasi</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fuel.trips.map((t) => (
                        <TableRow key={t.tripId}>
                          <TableCell>{formatTanggal(t.date, { weekday: false })}</TableCell>
                          <TableCell>{t.number}</TableCell>
                          <TableCell>{t.truckCode}</TableCell>
                          <TableCell>{t.zoneCode}</TableCell>
                          <TableCell className="text-right">{formatDistance(t.distanceM)}</TableCell>
                          <TableCell className="text-right">{formatRupiah(t.estimatedCost)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </SectionCard>
          </div>
        </>
      ) : (
        <SectionCard
          title={`Alamat yang jarak GPS-nya masuk zona lain (${zones?.rows.length ?? 0})`}
          description={`Rata-rata jarak GPS ${zones?.tripCount ?? 3} rit terakhir per alamat dibanding batas zona. Ubah zona hanya lewat Data master > Zona (persetujuan pemilik).`}
          actions={<ExportButtons excelHref="/api/export/m12.zone_check?format=xlsx" />}
          flush
        >
          {!zones || zones.rows.length === 0 ? (
            <EmptyState compact title="Semua alamat sesuai zonanya" />
          ) : (
            <div className="overflow-x-auto">
              <Table data-testid="cek-zona">
                <TableHeader>
                  <TableRow>
                    <TableHead>Pelanggan</TableHead>
                    <TableHead>Zona alamat</TableHead>
                    <TableHead className="text-right">Jarak rute (M1)</TableHead>
                    <TableHead className="text-right">Rata-rata GPS</TableHead>
                    <TableHead>Zona dari GPS</TableHead>
                    <TableHead className="text-right">Selisih tarif/rit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {zones.rows.map((r) => (
                    <TableRow key={r.addressId}>
                      <TableCell>
                        <Link href={`/master/pelanggan/${r.customerId}`} className="font-medium text-primary hover:underline">
                          {r.customerName}
                        </Link>
                        <span className="block text-xs text-muted-foreground">{r.addressLabel}</span>
                      </TableCell>
                      <TableCell>{r.currentZoneCode ?? "—"}</TableCell>
                      <TableCell className="text-right">{formatDistance(r.routeDistanceM)}</TableCell>
                      <TableCell className="text-right">
                        {formatDistance(r.avgGpsDistanceM)} <span className="text-xs text-muted-foreground">({r.tripsUsed} rit)</span>
                      </TableCell>
                      <TableCell>
                        <ToneBadge tone="warning">{r.actualZoneCode ?? "—"}</ToneBadge>
                      </TableCell>
                      <TableCell className="text-right">{r.tariffDifference === null ? "—" : formatRupiah(r.tariffDifference, { signed: true })}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>
      )}
    </div>
  );
}
