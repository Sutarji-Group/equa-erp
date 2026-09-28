import type { Metadata } from "next";
import Link from "next/link";

import { ActionForm } from "@/components/m1-master/action-form";
import { FormGrid, SelectField, TextField } from "@/components/m1-master/fields";
import { ExportButtons } from "@/components/shared/export-buttons";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { ToneBadge } from "@/components/shared/status-badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label } from "@/lib/labels";
import { formatTanggal } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { can } from "@/server/core/rbac";
import * as m1 from "@/server/modules/m1-master";

import { proposeZoneTableAction, proposeZoneTariffAction } from "./actions";

export const metadata: Metadata = { title: "Zona tarif" };

const km = (m: number | null) => (m === null ? "∞" : (m / 1000).toLocaleString("id-ID", { maximumFractionDigits: 2 }));

/**
 * Zona tarif (US-M1-05): tabel batas jarak & tarif per segmen berlaku per tanggal (KP-1), usulan menunggu persetujuan,
 * daftar alamat yang berpindah zona (KP-4), dan simulasi harga zona baru vs harga berlaku per pelanggan (KP-5).
 */
export default async function ZonaPage({ searchParams }: PageProps<"/master/zona">) {
  const { ctx } = await requirePermission("m1.tariff_zone.read");
  const sp = await searchParams;
  const approvalId = typeof sp.usulan === "string" && sp.usulan ? sp.usulan : undefined;
  const simDate = typeof sp.tanggal === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.tanggal) ? sp.tanggal : undefined;
  const overview = await m1.getZoneOverview(ctx);
  const [moves, simulation] = await Promise.all([m1.listZoneMoves(ctx, { approvalId }), m1.simulateZonePricing(ctx, { approvalId, date: simDate })]);
  const mode = can(ctx, "m1.price.set") || can(ctx, "m1.tariff_zone.update") ? "owner" : can(ctx, "m1.price.request") ? "request" : null;
  const simQuery = new URLSearchParams({ ...(approvalId ? { approvalId } : {}), ...(simDate ? { date: simDate } : {}) }).toString();
  const withLegacy = simulation.rows.filter((r) => r.legacyPrice !== null);

  return (
    <div className="grid gap-6">
      <PageHeader title="Zona tarif" description={`Tabel zona berlaku ${formatTanggal(overview.date, { weekday: false })}. Harga air truk = tarif zona + komponen BBM ${overview.fuel ? `(BBM Rp ${overview.fuel.amountPerTrip.toLocaleString("id-ID")}/rit)` : ""}.`} />

      <SectionCard title="Tabel zona & tarif per rit" description="Jarak dari sumber air acuan (bawaan terdekat). Rentang [dari, sampai) tanpa tumpang tindih & tanpa celah.">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Zona</TableHead>
                <TableHead>Jarak (km)</TableHead>
                <TableHead className="text-right">Tarif per rit</TableHead>
                <TableHead className="hidden sm:table-cell text-right">Alamat</TableHead>
                <TableHead className="hidden md:table-cell">Berlaku sejak</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.table.map((z) => (
                <TableRow key={z.zoneId}>
                  <TableCell>
                    <div className="font-medium">{z.code}</div>
                    <div className="text-xs text-muted-foreground">{z.name}</div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {km(z.minDistanceM)} – {km(z.maxDistanceM)}
                  </TableCell>
                  <TableCell className="text-right">
                    {z.tariffs.map((t) => (
                      <div key={t.segment ?? "all"} className="text-sm">
                        <span className="text-muted-foreground">{t.segment ? label("customer_segment", t.segment) : "Semua segmen"}:</span> <MoneyText value={t.pricePerTrip} />
                      </div>
                    ))}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-right">{z.addressCount}</TableCell>
                  <TableCell className="hidden md:table-cell">{formatTanggal(z.effectiveFrom, { weekday: false })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {overview.upcomingTables.length ? (
          <div className="mt-3 text-sm">
            {overview.upcomingTables.map((u) => (
              <p key={u.effectiveFrom}>
                <ToneBadge tone="info">Akan berlaku {formatTanggal(u.effectiveFrom, { weekday: false })}</ToneBadge>{" "}
                {u.zones.map((z) => `${z.code} ${km(z.minDistanceM)}–${km(z.maxDistanceM)} km`).join(" · ")}
              </p>
            ))}
          </div>
        ) : null}
      </SectionCard>

      {overview.pendingTables.length || overview.pendingTariffs.length ? (
        <SectionCard title="Usulan menunggu persetujuan pemilik" description="Lewat tenggat (sebelum tanggal berlaku) → harga/batas lama tetap berlaku.">
          <ul className="grid gap-2 text-sm">
            {overview.pendingTables.map((p) => (
              <li key={p.approvalId} className="rounded-md border p-3">
                <span className="tabular font-medium">{p.number}</span> · Tabel zona berlaku {formatTanggal(p.effectiveFrom, { weekday: false })}: {p.zones.map((z) => `${z.code} ${km(z.minDistanceM)}–${km(z.maxDistanceM)} km`).join(" · ")}
                <div className="mt-1 flex flex-wrap gap-3">
                  <Link href={`/master/zona?usulan=${p.approvalId}#berpindah`} className="text-primary underline-offset-4 hover:underline">
                    Pratinjau alamat berpindah & simulasi
                  </Link>
                  <Link href={`/persetujuan?id=${p.approvalId}`} className="text-primary underline-offset-4 hover:underline">
                    Buka di Persetujuan
                  </Link>
                </div>
              </li>
            ))}
            {overview.pendingTariffs.map((t) => (
              <li key={t.id} className="rounded-md border p-3">
                {t.approvalNumber ? <span className="tabular font-medium">{t.approvalNumber} · </span> : null}
                Tarif {t.zoneCode} {t.segment ? `(${label("customer_segment", t.segment)})` : ""}: <MoneyText value={t.pricePerTrip} /> berlaku {formatTanggal(t.effectiveFrom, { weekday: false })} — {t.reason}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {mode ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <SectionCard title={mode === "owner" ? "Tetapkan tabel zona baru" : "Ajukan tabel zona baru"} description="Wajib memuat semua zona aktif; boleh menambah satu zona baru. Perubahan tidak mengubah harga pesanan yang sudah dibuat.">
            <ActionForm action={proposeZoneTableAction} submitLabel={mode === "owner" ? "Tetapkan tabel zona" : "Ajukan ke pemilik"}>
              <input type="hidden" name="zoneCount" value={overview.table.length} />
              <div className="grid gap-2">
                {overview.table.map((z, i) => (
                  <div key={z.zoneId} className="grid grid-cols-[3rem_1fr_1fr] items-center gap-2 text-sm">
                    <input type="hidden" name={`zone_${i}_id`} value={z.zoneId} />
                    <span className="font-medium">{z.code}</span>
                    <Input name={`zone_${i}_min`} defaultValue={String(z.minDistanceM / 1000)} inputMode="decimal" aria-label={`${z.code} dari km`} />
                    <Input name={`zone_${i}_max`} defaultValue={z.maxDistanceM === null ? "" : String(z.maxDistanceM / 1000)} placeholder="tanpa batas" inputMode="decimal" aria-label={`${z.code} sampai km`} />
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">Zona baru (opsional):</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Input name="new_code" placeholder="Kode (Z5)" aria-label="Kode zona baru" />
                  <Input name="new_name" placeholder="Nama" aria-label="Nama zona baru" />
                  <Input name="new_min" placeholder="Dari km" inputMode="decimal" aria-label="Zona baru dari km" />
                  <Input name="new_max" placeholder="Sampai km" inputMode="decimal" aria-label="Zona baru sampai km" />
                </div>
              </div>
              <FormGrid>
                <TextField label="Berlaku mulai" name="effectiveFrom" type="date" required />
                <TextField label="Alasan" name="reason" required placeholder="Diturunkan dari harga hari ini (K23)" />
              </FormGrid>
            </ActionForm>
          </SectionCard>
          <SectionCard title={mode === "owner" ? "Tetapkan tarif zona" : "Ajukan tarif zona"} description="Tarif per segmen opsional; tanpa segmen = semua segmen.">
            <ActionForm action={proposeZoneTariffAction} submitLabel={mode === "owner" ? "Tetapkan tarif" : "Ajukan ke pemilik"}>
              <FormGrid>
                <SelectField label="Zona" name="zoneId" options={overview.zonesForSelect} required placeholder="— Pilih zona —" />
                <SelectField label="Segmen" name="segment" options={enumOptions("customer_segment")} placeholder="Semua segmen" />
                <TextField label="Tarif per rit (Rp)" name="pricePerTrip" inputMode="numeric" required />
                <TextField label="Berlaku mulai" name="effectiveFrom" type="date" required />
              </FormGrid>
              <TextField label="Alasan" name="reason" required />
            </ActionForm>
          </SectionCard>
        </div>
      ) : null}

      <SectionCard
        title="Alamat berpindah zona"
        description={moves.effectiveFrom ? `Akibat batas zona ${approvalId ? "usulan" : "yang berlaku"} ${formatTanggal(moves.effectiveFrom, { weekday: false })} — tinjau sebelum/ sesudah berlaku (US-M1-05 KP-4).` : "Belum ada perubahan batas zona."}
        actions={<ExportButtons excelHref={`/api/export/m1.zone_moves?format=xlsx${approvalId ? `&approvalId=${approvalId}` : ""}`} />}
      >
        <div id="berpindah" className="overflow-x-auto">
          {moves.moves.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pelanggan</TableHead>
                  <TableHead>Alamat</TableHead>
                  <TableHead className="text-right">Jarak</TableHead>
                  <TableHead>Zona</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {moves.moves.map((m) => (
                  <TableRow key={m.addressId}>
                    <TableCell>
                      <Link href={`/master/pelanggan/${m.customerId}`} className="text-primary underline-offset-4 hover:underline">
                        {m.customerName}
                      </Link>
                    </TableCell>
                    <TableCell>{m.label}</TableCell>
                    <TableCell className="text-right">{km(m.distanceM)} km</TableCell>
                    <TableCell>
                      {m.fromZoneCode ?? "—"} → {m.toZoneCode ?? "—"} {m.manual ? <ToneBadge tone="warning">Zona manual</ToneBadge> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">Tidak ada alamat yang berpindah zona.</p>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Simulasi harga zona vs harga berlaku per pelanggan"
        description={`Tabel zona & tarif ${approvalId ? "usulan" : ""} per ${formatTanggal(simulation.date, { weekday: false })} (termasuk usulan tarif menunggu) dibandingkan harga saat ini hasil impor data awal (K23). ${withLegacy.length} alamat memiliki harga impor.`}
        actions={<ExportButtons excelHref={`/api/export/m1.zone_simulation?format=xlsx${simQuery ? `&${simQuery}` : ""}`} pdfHref={`/api/export/m1.zone_simulation?format=pdf${simQuery ? `&${simQuery}` : ""}`} />}
      >
        <form method="get" className="mb-3 flex flex-wrap items-end gap-2" aria-label="Tanggal simulasi">
          {approvalId ? <input type="hidden" name="usulan" value={approvalId} /> : null}
          <label className="grid gap-1 text-sm">
            Tanggal tabel zona
            <input type="date" name="tanggal" defaultValue={simDate ?? ""} className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" />
          </label>
          <button type="submit" className="h-9 rounded-md border px-3 text-sm">
            Hitung
          </button>
        </form>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pelanggan</TableHead>
                <TableHead className="hidden sm:table-cell">Zona kini → baru</TableHead>
                <TableHead className="text-right">Harga saat ini</TableHead>
                <TableHead className="text-right">Harga zona baru</TableHead>
                <TableHead className="text-right">Selisih</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(withLegacy.length ? withLegacy : simulation.rows).slice(0, 200).map((r) => (
                <TableRow key={r.addressId}>
                  <TableCell>
                    <div className="font-medium">{r.customerName}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.addressLabel} · {label("customer_segment", r.segment)}
                      {r.hasSpecialPrice ? " · harga khusus" : ""}
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {r.currentZoneCode ?? "—"} → {r.newZoneCode ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">{r.legacyPrice !== null ? <MoneyText value={r.legacyPrice} /> : r.currentPrice !== null ? <MoneyText value={r.currentPrice} /> : "—"}</TableCell>
                  <TableCell className="text-right">{r.newPrice !== null ? <MoneyText value={r.newPrice} /> : "—"}</TableCell>
                  <TableCell className="text-right">
                    {r.difference !== null ? (
                      <>
                        <MoneyText value={r.difference} signed colorize />
                        {r.differencePct !== null ? <div className="text-xs text-muted-foreground">{r.differencePct.toLocaleString("id-ID")}%</div> : null}
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </div>
  );
}
