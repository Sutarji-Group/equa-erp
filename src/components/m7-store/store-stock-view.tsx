"use client";

import { ClipboardCheck, Truck } from "lucide-react";
import { useState } from "react";

import { searchStoreProducts, type InternalTransferPayload } from "@/client/m7-store/contract";
import { BigButton } from "@/components/field/big-button";
import { usePos } from "@/components/m6-pos/pos-context";
import { Banner, ChoiceButtons, ErrorText, NumberField, PosSection } from "@/components/m6-pos/ui";
import { newId } from "@/lib/ids";
import { enumOptions, label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggalJam } from "@/lib/time";
import { cn } from "@/lib/utils";

import { useStore } from "./store-context";

type Tab = "stok" | "opname" | "pesan" | "transfer";

function StockList() {
  const { store } = useStore();
  const [q, setQ] = useState("");
  if (!store) return null;
  const rows = searchStoreProducts(store.products, q, 500);
  return (
    <PosSection title="Stok barang toko" testId="stok-toko">
      <input aria-label="Cari barang" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari nama/kode" className="min-h-12 rounded-xl border-2 border-input bg-background px-3 text-lg" />
      <ul className="flex flex-col divide-y">
        {rows.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2 py-2 text-base">
            <span>
              {p.name} <span className="text-sm text-muted-foreground">({p.code})</span>
            </span>
            <span className={cn("tabular font-semibold", p.minStock !== null && p.balance <= p.minStock && "text-destructive")}>
              {p.balance} {p.unit}
              {p.minStock !== null ? <span className="text-sm font-normal text-muted-foreground"> · min {p.minStock}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </PosSection>
  );
}

/** Opname bulanan (US-M7-05): hitung buta — saldo sistem tampil setelah jumlah fisik dimasukkan. */
function CountSheet() {
  const { send, session } = usePos();
  const { store } = useStore();
  const [physical, setPhysical] = useState<Record<string, number | null>>({});
  const [countedAt, setCountedAt] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!store) return null;
  const open = store.openStockCount;
  const counted = new Map((open?.lines ?? []).map((l) => [l.productId, l]));
  const products = store.products.filter((p) => p.status === "active");

  async function submit() {
    setError(null);
    setDone(null);
    const entries = Object.entries(physical).filter((e): e is [string, number] => e[1] !== null && e[1] !== undefined);
    if (!entries.length) return setError("Isi jumlah fisik minimal satu barang.");
    try {
      await send(
        "m7.stock_count.count",
        {
          stockCountId: open?.id ?? newId(),
          lines: entries.map(([productId, qty]) => ({ productId, physicalQty: qty, countedAt: countedAt[productId] ?? new Date().toISOString(), reason: (reasons[productId] || null) as never })),
        },
        `Opname · ${entries.length} barang dihitung`,
      );
      setPhysical({});
      setDone("Hitungan tersimpan. Admin Keuangan memeriksa lembar hitung bersama Anda lalu mengajukan penyesuaian ke pemilik.");
      if (session.sync.online) void session.sync.syncNow();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Hitungan gagal disimpan.");
    }
  }

  if (store.monthCountDone && !open) return <Banner tone="success">Opname bulan ini sudah diajukan. Riwayat & keputusan dapat dilihat Admin Keuangan.</Banner>;
  return (
    <PosSection title={`Opname bulan ${store.businessDate.slice(0, 7)}`} testId="opname-toko">
      <p className="text-base text-muted-foreground">Hitung barang di rak, ketik jumlah fisiknya. Saldo sistem baru tampil setelah jumlah fisik diisi. Penjualan tetap boleh selama opname.</p>
      {done ? <Banner tone="success">{done}</Banner> : null}
      <ul className="flex flex-col divide-y">
        {products.map((p) => {
          const entered = physical[p.id];
          const prev = counted.get(p.id);
          const shown = entered !== undefined && entered !== null ? { physical: entered, system: p.balance } : prev ? { physical: prev.physicalQty, system: prev.systemQty } : null;
          const diff = shown ? shown.physical - shown.system : null;
          return (
            <li key={p.id} className="grid gap-2 py-3 sm:grid-cols-[1fr_10rem_1fr] sm:items-end">
              <span className="text-base font-semibold">
                {p.name} <span className="text-sm font-normal text-muted-foreground">({p.unit})</span>
              </span>
              <NumberField
                id={`fisik-${p.id}`}
                label="Jumlah fisik"
                value={entered ?? null}
                onChange={(v) => {
                  setPhysical({ ...physical, [p.id]: v });
                  setCountedAt({ ...countedAt, [p.id]: new Date().toISOString() });
                }}
              />
              <div className="text-base" data-testid={`hasil-hitung-${p.code}`}>
                {shown ? (
                  <>
                    Sistem {shown.system} · selisih <strong className={cn(diff !== 0 && "text-destructive")}>{diff! > 0 ? `+${diff}` : diff}</strong>
                    {diff !== 0 ? (
                      <select
                        aria-label={`Alasan selisih ${p.name}`}
                        value={reasons[p.id] ?? prev?.reason ?? ""}
                        onChange={(e) => setReasons({ ...reasons, [p.id]: e.target.value })}
                        className="mt-1 block min-h-11 w-full rounded-lg border-2 px-2"
                      >
                        <option value="">Alasan (diisi bersama Admin Keuangan)</option>
                        {enumOptions("stock_adjust_reason").map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted-foreground">Saldo tampil setelah dihitung</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <ErrorText>{error}</ErrorText>
      <BigButton icon={<ClipboardCheck aria-hidden />} onClick={() => void submit()}>
        Simpan hitungan
      </BigButton>
    </PosSection>
  );
}

/** Daftar pesan ulang (US-M7-03): tandai sudah dipesan (tanggal, pemasok). */
function ReorderList() {
  const { send } = usePos();
  const { store } = useStore();
  const [supplier, setSupplier] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  if (!store) return null;
  const suppliers = store.suppliers.filter((s) => s.status === "active");
  async function mark(itemId: string, s: string | null | undefined) {
    setError(null);
    if (!s) return setError("Pilih pemasok tempat memesan.");
    try {
      await send("m7.reorder.mark_ordered", { itemId, supplierId: s }, "Tandai sudah dipesan");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menandai.");
    }
  }
  return (
    <PosSection title="Daftar pesan ulang (stok ≤ minimum)" testId="pesan-ulang">
      {store.reorder.length === 0 ? <Banner tone="success">Tidak ada barang di bawah stok minimum.</Banner> : null}
      <ul className="flex flex-col divide-y">
        {store.reorder.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 py-3">
            <p className="text-base font-semibold">
              {r.name} — saldo {r.balance} {r.unit} (min {r.minStock ?? "—"})
            </p>
            <p className="text-sm text-muted-foreground">
              Rata-rata jual {r.avgDailySales}/hari ({store.rules.averageSalesDays} hari) · pemasok terakhir {r.lastSupplierName ?? "—"} · {label("reorder_status", r.status)}
              {r.orderedAt ? ` ${formatTanggalJam(r.orderedAt)} ke ${r.orderedSupplierName ?? ""}` : ""}
            </p>
            {r.status === "open" ? (
              <div className="flex flex-wrap gap-2">
                <select aria-label={`Pemasok ${r.name}`} value={supplier[r.id] ?? r.lastSupplierId ?? ""} onChange={(e) => setSupplier({ ...supplier, [r.id]: e.target.value })} className="min-h-12 flex-1 rounded-xl border-2 px-2">
                  <option value="">— pemasok —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void mark(r.id, supplier[r.id] ?? r.lastSupplierId)}
                  className="min-h-12 rounded-xl border-2 border-primary px-4 font-semibold text-primary"
                >
                  Sudah dipesan
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <ErrorText>{error}</ErrorText>
    </PosSection>
  );
}

/** Transfer internal ke depot sendiri (US-M7-06): nilai harga mitra, tanpa uang. */
function TransferForm() {
  const { send, session } = usePos();
  const { store, nextDocNumber } = useStore();
  const [depot, setDepot] = useState("");
  const [lines, setLines] = useState<Record<string, number | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!store) return null;
  const candidates = store.products.filter((p) => p.status === "active" && p.balance > 0 && p.category === "bahan_habis_pakai");
  async function submit() {
    setError(null);
    setDone(null);
    if (!depot) return setError("Pilih depot tujuan.");
    const chosen = Object.entries(lines).filter((e): e is [string, number] => !!e[1] && e[1] > 0);
    if (!chosen.length) return setError("Isi jumlah barang yang dikirim.");
    for (const [id, q] of chosen) {
      const p = store!.products.find((x) => x.id === id)!;
      if (q > p.balance) return setError(`Stok ${p.name} tinggal ${p.balance}.`);
    }
    try {
      const { localNumber, deviceSeq } = await nextDocNumber("internal_transfer", "TI");
      const payload: InternalTransferPayload = { transferId: newId(), localNumber, deviceSeq, toOutletId: depot, lines: chosen.map(([productId, quantity]) => ({ productId, quantity })) };
      await send("m7.internal_transfer.create", payload, `Transfer internal ${localNumber}`);
      setLines({});
      setDone("Transfer tercatat. Stok depot bertambah setelah operator depot mengonfirmasi penerimaan di POS depot.");
      if (session.sync.online) void session.sync.syncNow();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transfer gagal disimpan.");
    }
  }
  const value = Object.entries(lines).reduce((s, [id, q]) => s + (q ?? 0) * (store.products.find((p) => p.id === id)?.prices.partner ?? 0), 0);
  return (
    <PosSection title="Transfer bahan ke depot sendiri" testId="transfer-internal">
      {done ? <Banner tone="success">{done}</Banner> : null}
      <label className="flex flex-col gap-1.5 text-base font-medium">
        Depot tujuan
        <select aria-label="Depot tujuan" value={depot} onChange={(e) => setDepot(e.target.value)} className="min-h-14 rounded-xl border-2 border-input bg-background px-3 text-lg">
          <option value="">— pilih depot —</option>
          {store.depots.map((d) => (
            <option key={d.id} value={d.id}>
              {d.code} · {d.name}
            </option>
          ))}
        </select>
      </label>
      {candidates.map((p) => (
        <NumberField key={p.id} id={`kirim-${p.id}`} label={`${p.name} (stok ${p.balance} ${p.unit})`} value={lines[p.id] ?? null} onChange={(v) => setLines({ ...lines, [p.id]: v })} />
      ))}
      <p className="text-base">Nilai transfer (harga mitra): <strong>{formatRupiah(value)}</strong> — tanpa uang/piutang. Outlet mitra = penjualan biasa.</p>
      <ErrorText>{error}</ErrorText>
      <BigButton icon={<Truck aria-hidden />} onClick={() => void submit()}>
        Kirim ke depot
      </BigButton>
      <ul className="flex flex-col divide-y">
        {store.recentTransfers.map((t) => (
          <li key={t.id} className="flex justify-between gap-2 py-2 text-base">
            <span>
              {t.number ?? t.localNumber} → {t.toOutletName}
            </span>
            <span>
              {formatRupiah(t.totalValue)} · {label("internal_transfer_status", t.status)}
              {t.hasDifference ? " · ada selisih" : ""}
            </span>
          </li>
        ))}
      </ul>
    </PosSection>
  );
}

export function StoreStockView() {
  const { store } = useStore();
  const [tab, setTab] = useState<Tab>("stok");
  if (store === undefined) return <Banner tone="info">Mengunduh data toko…</Banner>;
  if (!store) return <Banner tone="danger">Perangkat ini bukan POS toko.</Banner>;
  return (
    <div className="flex flex-col gap-4">
      <ChoiceButtons
        label="Menu stok"
        value={tab}
        onChange={setTab}
        options={[
          { value: "stok", label: "Stok" },
          { value: "opname", label: "Opname" },
          { value: "pesan", label: `Pesan ulang${store.reorder.length ? ` (${store.reorder.length})` : ""}` },
          { value: "transfer", label: "Transfer ke depot" },
        ]}
      />
      {tab === "stok" ? <StockList /> : tab === "opname" ? <CountSheet /> : tab === "pesan" ? <ReorderList /> : <TransferForm />}
    </div>
  );
}
