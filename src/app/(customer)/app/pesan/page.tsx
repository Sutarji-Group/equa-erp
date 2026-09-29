import type { Metadata } from "next";
import Link from "next/link";

import { P2ActionForm } from "@/components/p2-customer/action-form";
import { CustomerCard, CustomerShell } from "@/components/p2-customer/customer-shell";
import { Button } from "@/components/ui/button";
import { newId } from "@/lib/ids";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, isBusinessDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { withTx } from "@/server/core/db";
import { toUserMessage } from "@/server/core/errors";
import * as p2 from "@/server/modules/p2-customer";
import { requireCustomer } from "@/server/modules/p2-customer/web";

import { placeOrderAction } from "../actions";

export const metadata: Metadata = { title: "Pesan air" };

const STEPS = ["Alamat", "Jumlah tangki", "Tanggal & slot", "Ringkasan"] as const;

function StepBar({ current }: { current: number }) {
  return (
    <ol className="mb-4 grid grid-cols-4 gap-1 text-center text-[11px]" aria-label="Langkah pemesanan">
      {STEPS.map((s, i) => (
        <li key={s} aria-current={i === current ? "step" : undefined} className={cn("rounded-md px-1 py-1.5", i < current ? "bg-primary/15 text-primary" : i === current ? "bg-primary font-semibold text-primary-foreground" : "bg-muted text-muted-foreground")}>
          {i + 1}. {s}
        </li>
      ))}
    </ol>
  );
}

/**
 * Pesan air ≤ 4 langkah (US-P2-02 KP-1): alamat → jumlah tangki → tanggal & slot (PAR-73, kapasitas M2) → ringkasan
 * harga + cara bayar → kirim. Harga dari master (zona + BBM / harga khusus), tanpa tawar-menawar.
 */
export default async function PesanPage({ searchParams }: PageProps<"/app/pesan">) {
  const cctx = await requireCustomer({ next: "/app/pesan" });
  const sp = await searchParams;
  const unread = await p2.unreadNotificationCount(cctx);
  const addresses = await p2.listMyAddresses(cctx);
  const addr = typeof sp.alamat === "string" ? addresses.find((a) => a.id === sp.alamat && a.orderable) : undefined;
  const tanks = typeof sp.tangki === "string" && /^\d+$/.test(sp.tangki) ? Math.min(20, Math.max(1, Number(sp.tangki))) : undefined;
  const date = typeof sp.tanggal === "string" && isBusinessDate(sp.tanggal) ? sp.tanggal : undefined;
  const slot = typeof sp.slot === "string" ? sp.slot : undefined;
  const base = (extra: Record<string, string | number>) => `/app/pesan?${new URLSearchParams(Object.fromEntries(Object.entries({ ...(addr ? { alamat: addr.id } : {}), ...(tanks ? { tangki: tanks } : {}), ...extra }).map(([k, v]) => [k, String(v)]))).toString()}`;

  // Langkah 1 — alamat.
  if (!addr) {
    return (
      <CustomerShell title="Pesan air" active="order" unread={unread}>
        <StepBar current={0} />
        <CustomerCard title="Kirim ke alamat mana?">
          <ul className="grid gap-2" data-testid="order-addresses">
            {addresses.map((a) => (
              <li key={a.id}>
                {a.orderable ? (
                  <Link href={`/app/pesan?alamat=${a.id}`} className="block rounded-lg border p-3 hover:border-primary">
                    <span className="block font-medium">{a.label}</span>
                    <span className="block text-sm text-muted-foreground">{a.addressText}</span>
                    <span className="block text-sm">{a.priceText}</span>
                  </Link>
                ) : (
                  <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                    <span className="block font-medium text-foreground">{a.label}</span>
                    {a.priceText}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Link href="/app/akun#alamat" className="mt-3 inline-block text-sm text-primary underline">
            + Tambah alamat kirim
          </Link>
        </CustomerCard>
      </CustomerShell>
    );
  }

  // Langkah 2 — jumlah tangki.
  if (!tanks) {
    return (
      <CustomerShell title="Pesan air" active="order" unread={unread} backHref="/app/pesan">
        <StepBar current={1} />
        <CustomerCard title="Berapa tangki?">
          <p className="mb-3 text-sm text-muted-foreground">
            {addr.label}: {addr.priceText}
          </p>
          <form method="get" className="grid gap-3">
            <input type="hidden" name="alamat" value={addr.id} />
            <div className="grid grid-cols-4 gap-2">
              {[1, 2, 3, 4].map((n) => (
                <Button key={n} asChild variant="outline" className="h-14 text-lg">
                  <Link href={`/app/pesan?alamat=${addr.id}&tangki=${n}`}>{n}</Link>
                </Button>
              ))}
            </div>
            <label className="grid gap-1 text-sm font-medium">
              Jumlah lain (maks. 20)
              <input name="tangki" type="number" min={1} max={20} className="h-11 rounded-md border border-input bg-background px-3 text-base" />
            </label>
            <Button type="submit" variant="secondary">
              Lanjut
            </Button>
          </form>
        </CustomerCard>
      </CustomerShell>
    );
  }

  // Langkah 3 — tanggal & slot.
  if (!date || !slot) {
    const days = await withTx((tx) => p2.slotAvailability(tx, { tenantId: cctx.tenantId, now: cctx.now, tankCount: tanks }));
    return (
      <CustomerShell title="Pesan air" active="order" unread={unread} backHref={`/app/pesan?alamat=${addr.id}`}>
        <StepBar current={2} />
        <CustomerCard title={`Kapan dikirim? (${tanks} tangki)`}>
          <ul className="grid gap-3" data-testid="order-slots">
            {days.map((d) => (
              <li key={d.date}>
                <p className="text-sm font-medium">{d.dateLabel}</p>
                {d.note ? <p className="text-xs text-muted-foreground">{d.note}</p> : null}
                <div className="mt-1 grid grid-cols-3 gap-2">
                  {d.slots.map((s) =>
                    s.available ? (
                      <Button key={s.key} asChild variant="outline" size="sm" className="h-auto flex-col py-2">
                        <Link href={base({ tanggal: d.date, slot: s.key })} data-testid={`slot-${d.date}-${s.key}`}>
                          <span>{s.label.split(" ")[0]}</span>
                          <span className="text-[11px] text-muted-foreground">{s.label.split(" ").slice(1).join(" ")}</span>
                        </Link>
                      </Button>
                    ) : (
                      <span key={s.key} className="grid rounded-md border border-dashed px-1 py-2 text-center text-[11px] text-muted-foreground" title={s.reason ?? ""}>
                        {s.label.split(" ")[0]}
                        <span>{s.reason === "Penuh" ? "Penuh" : "Tidak tersedia"}</span>
                      </span>
                    ),
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">Slot penuh tidak dapat dipilih. Pesanan hari ini ditutup pukul 15.00 — pilih besok atau telepon kantor.</p>
        </CustomerCard>
      </CustomerShell>
    );
  }

  // Langkah 4 — ringkasan harga + cara bayar + kirim.
  let quote: p2.OrderQuote | null = null;
  let error: string | null = null;
  try {
    quote = await p2.quoteOrder(cctx, { addressId: addr.id, tankCount: tanks, date });
  } catch (e) {
    error = toUserMessage(e);
  }
  const days = await withTx((tx) => p2.slotAvailability(tx, { tenantId: cctx.tenantId, now: cctx.now, from: date, days: 1, tankCount: tanks }));
  const chosen = days[0]?.slots.find((s) => s.key === slot);
  return (
    <CustomerShell title="Pesan air" active="order" unread={unread} backHref={base({})}>
      <StepBar current={3} />
      <CustomerCard title="Ringkasan pesanan" testId="order-summary">
        {error || !quote ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Alamat</dt>
              <dd>{quote.address.label} — {quote.address.addressText}</dd>
              <dt className="text-muted-foreground">Jadwal</dt>
              <dd>
                {formatTanggal(date)}, {chosen?.label ?? slot}
              </dd>
              <dt className="text-muted-foreground">Harga</dt>
              <dd>{quote.priceText}</dd>
              <dt className="text-muted-foreground">Jumlah</dt>
              <dd>{tanks} tangki</dd>
            </dl>
            <p className="mt-3 text-xl font-semibold" data-testid="order-total">
              Total {formatRupiah(quote.total)}
            </p>
            <P2ActionForm action={placeOrderAction} submitLabel="Kirim pesanan" resetOnSuccess={false} fullWidth size="lg" className="mt-3" testId="order-submit">
              <input type="hidden" name="addressId" value={addr.id} />
              <input type="hidden" name="tankCount" value={tanks} />
              <input type="hidden" name="date" value={date} />
              <input type="hidden" name="slot" value={slot} />
              <input type="hidden" name="clientRequestId" value={newId()} />
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">Cara bayar</legend>
                {quote.paymentOptions.map((o, i) => (
                  <label key={o.method} className={cn("flex items-start gap-2 rounded-md border p-2 text-sm", !o.available && "opacity-60")}>
                    <input type="radio" name="paymentMethod" value={o.method} defaultChecked={i === 0} disabled={!o.available} className="mt-0.5 size-4" />
                    <span>
                      {o.label}
                      {!o.available && o.reason ? <span className="block text-xs text-muted-foreground">{o.reason}</span> : null}
                    </span>
                  </label>
                ))}
              </fieldset>
              <label className="grid gap-1 text-sm font-medium">
                Catatan untuk kantor (opsional)
                <textarea name="notes" rows={2} maxLength={300} className="rounded-md border border-input bg-background px-3 py-2 text-base" />
              </label>
            </P2ActionForm>
          </>
        )}
      </CustomerCard>
    </CustomerShell>
  );
}
