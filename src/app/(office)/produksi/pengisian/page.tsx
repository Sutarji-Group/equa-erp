import type { Metadata } from "next";
import Link from "next/link";

import { Field, M8ActionForm, SelectField, TextareaField } from "@/components/m8-production/office-form";
import { FilterForm, FilterInput, FilterSelect, Liter, M8Badge, Pct, TabLinks } from "@/components/m8-production/office-ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { addDays, formatJam, formatTanggal, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { ctxBusinessDate, type ActorContext } from "@/server/core/context";
import { getDb } from "@/server/core/db";
import { can } from "@/server/core/rbac";
import * as m8 from "@/server/modules/m8-production";

import { linkFillAction, recordDepotOpeningAction, reverseFillAction } from "../actions";

export const metadata: Metadata = { title: "Pengisian & pasokan" };

type Search = { tab?: string; tanggal?: string; dari?: string; sampai?: string; sumber?: string; depot?: string; per?: string };

function qs(params: Record<string, string | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
  return u.toString();
}

/**
 * Pengisian truk & pasokan depot (US-M8-02, US-M8-03): pengisian vs jadwal rit per truk (Dispatcher), semua pengisian
 * dengan penanda (tanpa rit, di luar rencana, ponsel cadangan, geofence) + pembalik/penautan Admin Keuangan, pasokan
 * depot tiga angka (diisi/diserahkan/diterima) + ringkasan per depot per hari/bulan, dan stok air awal depot (B-10).
 */
export default async function PengisianPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { ctx } = await requirePermission("m8.truck_fill.read");
  const sp = await searchParams;
  const today = ctxBusinessDate(ctx);
  const tab = ["semua", "pasokan", "stok-awal"].includes(sp.tab ?? "") ? sp.tab! : "jadwal";
  const date = sp.tanggal && isBusinessDate(sp.tanggal) ? sp.tanggal : today;
  const to = sp.sampai && isBusinessDate(sp.sampai) ? sp.sampai : today;
  const from = sp.dari && isBusinessDate(sp.dari) ? sp.dari : addDays(to, -6);
  const sourceId = sp.sumber || null;
  const sources = await m8.sourceOptions(ctx);
  const sourceOpts = sources.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }));
  const tabs = [
    { key: "jadwal", label: "Pengisian vs jadwal", href: `/produksi/pengisian?${qs({ tanggal: date, sumber: sourceId })}` },
    { key: "semua", label: "Semua pengisian", href: `/produksi/pengisian?${qs({ tab: "semua", dari: from, sampai: to, sumber: sourceId })}` },
    { key: "pasokan", label: "Pasokan depot", href: `/produksi/pengisian?${qs({ tab: "pasokan", dari: from, sampai: to })}` },
    { key: "stok-awal", label: "Stok air awal depot", href: "/produksi/pengisian?tab=stok-awal" },
  ];
  return (
    <div className="grid gap-6">
      <PageHeader title="Pengisian & pasokan" description="Setiap liter yang keluar dari sumber punya tujuan: satu pengisian satu rit (PTB-09); pasokan depot tercatat dari pengisian sampai konfirmasi depot (BR-33)." />
      <TabLinks tabs={tabs} active={tab} testId="tab-pengisian" />
      {tab === "jadwal" ? <ScheduleTab ctx={ctx} date={date} sourceId={sourceId} sourceOpts={sourceOpts} /> : null}
      {tab === "semua" ? <AllFillsTab ctx={ctx} from={from} to={to} sourceId={sourceId} sourceOpts={sourceOpts} /> : null}
      {tab === "pasokan" ? <SupplyTab ctx={ctx} from={from} to={to} granularity={sp.per === "bulan" ? "month" : "day"} /> : null}
      {tab === "stok-awal" ? <OpeningTab ctx={ctx} today={today} /> : null}
    </div>
  );
}

async function ScheduleTab({ ctx, date, sourceId, sourceOpts }: { ctx: ActorContext; date: string; sourceId: string | null; sourceOpts: { value: string; label: string }[] }) {
  const rows = await m8.fillsVsSchedule(ctx, { date, sourceId });
  const trips = rows.flatMap((r) => r.trips);
  const filled = trips.filter((t) => t.fill).length;
  const without = rows.reduce((a, r) => a + r.fillsWithoutTrip.length, 0);
  const exportQs = qs({ date, sourceId });
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FilterForm action="/produksi/pengisian">
          <FilterInput label="Tanggal" name="tanggal" defaultValue={date} />
          <FilterSelect label="Sumber air" name="sumber" options={sourceOpts} defaultValue={sourceId} allLabel="Semua sumber" />
        </FilterForm>
        <ExportButtons excelHref={`/api/export/m8.fills_vs_schedule?format=xlsx&${exportQs}`} pdfHref={`/api/export/m8.fills_vs_schedule?format=pdf&${exportQs}`} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Rit terjadwal" value={trips.length} />
        <KpiTile label="Rit sudah diisi" value={`${filled}/${trips.length}`} />
        <KpiTile label="Pengisian tanpa rit" value={without} tone={without ? "warning" : undefined} hint="Indikasi rit tanpa pesanan (P-01 langkah 8)" />
      </div>
      <SectionCard title={`Jadwal rit vs pengisian · ${formatTanggal(date)}`} flush>
        {rows.length === 0 ? (
          <EmptyState title="Tidak ada rit terjadwal atau pengisian" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-jadwal-isi">
              <TableHeader>
                <TableRow>
                  <TableHead>Truk</TableHead>
                  <TableHead>Rit</TableHead>
                  <TableHead>Pelanggan / depot</TableHead>
                  <TableHead>Status rit</TableHead>
                  <TableHead>Pengisian</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.flatMap((r) => [
                  ...r.trips.map((t, i) => (
                    <TableRow key={t.id}>
                      <TableCell>
                        {i === 0 ? (
                          <span className="font-medium">
                            {r.truckCode}
                            {r.plannedSourceName ? <span className="block text-xs text-muted-foreground">rencana isi: {r.plannedSourceName}</span> : null}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {t.number}
                        {t.isInternal ? <span className="block text-xs text-muted-foreground">pasokan depot</span> : null}
                      </TableCell>
                      <TableCell>{t.customerName}</TableCell>
                      <TableCell>
                        <M8Badge enumName="trip_status" value={t.status} />
                      </TableCell>
                      <TableCell>
                        {t.fill ? (
                          <span>
                            <Liter value={t.fill.volumeL} /> · {t.fill.sourceName} · {formatJam(t.fill.filledAt)}
                          </span>
                        ) : (
                          <ToneBadge tone={t.status === "assigned" ? "neutral" : "warning"}>Belum diisi</ToneBadge>
                        )}
                      </TableCell>
                    </TableRow>
                  )),
                  ...r.fillsWithoutTrip.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell>{r.trips.length === 0 ? <span className="font-medium">{r.truckCode}</span> : null}</TableCell>
                      <TableCell colSpan={3}>
                        <ToneBadge tone="warning">Pengisian tanpa rit</ToneBadge> {f.syncConflictNote ?? ""}
                      </TableCell>
                      <TableCell>
                        <Liter value={f.volumeL} /> · {f.sourceName} · {formatJam(f.filledAt)}
                      </TableCell>
                    </TableRow>
                  )),
                ])}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

async function AllFillsTab({ ctx, from, to, sourceId, sourceOpts }: { ctx: ActorContext; from: string; to: string; sourceId: string | null; sourceOpts: { value: string; label: string }[] }) {
  const rows = await m8.fillsInRange(ctx, { from, to, sourceId });
  const canFix = can(ctx, "m8.truck_fill.correct");
  const canDetail = can(ctx, "m8.water_balance.read");
  const live = rows.filter((f) => !f.reversalOfId && !f.reversedAt);
  const net = rows.reduce((a, f) => a + f.volumeL, 0);
  const exportQs = qs({ from, to, sourceId });
  // Rit terbuka per (truk, tanggal) untuk penautan pengisian tanpa rit (Admin Keuangan).
  const linkOptions = new Map<string, { value: string; label: string }[]>();
  if (canFix) {
    for (const f of live.filter((x) => !x.tripId)) {
      const key = `${f.truckId}:${f.businessDate}`;
      if (linkOptions.has(key)) continue;
      const plan = (await m8.fillsVsSchedule(ctx, { date: f.businessDate, sourceId: f.waterSourceId })).find((r) => r.truckId === f.truckId);
      linkOptions.set(key, (plan?.trips ?? []).filter((t) => !t.fill && t.status !== "failed").map((t) => ({ value: t.id, label: `${t.number} · ${t.customerName}` })));
    }
  }
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FilterForm action="/produksi/pengisian" hidden={{ tab: "semua" }}>
          <FilterInput label="Dari" name="dari" defaultValue={from} />
          <FilterInput label="Sampai" name="sampai" defaultValue={to} />
          <FilterSelect label="Sumber air" name="sumber" options={sourceOpts} defaultValue={sourceId} allLabel="Semua sumber" />
        </FilterForm>
        <ExportButtons excelHref={`/api/export/m8.truck_fills?format=xlsx&${exportQs}`} pdfHref={`/api/export/m8.truck_fills?format=pdf&${exportQs}`} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile label="Pengisian" value={live.length} />
        <KpiTile label="Volume bersih" value={<Liter value={net} />} hint="Pembalik bervolume negatif" />
        <KpiTile label="Tanpa rit" value={live.filter((f) => !f.tripId).length} tone={live.some((f) => !f.tripId) ? "warning" : undefined} />
      </div>
      <SectionCard title={`Pengisian ${formatTanggal(from)} s.d. ${formatTanggal(to)}`} flush>
        {rows.length === 0 ? (
          <EmptyState title="Belum ada pengisian" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-pengisian">
              <TableHeader>
                <TableRow>
                  <TableHead>Waktu</TableHead>
                  <TableHead>Sumber</TableHead>
                  <TableHead>Truk</TableHead>
                  <TableHead>Rit</TableHead>
                  <TableHead className="text-right">Volume</TableHead>
                  <TableHead className="text-right">Terkirim</TableHead>
                  <TableHead>Penanda</TableHead>
                  <TableHead>Pencatat</TableHead>
                  {canFix ? <TableHead>Tindakan</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((f) => {
                  const isLive = !f.reversalOfId && !f.reversedAt;
                  const opts = linkOptions.get(`${f.truckId}:${f.businessDate}`) ?? [];
                  return (
                    <TableRow key={f.id} className={isLive ? undefined : "text-muted-foreground"}>
                      <TableCell>
                        {canDetail ? (
                          <Link className="text-primary hover:underline" href={`/produksi/neraca-air/rincian?sumber=${f.waterSourceId}&tanggal=${f.businessDate}`}>
                            {formatTanggal(f.businessDate)}
                          </Link>
                        ) : (
                          formatTanggal(f.businessDate)
                        )}
                        <span className="block text-xs text-muted-foreground">{formatJam(f.filledAt)}</span>
                      </TableCell>
                      <TableCell>{f.sourceName}</TableCell>
                      <TableCell>{f.truckCode}</TableCell>
                      <TableCell>
                        {f.tripNumber ?? "—"}
                        {f.destinationName || f.customerName ? <span className="block text-xs text-muted-foreground">{f.destinationName ?? f.customerName}</span> : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <Liter value={f.volumeL} className={f.volumeL < 0 ? "text-destructive" : undefined} />
                        {f.volumeReason ? <span className="block text-xs text-muted-foreground">{f.volumeReason}</span> : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <Liter value={f.deliveredVolumeL} />
                      </TableCell>
                      <TableCell>
                        <div className="flex max-w-64 flex-wrap gap-1">
                          <M8Badge enumName="truck_fill_status" value={f.status} />
                          {f.isDepotSupply ? <ToneBadge tone="info">Pasokan depot</ToneBadge> : null}
                          {f.unplannedTruck ? <ToneBadge tone="warning">Di luar rencana</ToneBadge> : null}
                          {f.deviceSpare ? <ToneBadge tone="warning">Ponsel cadangan</ToneBadge> : null}
                          {f.lateSync ? <ToneBadge tone="muted">Sinkron terlambat</ToneBadge> : null}
                          {f.reversalOfId ? <ToneBadge tone="danger">Pembalik</ToneBadge> : null}
                          {f.reversedAt ? <ToneBadge tone="muted">Dibalik</ToneBadge> : null}
                        </div>
                        {f.syncConflictNote ? <span className="block max-w-64 text-xs text-warning-foreground">{f.syncConflictNote}</span> : null}
                      </TableCell>
                      <TableCell className="text-sm">{f.recordedByName ?? "—"}</TableCell>
                      {canFix ? (
                        <TableCell className="min-w-56">
                          {isLive ? (
                            <div className="grid gap-1">
                              {!f.tripId && opts.length ? (
                                <details>
                                  <summary className="cursor-pointer text-sm text-primary">Tautkan ke rit…</summary>
                                  <M8ActionForm action={linkFillAction.bind(null, f.id)} submitLabel="Tautkan" className="mt-2">
                                    <SelectField label="Rit" name="tripId" required placeholder="Pilih rit" options={opts} />
                                    <TextareaField label="Alasan" name="reason" required rows={2} />
                                  </M8ActionForm>
                                </details>
                              ) : null}
                              <details>
                                <summary className="cursor-pointer text-sm text-primary">Balik pengisian…</summary>
                                <M8ActionForm action={reverseFillAction.bind(null, f.id)} submitLabel="Buat pembalik" variant="destructive" className="mt-2">
                                  <TextareaField label="Alasan pembalik" name="reason" required rows={2} placeholder="Mis. pengisian ganda" />
                                </M8ActionForm>
                              </details>
                            </div>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

async function SupplyTab({ ctx, from, to, granularity }: { ctx: ActorContext; from: string; to: string; granularity: "day" | "month" }) {
  const list = await m8.depotSupplyList(ctx, { from, to });
  const summary = await m8.depotSupplySummary(ctx, { from, to, granularity });
  const rules = await m8.m8Rules(getDb(), to, ctx.tenantId);
  const exportQs = qs({ from, to });
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FilterForm action="/produksi/pengisian" hidden={{ tab: "pasokan" }}>
          <FilterInput label="Dari" name="dari" defaultValue={from} />
          <FilterInput label="Sampai" name="sampai" defaultValue={to} />
          <FilterSelect
            label="Ringkasan per"
            name="per"
            options={[
              { value: "hari", label: "Hari" },
              { value: "bulan", label: "Bulan" },
            ]}
            defaultValue={granularity === "month" ? "bulan" : "hari"}
            allLabel="Hari"
          />
        </FilterForm>
        <ExportButtons excelHref={`/api/export/m8.depot_supply?format=xlsx&${exportQs}`} pdfHref={`/api/export/m8.depot_supply?format=pdf&${exportQs}`} />
      </div>
      <SectionCard
        title={`Ringkasan pasokan per depot per ${granularity === "month" ? "bulan" : "hari"}`}
        description="Liter & jumlah rit untuk neraca air outlet (US-M6-05 KP-4) dan kemitraan (Bab 9)."
        actions={<ExportButtons excelHref={`/api/export/m8.depot_supply_summary?format=xlsx&${qs({ from, to, granularity })}`} />}
        flush
      >
        {summary.length === 0 ? (
          <EmptyState title="Belum ada pasokan selesai" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-ringkasan-pasokan">
              <TableHeader>
                <TableRow>
                  <TableHead>Periode</TableHead>
                  <TableHead>Depot</TableHead>
                  <TableHead className="text-right">Rit</TableHead>
                  <TableHead className="text-right">Diisi</TableHead>
                  <TableHead className="text-right">Diserahkan</TableHead>
                  <TableHead className="text-right">Diterima</TableHead>
                  <TableHead className="text-right">Selisih</TableHead>
                  <TableHead className="text-right">Nilai transfer</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.map((s) => (
                  <TableRow key={`${s.period}:${s.outletId}`}>
                    <TableCell>{s.period.length === 10 ? formatTanggal(s.period) : s.period}</TableCell>
                    <TableCell>
                      {s.outletCode} · {s.outletName}
                    </TableCell>
                    <TableCell className="text-right">{s.trips}</TableCell>
                    <TableCell className="text-right">
                      <Liter value={s.filledL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={s.deliveredL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={s.receivedL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={s.differenceL} className={s.outOfToleranceCount ? "text-destructive" : undefined} />
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={s.transferValue} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
      <SectionCard title="Pasokan per rit (tiga angka)" description={`Diisi di sumber · diserahkan sopir · diterima operator depot. Selisih diisi − diterima > ${rules.supplyTolerancePct}% (PAR-69) ditandai.`} flush>
        {list.length === 0 ? (
          <EmptyState title="Belum ada rit pasokan depot" compact />
        ) : (
          <div className="overflow-x-auto">
            <Table data-testid="tabel-pasokan">
              <TableHeader>
                <TableRow>
                  <TableHead>Tanggal</TableHead>
                  <TableHead>Rit</TableHead>
                  <TableHead>Depot</TableHead>
                  <TableHead>Truk · sumber</TableHead>
                  <TableHead className="text-right">Diisi</TableHead>
                  <TableHead className="text-right">Diserahkan</TableHead>
                  <TableHead className="text-right">Diterima</TableHead>
                  <TableHead className="text-right">Selisih</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Nilai transfer</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((s) => (
                  <TableRow key={s.tripId}>
                    <TableCell>{formatTanggal(s.businessDate)}</TableCell>
                    <TableCell>{s.tripNumber}</TableCell>
                    <TableCell>{s.outletName}</TableCell>
                    <TableCell>
                      {s.truckCode ?? "—"} · {s.sourceName ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={s.filledL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={s.deliveredL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={s.receivedL} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Liter value={s.differenceL} className={s.outOfTolerance ? "font-semibold text-destructive" : undefined} />
                      {s.differencePct !== null ? (
                        <span className="block text-xs">
                          <Pct value={s.differencePct} danger={s.outOfTolerance} />
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <M8Badge enumName="trip_status" value={s.tripStatus} />
                      {s.receiptStatus ? <span className="block text-xs text-muted-foreground">{label("water_supply_status", s.receiptStatus)}</span> : null}
                    </TableCell>
                    <TableCell className="text-right">{s.transferValue !== null ? <MoneyText value={s.transferValue} /> : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

async function OpeningTab({ ctx, today }: { ctx: ActorContext; today: string }) {
  const rows = await m8.depotWaterOpenings(ctx);
  const canRecord = can(ctx, "m8.depot_water_opening.create");
  const pending = rows.filter((r) => !r.opening);
  return (
    <div className="grid gap-4">
      <SectionCard title="Stok air awal depot (cut-over)" description="Air di toren depot saat mulai memakai sistem — dasar stok air depot = stok awal + diterima − galon terjual (US-M6-05 KP-3). Dicatat sekali per depot; salah catat dikoreksi lewat penyesuaian stok air depot." flush>
        <div className="overflow-x-auto">
          <Table data-testid="tabel-stok-awal">
            <TableHeader>
              <TableRow>
                <TableHead>Depot</TableHead>
                <TableHead className="text-right">Kapasitas toren</TableHead>
                <TableHead className="text-right">Stok awal</TableHead>
                <TableHead>Tanggal</TableHead>
                <TableHead className="text-right">Stok air saat ini</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.outletId}>
                  <TableCell>
                    {r.outletCode} · {r.outletName}
                  </TableCell>
                  <TableCell className="text-right">
                    <Liter value={r.storageCapacityL} />
                  </TableCell>
                  <TableCell className="text-right">{r.opening ? <Liter value={r.opening.volumeL} /> : <ToneBadge tone="warning">Belum dicatat</ToneBadge>}</TableCell>
                  <TableCell>{r.opening ? formatTanggal(r.opening.businessDate) : "—"}</TableCell>
                  <TableCell className="text-right">
                    <Liter value={r.currentBalanceL} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
      {canRecord && pending.length ? (
        <SectionCard title="Catat stok air awal">
          <M8ActionForm action={recordDepotOpeningAction} submitLabel="Simpan stok awal" testId="form-stok-awal" className="sm:grid-cols-2">
            <SelectField label="Depot" name="outletId" required placeholder="Pilih depot" options={pending.map((r) => ({ value: r.outletId, label: `${r.outletCode} · ${r.outletName}` }))} />
            <Field label="Jumlah air (L)" name="volumeL" inputMode="numeric" required />
            <Field label="Tanggal cut-over" name="businessDate" type="date" defaultValue={today} />
            <TextareaField label="Dasar angka" name="reason" required rows={2} placeholder="Mis. hasil ukur toren bersama operator depot" />
          </M8ActionForm>
        </SectionCard>
      ) : null}
    </div>
  );
}
