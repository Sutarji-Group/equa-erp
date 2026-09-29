import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { P2ActionForm } from "@/components/p2-customer/action-form";
import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { TrackingPanel } from "@/components/p2-customer/tracking-panel";
import { Button } from "@/components/ui/button";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, formatTanggalJam } from "@/lib/time";
import { cn } from "@/lib/utils";
import { NotFoundError } from "@/server/core/errors";
import * as p2 from "@/server/modules/p2-customer";
import { requireCustomer } from "@/server/modules/p2-customer/web";

import { cancelOrderAction, createPaymentAction, rateDeliveryAction } from "../../actions";

export const metadata: Metadata = { title: "Rincian pesanan" };

const DOT: Record<string, string> = { done: "bg-primary", current: "bg-warning", pending: "bg-muted-foreground/30", failed: "bg-destructive" };

/**
 * Rincian pesanan pelanggan: garis waktu status (US-P2-03 KP-1), peta posisi truk saat Berangkat (KP-2/KP-5),
 * identitas truk & nama depan sopir + hubungi kantor (KP-3), batal sendiri sampai Berangkat (US-P2-02 KP-5), bayar di
 * muka (US-P2-04 KP-4), struk & penilaian per pengiriman (US-P2-04 KP-1, US-P2-06 KP-1), keluhan (US-P2-06 KP-2).
 */
export default async function PesananDetailPage({ params, searchParams }: PageProps<"/app/pesanan/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const cctx = await requireCustomer({ next: `/app/pesanan/${id}` });
  let d: p2.MyOrderDetail;
  try {
    d = await p2.getMyOrder(cctx, id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const [tracking, unread] = await Promise.all([p2.getTracking(cctx, id), p2.unreadNotificationCount(cctx)]);
  return (
    <CustomerShell title={`Pesanan ${d.number}`} active="orders" backHref="/app/pesanan" unread={unread}>
      {sp.baru ? (
        <p role="status" className="mb-3 rounded-md border border-success bg-success/10 p-3 text-sm" data-testid="order-created">
          Pesanan <strong>{d.number}</strong> terkirim. Sebutkan nomor ini bila menelepon kantor.
          {d.confirmDueAt ? ` Kantor EQUA mengonfirmasi paling lambat ${formatTanggalJam(d.confirmDueAt)}.` : ""}
        </p>
      ) : null}

      <CustomerCard title="Status" testId="order-timeline">
        <p className="mb-3 text-sm">
          <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary" data-testid="order-status">
            {d.statusLabel}
          </span>{" "}
          · {formatTanggal(d.requestedDate)}
          {d.slotLabel ? `, ${d.slotLabel}` : ""}
        </p>
        <ol className="relative grid gap-3 border-l pl-4">
          {d.timeline.map((s) => (
            <li key={s.key} className="relative">
              <span className={cn("absolute top-1 -left-[21px] size-3 rounded-full", DOT[s.state])} aria-hidden />
              <p className={cn("text-sm font-medium", s.state === "pending" && "text-muted-foreground")}>
                {s.title}
                {s.at ? <span className="ml-2 text-xs font-normal text-muted-foreground">{formatTanggalJam(s.at)}</span> : null}
              </p>
              {s.description ? <p className="text-xs text-muted-foreground">{s.description}</p> : null}
            </li>
          ))}
        </ol>
      </CustomerCard>

      <CustomerCard title="Posisi truk">
        <TrackingPanel orderId={d.id} initial={tracking} />
      </CustomerCard>

      <CustomerCard title="Pesanan">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Alamat</dt>
          <dd>
            {d.address.label} — {d.address.addressText}
          </dd>
          <dt className="text-muted-foreground">Jumlah</dt>
          <dd>
            {d.tankCount} tangki × {formatRupiah(d.pricePerTank)}
          </dd>
          <dt className="text-muted-foreground">Total</dt>
          <dd className="font-semibold">{formatRupiah(d.total)}</dd>
          <dt className="text-muted-foreground">Cara bayar</dt>
          <dd data-testid="order-payment">{d.paymentLabel}</dd>
        </dl>
        {d.canPay ? (
          <P2ActionForm action={createPaymentAction} submitLabel="Bayar sekarang (QRIS)" className="mt-3" resetOnSuccess={false} testId="pay-order">
            <input type="hidden" name="target" value="order" />
            <input type="hidden" name="orderId" value={d.id} />
            <input type="hidden" name="method" value="qris_dynamic" />
            {sp.bayar ? <p className="text-sm">Selesaikan pembayaran agar pesanan tercatat lunas di muka — sopir tidak menagih tunai.</p> : null}
          </P2ActionForm>
        ) : null}
      </CustomerCard>

      {d.deliveries.length ? (
        <CustomerCard title="Pengiriman">
          <ul className="grid gap-3">
            {d.deliveries.map((x) => (
              <li key={x.tripId} className="rounded-lg border p-3 text-sm" data-testid={`delivery-${x.sequence}`}>
                <p className="flex items-center justify-between">
                  <span className="font-medium">Tangki ke-{x.sequence}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{x.statusLabel}</span>
                </p>
                {x.truckPlate ? (
                  <p className="text-xs text-muted-foreground">
                    Truk {x.truckPlate}
                    {x.driverFirstName ? ` · sopir ${x.driverFirstName}` : ""}
                  </p>
                ) : null}
                {x.status === "completed" ? (
                  <p className="text-xs">
                    {(x.deliveredVolumeL ?? 0).toLocaleString("id-ID")} L diterima{x.recipientName ? ` oleh ${x.recipientName}` : ""}.{" "}
                    <Link href={`/app/struk/${x.tripId}`} className="text-primary underline">
                      Lihat struk
                    </Link>
                  </p>
                ) : null}
                {x.failReason ? <p className="text-xs text-destructive">Gagal: {x.failReason}</p> : null}
                {x.canRate ? (
                  <P2ActionForm action={rateDeliveryAction.bind(null, x.tripId, d.id)} submitLabel="Kirim penilaian" size="sm" className="mt-2" testId={`rate-${x.sequence}`}>
                    <fieldset className="flex gap-3" aria-label="Nilai 1 sampai 5">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <label key={n} className="grid place-items-center gap-0.5 text-xs">
                          <input type="radio" name="rating" value={n} required className="size-5" />
                          {n}★
                        </label>
                      ))}
                    </fieldset>
                    <input name="comment" maxLength={500} placeholder="Komentar (opsional)" className="h-9 rounded-md border border-input bg-background px-2 text-sm" />
                  </P2ActionForm>
                ) : x.rating ? (
                  <p className="mt-1 text-xs">Nilai Anda: {"★".repeat(x.rating)}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </CustomerCard>
      ) : null}

      <div className="grid gap-2">
        <Button asChild variant="outline">
          <Link href={`/app/keluhan/baru?pesanan=${d.id}`}>Ajukan keluhan untuk pesanan ini</Link>
        </Button>
        {d.canCancel ? (
          <details className="rounded-lg border bg-card p-3">
            <summary className="cursor-pointer text-sm font-medium text-destructive">Batalkan pesanan</summary>
            <P2ActionForm action={cancelOrderAction.bind(null, d.id)} submitLabel="Batalkan pesanan" variant="destructive" className="mt-3" testId="cancel-order">
              <label className="grid gap-1 text-sm font-medium">
                Alasan pembatalan
                <input name="reason" required minLength={3} maxLength={300} className="h-11 rounded-md border border-input bg-background px-3 text-base" />
              </label>
            </P2ActionForm>
          </details>
        ) : d.cancelBlockedReason ? (
          <p className="text-xs text-muted-foreground">{d.cancelBlockedReason} Telepon {d.officePhone}.</p>
        ) : null}
      </div>
    </CustomerShell>
  );
}
