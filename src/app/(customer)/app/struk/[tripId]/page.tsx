import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { formatRupiah } from "@/lib/money";
import { NotFoundError } from "@/server/core/errors";
import * as p2 from "@/server/modules/p2-customer";
import { requireCustomer } from "@/server/modules/p2-customer/web";

export const metadata: Metadata = { title: "Struk digital" };

/** Struk digital per pengiriman + foto bukti kirim sebagai bukti (US-P2-04 KP-1); pembukaan struk tercatat (KP-5). */
export default async function StrukPage({ params }: PageProps<"/app/struk/[tripId]">) {
  const { tripId } = await params;
  const cctx = await requireCustomer({ next: `/app/struk/${tripId}` });
  let r: p2.ReceiptView;
  try {
    r = await p2.myReceipt(cctx, tripId);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  return (
    <CustomerShell title="Struk digital" active="orders" backHref="/app/pesanan">
      <CustomerCard testId="receipt">
        <p className="text-center text-lg font-semibold">EQUA — Air Bersih</p>
        <p className="mb-3 text-center text-xs text-muted-foreground">Struk pengiriman {r.number}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">No. pesanan</dt>
          <dd>{r.orderNumber}</dd>
          <dt className="text-muted-foreground">Waktu</dt>
          <dd>{r.dateLabel}</dd>
          <dt className="text-muted-foreground">Volume terkirim</dt>
          <dd>
            {(r.deliveredVolumeL ?? 0).toLocaleString("id-ID")} L{r.partialReason ? ` (${r.partialReason})` : ""}
          </dd>
          <dt className="text-muted-foreground">Harga</dt>
          <dd>{formatRupiah(r.price)}</dd>
          <dt className="text-muted-foreground">Cara bayar</dt>
          <dd>{r.paymentLabel}</dd>
          {r.receivedAmount != null ? (
            <>
              <dt className="text-muted-foreground">Diterima</dt>
              <dd>{formatRupiah(r.receivedAmount)}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Penerima</dt>
          <dd>{r.recipientName ?? "—"}</dd>
        </dl>
        {r.photos.length ? (
          <div className="mt-4 grid gap-2">
            <p className="text-sm font-medium">Bukti kirim</p>
            {r.photos.map((p) => (
              // eslint-disable-next-line @next/next/no-img-element -- berkas privat lewat route berotorisasi
              <img key={p.id} src={p.url} alt={p.kind === "signature" ? "Tanda tangan penerima" : "Foto bukti kirim"} className="w-full rounded-md border" />
            ))}
          </div>
        ) : null}
      </CustomerCard>
    </CustomerShell>
  );
}
