import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionButton, ReasonActionButton } from "@/components/m1-master/action-buttons";
import { ActionForm } from "@/components/m1-master/action-form";
import { AddAddressForm, CoordinateForm, CustomerEditForm } from "@/components/m1-master/customer-forms";
import { FormGrid, SelectField, TextField } from "@/components/m1-master/fields";
import { KeyValueList } from "@/components/shared/key-value-list";
import { MoneyText } from "@/components/shared/money-text";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import * as approvals from "@/server/core/approvals";
import { requirePermission } from "@/server/core/auth/office";
import { getDb } from "@/server/core/db";
import { isDomainError } from "@/server/core/errors";
import { can } from "@/server/core/rbac";
import { formatWaNumber } from "@/server/core/wa";
import * as m1 from "@/server/modules/m1-master";

import {
  addAddressAction,
  cancelApprovalAction,
  clearManualZoneAction,
  confirmProposalAction,
  deactivateAddressAction,
  deactivateCustomerAction,
  reactivateCustomerAction,
  rejectProposalAction,
  requestCreditAction,
  requestCreditTermsAction,
  requestSpecialPriceAction,
  setCoordinatesAction,
  setManualZoneAction,
  setReferenceSourceAction,
  setStorePartnerAction,
  updateCustomerAction,
} from "../actions";

export const metadata: Metadata = { title: "Rincian pelanggan" };

/**
 * Rincian pelanggan (US-M1-01): ringkasan KP-9 (piutang terbuka, batas tersisa, 10 pesanan terakhir, rata-rata jarak,
 * catatan khusus, harga khusus), status kredit & "Ajukan Tempo" (aktif hanya bila layak PAR-11 + PAR-82), alamat kirim
 * berkoordinat & zona, harga khusus, nonaktif beralasan.
 */
export default async function PelangganDetailPage({ params }: PageProps<"/master/pelanggan/[id]">) {
  const { ctx } = await requirePermission("m1.customer.read");
  const { id } = await params;
  let detail: Awaited<ReturnType<typeof m1.getCustomerDetail>>;
  try {
    detail = await m1.getCustomerDetail(ctx, id);
  } catch (error) {
    if (isDomainError(error)) notFound();
    throw error;
  }
  const { customer } = detail;
  const [summary, eligibility, overview, products, sources, pending] = await Promise.all([
    m1.getCustomerSummary(ctx, id),
    m1.getCreditEligibility(ctx, id),
    m1.getZoneOverview(ctx),
    m1.listProducts(ctx),
    m1.listWaterSources(ctx),
    approvals.listForObject(getDb(), "customer", id),
  ]);
  const openApprovals = pending.filter((a) => a.status === "submitted");
  const canUpdate = can(ctx, "m1.customer.update");
  const canLock = can(ctx, "m1.customer.lock_coordinate");
  const canDeactivate = can(ctx, "m1.customer.deactivate");
  const canRequestCredit = can(ctx, "m1.customer.request_credit");
  const canRequestTerms = can(ctx, "m1.customer.request_credit_terms");
  const canSpecial = can(ctx, "m1.special_price.request");
  const zones = overview.zonesForSelect;
  const productOptions = products.filter((p) => (p.line === "truck_water" && !p.isInternalTransfer) || p.line === "depot").map((p) => ({ value: p.id, label: `${p.name} (${label("product_line", p.line)})` }));
  const sourceOptions = sources.filter((s) => s.isActive).map((s) => ({ value: s.id, label: s.name }));
  const household = customer.segment === "household";

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={customer.name} />
      <PageHeader
        backHref="/master/pelanggan"
        backLabel="Daftar pelanggan"
        title={customer.name}
        meta={
          <>
            <span>{customer.code ?? "Tanpa kode"}</span>
            <StatusBadge enumName="customer_segment" value={customer.segment} dot={false} />
            <StatusBadge enumName="credit_status" value={customer.creditStatus} />
            {customer.isActive ? <ToneBadge tone="success">Aktif</ToneBadge> : <ToneBadge tone="muted">Nonaktif</ToneBadge>}
            {customer.isStorePartner ? <ToneBadge tone="info">Mitra toko ({label("store_partner_source", customer.storePartnerSource)})</ToneBadge> : null}
            {customer.isInitialData ? <ToneBadge tone="neutral">Data awal</ToneBadge> : null}
          </>
        }
        actions={
          <>
            {canUpdate && customer.segment === "third_party_depot" ? (
              <ReasonActionButton
                label={customer.isStorePartner ? "Cabut mitra toko" : "Tandai mitra toko"}
                title={customer.isStorePartner ? "Cabut penanda mitra toko?" : "Tandai sebagai mitra toko (manual)?"}
                description="Penanda manual untuk mitra depot EQUA (BR-18); penanda otomatis dikelola job harian."
                action={setStorePartnerAction.bind(null, id, !customer.isStorePartner)}
              />
            ) : null}
            {canDeactivate ? (
              customer.isActive ? (
                <ReasonActionButton label="Nonaktifkan" title="Nonaktifkan pelanggan?" description="Tidak dapat bila masih ada piutang terbuka atau pesanan aktif (KP-8)." action={deactivateCustomerAction.bind(null, id)} destructive />
              ) : (
                <ReasonActionButton label="Aktifkan kembali" title="Aktifkan kembali pelanggan?" action={reactivateCustomerAction.bind(null, id)} />
              )
            ) : null}
          </>
        }
      />

      <SectionCard title="Ringkasan" description="Saldo piutang dari modul Piutang (M5: faktur terbuka + rit belum ditagih); batas tersisa = batas − eksposur (piutang + pesanan tempo berjalan + tempo toko belum difakturkan), BR-06.">
        <KeyValueList
          columns={3}
          items={[
            { label: "Nomor WA", value: customer.waPhone ? formatWaNumber(customer.waPhone) : "—" },
            { label: "Kontak", value: customer.contactName ?? "—" },
            { label: "Jam terima tetap", value: customer.fixedReceiveTime?.slice(0, 5) ?? "—" },
            { label: "Saldo piutang", value: <MoneyText value={summary.openReceivable} /> },
            { label: "Batas kredit", value: <MoneyText value={summary.creditLimit} />, hint: `Tempo ${summary.paymentTermDays} hari` },
            { label: "Batas tersisa", value: <MoneyText value={summary.remainingLimit} colorize />, hint:
                [
                  summary.openCreditOrders ? `Pesanan tempo berjalan ${formatRupiah(summary.openCreditOrders)}` : null,
                  summary.uninvoicedStoreCredit ? `Tempo toko belum difakturkan ${formatRupiah(summary.uninvoicedStoreCredit)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || undefined,
            },
            { label: "Rata-rata jarak antar pesanan", value: summary.averageDaysBetweenOrders !== null ? `${summary.averageDaysBetweenOrders.toLocaleString("id-ID")} hari` : "—" },
            { label: "Catatan khusus", value: summary.notes ?? "—", full: true },
          ]}
        />
        <div className="mt-4 grid gap-2">
          <p className="text-sm font-medium">Harga khusus aktif</p>
          {summary.activeSpecialPrices.length ? (
            <ul className="grid gap-1 text-sm">
              {summary.activeSpecialPrices.map((s) => (
                <li key={s.id}>
                  {s.productName}: <MoneyText value={s.price} /> sejak {formatTanggal(s.validFrom, { weekday: false })} · tinjauan {formatTanggal(s.reviewDate, { weekday: false })}
                  {s.reviewOverdue ? <ToneBadge tone="warning" className="ml-2">Perlu ditinjau</ToneBadge> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Tidak ada — harga dari tarif zona + komponen BBM.</p>
          )}
        </div>
        <div className="mt-4 overflow-x-auto">
          <p className="mb-2 text-sm font-medium">10 pesanan terakhir</p>
          {summary.lastOrders.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nomor</TableHead>
                  <TableHead>Tanggal</TableHead>
                  <TableHead className="text-right">Tangki</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Truk</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.lastOrders.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="tabular">{o.number}</TableCell>
                    <TableCell>{formatTanggal(o.requestedDate, { weekday: false })}</TableCell>
                    <TableCell className="text-right">{o.tankCount}</TableCell>
                    <TableCell>
                      <StatusBadge enumName="order_status" value={o.status} />
                    </TableCell>
                    <TableCell>{o.trucks.join(", ") || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">Belum ada pesanan.</p>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Status kredit" description="Pelanggan baru Tunai (BR-01). Tempo hanya bila memenuhi PAR-11 dan PAR-82, dengan persetujuan pemilik. Rumah tangga tunai saja (BR-04).">
        <div className="grid gap-4">
          <KeyValueList
            columns={3}
            items={[
              { label: "Status", value: <StatusBadge enumName="credit_status" value={customer.creditStatus} /> },
              { label: "Pesanan Selesai", value: `${eligibility.metrics.completedOrders} (syarat ${eligibility.metrics.ordersRequired})` },
              { label: "Selesai pertama", value: eligibility.metrics.firstCompletedDate ? formatTanggal(eligibility.metrics.firstCompletedDate, { weekday: false }) : "—", hint: `Syarat ${eligibility.metrics.monthsRequired} bulan` },
              { label: "Kurang bayar lewat tempo", value: String(eligibility.metrics.underpaymentsOverdue) },
              { label: "Transfer tidak ditemukan", value: String(eligibility.metrics.transfersNotFound) },
              { label: "Rit gagal (pelanggan menolak)", value: `${eligibility.metrics.failedTripsCustomerRefused} (maks. ${eligibility.limits.maxFailedTripsCustomerRefused})` },
            ]}
          />
          {customer.creditStatus === "cash" ? (
            <div className="grid gap-2">
              {eligibility.eligible ? (
                <p className="text-sm text-success">Memenuhi syarat Tempo — ajukan ke pemilik.</p>
              ) : (
                <ul className="list-disc pl-5 text-sm text-muted-foreground">
                  {eligibility.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              {canRequestCredit ? (
                <div>
                  <ReasonActionButton
                    label="Ajukan Tempo"
                    title="Ajukan status Tempo ke pemilik?"
                    description="Batas mengikuti segmen (PAR-10), tempo standar (PAR-08). Status berubah setelah pemilik menyetujui."
                    action={requestCreditAction.bind(null, id)}
                    variant="default"
                    disabled={!eligibility.eligible || openApprovals.some((a) => a.type === "credit_grant")}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
          {openApprovals.length ? (
            <div className="grid gap-2">
              <p className="text-sm font-medium">Pengajuan menunggu keputusan pemilik</p>
              {openApprovals.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
                  <span>
                    <span className="tabular font-medium">{a.number}</span> · {label("approval_type", a.type)} · {a.reason}
                  </span>
                  {a.requesterUserId === ctx.userId ? <ReasonActionButton label="Batalkan" title={`Batalkan ${a.number}?`} action={cancelApprovalAction.bind(null, a.id, id)} /> : null}
                </div>
              ))}
            </div>
          ) : null}
          {canRequestTerms && customer.creditStatus !== "cash" && !household ? (
            <ActionForm action={requestCreditTermsAction.bind(null, id)} submitLabel="Ajukan ubah batas/tempo" variant="outline">
              <FormGrid>
                <TextField label="Batas kredit baru (Rp)" name="creditLimit" inputMode="numeric" defaultValue={String(customer.creditLimit)} required />
                <TextField label="Tempo (hari)" name="paymentTermDays" inputMode="numeric" defaultValue={String(customer.paymentTermDays)} required />
              </FormGrid>
              <TextField label="Alasan" name="reason" required />
            </ActionForm>
          ) : null}
          {detail.creditHistory.length ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Riwayat status kredit ({detail.creditHistory.length})</summary>
              <ul className="mt-2 grid gap-1">
                {detail.creditHistory.map((h) => (
                  <li key={h.id}>
                    {formatTanggalJam(h.changedAt)} — {h.fromStatus ? `${label("credit_status", h.fromStatus)} → ` : ""}
                    {label("credit_status", h.toStatus)}
                    {h.creditLimitAfter !== null ? ` · batas ${h.creditLimitAfter.toLocaleString("id-ID")}` : ""}
                    {h.reason ? ` · ${h.reason}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard title="Alamat kirim" description="Koordinat Dikunci → zona otomatis dari sumber air acuan terdekat (jarak peta; cadangan garis lurus × 1,3). Zona manual wajib alasan.">
        <div className="grid gap-4">
          {detail.addresses.map((a) => (
            <div key={a.id} id={`alamat-${a.id}`} className="grid gap-3 rounded-md border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {a.label} {a.isActive ? null : <ToneBadge tone="muted">Nonaktif</ToneBadge>}
                  </p>
                  <p className="text-sm text-muted-foreground">{a.addressText}</p>
                </div>
                <div className="flex flex-wrap gap-1">
                  <StatusBadge enumName="coordinate_status" value={a.coordinateStatus} tone={a.coordinateStatus === "locked" ? "success" : "warning"} />
                  <ToneBadge tone={a.zoneAssignment === "manual" ? "warning" : "info"}>
                    {a.zoneCode ?? "Tanpa zona"} · {label("zone_assignment", a.zoneAssignment)}
                  </ToneBadge>
                </div>
              </div>
              <KeyValueList
                columns={3}
                items={[
                  { label: "Koordinat", value: a.lat !== null && a.lng !== null ? `${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}` : "Belum dikunci", hint: a.coordinateSource ? label("coordinate_source", a.coordinateSource) : undefined },
                  { label: "Sumber acuan", value: a.referenceSourceName ?? "—", hint: a.referenceSourceManual ? `Diubah: ${a.referenceSourceReason ?? ""}` : "Terdekat (bawaan)" },
                  { label: "Jarak", value: a.distanceM !== null ? `${(a.distanceM / 1000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} km` : "—", hint: a.distanceMethod ? `${label("distance_method", a.distanceMethod)}${a.distanceNeedsRecalc ? " · perlu hitung ulang" : ""}` : undefined },
                  ...(a.zoneManualReason ? [{ label: "Alasan zona manual", value: a.zoneManualReason, full: true }] : []),
                  ...(a.notes ? [{ label: "Catatan", value: a.notes, full: true }] : []),
                ]}
              />
              {a.proposedLat !== null && a.coordinateStatus === "unlocked" ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-warning/10 p-2 text-sm">
                  <span>
                    Usulan koordinat dari lokasi Selesai rit: {a.proposedLat.toFixed(5)}, {a.proposedLng?.toFixed(5)}
                  </span>
                  {canLock ? (
                    <span className="flex gap-2">
                      <ActionButton label="Konfirmasi" action={confirmProposalAction.bind(null, id, a.id)} />
                      <ReasonActionButton label="Tolak" title="Tolak usulan koordinat?" action={rejectProposalAction.bind(null, id, a.id)} />
                    </span>
                  ) : null}
                </div>
              ) : null}
              {a.isActive && (canLock || canUpdate) ? (
                <details className="text-sm">
                  <summary className="cursor-pointer text-primary">Ubah koordinat, zona, atau sumber acuan</summary>
                  <div className="mt-3 grid gap-4 lg:grid-cols-3">
                    {canLock ? <CoordinateForm action={setCoordinatesAction.bind(null, id, a.id)} prefix={`c_${a.id}_`} defaultValue={a.lat !== null && a.lng !== null ? { lat: a.lat, lng: a.lng } : null} /> : null}
                    {canUpdate ? (
                      <ActionForm action={setManualZoneAction.bind(null, id, a.id)} submitLabel="Tetapkan zona manual" variant="outline">
                        <SelectField label="Zona" name="zoneId" options={zones} required placeholder="— Pilih zona —" />
                        <TextField label="Alasan" name="reason" required placeholder="Alamat di batas zona / tanpa koordinat" />
                      </ActionForm>
                    ) : null}
                    {canUpdate && a.lat !== null ? (
                      <ActionForm action={setReferenceSourceAction.bind(null, id, a.id)} submitLabel="Ubah sumber acuan" variant="outline">
                        <SelectField label="Sumber air acuan" name="waterSourceId" options={sourceOptions} placeholder="— Terdekat (bawaan) —" />
                        <TextField label="Alasan" name="reason" required />
                      </ActionForm>
                    ) : null}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {canUpdate && a.zoneAssignment === "manual" && a.lat !== null ? <ReasonActionButton label="Kembalikan zona otomatis" title="Kembalikan zona otomatis dari koordinat?" action={clearManualZoneAction.bind(null, id, a.id)} /> : null}
                    {canUpdate ? <ReasonActionButton label="Nonaktifkan alamat" title="Nonaktifkan alamat ini?" action={deactivateAddressAction.bind(null, id, a.id)} destructive /> : null}
                  </div>
                </details>
              ) : null}
            </div>
          ))}
          {canUpdate && customer.isActive ? (
            <details>
              <summary className="cursor-pointer text-sm text-primary">Tambah alamat kirim</summary>
              <div className="mt-3">
                <AddAddressForm action={addAddressAction.bind(null, id)} zones={zones} />
              </div>
            </details>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard title="Harga khusus" description="Per produk, beralasan, berlaku setelah persetujuan pemilik; tinjauan otomatis 6 bulan (BR-16, PAR-24).">
        <div className="grid gap-4" id="harga-khusus">
          {detail.specialPrices.length ? (
            <ul className="grid gap-1 text-sm">
              {detail.specialPrices.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2">
                  <StatusBadge enumName="price_status" value={s.status} />
                  {s.productName}: <MoneyText value={s.price} /> · mulai {formatTanggal(s.validFrom, { weekday: false })} · tinjauan {formatTanggal(s.reviewDate, { weekday: false })}
                  {s.validUntil ? ` · s.d. ${formatTanggal(s.validUntil, { weekday: false })}` : ""} · {s.reason}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Belum ada harga khusus.</p>
          )}
          {canSpecial && customer.isActive ? (
            <ActionForm action={requestSpecialPriceAction.bind(null, id)} submitLabel="Ajukan harga khusus" variant="outline">
              <FormGrid>
                <SelectField label="Produk" name="productId" options={productOptions} required placeholder="— Pilih produk —" />
                <TextField label="Harga (Rp)" name="price" inputMode="numeric" required />
                <TextField label="Mulai berlaku" name="validFrom" type="date" required />
                <TextField label="Alasan" name="reason" required />
              </FormGrid>
            </ActionForm>
          ) : null}
        </div>
      </SectionCard>

      {canUpdate ? (
        <SectionCard title="Ubah data pelanggan" description="Status kredit, batas, dan tempo tidak dapat diubah di sini (lewat persetujuan pemilik).">
          <CustomerEditForm
            action={updateCustomerAction.bind(null, id)}
            initialData={customer.isInitialData}
            defaults={{ name: customer.name, segment: customer.segment, waPhone: customer.waPhone ? formatWaNumber(customer.waPhone) : "", contactName: customer.contactName, notes: customer.notes, fixedReceiveTime: customer.fixedReceiveTime }}
          />
        </SectionCard>
      ) : null}

      {can(ctx, "m10.audit_log.read") ? (
        <p className="text-sm">
          <Link href={`/audit?objectId=${id}`} className="text-primary underline-offset-4 hover:underline">
            Lihat jejak audit pelanggan ini
          </Link>
        </p>
      ) : null}
    </div>
  );
}
