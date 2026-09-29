import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { P2ActionForm } from "@/components/p2-customer/action-form";
import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { newId } from "@/lib/ids";
import { formatRupiah } from "@/lib/money";
import { formatTanggal } from "@/lib/time";
import { NotFoundError } from "@/server/core/errors";
import * as p2 from "@/server/modules/p2-customer";
import { requireCustomer } from "@/server/modules/p2-customer/web";

import { reorderAction } from "../../actions";

export const metadata: Metadata = { title: "Pesan ulang" };

/** Pesan ulang satu ketukan (US-P2-05 KP-2): alamat, jumlah tangki & cara bayar pesanan rujukan; slot terdekat. */
export default async function PesanUlangPage({ searchParams }: PageProps<"/app/pesan/ulang">) {
  const cctx = await requireCustomer({ next: "/app/pesan/ulang" });
  const sp = await searchParams;
  const ref = typeof sp.dari === "string" ? sp.dari : null;
  if (!ref) notFound();
  let order: p2.MyOrderDetail;
  try {
    order = await p2.getMyOrder(cctx, ref);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  return (
    <CustomerShell title="Pesan ulang" active="order" backHref="/app">
      <CustomerCard title="Sama seperti pesanan terakhir">
        <p className="text-sm">
          {order.tankCount} tangki ke <strong>{order.address.label}</strong> ({order.address.addressText}). Terakhir {formatTanggal(order.requestedDate)}, {formatRupiah(order.total)}.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Tanggal & slot tersedia terdekat dipilih otomatis; harga mengikuti tarif hari ini.</p>
        <P2ActionForm action={reorderAction} submitLabel="Pesan ulang sekarang" fullWidth size="lg" className="mt-3" resetOnSuccess={false} testId="reorder-form">
          <input type="hidden" name="orderId" value={order.id} />
          <input type="hidden" name="clientRequestId" value={newId()} />
        </P2ActionForm>
      </CustomerCard>
    </CustomerShell>
  );
}
