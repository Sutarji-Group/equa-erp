import type { Metadata } from "next";

import { P3ActionForm } from "@/components/p3-partner/action-form";
import { CheckField, Field, SelectField, TextAreaField } from "@/components/p3-partner/fields";
import { Phase3Disabled } from "@/components/p3-partner/phase3-disabled";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EmptyState } from "@/components/shared/empty-state";
import { MoneyText } from "@/components/shared/money-text";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";
import { label } from "@/lib/labels";
import { addDays, formatTanggal, formatTanggalJam, toBusinessDate } from "@/lib/time";
import * as p3 from "@/server/modules/p3-partner";

import { requirePortalSession } from "../../_session";
import { cancelSparePartAction, sparePartOrderAction, waterOrderAction } from "../../actions";

export const metadata: Metadata = { title: "Pesan air & spare part" };

const PAYMENT = [
  { value: "cash", label: "Tunai ke sopir/kasir" },
  { value: "transfer", label: "Transfer" },
  { value: "credit", label: "Tempo (dalam batas kredit kontrak)" },
];

/**
 * Pesanan portal mitra (Tahap 3 US-P3-03): air → pesanan M2 (harga zona outlet − diskon Opsi A; SLA 24 jam PAR-76),
 * spare part → katalog toko EQUA harga mitra (BR-18), dikonfirmasi kasir; ambil di toko atau ikut truk. Tempo memakai
 * satu batas kredit kontrak lintas lini. Penghentian pasokan (sanksi) menolak pesanan air dengan alasan & syarat
 * pemulihan (US-P3-07 KP-1). Status, rit, volume kirim, bukti kirim & konfirmasi volume operator tampil di sini.
 */
export default async function PortalOrdersPage() {
  const { ctx } = await requirePortalSession();
  const data = await p3.portalOrders(ctx);
  if (!data.enabled) {
    return (
      <>
        <PageHeader title="Pesan air & spare part" />
        <Phase3Disabled what="Pemesanan air & spare part dari portal" />
      </>
    );
  }
  const tomorrow = addDays(toBusinessDate(ctx.now), 1);
  const outletOpts = data.outlets.map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` }));
  const single = data.outlets.length === 1 ? data.outlets[0]!.id : null;

  return (
    <>
      <PageHeader
        title="Pesan air & spare part"
        description={
          data.contract
            ? `Kontrak ${data.contract.number} · ${label("partner_option", data.contract.option)}${data.contract.waterDiscountPercent ? ` · diskon air ${data.contract.waterDiscountPercent}%` : ""} · batas kredit ${data.contract.creditLimit.toLocaleString("id-ID")}`
            : undefined
        }
      />
      {data.suspension ? (
        <Alert variant="destructive" data-testid="penghentian-pasokan">
          <AlertTitle>Pasokan air dihentikan sementara sejak {data.suspension.effectiveFrom ? formatTanggal(data.suspension.effectiveFrom) : "-"}</AlertTitle>
          <AlertDescription>
            <p>Alasan: {data.suspension.reason || "-"}</p>
            <p>Syarat pemulihan: {data.suspension.recoveryConditions || "-"}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Pesan air" description="Dikirim truk EQUA; target sampai ≤ 24 jam sejak pesanan dibuat.">
          <P3ActionForm action={waterOrderAction} submitLabel="Kirim pesanan air" testId="form-pesan-air">
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField label="Outlet" name="outletId" required defaultValue={single} options={outletOpts} />
              <Field label="Jumlah tangki (rit)" name="tankCount" type="number" min="1" max="20" defaultValue={1} required />
              <Field label="Tanggal kirim" name="requestedDate" type="date" defaultValue={tomorrow} required />
              <Field label="Jam (opsional)" name="requestedTime" type="time" />
              <SelectField label="Cara bayar" name="paymentMethod" required defaultValue="cash" options={PAYMENT} />
            </div>
            <TextAreaField label="Catatan (opsional)" name="notes" rows={2} />
            <CheckField name="confirmAdditional" label="Ini pesanan tambahan (sudah ada pesanan pada tanggal yang sama)" />
          </P3ActionForm>
        </SectionCard>

        <SectionCard title="Pesan spare part & bahan" description="Harga mitra toko EQUA. Kasir toko mengonfirmasi pesanan saat mencatat penjualan.">
          {data.catalog.length === 0 ? (
            <p className="text-sm text-muted-foreground">Katalog harga mitra belum tersedia.</p>
          ) : (
            <P3ActionForm action={sparePartOrderAction} submitLabel="Kirim pesanan spare part" testId="form-pesan-spare-part">
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField label="Outlet" name="outletId" required defaultValue={single} options={outletOpts} />
                <SelectField
                  label="Cara ambil"
                  name="pickup"
                  required
                  defaultValue="store_pickup"
                  options={[
                    { value: "store_pickup", label: label("spare_part_pickup", "store_pickup") },
                    { value: "with_truck", label: label("spare_part_pickup", "with_truck") },
                  ]}
                />
                <SelectField label="Cara bayar" name="paymentMethod" required defaultValue="cash" options={PAYMENT} />
              </div>
              <div className="max-h-72 overflow-y-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted text-left">
                    <tr>
                      <th className="px-2 py-1 font-medium">Barang</th>
                      <th className="px-2 py-1 text-right font-medium">Harga mitra</th>
                      <th className="px-2 py-1 text-right font-medium">Jumlah</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.catalog.map((c) => (
                      <tr key={c.productId} className="border-t">
                        <td className="px-2 py-1">
                          {c.name}
                          <input type="hidden" name="productId" value={c.productId} />
                        </td>
                        <td className="px-2 py-1 text-right">
                          <MoneyText value={c.partnerPrice} /> <span className="text-xs text-muted-foreground">/{c.unit}</span>
                        </td>
                        <td className="px-2 py-1 text-right">
                          <input name="quantity" type="number" min="0" max="999" defaultValue="0" aria-label={`Jumlah ${c.name}`} className="h-9 w-20 rounded-md border border-input bg-background px-2 text-right text-base" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <TextAreaField label="Catatan (opsional)" name="notes" rows={2} />
            </P3ActionForm>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Pesanan saya">
        {data.orders.length === 0 ? (
          <EmptyState title="Belum ada pesanan dari portal" compact />
        ) : (
          <ul className="grid gap-3" data-testid="daftar-pesanan-portal">
            {data.orders.map((o) => (
              <li key={o.id} className="rounded-md border bg-background p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{label("portal_order_kind", o.kind)}</span>
                  {o.orderNumber ? <span>{o.orderNumber}</span> : null}
                  <ToneBadge tone={o.status === "cancelled" || o.status === "rejected" ? "muted" : "info"}>{o.statusText}</ToneBadge>
                  <span className="text-muted-foreground">dipesan {formatTanggalJam(o.submittedAt)}</span>
                  <span className="ml-auto">
                    <MoneyText value={o.estimatedAmount} />
                  </span>
                </div>
                {o.kind === "water" ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {o.tankCount} tangki · kirim {o.requestedDate ? formatTanggal(o.requestedDate) : "-"}
                    {o.requestedTime ? ` ${o.requestedTime}` : ""} · {o.paymentMethod ? label("payment_method", o.paymentMethod) : "-"}
                    {o.slaDueAt ? ` · target sampai ${formatTanggalJam(o.slaDueAt)}` : ""}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {(o.items ?? []).map((i) => `${String(i.name)} × ${String(i.quantity)}`).join(", ")} · {o.pickup ? label("spare_part_pickup", o.pickup) : "-"}
                    {o.saleNumber ? ` · nota ${o.saleNumber}` : ""}
                  </p>
                )}
                {o.trips.length ? (
                  <ul className="mt-2 grid gap-1 text-xs">
                    {o.trips.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center gap-2">
                        <span>Rit {t.number}</span>
                        <StatusBadge enumName="trip_status" value={t.status} />
                        {t.deliveredVolumeL !== null ? <span>dikirim {t.deliveredVolumeL.toLocaleString("id-ID")} L</span> : null}
                        {t.receiptStatus ? (
                          <span>
                            · {label("water_supply_status", t.receiptStatus)}
                            {t.receivedVolumeL !== null ? ` ${t.receivedVolumeL.toLocaleString("id-ID")} L` : ""}
                          </span>
                        ) : null}
                        {t.signatureAttachmentId ? (
                          <a className="text-primary underline" href={`/mitra/lampiran/${t.signatureAttachmentId}`} target="_blank" rel="noreferrer">
                            bukti kirim
                          </a>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {o.rejectedReason ? <p className="mt-1 text-xs">Alasan: {o.rejectedReason}</p> : null}
                {o.kind === "spare_part" && o.status === "submitted" ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-medium text-primary">Batalkan pesanan</summary>
                    <P3ActionForm action={cancelSparePartAction.bind(null, o.id)} submitLabel="Batalkan" variant="outline" className="mt-2 max-w-md">
                      <Field label="Alasan" name="reason" required />
                    </P3ActionForm>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </>
  );
}
