import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";

import { P2ActionButton } from "@/components/p2-customer/action-form";
import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { PaymentStatus } from "@/components/p2-customer/payment-status";
import { formatRupiah } from "@/lib/money";
import { formatTanggalJam } from "@/lib/time";
import { NotFoundError } from "@/server/core/errors";
import * as p2 from "@/server/modules/p2-customer";
import { requireCustomer } from "@/server/modules/p2-customer/web";

import { simulatePaymentAction } from "../../actions";

export const metadata: Metadata = { title: "Bayar" };

/** Kode bayar QRIS dinamis / virtual account (US-P2-04 KP-3); status Berhasil diterima otomatis dari gerbang. */
export default async function BayarPage({ params }: PageProps<"/app/bayar/[id]">) {
  const { id } = await params;
  const cctx = await requireCustomer({ next: `/app/bayar/${id}` });
  let v: p2.PaymentIntentView;
  try {
    v = await p2.getMyPaymentIntent(cctx, id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const qr = v.method === "qris_dynamic" && v.qrString && !v.qrString.startsWith("http") ? await QRCode.toDataURL(v.qrString, { margin: 1, width: 280 }) : v.qrString?.startsWith("http") ? v.qrString : null;
  const mock = p2.activeGateway()?.key === "mock";
  return (
    <CustomerShell title="Bayar" active="billing" backHref={v.orderId ? `/app/pesanan/${v.orderId}` : "/app/tagihan"}>
      <CustomerCard testId="payment-intent">
        <p className="text-sm text-muted-foreground">{v.orderNumber ? `Bayar di muka pesanan ${v.orderNumber}` : v.invoiceNumber ? `Faktur ${v.invoiceNumber}` : "Semua tagihan terbuka"}</p>
        <p className="text-2xl font-semibold">{formatRupiah(v.amount)}</p>
        <p className="mb-3 text-xs text-muted-foreground">
          {v.methodLabel} · No. transaksi {v.gatewayOrderId}
          {v.expiresAt ? ` · berlaku sampai ${formatTanggalJam(v.expiresAt)}` : ""}
        </p>
        <PaymentStatus intentId={v.id} initial={{ status: v.status, statusLabel: v.statusLabel }} />
        {v.status === "pending" ? (
          <div className="mt-3 grid gap-3">
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element -- gambar QR data URL
              <img src={qr} alt="Kode QRIS — pindai dengan aplikasi bank atau dompet digital" className="mx-auto size-64 rounded-md border bg-white p-2" />
            ) : null}
            {v.vaNumber ? (
              <p className="text-center text-sm">
                Transfer ke virtual account <strong className="uppercase">{v.vaBank}</strong>
                <span className="block text-2xl font-semibold tracking-wider tabular" data-testid="va-number">
                  {v.vaNumber}
                </span>
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">Status diperbarui otomatis setelah pembayaran diterima gerbang. Biaya gerbang ditanggung EQUA.</p>
            {mock ? <P2ActionButton action={simulatePaymentAction.bind(null, v.id)} label="Simulasikan pembayaran berhasil (mode uji)" variant="secondary" testId="simulate-payment" /> : null}
          </div>
        ) : (
          <Link href={v.orderId ? `/app/pesanan/${v.orderId}` : "/app/tagihan"} className="mt-3 inline-block text-sm text-primary underline">
            Kembali
          </Link>
        )}
      </CustomerCard>
    </CustomerShell>
  );
}
