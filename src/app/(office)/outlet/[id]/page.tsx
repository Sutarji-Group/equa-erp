import type { Metadata } from "next";
import Link from "next/link";

import { Field, OutletActionForm } from "@/components/m6-pos/office-form";
import { LinkTabs, SignedNumber } from "@/components/m6-pos/office-ui";
import { EmptyState } from "@/components/shared/empty-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KeyValueList } from "@/components/shared/key-value-list";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { addDays, formatJam, formatTanggal, formatTanggalJam, isBusinessDate } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m6 from "@/server/modules/m6-pos";

import { reverseSaleAction, setThresholdAction, updateSettingsAction } from "../actions";

export const metadata: Metadata = { title: "Rincian outlet" };

const TABS = [
  { key: "ringkasan", label: "Ringkasan" },
  { key: "shift", label: "Shift" },
  { key: "transaksi", label: "Transaksi" },
  { key: "stok", label: "Stok bahan" },
  { key: "air", label: "Pasokan air" },
  { key: "opname", label: "Opname" },
  { key: "pengaturan", label: "Pengaturan" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const THRESHOLD_LABELS: Record<m6.OutletThresholdKey, string> = {
  "PAR-02": "PAR-02 Kas maksimal di outlet (Rp)",
  "PAR-03": "PAR-03 Batas void per hari (kejadian)",
  "PAR-04": "PAR-04 Void di atas nilai ini perlu persetujuan (Rp)",
  "PAR-57": "PAR-57 Kas awal tetap (Rp)",
  "PAR-58": "PAR-58 Toleransi selisih stok bahan per hari (buah)",
  "PAR-59": "PAR-59 Toleransi neraca air (%)",
};

/** Rincian outlet (M6 kantor): shift, transaksi, stok bahan, pasokan air, opname, pengaturan POS & ambang per outlet. */
export default async function OutletDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; tanggal?: string }> }) {
  const { ctx } = await requirePermission("m6.outlet.read");
  const { id } = await params;
  const sp = await searchParams;
  const date = sp.tanggal && isBusinessDate(sp.tanggal) ? sp.tanggal : undefined;
  const d = await m6.getOutletDetail(ctx, id, { date });
  const tab: TabKey = TABS.some((t) => t.key === sp.tab) ? (sp.tab as TabKey) : "ringkasan";
  const isDepot = d.outlet.kind === "depot";
  const canReverse = can(ctx, "m6.pos_sale.correct");
  const canSettings = can(ctx, "m6.outlet_settings.update");
  const openShift = d.shifts.find((s) => s.status === "open");
  const pendingSupplies = d.supplies.filter((s) => s.status === "arrived").length;
  const qs = (key: string) => `/outlet/${d.outlet.id}?tab=${key}${date ? `&tanggal=${date}` : ""}`;
  const tabs = TABS.filter((t) => isDepot || (t.key !== "air" && t.key !== "stok")).map((t) => ({
    ...t,
    count: t.key === "transaksi" ? d.pendingReversals.length : t.key === "air" ? pendingSupplies : undefined,
  }));

  return (
    <div className="grid gap-6">
      <PageHeader
        title={`${d.outlet.code} · ${d.outlet.name}`}
        backHref="/outlet"
        backLabel="Pemantauan outlet"
        description={`${label("outlet_kind", d.outlet.kind)} · ${formatTanggal(d.date)}${d.outlet.address ? ` · ${d.outlet.address}` : ""}`}
        meta={d.outlet.isActive ? <ToneBadge tone="success">Aktif</ToneBadge> : <ToneBadge tone="muted">Nonaktif</ToneBadge>}
        actions={
          <form className="flex items-center gap-2" action={`/outlet/${d.outlet.id}`}>
            <input type="hidden" name="tab" value={tab} />
            <input type="date" name="tanggal" defaultValue={d.date} className="h-9 rounded-md border px-2 text-sm" aria-label="Tanggal" />
            <button type="submit" className="h-9 rounded-md border px-3 text-sm">
              Tampilkan
            </button>
          </form>
        }
      />
      <LinkTabs tabs={tabs} active={tab} hrefFor={qs} label="Bagian rincian outlet" />

      {tab === "ringkasan" ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiTile label="Penjualan" value={<MoneyText value={d.salesToday?.salesTotal ?? 0} />} unclosed={Boolean(openShift)} hint={`${d.salesToday?.transactions ?? 0} transaksi`} />
            <KpiTile label="Galon terjual" value={`${(d.salesToday?.gallons ?? 0).toLocaleString("id-ID")} galon`} hint={`${(d.salesToday?.gallonLiters ?? 0).toLocaleString("id-ID")} L`} />
            <KpiTile label="QRIS" value={<MoneyText value={d.salesToday?.qrisSales ?? 0} />} hint="Bukan kas fisik" />
            <KpiTile
              label="Void"
              value={`${d.voidsToday?.voidCount ?? 0} · ${formatRupiah(d.voidsToday?.voidAmount ?? 0)}`}
              tone={(d.voidsToday?.voidCount ?? 0) > d.settings.voidDailyCount ? "danger" : undefined}
              hint={`Batas ${d.settings.voidDailyCount} per hari (PAR-03)${d.voidsToday?.pendingCount ? ` · ${d.voidsToday.pendingCount} menunggu` : ""}`}
            />
          </div>
          <SectionCard title="Keadaan sekarang">
            <KeyValueList
              columns={3}
              items={[
                {
                  label: "Shift berjalan",
                  value: openShift ? (
                    <Link href={`/outlet/shift/${openShift.id}`} className="text-primary hover:underline">
                      {openShift.operatorName ?? "—"} · sejak {formatTanggalJam(openShift.openedAt)}
                    </Link>
                  ) : (
                    "Tidak ada"
                  ),
                },
                { label: "Kas awal tetap", value: formatRupiah(d.settings.fixedOpeningCash) },
                { label: "Kas maksimal (PAR-02)", value: formatRupiah(d.settings.cashLimit) },
                ...(isDepot
                  ? [
                      {
                        label: "Stok air",
                        value: d.waterStockL === null ? "—" : `${d.waterStockL.toLocaleString("id-ID")} L`,
                        hint: d.outlet.storageCapacityL ? `Kapasitas ${d.outlet.storageCapacityL.toLocaleString("id-ID")} L${d.overCapacity ? " — melebihi kapasitas, periksa data" : ""}` : undefined,
                      },
                      { label: "Pasokan menunggu konfirmasi", value: pendingSupplies },
                    ]
                  : []),
                { label: "Void disetujui menunggu pembalik", value: d.pendingReversals.length },
              ]}
            />
          </SectionCard>
        </>
      ) : null}

      {tab === "shift" ? (
        <SectionCard
          title="Shift 30 hari terakhir"
          actions={<ExportButtons excelHref={`/api/export/m6.shifts?format=xlsx&outletId=${d.outlet.id}&from=${addDays(d.date, -30)}&to=${d.date}`} pdfHref={`/api/export/m6.shifts?format=pdf&outletId=${d.outlet.id}&from=${addDays(d.date, -30)}&to=${d.date}`} />}
        >
          {d.shifts.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="tabel-shift">
                <TableHeader>
                  <TableRow>
                    <TableHead>Tanggal</TableHead>
                    <TableHead>Operator</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Tunai</TableHead>
                    <TableHead className="text-right">QRIS</TableHead>
                    <TableHead className="text-right">Void</TableHead>
                    <TableHead className="text-right">Selisih kas</TableHead>
                    <TableHead className="text-right">Setoran</TableHead>
                    <TableHead>Setor</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.shifts.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <Link href={`/outlet/shift/${s.id}`} className="font-medium text-primary hover:underline">
                          {formatTanggal(s.businessDate)}
                        </Link>
                        <span className="block text-xs text-muted-foreground">
                          {formatJam(s.openedAt)}–{s.closedAt ? formatJam(s.closedAt) : "…"}
                        </span>
                      </TableCell>
                      <TableCell>{s.operatorName ?? "—"}</TableCell>
                      <TableCell>
                        <StatusBadge enumName="shift_status" value={s.status} />
                        {s.syncConflict ? (
                          <ToneBadge tone={s.conflictResolvedAt ? "muted" : "danger"} className="ml-1">
                            Konflik{s.conflictResolvedAt ? " (ditinjau)" : ""}
                          </ToneBadge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">{s.cashSales === null ? "—" : formatRupiah(s.cashSales)}</TableCell>
                      <TableCell className="text-right">{s.qrisSales === null ? "—" : formatRupiah(s.qrisSales)}</TableCell>
                      <TableCell className="text-right">{s.voidCount ?? "—"}</TableCell>
                      <TableCell className="text-right">
                        <SignedNumber value={s.cashDifference} money />
                      </TableCell>
                      <TableCell className="text-right">{s.depositAmount === null ? "—" : formatRupiah(s.depositAmount)}</TableCell>
                      <TableCell>
                        <StatusBadge enumName="shift_deposit_status" value={s.depositStatus} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState compact title="Belum ada shift" description="Shift muncul setelah operator membuka shift di POS dan data tersinkron." />
          )}
        </SectionCard>
      ) : null}

      {tab === "transaksi" ? (
        <>
          {d.pendingReversals.length ? (
            <SectionCard title="Void disetujui setelah shift ditutup" description="Buat transaksi pembalik pada tanggal koreksi; transaksi asal tidak diubah.">
              <ul className="grid gap-3" data-testid="daftar-pembalik">
                {d.pendingReversals.map((r) => (
                  <li key={r.sale.id} className="rounded-md border p-3 text-sm">
                    <p className="font-medium">
                      {r.sale.number ?? r.sale.localNumber} · {formatRupiah(r.sale.total)} · {label("payment_method", r.sale.paymentMethod)}
                    </p>
                    <p className="text-muted-foreground">
                      Persetujuan {r.approvalNumber}
                      {r.approvedAt ? ` · ${formatTanggalJam(r.approvedAt)}` : ""} · alasan: {label("void_reason", r.sale.voidReason)}
                      {r.sale.voidNote ? ` — ${r.sale.voidNote}` : ""}
                    </p>
                    {canReverse ? (
                      <OutletActionForm action={reverseSaleAction.bind(null, r.sale.id, r.sale.shiftId)} submitLabel="Buat transaksi pembalik" className="mt-2">
                        <Field label="Keterangan pembalik" name="reason" required defaultValue={`Void disetujui ${r.approvalNumber}`} />
                      </OutletActionForm>
                    ) : null}
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
          <SectionCard
            title={`Transaksi ${formatTanggal(d.date)}`}
            description="Termasuk void yang diajukan pada tanggal ini. Nomor resmi terbit saat sinkron; nomor lokal tetap tercatat."
            actions={<ExportButtons excelHref={`/api/export/m6.pos_sales?format=xlsx&outletId=${d.outlet.id}&from=${d.date}&to=${d.date}`} pdfHref={`/api/export/m6.pos_sales?format=pdf&outletId=${d.outlet.id}&from=${d.date}&to=${d.date}`} />}
          >
            {d.sales.length ? (
              <div className="overflow-x-auto">
                <Table data-testid="tabel-transaksi">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nomor</TableHead>
                      <TableHead>Jam</TableHead>
                      <TableHead>Cara bayar</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Catatan</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.sales.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell>
                          <span className="font-medium">{s.number ?? "—"}</span>
                          <span className="block text-xs text-muted-foreground">{s.localNumber}</span>
                        </TableCell>
                        <TableCell>{formatJam(s.soldAt)}</TableCell>
                        <TableCell>{label("payment_method", s.paymentMethod)}</TableCell>
                        <TableCell className="text-right">
                          <SignedNumber value={s.isReversal ? s.total : null} money />
                          {s.isReversal ? null : formatRupiah(s.total)}
                        </TableCell>
                        <TableCell>
                          {s.isReversal ? <ToneBadge tone="info">Pembalik</ToneBadge> : <StatusBadge enumName="pos_sale_status" value={s.status} />}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {[
                            s.voidReason ? `Void: ${label("void_reason", s.voidReason)}${s.voidNote ? ` — ${s.voidNote}` : ""}` : null,
                            s.reversalReason,
                            s.priceMismatch ? "Harga perangkat berbeda dari harga berlaku" : null,
                            s.replacesSaleId ? "Pengganti transaksi yang di-void" : null,
                            s.lateSync ? "Sinkron terlambat" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <EmptyState compact title="Belum ada transaksi" description="Transaksi POS tampil setelah tersinkron dari perangkat outlet." />
            )}
          </SectionCard>
        </>
      ) : null}

      {tab === "stok" ? (
        <>
          <SectionCard
            title="Saldo bahan habis pakai"
            description="Saldo kartu stok (sudah termasuk pemakaian shift yang ditutup). Pemakaian shift berjalan diposting saat tutup shift."
            actions={
              <ExportButtons
                excelHref={`/api/export/m6.stock_card?format=xlsx&outletId=${d.outlet.id}&from=${addDays(d.date, -30)}&to=${d.date}`}
                pdfHref={`/api/export/m6.stock_card?format=pdf&outletId=${d.outlet.id}&from=${addDays(d.date, -30)}&to=${d.date}`}
              />
            }
          >
            <div className="overflow-x-auto">
              <Table data-testid="tabel-stok">
                <TableHeader>
                  <TableRow>
                    <TableHead>Bahan</TableHead>
                    <TableHead className="text-right">Saldo</TableHead>
                    <TableHead className="text-right">Harga rata-rata</TableHead>
                    <TableHead className="text-right">Nilai</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.stock.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>{m.name}</TableCell>
                      <TableCell className="text-right">
                        {m.quantity.toLocaleString("id-ID")} {m.unit}
                      </TableCell>
                      <TableCell className="text-right">{formatRupiah(m.avgCost)}</TableCell>
                      <TableCell className="text-right">{formatRupiah(m.quantity * m.avgCost)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </SectionCard>
          <SectionCard title="Penerimaan bahan terakhir">
            {d.receipts.length ? (
              <ul className="grid gap-2 text-sm">
                {d.receipts.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                    <span>
                      {formatTanggalJam(r.receivedAt)} · {label("consumable_source", r.source)}
                      {r.supplierNoteNumber ? ` · nota ${r.supplierNoteNumber}` : ""}
                    </span>
                    <span className="text-muted-foreground">{r.notes ?? ""}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact title="Belum ada penerimaan bahan" />
            )}
          </SectionCard>
        </>
      ) : null}

      {tab === "air" ? (
        <SectionCard
          title="Pasokan air"
          description="Tiba otomatis dari rit internal selesai; operator mengonfirmasi volume diterima. Tanpa konfirmasi sampai tutup shift → diterima sesuai volume sopir."
          actions={<ExportButtons excelHref={`/api/export/m6.water_supply?format=xlsx&outletId=${d.outlet.id}&from=${addDays(d.date, -30)}&to=${d.date}`} pdfHref={`/api/export/m6.water_supply?format=pdf&outletId=${d.outlet.id}&from=${addDays(d.date, -30)}&to=${d.date}`} />}
        >
          {d.supplies.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="tabel-pasokan">
                <TableHeader>
                  <TableRow>
                    <TableHead>Tanggal</TableHead>
                    <TableHead>Sumber</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Diserahkan</TableHead>
                    <TableHead className="text-right">Diterima</TableHead>
                    <TableHead className="text-right">Selisih</TableHead>
                    <TableHead>Keterangan</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.supplies.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>{formatTanggal(s.businessDate)}</TableCell>
                      <TableCell>{label("water_supply_source", s.source)}</TableCell>
                      <TableCell>
                        <StatusBadge enumName="water_supply_status" value={s.status} />
                      </TableCell>
                      <TableCell className="text-right">{s.deliveredVolumeL === null ? "—" : `${s.deliveredVolumeL.toLocaleString("id-ID")} L`}</TableCell>
                      <TableCell className="text-right">{s.receivedVolumeL === null ? "—" : `${s.receivedVolumeL.toLocaleString("id-ID")} L`}</TableCell>
                      <TableCell className="text-right">
                        <SignedNumber value={s.differenceL} suffix=" L" />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{s.differenceReason ?? s.otherSourceReason ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState compact title="Belum ada pasokan air" />
          )}
        </SectionCard>
      ) : null}

      {tab === "opname" ? (
        <SectionCard
          title="Opname bahan"
          description="Opname mingguan wajib (depot). Selisih diajukan sebagai penyesuaian stok dan menunggu persetujuan Admin Keuangan."
          actions={<ExportButtons excelHref={`/api/export/m6.stock_counts?format=xlsx&outletId=${d.outlet.id}&from=${addDays(d.date, -90)}&to=${d.date}`} pdfHref={`/api/export/m6.stock_counts?format=pdf&outletId=${d.outlet.id}&from=${addDays(d.date, -90)}&to=${d.date}`} />}
        >
          {d.stockCounts.length ? (
            <ul className="grid gap-2 text-sm" data-testid="daftar-opname">
              {d.stockCounts.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                  <span>
                    {c.periodLabel} · {formatTanggalJam(c.startedAt)}
                  </span>
                  <StatusBadge enumName="stock_count_status" value={c.status} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState compact title="Belum ada opname" />
          )}
        </SectionCard>
      ) : null}

      {tab === "pengaturan" ? (
        <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
          <SectionCard title="Pengaturan POS berlaku" description={`Per ${formatTanggal(d.date)} — dari parameter tenant/outlet (tanpa kode).`}>
            <KeyValueList
              items={[
                { label: "Kas awal tetap", value: formatRupiah(d.settings.fixedOpeningCash) },
                { label: "Kas maksimal (PAR-02)", value: formatRupiah(d.settings.cashLimit) },
                { label: "Void per hari (PAR-03)", value: `${d.settings.voidDailyCount} kejadian` },
                { label: "Void perlu persetujuan di atas (PAR-04)", value: formatRupiah(d.settings.voidApprovalAbove) },
                { label: "Toleransi stok bahan (PAR-58)", value: `${d.settings.stockTolerance} buah/hari` },
                { label: "Toleransi neraca air (PAR-59)", value: `${d.settings.waterTolerancePct}%` },
                { label: "QRIS", value: d.settings.qrisEnabled ? "Aktif" : "Nonaktif" },
                { label: "Printer struk", value: d.settings.printerEnabled ? "Aktif" : "Nonaktif" },
                { label: "Batas persetujuan void pada", value: `pukul ${d.settings.rules.void_approval_deadline_time} WIB tanggal shift` },
                { label: "Kapasitas tangki", value: d.outlet.storageCapacityL ? `${d.outlet.storageCapacityL.toLocaleString("id-ID")} L` : "—" },
              ]}
            />
          </SectionCard>
          {canSettings ? (
            <div className="grid gap-6">
              <SectionCard title="Ubah pengaturan POS" description="Berlaku saat perangkat mengunduh data berikutnya.">
                <OutletActionForm action={updateSettingsAction.bind(null, d.outlet.id)} testId="form-pengaturan">
                  <Field label="Kas awal tetap (Rp)" name="fixedOpeningCash" inputMode="numeric" defaultValue={d.outlet.fixedOpeningCash} hint="Kosongkan untuk memakai nilai PAR-57." />
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input type="checkbox" name="qrisEnabled" defaultChecked={d.outlet.qrisEnabled} className="size-4" /> QRIS aktif
                  </label>
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input type="checkbox" name="printerEnabled" defaultChecked={d.outlet.printerEnabled} className="size-4" /> Printer struk aktif
                  </label>
                  <Field label="Alasan perubahan" name="reason" required />
                </OutletActionForm>
              </SectionCard>
              <SectionCard title="Ambang khusus outlet" description="Nilai baru berlaku mulai tanggal yang dipilih; riwayat nilai lama tetap tersimpan.">
                <OutletActionForm action={setThresholdAction.bind(null, d.outlet.id)} testId="form-ambang">
                  <label className="grid gap-1 text-sm font-medium">
                    Parameter
                    <select name="key" className="h-10 rounded-md border border-input bg-background px-3 text-base" defaultValue="PAR-04">
                      {m6.OUTLET_THRESHOLD_KEYS.map((k) => (
                        <option key={k} value={k}>
                          {THRESHOLD_LABELS[k]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Field label="Nilai" name="value" inputMode="numeric" required />
                  <Field label="Berlaku mulai" name="effectiveFrom" type="date" required defaultValue={d.date} />
                  <Field label="Alasan perubahan" name="reason" required />
                </OutletActionForm>
              </SectionCard>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
