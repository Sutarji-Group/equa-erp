"use client";

import { PackagePlus, Search, Trash2 } from "lucide-react";
import { useState } from "react";

import { searchStoreProducts, type PurchaseReceiptPayload } from "@/client/m7-store/contract";
import { BigButton } from "@/components/field/big-button";
import { PhotoCapture, type CapturedPhoto } from "@/components/field/photo-capture";
import { usePos } from "@/components/m6-pos/pos-context";
import { Banner, ChoiceButtons, ErrorText, NumberField, PosSection, ReasonField } from "@/components/m6-pos/ui";
import { newId } from "@/lib/ids";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, toBusinessDate } from "@/lib/time";

import { useStore } from "./store-context";

type Line = { productId: string; name: string; unit: string; quantity: number; unitCost: number };

/**
 * Penerimaan barang dari nota pemasok (US-M7-02 KP-1, BR-28): pemasok aktif, nomor & tanggal nota, foto nota, baris
 * jumlah + harga beli satuan, total. Barang tanpa nota → "Nota pengganti" (foto barang + keterangan) — belum masuk stok
 * sampai diterima Admin Keuangan.
 */
export function StoreReceiveView() {
  const { send, session } = usePos();
  const { store, nextDocNumber } = useStore();
  const [mode, setMode] = useState<"note" | "substitute">("note");
  const [supplierId, setSupplierId] = useState("");
  const [noteNumber, setNoteNumber] = useState("");
  const [noteDate, setNoteDate] = useState(() => toBusinessDate(new Date()));
  const [dueDate, setDueDate] = useState("");
  const [query, setQuery] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [qty, setQty] = useState<number | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [noteTotal, setNoteTotal] = useState<number | null>(null);
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (store === undefined) return <Banner tone="info">Mengunduh data toko…</Banner>;
  if (!store) return <Banner tone="danger">Perangkat ini bukan POS toko.</Banner>;
  const suppliers = store.suppliers.filter((s) => s.status === "active");
  const candidates = searchStoreProducts(
    store.products.map((p) => ({ ...p, status: p.status === "pending_approval" ? "active" : p.status })),
    query,
    8,
  );
  const pickedProduct = store.products.find((p) => p.id === picked) ?? null;
  const computed = lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);

  function addLine() {
    setError(null);
    if (!pickedProduct) return setError("Pilih barang.");
    if (!qty || qty <= 0) return setError("Isi jumlah diterima.");
    if (cost === null) return setError("Isi harga beli satuan sesuai nota.");
    setLines([...lines.filter((l) => l.productId !== pickedProduct.id), { productId: pickedProduct.id, name: pickedProduct.name, unit: pickedProduct.unit, quantity: qty, unitCost: cost }]);
    setPicked(null);
    setQty(null);
    setCost(null);
    setQuery("");
  }

  async function submit() {
    setError(null);
    setDone(null);
    if (!supplierId) return setError("Pilih pemasok (belum ada? usulkan di menu Usulan).");
    if (!lines.length) return setError("Tambahkan barang yang diterima.");
    const substitute = mode === "substitute";
    if (!substitute) {
      if (!noteNumber.trim() || !noteDate) return setError("Isi nomor dan tanggal nota pemasok.");
      if (noteTotal === null || noteTotal !== computed) return setError(`Total nota harus sama dengan jumlah baris (${formatRupiah(computed)}).`);
    } else if (notes.trim().length < 5) return setError("Isi keterangan nota pengganti.");
    if (!photo) return setError(substitute ? "Ambil foto barang yang diterima." : "Ambil foto nota pemasok.");
    setBusy(true);
    try {
      const { localNumber, deviceSeq } = await nextDocNumber("purchase_receipt", "NB");
      const payload: PurchaseReceiptPayload = {
        receiptId: newId(),
        localNumber,
        deviceSeq,
        supplierId,
        isSubstitute: substitute,
        supplierNoteNumber: substitute ? null : noteNumber.trim(),
        supplierNoteDate: substitute ? null : noteDate,
        dueDate: substitute || !dueDate ? null : dueDate,
        lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCost: l.unitCost })),
        totalAmount: computed,
        notes: notes.trim() || null,
      };
      await send("m7.purchase_receipt.create", payload, `${substitute ? "Nota pengganti" : "Nota"} ${payload.supplierNoteNumber ?? localNumber} · ${formatRupiah(computed)}`, [
        { kind: substitute ? "goods_photo" : "supplier_note", blob: photo.blob, capturedAt: photo.capturedAt },
      ]);
      setDone(substitute ? "Nota pengganti tersimpan — barang masuk stok setelah diterima Admin Keuangan." : "Penerimaan tersimpan — stok bertambah.");
      setLines([]);
      setNoteNumber("");
      setNoteTotal(null);
      setDueDate("");
      setPhoto(null);
      setNotes("");
      if (session.sync.online) void session.sync.syncNow();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Penerimaan gagal disimpan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
      <PosSection title="Terima barang dari pemasok" testId="terima-barang">
        {done ? <Banner tone="success">{done}</Banner> : null}
        <ChoiceButtons
          label="Jenis bukti"
          value={mode}
          onChange={setMode}
          options={[
            { value: "note", label: "Ada nota pemasok" },
            { value: "substitute", label: "Nota pengganti" },
          ]}
        />
        <label className="flex flex-col gap-1.5 text-base font-medium">
          Pemasok
          <select aria-label="Pemasok" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="min-h-14 rounded-xl border-2 border-input bg-background px-3 text-lg">
            <option value="">— pilih pemasok —</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {mode === "note" ? (
          <>
            <ReasonField id="no-nota" label="Nomor nota pemasok" value={noteNumber} onChange={setNoteNumber} />
            <label className="flex flex-col gap-1.5 text-base font-medium">
              Tanggal nota
              <input type="date" aria-label="Tanggal nota" value={noteDate} onChange={(e) => setNoteDate(e.target.value)} className="min-h-14 rounded-xl border-2 border-input bg-background px-3 text-lg" />
            </label>
            <label className="flex flex-col gap-1.5 text-base font-medium">
              Jatuh tempo di nota (kosongkan bila tidak ada)
              <input type="date" aria-label="Jatuh tempo" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="min-h-14 rounded-xl border-2 border-input bg-background px-3 text-lg" />
            </label>
          </>
        ) : (
          <Banner tone="warning">Barang tanpa nota tidak masuk stok & tidak dapat dijual sampai Admin Keuangan menerima nota pengganti ini (BR-28).</Banner>
        )}
        <PhotoCapture label={mode === "note" ? "Foto nota pemasok" : "Foto barang"} onCapture={setPhoto} onClear={() => setPhoto(null)} />
        <ReasonField id="keterangan-nota" label={mode === "note" ? "Catatan (opsional)" : "Keterangan (wajib)"} value={notes} onChange={setNotes} />
      </PosSection>
      <PosSection title="Barang di nota">
        <label className="flex min-h-14 items-center gap-2 rounded-xl border-2 border-input bg-background px-3">
          <Search className="size-5 text-muted-foreground" aria-hidden />
          <input aria-label="Cari barang untuk nota" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nama atau kode barang" className="min-w-0 flex-1 bg-transparent text-lg outline-none" />
        </label>
        {query ? (
          <ul className="flex flex-col divide-y">
            {candidates.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => setPicked(p.id)} className="flex w-full justify-between py-2 text-left text-base">
                  <span>
                    {p.name} <span className="text-sm text-muted-foreground">({p.code})</span>
                  </span>
                  {picked === p.id ? <strong>dipilih</strong> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {pickedProduct ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <NumberField id="qty-terima" label={`Jumlah (${pickedProduct.unit})`} value={qty} onChange={setQty} />
            <NumberField id="harga-beli" label="Harga beli satuan" prefix="Rp" value={cost} onChange={setCost} />
            <BigButton variant="secondary" icon={<PackagePlus aria-hidden />} onClick={addLine} className="sm:col-span-2">
              Tambah ke nota
            </BigButton>
          </div>
        ) : null}
        <ul className="flex flex-col divide-y" data-testid="baris-nota">
          {lines.map((l) => (
            <li key={l.productId} className="flex items-center justify-between gap-2 py-2">
              <span className="text-base">
                {l.name} × {l.quantity} @ {formatRupiah(l.unitCost)} = <strong>{formatRupiah(l.quantity * l.unitCost)}</strong>
              </span>
              <button type="button" aria-label={`Hapus ${l.name}`} onClick={() => setLines(lines.filter((x) => x.productId !== l.productId))} className="flex size-10 items-center justify-center rounded-lg border">
                <Trash2 className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
        <p className="flex justify-between text-lg">
          <span>Jumlah baris</span>
          <strong className="tabular">{formatRupiah(computed)}</strong>
        </p>
        {mode === "note" ? <NumberField id="total-nota" label="Total tertulis di nota" prefix="Rp" value={noteTotal} onChange={setNoteTotal} /> : null}
        <ErrorText>{error}</ErrorText>
        <BigButton size="xl" disabled={busy} onClick={() => void submit()} data-testid="simpan-penerimaan">
          Simpan penerimaan
        </BigButton>
      </PosSection>
      <PosSection title="Penerimaan terakhir" className="lg:col-span-2">
        <ul className="flex flex-col divide-y">
          {store.recentReceipts.map((r) => (
            <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2 text-base">
              <span>
                {r.number ?? r.localNumber} · {r.supplierName} {r.supplierNoteNumber ? `· nota ${r.supplierNoteNumber}` : ""} · {formatTanggal(r.businessDate)}
              </span>
              <span>
                {formatRupiah(r.total)} · {label("purchase_receipt_status", r.status)}
              </span>
            </li>
          ))}
          {store.recentReceipts.length === 0 ? <li className="py-3 text-muted-foreground">Belum ada penerimaan.</li> : null}
        </ul>
      </PosSection>
    </div>
  );
}
