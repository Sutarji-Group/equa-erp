import { CircleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionForm } from "@/components/m2-orders/action-form";
import { ReasonActionButton } from "@/components/m2-orders/action-buttons";
import { FormGrid, SelectField, TextAreaField, TextField } from "@/components/m2-orders/fields";
import { OrderFlags } from "@/components/m2-orders/order-table";
import { WaConfirmButton } from "@/components/m2-orders/wa-button";
import { KeyValueList } from "@/components/shared/key-value-list";
import { MoneyText } from "@/components/shared/money-text";
import { OfficeBreadcrumbLabel } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Timeline, type TimelineItem } from "@/components/shared/timeline";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { enumOptions, label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam, toBusinessDate, toWibParts } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import { isDomainError } from "@/server/core/errors";
import { can } from "@/server/core/rbac";
import * as m2 from "@/server/modules/m2-orders";

import {
  cancelOrderAction,
  changePaymentAction,
  reconfirmAction,
  refreshPriceAction,
  requestCreditApprovalAction,
  requestUnderpaymentApprovalAction,
  rescheduleAction,
  sendWaAction,
  updateNotesAction,
} from "../actions";

export const metadata: Metadata = { title: "Rincian pesanan" };

const ACTION_TITLES: Record<string, string> = {
  create: "Pesanan dibuat",
  status: "Status berubah",
  cancel: "Pesanan dibatalkan",
  reschedule: "Dijadwalkan ulang",
  update: "Pesanan diubah",
  reconfirm: "Konfirmasi ulang dicatat",
  credit_approved: "Tempo disetujui pemilik",
  credit_rejected: "Tempo ditolak pemilik",
  underpayment_approved: "Pesanan kurang bayar kedua disetujui",
  approve: "Persetujuan diputuskan",
  reject: "Persetujuan ditolak",
  wa_opened: "Konfirmasi WA dibuka",
  wa_sent: "Konfirmasi WA terkirim",
  wa_failed: "Konfirmasi WA gagal terkirim",
};

/**
 * Rincian pesanan (US-M2-02, US-M2-05, US-M2-07, US-M2-09): rit & truk, siklus status berjejak (waktu & pelaku),
 * riwayat tanggal, persetujuan, penghalang jadwal, peringatan harga berubah (PTB-13), dan tindakan Dispatcher.
 */
export default async function PesananDetailPage({ params }: PageProps<"/pesanan/[id]">) {
  const { ctx } = await requirePermission("m2.order.read");
  const { id } = await params;
  let d: m2.OrderDetail;
  try {
    d = await m2.getOrderDetail(ctx, id);
  } catch (error) {
    if (isDomainError(error)) notFound();
    throw error;
  }
  const o = d.order;
  const locked = o.status === "completed" || o.status === "cancelled";
  const onRoad = d.trips.some((t) => t.status === "departed" || t.status === "arrived");
  const openTrips = d.trips.filter((t) => t.status === "assigned" && !t.withdrawnAt);
  const today = toBusinessDate(ctx.now);
  const canUpdate = can(ctx, "m2.order.update");
  const reconfirmPending = o.reconfirmationRequired && !o.reconfirmedAt;
  const hasSecondUnderpaymentBlock = d.blockers.some((b) => b.code === "second_underpayment");
  const creditBlocked = d.blockers.some((b) => b.code === "credit_rejected");

  const timeline: TimelineItem[] = d.timeline.map((t) => {
    const after = (t.after ?? {}) as Record<string, unknown>;
    return {
      id: t.id,
      title: ACTION_TITLES[t.action] ?? t.action,
      at: t.at,
      actor: t.actorName ?? "Sistem",
      description: t.reason ?? undefined,
      status: t.action === "status" && typeof after.status === "string" ? { enumName: "order_status", value: after.status } : t.action === "cancel" ? { enumName: "order_status", value: "cancelled" } : undefined,
    };
  });

  return (
    <div className="grid gap-6">
      <OfficeBreadcrumbLabel label={o.number} />
      <PageHeader
        backHref="/pesanan"
        backLabel="Daftar pesanan"
        meta={
          <>
            <StatusBadge enumName="order_status" value={o.status} />
            <span>{label("order_source", o.source)}</span>
          </>
        }
        title={<span className="tabular-nums">{o.number}</span>}
        description={`${d.customer.name} · ${formatTanggal(o.requestedDate)}${o.requestedTime ? ` pukul ${o.requestedTime.slice(0, 5).replace(":", ".")}` : ""} · ${o.tankCount} tangki`}
        actions={!locked && can(ctx, "m2.order.send_wa") ? <WaConfirmButton action={sendWaAction.bind(null, o.id)} /> : null}
      />

      <OrderFlags
        row={{
          isInternal: o.isInternal,
          recurring: !!o.recurringOrderId,
          possibleDuplicate: o.possibleDuplicate,
          needsReschedule: o.needsReschedule,
          reconfirmPending,
          collectUnderpayment: o.collectUnderpayment,
          afterCutoffForced: o.afterCutoffForced,
          priceIsProvisional: o.priceIsProvisional,
        }}
      />

      {d.blockers.length && !locked ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertTitle>Belum dapat dijadwalkan/diterbitkan</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5">
              {d.blockers.map((b) => (
                <li key={b.code}>{b.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {d.priceChange?.changed && !locked ? (
        <Alert>
          <CircleAlert aria-hidden />
          <AlertTitle>Harga berubah sebelum kirim (PTB-13)</AlertTitle>
          <AlertDescription>
            Harga terkunci {formatRupiah(d.priceChange.lockedUnitPrice)}/rit, harga berlaku saat kirim {formatRupiah(d.priceChange.currentUnitPrice)}/rit (selisih {formatRupiah(d.priceChange.difference, { signed: true })}). Perbarui
            hanya setelah pelanggan setuju.
            {canUpdate ? (
              <div className="mt-2">
                <ReasonActionButton label="Perbarui harga" title="Perbarui harga pesanan?" description="Tuliskan konfirmasi pelanggan (siapa, kapan, lewat apa)." confirmLabel="Perbarui" action={refreshPriceAction.bind(null, o.id)} />
              </div>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {o.priceIsProvisional && !d.priceChange?.changed && !locked && canUpdate ? (
        <Alert>
          <AlertDescription>
            Harga sementara: setelah zona alamat ditetapkan di Data master, perbarui harga.{" "}
            <ReasonActionButton label="Perbarui harga" title="Perbarui harga pesanan?" description="Tuliskan konfirmasi pelanggan atas harga final." action={refreshPriceAction.bind(null, o.id)} />
          </AlertDescription>
        </Alert>
      ) : null}

      {d.duplicates.length ? (
        <Alert>
          <AlertDescription>
            Pesanan lain untuk alamat & tanggal yang sama:{" "}
            {d.duplicates.map((x, i) => (
              <span key={x.id}>
                {i ? ", " : ""}
                <Link href={`/pesanan/${x.id}`} className="font-medium underline">
                  {x.number}
                </Link>{" "}
                ({label("order_status", x.status)})
              </span>
            ))}
            {o.duplicateReason ? ` — alasan tambahan: ${o.duplicateReason}` : ""}
          </AlertDescription>
        </Alert>
      ) : null}

      <SectionCard title="Pesanan">
        <KeyValueList
          columns={3}
          items={[
            {
              label: "Pelanggan",
              value: can(ctx, "m1.customer.read") ? (
                <Link href={`/master/pelanggan/${d.customer.id}`} className="text-primary underline-offset-4 hover:underline">
                  {d.customer.name}
                </Link>
              ) : (
                d.customer.name
              ),
              hint: label("credit_status", d.customer.creditStatus),
            },
            { label: "Alamat kirim", value: `${d.address.label} — ${d.address.addressText}`, full: true },
            { label: "Tanggal & jam diminta", value: `${formatTanggal(o.requestedDate)}${o.requestedTime ? ` ${o.requestedTime.slice(0, 5).replace(":", ".")}` : ""}` },
            { label: "Jumlah tangki", value: String(o.tankCount) },
            { label: "Cara bayar", value: label("payment_method", o.paymentMethod) },
            { label: "Harga per rit", value: <MoneyText value={o.pricePerTrip} />, hint: `${label("order_price_source", o.priceSource)}${o.priceIsProvisional ? " · harga sementara" : ""}` },
            { label: "Total", value: <MoneyText value={o.totalAmount} /> },
            { label: "Dibuat", value: formatTanggalJam(o.createdAt), hint: d.createdByName ?? "Sistem" },
            ...(o.afterCutoffForced ? [{ label: "H+0 setelah batas (6.2c)", value: o.afterCutoffReason ?? "—" }] : []),
            ...(o.creditExposureAtDecision != null ? [{ label: "Eksposur saat keputusan", value: <MoneyText value={o.creditExposureAtDecision} />, hint: `Batas ${formatRupiah(o.creditLimitAtDecision ?? 0)}` }] : []),
            ...(d.exposure ? [{ label: "Eksposur kredit saat ini", value: <MoneyText value={d.exposure.exposure} />, hint: `Batas ${formatRupiah(d.exposure.creditLimit)} · sisa ${formatRupiah(d.exposure.remaining)}` }] : []),
            ...(o.reconfirmationRequired
              ? [{ label: "Konfirmasi ulang (BR-24)", value: o.reconfirmedAt ? `${formatTanggalJam(o.reconfirmedAt)} · ${o.reconfirmationMethod ?? ""}` : "Belum", hint: d.reconfirmedByName ?? undefined }]
              : []),
            ...(o.status === "cancelled" ? [{ label: "Alasan batal", value: `${label("order_cancel_reason", o.cancelReason)}${o.cancelNote ? `: ${o.cancelNote}` : ""}`, hint: `${d.cancelledByName ?? "Sistem"} · ${o.cancelledAt ? formatTanggalJam(o.cancelledAt) : ""}` }] : []),
            { label: "Catatan (ke sopir)", value: o.notes ?? "—", full: true },
          ]}
        />
      </SectionCard>

      <SectionCard title="Rit" description="n tangki = n rit; tiap rit dapat dijadwalkan ke truk & hari berbeda.">
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>No. rit</TableHead>
                <TableHead>Tanggal</TableHead>
                <TableHead>Truk</TableHead>
                <TableHead>Pengemudi</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Harga</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.trips.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium tabular-nums">{t.number}</TableCell>
                  <TableCell>{formatTanggal(t.scheduledDate, { weekday: false })}</TableCell>
                  <TableCell>{t.truckCode ?? "—"}</TableCell>
                  <TableCell>{t.driverName ?? "—"}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {t.status !== "assigned" ? <StatusBadge enumName="trip_status" value={t.status} /> : null}
                      {t.withdrawnAt ? <ToneBadge tone="muted">Ditarik</ToneBadge> : t.status === "assigned" ? (t.truckId ? (t.publishedAt ? <ToneBadge tone="info">Terbit</ToneBadge> : <ToneBadge tone="warning">Draf</ToneBadge>) : <ToneBadge tone="warning">Belum terjadwal</ToneBadge>) : null}
                      {t.failReason ? <ToneBadge tone="danger">{label("trip_fail_reason", t.failReason)}</ToneBadge> : null}
                      {t.syncConflict && !t.syncConflictResolvedAt ? <ToneBadge tone="danger">Konflik</ToneBadge> : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <MoneyText value={t.price} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      {!locked && !onRoad ? (
        <div className="grid gap-6 lg:grid-cols-2">
          {can(ctx, "m2.order.reschedule") ? (
            <SectionCard title="Jadwal ulang" description="Ubah tanggal diminta dengan alasan; riwayat tanggal tersimpan (US-M2-09 KP-1).">
              <ActionForm action={rescheduleAction.bind(null, o.id)} submitLabel="Simpan tanggal baru" aria-label="Jadwal ulang">
                <FormGrid>
                  <TextField label="Tanggal baru" name="requestedDate" type="date" min={today} required defaultValue={o.requestedDate < today ? today : o.requestedDate} />
                  <TextField label="Jam" name="requestedTime" type="time" defaultValue={o.requestedTime?.slice(0, 5) ?? ""} />
                  <TextField label="Alasan" name="reason" required className="sm:col-span-2" placeholder="Mis. pelanggan minta besok pagi" />
                </FormGrid>
              </ActionForm>
            </SectionCard>
          ) : null}
          {canUpdate && !o.isInternal && openTrips.length ? (
            <SectionCard title="Cara bayar" description="Dispatcher dapat mengubah ke tunai kapan saja; tempo mengikuti kontrol kredit (US-M2-05).">
              <ActionForm action={changePaymentAction.bind(null, o.id)} submitLabel="Ubah cara bayar" aria-label="Ubah cara bayar">
                <FormGrid>
                  <SelectField label="Cara bayar" name="paymentMethod" defaultValue={o.paymentMethod} options={enumOptions("payment_method").filter((x) => ["cash", "transfer", "credit"].includes(x.value))} />
                  <TextField label="Keterangan" name="reason" placeholder="Opsional" />
                </FormGrid>
              </ActionForm>
              <div className="mt-3 flex flex-wrap gap-2">
                {can(ctx, "m2.order.request_approval") && o.paymentMethod === "credit" && o.status === "new" && (creditBlocked || d.blockers.length === 0) ? (
                  <ReasonActionButton
                    label="Ajukan persetujuan pemilik (tempo)"
                    title="Ajukan persetujuan tempo?"
                    description="Persetujuan berlaku untuk pesanan ini saja; batas pelanggan tidak berubah."
                    confirmLabel="Ajukan"
                    action={requestCreditApprovalAction.bind(null, o.id)}
                  />
                ) : null}
                {can(ctx, "m2.order.request_approval") && hasSecondUnderpaymentBlock && o.status === "new" ? (
                  <ReasonActionButton
                    label="Ajukan persetujuan pemilik (kurang bayar kedua)"
                    title="Ajukan persetujuan pesanan saat kurang bayar kedua?"
                    description="PTB-18: pesanan hanya dapat dijadwalkan setelah lunas atau disetujui pemilik."
                    confirmLabel="Ajukan"
                    action={requestUnderpaymentApprovalAction.bind(null, o.id)}
                  />
                ) : null}
              </div>
            </SectionCard>
          ) : null}
          {reconfirmPending && can(ctx, "m2.order.reconfirm") ? (
            <SectionCard title="Sudah dikonfirmasi ulang (BR-24)" description="Wajib sebelum dijadwalkan: catat waktu & cara konfirmasi dengan pelanggan.">
              <ActionForm action={reconfirmAction.bind(null, o.id)} submitLabel="Catat konfirmasi ulang" aria-label="Konfirmasi ulang">
                <FormGrid>
                  <TextField label="Tanggal konfirmasi" name="date" type="date" required defaultValue={today} max={today} />
                  <TextField label="Jam" name="time" type="time" required defaultValue={toWibParts(ctx.now).time} />
                  <SelectField label="Cara" name="method" required options={[{ value: "Telepon", label: "Telepon" }, { value: "WhatsApp", label: "WhatsApp" }, { value: "Datang langsung", label: "Datang langsung" }]} />
                  <TextField label="Keterangan" name="note" placeholder="Mis. Bu pemilik ada di rumah besok pagi" />
                </FormGrid>
              </ActionForm>
            </SectionCard>
          ) : null}
          {canUpdate ? (
            <SectionCard title="Catatan untuk sopir" description="Ikut terkirim ke aplikasi sopir pada rit terkait (US-M2-08 KP-2).">
              <ActionForm action={updateNotesAction.bind(null, o.id)} submitLabel="Simpan catatan" resetOnSuccess={false} aria-label="Catatan pesanan">
                <TextAreaField label="Catatan" name="notes" defaultValue={o.notes ?? ""} />
              </ActionForm>
            </SectionCard>
          ) : null}
          {can(ctx, "m2.order.cancel") ? (
            <SectionCard title="Batalkan pesanan" description="Alasan wajib dari daftar; alasan 'Dobel' dihitung KPI-06. Tidak ada penghapusan.">
              <ReasonActionButton
                label="Batalkan pesanan"
                title={`Batalkan ${o.number}?`}
                description="Rit yang belum berangkat ditarik dari jadwal."
                reasons={enumOptions("order_cancel_reason")
                  .filter((x) => x.value !== "other")
                  .map((x) => ({ code: x.value, label: x.label }))}
                confirmLabel="Batalkan pesanan"
                destructive
                variant="destructive"
                action={cancelOrderAction.bind(null, o.id)}
              />
            </SectionCard>
          ) : null}
        </div>
      ) : onRoad ? (
        <p className="text-sm text-muted-foreground">Pesanan sedang Dalam pengiriman — tidak dapat dibatalkan dari kantor (Bab 5.2). Bila tidak jadi, sopir menandai rit Gagal.</p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Riwayat status & perubahan" description="Setiap transisi mencatat waktu dan pelaku (US-M2-02 KP-2).">
          <Timeline items={timeline} />
        </SectionCard>
        <div className="grid content-start gap-6">
          {d.dateHistory.length ? (
            <SectionCard title="Riwayat tanggal">
              <ul className="grid gap-2 text-sm">
                {d.dateHistory.map((h) => (
                  <li key={h.id}>
                    {formatTanggal(h.fromDate, { weekday: false })} → <span className="font-medium">{formatTanggal(h.toDate, { weekday: false })}</span> · {h.reason}
                    <span className="block text-xs text-muted-foreground">
                      {h.changedByName ?? "—"} · {formatTanggalJam(h.changedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
          {d.approvals.length ? (
            <SectionCard title="Persetujuan">
              <ul className="grid gap-2 text-sm">
                {d.approvals.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {label("approval_type", a.type)} · <span className="tabular-nums">{a.number}</span>
                      {a.decisionReason ? <span className="block text-xs text-muted-foreground">{a.decisionReason}</span> : null}
                    </span>
                    <StatusBadge enumName="approval_status" value={a.status} />
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
          <SectionCard title="Konfirmasi WA" description="Sistem mencatat 'konfirmasi dibuka' — bukan terkirim/terbaca.">
            {d.waLogs.length ? (
              <ul className="grid gap-1 text-sm">
                {d.waLogs.map((w) => (
                  <li key={w.id}>
                    {label("wa_message_status", w.status)} · {w.openedAt ? formatTanggalJam(w.openedAt) : "—"} · {w.openedByName ?? "—"}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Belum pernah dibuka.</p>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
