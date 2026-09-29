"use client";

import { Minus, Plus, Printer, ScanBarcode, Search, Send, Trash2, UserRound } from "lucide-react";
import { useMemo, useState, useSyncExternalStore, type ChangeEvent } from "react";

import type { RecordSalePayload } from "@/client/m6-pos/contract";
import {
  deviceCreditCheck,
  discountNeedsApproval,
  receiptText,
  searchStoreProducts,
  sellable,
  storePriceKind,
  storeSaleStatusText,
  waLink,
  type StoreCartPrefill,
  type StoreCustomerRef,
  type StoreProductRef,
} from "@/client/m7-store/contract";
import { BigButton } from "@/components/field/big-button";
import { usePos } from "@/components/m6-pos/pos-context";
import { Banner, ChoiceButtons, ErrorText, NumberField, PosSection, ReasonField } from "@/components/m6-pos/ui";
import { newId } from "@/lib/ids";
import { formatRupiah } from "@/lib/money";
import { formatTanggalJam } from "@/lib/time";
import { cn } from "@/lib/utils";

import { useStore } from "./store-context";

export type StoreCartLine = { productId: string; quantity: number };

export type SavedStoreSale = {
  id: string;
  localNumber: string;
  soldAt: string;
  customer: StoreCustomerRef | null;
  lines: { productId: string; name: string; quantity: number; unitPrice: number; lineTotal: number }[];
  subtotal: number;
  discountAmount: number;
  total: number;
  method: "cash" | "qris" | "credit";
  cashReceived: number | null;
  qrisReference: string | null;
  pending: boolean;
};

type BarcodeDetectorLike = { detect: (image: ImageBitmap) => Promise<{ rawValue: string }[]> };

function subscribeNever(): () => void {
  return () => {};
}

/** Pemindaian barcode kamera [USULAN] — hanya bila peramban mendukung BarcodeDetector. */
function useBarcodeSupported(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => typeof window !== "undefined" && "BarcodeDetector" in window,
    () => false,
  );
}

async function detectBarcode(file: File): Promise<string | null> {
  const Ctor = (window as unknown as { BarcodeDetector?: new () => BarcodeDetectorLike }).BarcodeDetector;
  if (!Ctor) return null;
  const bitmap = await createImageBitmap(file);
  const codes = await new Ctor().detect(bitmap);
  return codes[0]?.rawValue ?? null;
}

/** Struk toko di layar: cetak (dialog cetak/PDF peramban) atau kirim WA; tempo menyebut nomor faktur setelah terbit. */
export function StoreReceiptView({ sale, onDone }: { sale: SavedStoreSale; onDone: () => void }) {
  const { ref } = usePos();
  const { store } = useStore();
  // Entri optimistis (belum terkirim) belum punya nomor resmi; nomor resmi terbit saat tersinkron di server.
  const synced = store?.recentSales.find((s) => s.id === sale.id);
  const sent = !!synced?.number;
  const number = synced?.number ?? sale.localNumber;
  const invoiceNumber = synced?.invoiceNumber ?? null;
  const status = synced?.status ?? (sale.pending ? "pending_approval" : "valid");
  const text = receiptText({
    companyName: ref?.companyName ?? "EQUA",
    outletName: ref?.outlet?.name ?? "Toko",
    number,
    soldAt: formatTanggalJam(sale.soldAt),
    customerName: sale.customer?.name ?? null,
    lines: sale.lines,
    subtotal: sale.subtotal,
    discountAmount: sale.discountAmount,
    total: sale.total,
    method: sale.method,
    invoiceNumber,
    invoiceDueDate: synced?.invoiceDueDate ?? null,
  });
  const wa = waLink(sale.customer?.waPhone ?? null, text);
  return (
    <section aria-label="Struk" className="flex flex-col gap-4 rounded-2xl border-2 bg-card p-4" data-testid="struk-toko">
      {status === "pending_approval" ? (
        <Banner tone="warning">Menunggu persetujuan pemilik — transaksi belum selesai. Barang jangan diserahkan sebelum disetujui.</Banner>
      ) : status === "rejected" ? (
        <Banner tone="danger">Transaksi ditolak. Ulangi tanpa diskon/tempo atau batalkan.</Banner>
      ) : null}
      <div className="print-area flex flex-col gap-1 font-mono text-base">
        <p className="text-center text-lg font-bold">{ref?.companyName ?? "EQUA"}</p>
        <p className="text-center">{ref?.outlet?.name}</p>
        <p className="text-center text-sm">{formatTanggalJam(sale.soldAt)}</p>
        <p className="text-center text-sm" data-testid="nomor-transaksi-toko">
          No. {number}
        </p>
        {sale.customer ? <p className="text-center text-sm">Pelanggan: {sale.customer.name}</p> : null}
        <hr className="my-2 border-dashed" />
        {sale.lines.map((l) => (
          <p key={l.productId} className="flex justify-between gap-2">
            <span>
              {l.name} × {l.quantity}
            </span>
            <span className="tabular">{formatRupiah(l.lineTotal)}</span>
          </p>
        ))}
        <hr className="my-2 border-dashed" />
        {sale.discountAmount > 0 ? (
          <>
            <p className="flex justify-between">
              <span>Subtotal</span>
              <span className="tabular">{formatRupiah(sale.subtotal)}</span>
            </p>
            <p className="flex justify-between">
              <span>Diskon</span>
              <span className="tabular">-{formatRupiah(sale.discountAmount)}</span>
            </p>
          </>
        ) : null}
        <p className="flex justify-between text-lg font-bold">
          <span>Total</span>
          <span className="tabular">{formatRupiah(sale.total)}</span>
        </p>
        {sale.method === "cash" ? (
          <p className="flex justify-between">
            <span>Tunai / kembalian</span>
            <span className="tabular">
              {formatRupiah(sale.cashReceived ?? sale.total)} / {formatRupiah((sale.cashReceived ?? sale.total) - sale.total)}
            </span>
          </p>
        ) : sale.method === "qris" ? (
          <p className="flex justify-between">
            <span>QRIS</span>
            <span>{sale.qrisReference ?? "—"}</span>
          </p>
        ) : (
          <p className="flex justify-between" data-testid="faktur-tempo">
            <span>Tempo · faktur</span>
            <span>{invoiceNumber ?? "terbit setelah terkirim"}</span>
          </p>
        )}
        <p className="mt-2 text-center text-sm">Terima kasih</p>
      </div>
      <p className="text-base text-muted-foreground">Status: {storeSaleStatusText(status)}{sent ? " · terkirim" : " · tersimpan di perangkat"}</p>
      <div className="grid gap-3 sm:grid-cols-3 print:hidden">
        <BigButton variant="secondary" icon={<Printer aria-hidden />} onClick={() => window.print()}>
          Cetak / PDF
        </BigButton>
        {wa ? (
          <BigButton variant="secondary" icon={<Send aria-hidden />} asChild>
            <a href={wa} target="_blank" rel="noreferrer">
              Kirim WA
            </a>
          </BigButton>
        ) : null}
        <BigButton onClick={onDone}>Transaksi baru</BigButton>
      </div>
    </section>
  );
}

/** Layar jual toko: pilih pelanggan, cari barang, keranjang, diskon beralasan, tunai/QRIS/tempo mitra. */
export function StoreSaleView({ blocked, onSaved, prefill }: { blocked: string | null; onSaved: (sale: SavedStoreSale) => void; prefill?: StoreCartPrefill | null }) {
  const { shift, send, nextLocalNumber, session, ref } = usePos();
  const { store } = useStore();
  // B-73: isian awal dari pesanan spare part portal mitra (pemanggil memasang ulang layar dengan `key` = id pesanan).
  const [customerId, setCustomerId] = useState<string | null>(prefill?.customerId ?? null);
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<StoreCartLine[]>(prefill?.cart ?? []);
  const [discount, setDiscount] = useState<number | null>(null);
  const [discountReason, setDiscountReason] = useState("");
  const [method, setMethod] = useState<"cash" | "qris" | "credit">(prefill?.method ?? "cash");
  const [received, setReceived] = useState<number | null>(null);
  const [qrisRef, setQrisRef] = useState("");
  const [requestApproval, setRequestApproval] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const barcodeSupported = useBarcodeSupported();

  const customer = store?.customers.find((c) => c.id === customerId) ?? null;
  const kind = storePriceKind(customer);
  const products = useMemo(() => store?.products ?? [], [store]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const results = searchStoreProducts(products, query, 20);
  const lines = cart.flatMap((c) => {
    const p = byId.get(c.productId);
    const price = p?.prices[kind];
    return p && typeof price === "number" ? [{ productId: p.id, name: p.name, unit: p.unit, quantity: c.quantity, unitPrice: price, lineTotal: price * c.quantity, balance: p.balance }] : [];
  });
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const discountAmount = discount ?? 0;
  const total = Math.max(0, subtotal - discountAmount);
  const needsDiscountApproval = discountAmount > 0 && discountNeedsApproval(discountAmount, subtotal, store?.rules.discountMaxPercent ?? 5);
  const queuedCredit = (store?.recentSales ?? []).filter((s) => s.customerId === customerId && s.paymentMethod === "credit" && s.status === "valid" && !s.invoiceNumber && !s.number).reduce((s, x) => s + x.total, 0);
  const credit = method === "credit" ? deviceCreditCheck(customer, total, queuedCredit) : null;
  const online = session.sync.online;
  const disabled = !!blocked || !shift;

  function add(p: StoreProductRef) {
    const check = sellable(p, kind);
    if (!check.ok) return setError(`${p.name}: ${check.reason}.`);
    const inCart = cart.find((c) => c.productId === p.id)?.quantity ?? 0;
    if (inCart + 1 > p.balance) return setError(`Stok ${p.name} tinggal ${p.balance} ${p.unit}.`);
    setError(null);
    setCart(inCart ? cart.map((c) => (c.productId === p.id ? { ...c, quantity: c.quantity + 1 } : c)) : [...cart, { productId: p.id, quantity: 1 }]);
  }

  function change(productId: string, delta: number) {
    setCart(cart.flatMap((c) => (c.productId !== productId ? [c] : c.quantity + delta <= 0 ? [] : [{ ...c, quantity: Math.min(c.quantity + delta, byId.get(productId)?.balance ?? c.quantity) }])));
  }

  async function onScan(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const code = await detectBarcode(file);
      if (!code) return setError("Barcode tidak terbaca. Ketik nama atau kode barang.");
      setQuery(code);
      const hit = searchStoreProducts(products, code, 1)[0];
      if (hit) add(hit);
    } catch {
      setError("Barcode tidak terbaca. Ketik nama atau kode barang.");
    }
  }

  function reset() {
    setCart([]);
    setDiscount(null);
    setDiscountReason("");
    setMethod("cash");
    setReceived(null);
    setQrisRef("");
    setRequestApproval(false);
    setQuery("");
  }

  async function save() {
    if (!shift) return;
    setError(null);
    if (!lines.length) return setError("Keranjang masih kosong.");
    if (discountAmount > subtotal) return setError("Diskon melebihi total belanja.");
    if (discountAmount > 0 && discountReason.trim().length < 3) return setError("Isi alasan diskon.");
    if (method === "cash" && received !== null && received < total) return setError("Uang diterima kurang dari total.");
    let approval = needsDiscountApproval;
    if (method === "credit") {
      if (!customer) return setError("Pilih pelanggan mitra toko untuk tempo.");
      if (credit && !credit.ok) {
        // US-M7-04 KP-4 / PTB-42: saat offline tempo hanya bila data kredit sinkron terakhir di perangkat mengizinkan;
        // persetujuan pemilik hanya dapat diajukan saat daring.
        if (!online) return setError(`${credit.message} Saat offline tempo hanya bila data kredit terakhir mengizinkan — pilih tunai/QRIS.`);
        if (!credit.canRequestApproval) return setError(credit.message);
        if (!requestApproval) return setError(`${credit.message} Centang "Ajukan persetujuan pemilik" atau pilih tunai/QRIS.`);
        approval = true;
      }
    }
    setBusy(true);
    try {
      const { localNumber, deviceSeq } = await nextLocalNumber();
      const saleId = newId();
      const payload: RecordSalePayload = {
        saleId,
        shiftId: shift.id,
        localNumber,
        deviceSeq,
        lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice })),
        paymentMethod: method,
        cashReceived: method === "cash" ? (received ?? total) : null,
        qrisReference: method === "qris" ? qrisRef.trim() || null : null,
        customerId: customer?.id ?? null,
        ...(discountAmount > 0 ? { discountAmount, discountReason: discountReason.trim() } : {}),
        ...(approval ? { requestApproval: true } : {}),
        ...(method === "credit" && !online ? { creditOffline: true } : {}),
      };
      await send("m6.pos_sale.create", payload, `Transaksi toko ${localNumber} · ${formatRupiah(total)}${approval ? " (menunggu persetujuan)" : ""}`);
      onSaved({
        id: saleId,
        localNumber,
        soldAt: new Date().toISOString(),
        customer,
        lines: lines.map((l) => ({ productId: l.productId, name: l.name, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
        subtotal,
        discountAmount,
        total,
        method,
        cashReceived: method === "cash" ? (received ?? total) : null,
        qrisReference: method === "qris" ? qrisRef.trim() || null : null,
        pending: approval,
      });
      reset();
      if (online) void session.sync.syncNow();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaksi gagal disimpan.");
    } finally {
      setBusy(false);
    }
  }

  if (store === undefined) return <Banner tone="info">Mengunduh data toko… Pastikan ada sinyal saat pertama kali masuk.</Banner>;

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(20rem,28rem)] md:items-start">
      <div className="flex min-w-0 flex-col gap-4">
        {blocked ? <Banner tone="warning">{blocked}</Banner> : null}
        <PosSection title="Pelanggan" testId="pilih-pelanggan">
          <label className="flex flex-col gap-1.5 text-base font-medium">
            <span className="flex items-center gap-2">
              <UserRound className="size-5" aria-hidden /> Pelanggan (wajib untuk harga mitra & tempo)
            </span>
            <select
              aria-label="Pelanggan"
              value={customerId ?? ""}
              onChange={(e) => {
                setCustomerId(e.target.value || null);
                if (!e.target.value && method === "credit") setMethod("cash");
              }}
              className="min-h-14 rounded-xl border-2 border-input bg-background px-3 text-lg"
            >
              <option value="">Umum (harga umum, tunai/QRIS)</option>
              {(store?.customers ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — mitra toko
                </option>
              ))}
            </select>
          </label>
          <p className="text-base text-muted-foreground" data-testid="jenis-harga">
            Harga dipakai: <strong>{kind === "partner" ? "Harga mitra" : "Harga umum"}</strong> (otomatis, BR-18)
          </p>
        </PosSection>
        <PosSection title="Cari barang">
          <div className="flex gap-2">
            <label className="flex min-h-14 flex-1 items-center gap-2 rounded-xl border-2 border-input bg-background px-3">
              <Search className="size-5 text-muted-foreground" aria-hidden />
              <input
                aria-label="Cari barang (nama, kode, barcode)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Nama, kode, atau barcode"
                className="min-w-0 flex-1 bg-transparent text-lg outline-none"
              />
            </label>
            {barcodeSupported ? (
              <label className="inline-flex min-h-14 cursor-pointer items-center gap-2 rounded-xl border-2 px-3 text-base font-semibold">
                <ScanBarcode className="size-5" aria-hidden /> Pindai
                <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => void onScan(e)} />
              </label>
            ) : null}
          </div>
          <ul className="flex flex-col divide-y" data-testid="hasil-cari">
            {results.map((p) => {
              const check = sellable(p, kind);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => add(p)}
                    className={cn("flex w-full items-center justify-between gap-3 py-3 text-left", !check.ok && "opacity-60")}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-base font-semibold">{p.name}</span>
                      <span className="block text-sm text-muted-foreground">
                        {p.code} · stok {p.balance} {p.unit}
                        {check.ok ? "" : ` · ${check.reason}`}
                      </span>
                    </span>
                    <span className="tabular shrink-0 text-lg font-bold">{typeof p.prices[kind] === "number" ? formatRupiah(p.prices[kind]!) : "—"}</span>
                  </button>
                </li>
              );
            })}
            {results.length === 0 ? <li className="py-4 text-base text-muted-foreground">Barang tidak ditemukan.</li> : null}
          </ul>
        </PosSection>
      </div>
      <div className="flex min-w-0 flex-col gap-4 md:sticky md:top-28">
        <PosSection title="Keranjang" testId="keranjang-toko">
          {lines.length === 0 ? <p className="py-3 text-base text-muted-foreground">Cari & ketuk barang untuk menambah.</p> : null}
          <ul className="flex flex-col divide-y">
            {lines.map((l) => (
              <li key={l.productId} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-semibold">{l.name}</p>
                  <p className="tabular text-sm text-muted-foreground">
                    {formatRupiah(l.unitPrice)} × {l.quantity} = {formatRupiah(l.lineTotal)}
                  </p>
                </div>
                <button type="button" aria-label={`Kurangi ${l.name}`} onClick={() => change(l.productId, -1)} className="flex size-11 items-center justify-center rounded-xl border-2">
                  {l.quantity === 1 ? <Trash2 className="size-5" aria-hidden /> : <Minus className="size-5" aria-hidden />}
                </button>
                <button type="button" aria-label={`Tambah ${l.name}`} disabled={l.quantity >= l.balance} onClick={() => change(l.productId, 1)} className="flex size-11 items-center justify-center rounded-xl border-2 disabled:opacity-40">
                  <Plus className="size-5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
          <p className="flex justify-between text-lg">
            <span>Subtotal</span>
            <span className="tabular font-semibold">{formatRupiah(subtotal)}</span>
          </p>
          <NumberField id="diskon" label="Diskon per transaksi (Rp)" prefix="Rp" value={discount} onChange={setDiscount} hint={`Maks. ${store?.rules.discountMaxPercent ?? 5}% tanpa persetujuan pemilik (PAR-14)`} />
          {discountAmount > 0 ? <ReasonField id="alasan-diskon" label="Alasan diskon" value={discountReason} onChange={setDiscountReason} /> : null}
          {needsDiscountApproval ? <Banner tone="warning">Diskon di atas batas — transaksi menunggu persetujuan pemilik dan tidak dapat diselesaikan sampai disetujui.</Banner> : null}
          <p className="flex justify-between text-2xl font-bold" data-testid="total-toko">
            <span>Total</span>
            <span className="tabular">{formatRupiah(total)}</span>
          </p>
        </PosSection>
        <PosSection title="Cara bayar">
          <ChoiceButtons
            label="Cara bayar"
            value={method}
            onChange={setMethod}
            options={[
              { value: "cash", label: "Tunai" },
              ...(ref?.settings.qrisEnabled === false ? [] : [{ value: "qris" as const, label: "QRIS" }]),
              ...(customer ? [{ value: "credit" as const, label: "Tempo mitra" }] : []),
            ]}
          />
          {method === "cash" ? <NumberField id="uang-diterima" label="Uang diterima" prefix="Rp" value={received} onChange={setReceived} hint={`Kosongkan bila pas. Kembalian ${formatRupiah(Math.max(0, (received ?? total) - total))}`} /> : null}
          {method === "qris" ? <ReasonField id="ref-qris" label="Referensi QRIS (4 digit terakhir)" value={qrisRef} onChange={setQrisRef} /> : null}
          {method === "credit" && credit ? (
            credit.ok ? (
              <Banner tone="info">Sisa batas kredit ± {formatRupiah(credit.remaining)} (data sinkron terakhir).{online ? "" : " Offline: tempo ditandai untuk ditinjau Admin Keuangan (PTB-42)."}</Banner>
            ) : (
              <Banner tone="danger">
                {credit.message}
                {credit.canRequestApproval ? (
                  <label className="mt-2 flex items-center gap-2 font-semibold">
                    <input type="checkbox" className="size-5" checked={requestApproval} onChange={(e) => setRequestApproval(e.target.checked)} /> Ajukan persetujuan pemilik
                  </label>
                ) : null}
              </Banner>
            )
          ) : null}
          <ErrorText>{error}</ErrorText>
          <BigButton size="xl" disabled={disabled || busy || lines.length === 0} onClick={() => void save()} data-testid="simpan-transaksi-toko">
            {method === "cash" ? "Bayar tunai" : method === "qris" ? "Bayar QRIS" : "Simpan tempo"} · {formatRupiah(total)}
          </BigButton>
        </PosSection>
      </div>
    </div>
  );
}
