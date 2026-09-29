import type { Metadata } from "next";

import { Field, M3ActionForm, TextAreaField } from "@/components/m3-driver/office-form";
import { EmptyState } from "@/components/shared/empty-state";
import { KeyValueList } from "@/components/shared/key-value-list";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { label } from "@/lib/labels";
import { formatTanggal } from "@/lib/time";
import { requirePermission } from "@/server/core/auth/office";
import * as m3 from "@/server/modules/m3-driver";

import { correctTripAction, reverseTripPaymentAction } from "../actions";

export const metadata: Metadata = { title: "Koreksi rit" };

/**
 * Koreksi rit Selesai & pembalik pembayaran rit oleh Admin Keuangan (B-34; FR-M3-07, US-M3-10 KP-2, BR-38). Rit dan
 * pembayaran tidak pernah dihapus: harga/volume dikoreksi dengan alasan (nilai lama di jejak audit), pembayaran salah
 * dibalik dengan baris pembalik. Koreksi > PAR-21 menunggu persetujuan pemilik. Piutang (faktur koreksi / nota kredit /
 * uang muka), transfer masuk, dan jurnal disesuaikan otomatis lewat event `trip.corrected` / `trip_payment.reversed`.
 */
export default async function KoreksiRitPage({ searchParams }: PageProps<"/sopir-kantor/koreksi">) {
  const { ctx } = await requirePermission("m3.trip.correct");
  const sp = await searchParams;
  const number = typeof sp.rit === "string" ? sp.rit.trim() : "";
  const view = number ? await m3.findTripForCorrection(ctx, number) : null;
  const t = view?.trip;

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Koreksi rit"
        description="Koreksi harga/volume rit Selesai dan pembalik pembayaran rit yang salah catat. Wajib beralasan; di atas batas PAR-21 disetujui pemilik. Piutang & jurnal disesuaikan otomatis."
        actions={
          <form method="get" className="flex items-center gap-2">
            <input name="rit" defaultValue={number} placeholder="P-26-000123/1" aria-label="Nomor rit" className="h-9 w-48 rounded-md border border-input bg-transparent px-2 text-sm" />
            <Button type="submit" variant="outline" size="sm">
              Cari rit
            </Button>
          </form>
        }
      />

      {!number ? (
        <EmptyState title="Cari rit" description="Masukkan nomor rit (mis. P-26-000123/1) dari pesanan, faktur, atau laporan sopir." />
      ) : !view || !t ? (
        <EmptyState title="Rit tidak ditemukan" description={`Nomor ${number} tidak ada di tenant ini. Periksa penulisan nomor rit (termasuk /n).`} />
      ) : (
        <>
          <SectionCard title={`Rit ${t.number}`} description={`${view.customerName} · ${formatTanggal(t.scheduledDate)}`}>
            <div className="flex flex-wrap items-center gap-2" data-testid="koreksi-rit-status">
              <StatusBadge enumName="trip_status" value={t.status} />
              {t.isInternal ? <ToneBadge tone="info">Internal</ToneBadge> : null}
              <ToneBadge tone="muted">{label("payment_method", t.paymentMethod)}</ToneBadge>
            </div>
            <KeyValueList
              items={[
                { label: "Harga rit", value: <MoneyText value={t.price} /> },
                { label: "Volume terkirim", value: `${(t.deliveredVolumeL ?? t.plannedVolumeL).toLocaleString("id-ID")} L` },
                { label: "Piutang rit terbuka", value: <MoneyText value={view.openReceivable} /> },
              ]}
            />
          </SectionCard>

          {t.status === "completed" && !t.isInternal ? (
            <SectionCard title="Koreksi harga / volume" description="Harga turun melebihi piutang rit yang masih terbuka menjadi uang muka pelanggan (dapat dikembalikan dari Piutang).">
              <M3ActionForm action={correctTripAction.bind(null, t.id)} submitLabel="Simpan koreksi" testId="form-koreksi-rit">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Harga rit baru (Rp)" name="price" inputMode="numeric" defaultValue={t.price} />
                  <Field label="Volume terkirim (liter)" name="deliveredVolumeL" inputMode="numeric" defaultValue={t.deliveredVolumeL ?? t.plannedVolumeL} />
                </div>
                <TextAreaField label="Alasan koreksi" name="reason" required hint="Minimal 10 karakter, mis. volume parsial 4.000 L disepakati dengan pelanggan." />
              </M3ActionForm>
            </SectionCard>
          ) : (
            <SectionCard title="Koreksi harga / volume">
              <p className="text-sm text-muted-foreground">Hanya rit pelanggan berstatus Selesai yang dapat dikoreksi.</p>
            </SectionCard>
          )}

          <SectionCard title="Pembayaran rit" description="Pembayaran tunai/transfer yang salah dibalik (baris asal tetap tampil). Tempo & pembayaran digital dikoreksi di menu Piutang.">
            {view.payments.length === 0 ? (
              <EmptyState compact title="Belum ada pembayaran rit" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tanggal</TableHead>
                    <TableHead>Cara bayar</TableHead>
                    <TableHead className="text-right">Diterima</TableHead>
                    <TableHead className="text-right">Kurang bayar</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Tindakan</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.payments.map((p) => {
                    const live = !p.reversalOfId && !p.reversedAt;
                    const reversible = live && (p.method === "cash" || p.method === "transfer") && p.receivedAmount > 0;
                    return (
                      <TableRow key={p.id} data-testid={`pembayaran-rit-${p.id}`}>
                        <TableCell>{formatTanggal(p.businessDate, { weekday: false })}</TableCell>
                        <TableCell>{label("payment_method", p.method)}</TableCell>
                        <TableCell className="text-right">
                          <MoneyText value={p.receivedAmount} />
                        </TableCell>
                        <TableCell className="text-right">
                          <MoneyText value={p.underpaymentAmount} />
                        </TableCell>
                        <TableCell>
                          {p.reversalOfId ? <ToneBadge tone="warning">Baris pembalik{p.reversalReason ? `: ${p.reversalReason}` : ""}</ToneBadge> : p.reversedAt ? <ToneBadge tone="muted">Dibalik</ToneBadge> : <ToneBadge tone="success">Berlaku</ToneBadge>}
                        </TableCell>
                        <TableCell className="min-w-64">
                          {reversible ? (
                            <M3ActionForm action={reverseTripPaymentAction.bind(null, p.id)} submitLabel="Balik pembayaran" variant="destructive" testId={`form-balik-${p.id}`}>
                              <TextAreaField label="Alasan pembalik" name="reason" required hint="Minimal 10 karakter." />
                            </M3ActionForm>
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
