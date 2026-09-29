"use client";

/**
 * Pesanan spare part portal mitra yang menunggu kasir toko (B-73, US-P3-03 KP-3). Data dari pull P3
 * `p3.store_partner_orders` (tersimpan di perangkat, tampil walau offline). Kasir mengetuk "Isi keranjang" → pelanggan
 * mitra + barang pesanan masuk keranjang dengan harga mitra master (BR-18); pesanan terkonfirmasi otomatis di server
 * saat penjualan harga mitra pelanggan itu tersinkron (tidak ada tombol konfirmasi terpisah).
 */
import { PackageCheck } from "lucide-react";

import {
  P3_STORE_PARTNER_ORDERS_KEY,
  partnerOrderCart,
  type StoreCartPrefill,
  type StorePartnerOrderRef,
  type StorePartnerOrdersReference,
} from "@/client/m7-store/contract";
import { useReference } from "@/client/offline/hooks";
import { BigButton } from "@/components/field/big-button";
import { usePos } from "@/components/m6-pos/pos-context";
import { Banner, PosSection } from "@/components/m6-pos/ui";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggalJam } from "@/lib/time";

import { useStore } from "./store-context";

/** Jumlah pesanan portal menunggu (lencana menu Jual). */
export function usePendingPartnerOrders(): StorePartnerOrderRef[] {
  const { session } = usePos();
  const data = useReference<StorePartnerOrdersReference | null>(P3_STORE_PARTNER_ORDERS_KEY, session.user.id);
  return data?.orders ?? [];
}

export function PartnerOrdersPanel({ onUse, disabled }: { onUse: (prefill: StoreCartPrefill) => void; disabled?: boolean }) {
  const orders = usePendingPartnerOrders();
  const { store } = useStore();
  if (!orders.length) return null;
  const customers = new Map((store?.customers ?? []).map((c) => [c.id, c]));
  return (
    <PosSection title={`Pesanan spare part mitra (${orders.length})`} testId="pesanan-mitra">
      <p className="text-base text-muted-foreground">
        Pesanan dari portal mitra. Catat sebagai penjualan harga mitra untuk pelanggan itu — pesanan terkonfirmasi otomatis saat transaksi terkirim.
      </p>
      <ul className="flex flex-col gap-3">
        {orders.map((o) => {
          const customer = customers.get(o.customerId) ?? null;
          const cart = partnerOrderCart(o, store?.products ?? []);
          return (
            <li key={o.id} className="flex flex-col gap-2 rounded-xl border-2 p-3" data-testid="pesanan-mitra-item">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-base font-semibold">{o.customerName}</span>
                <span className="text-sm text-muted-foreground">Dipesan {formatTanggalJam(o.submittedAt)}</span>
              </div>
              <ul className="text-base">
                {(o.items ?? []).map((i, idx) => (
                  <li key={`${o.id}-${idx}`} className="flex justify-between gap-2">
                    <span>
                      {i.name ?? i.code ?? "Barang"} × {i.quantity ?? 0}
                    </span>
                    {typeof i.unitPrice === "number" ? <span className="tabular">{formatRupiah(i.unitPrice * (i.quantity ?? 0))}</span> : null}
                  </li>
                ))}
              </ul>
              <p className="text-sm text-muted-foreground">
                {label("spare_part_pickup", o.pickup)} · {label("payment_method", o.paymentMethod)} · perkiraan {formatRupiah(o.estimatedAmount)}
              </p>
              {cart.issues.length ? (
                <Banner tone="warning">
                  <ul>
                    {cart.issues.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                </Banner>
              ) : null}
              {!customer ? <Banner tone="warning">Pelanggan ini belum terunduh sebagai mitra toko di perangkat. Kirim sekarang (sinkron), lalu coba lagi.</Banner> : null}
              <BigButton
                variant="secondary"
                icon={<PackageCheck aria-hidden />}
                disabled={disabled || !customer || !cart.lines.length}
                onClick={() => onUse({ key: o.id, customerId: o.customerId, cart: cart.lines, method: o.paymentMethod === "credit" ? "credit" : "cash" })}
              >
                Isi keranjang
              </BigButton>
            </li>
          );
        })}
      </ul>
    </PosSection>
  );
}
