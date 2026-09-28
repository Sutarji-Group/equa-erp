"use client";

import { Check, Droplets, PackagePlus } from "lucide-react";
import { useState } from "react";

import { expectedClosingStock, type PosTransferRef, type PosWaterSupplyRef, type StockCountPayload } from "@/client/m6-pos/contract";
import { newId } from "@/lib/ids";
import { formatTanggalJam } from "@/lib/time";
import { BigButton } from "@/components/field/big-button";
import { PhotoCapture, type CapturedPhoto } from "@/components/field/photo-capture";

import { usePos } from "./pos-context";
import { Banner, ChoiceButtons, ErrorText, NumberField, PosSection, ReasonField } from "./ui";

const fmtL = (n: number) => `${n.toLocaleString("id-ID")} L`;

// =====================================================================================================================
// Pasokan air (US-M6-05)
// =====================================================================================================================

function SupplyItem({ item }: { item: PosWaterSupplyRef }) {
  const { send } = usePos();
  const [mode, setMode] = useState<"view" | "differ">("view");
  const [volume, setVolume] = useState<number | null>(item.deliveredVolumeL);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function confirm(received: number, why: string | null) {
    setError(null);
    try {
      await send("m6.water_supply.confirm", { receiptId: item.id, receivedVolumeL: received, reason: why }, `Terima pasokan ${fmtL(received)}${item.tripNumber ? ` · rit ${item.tripNumber}` : ""}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Konfirmasi gagal dicatat.");
    }
  }
  return (
    <li className="flex flex-col gap-2 rounded-xl border-2 p-3" data-testid="pasokan-tiba">
      <p className="text-base font-semibold">
        Pasokan tiba {item.tripNumber ? `· rit ${item.tripNumber}` : ""} · {formatTanggalJam(item.arrivedAt)}
      </p>
      <p className="text-lg">
        Volume diserahkan sopir: <strong>{item.deliveredVolumeL !== null ? fmtL(item.deliveredVolumeL) : "—"}</strong>
      </p>
      {mode === "view" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <BigButton variant="success" icon={<Check aria-hidden />} onClick={() => void confirm(item.deliveredVolumeL ?? 0, null)}>
            Sesuai, terima
          </BigButton>
          <BigButton variant="outline" onClick={() => setMode("differ")}>
            Volume berbeda
          </BigButton>
        </div>
      ) : (
        <>
          <NumberField id={`vol-${item.id}`} label="Volume diterima" suffix="L" value={volume} onChange={setVolume} />
          <ReasonField id={`alasan-${item.id}`} label="Alasan beda volume" value={reason} onChange={setReason} />
          <BigButton
            onClick={() => {
              if (volume === null) return setError("Isi volume diterima.");
              if (reason.trim().length < 3) return setError("Isi alasan beda volume.");
              void confirm(volume, reason.trim());
            }}
          >
            Simpan penerimaan
          </BigButton>
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </li>
  );
}

export function SupplyView() {
  const { ref, send } = usePos();
  const [volume, setVolume] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [source, setSource] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const water = ref?.water;
  if (!water) return <Banner tone="info">Pasokan air hanya untuk depot.</Banner>;
  async function other() {
    setError(null);
    if (!volume) return setError("Isi volume pasokan.");
    if (reason.trim().length < 3) return setError("Isi alasan pasokan dari sumber lain.");
    try {
      await send("m6.water_supply.record_other", { receiptId: newId(), volumeL: volume, reason: reason.trim(), sourceNote: source.trim() || null }, `Pasokan sumber lain ${fmtL(volume)}`);
      setMsg("Pasokan sumber lain tercatat.");
      setVolume(null);
      setReason("");
      setSource("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal dicatat.");
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <PosSection title="Stok air outlet" testId="stok-air">
        <p className="tabular text-3xl font-bold">{fmtL(water.stockL)}</p>
        {water.capacityL !== null ? <p className="text-base text-muted-foreground">Kapasitas simpan {fmtL(water.capacityL)}</p> : null}
        {water.overCapacity ? <Banner tone="danger">Stok air melebihi kapasitas simpan — periksa pencatatan pasokan/penjualan.</Banner> : null}
      </PosSection>
      <PosSection title={`Pasokan tiba (${water.pending.length})`}>
        {water.pending.length ? (
          <ul className="flex flex-col gap-2">
            {water.pending.map((p) => (
              <SupplyItem key={p.id} item={p} />
            ))}
          </ul>
        ) : (
          <p className="text-base text-muted-foreground">Tidak ada pasokan yang menunggu konfirmasi.</p>
        )}
      </PosSection>
      <PosSection title="Pasokan darurat dari sumber lain">
        {msg ? <Banner tone="success">{msg}</Banner> : null}
        <NumberField id="vol-lain" label="Volume diterima" suffix="L" value={volume} onChange={setVolume} />
        <ReasonField id="alasan-lain" label="Alasan" value={reason} onChange={setReason} placeholder="mis. truk EQUA mogok" />
        <ReasonField id="sumber-lain" label="Sumber (opsional)" value={source} onChange={setSource} />
        <ErrorText>{error}</ErrorText>
        <BigButton variant="secondary" icon={<Droplets aria-hidden />} onClick={() => void other()}>
          Catat pasokan sumber lain
        </BigButton>
      </PosSection>
    </div>
  );
}

// =====================================================================================================================
// Bahan habis pakai: penerimaan, transfer internal, opname (US-M6-04)
// =====================================================================================================================

function TransferItem({ transfer }: { transfer: PosTransferRef }) {
  const { send } = usePos();
  const [qty, setQty] = useState<Record<string, number | null>>(Object.fromEntries(transfer.lines.map((l) => [l.lineId, l.quantitySent])));
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  async function receive() {
    setError(null);
    for (const l of transfer.lines) {
      const q = qty[l.lineId];
      if (q === null || q === undefined) return setError(`Isi jumlah diterima ${l.productName}.`);
      if (q !== l.quantitySent && (reasons[l.lineId]?.trim().length ?? 0) < 3) return setError(`${l.productName}: jumlah berbeda — isi alasannya.`);
    }
    try {
      await send(
        "m6.internal_transfer.receive",
        { transferId: transfer.id, receiptId: newId(), lines: transfer.lines.map((l) => ({ lineId: l.lineId, quantityReceived: qty[l.lineId]!, reason: reasons[l.lineId]?.trim() || null })) },
        `Terima transfer ${transfer.number ?? transfer.localNumber ?? ""}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal dicatat.");
    }
  }
  return (
    <li className="flex flex-col gap-2 rounded-xl border-2 p-3">
      <p className="text-base font-semibold">
        Transfer {transfer.number ?? transfer.localNumber} dari {transfer.fromOutletName} · {formatTanggalJam(transfer.sentAt)}
      </p>
      {transfer.lines.map((l) => (
        <div key={l.lineId} className="flex flex-col gap-2">
          <NumberField id={`tr-${l.lineId}`} label={`${l.productName} (dikirim ${l.quantitySent} ${l.unit})`} value={qty[l.lineId] ?? null} onChange={(v) => setQty({ ...qty, [l.lineId]: v })} />
          {qty[l.lineId] !== l.quantitySent ? (
            <ReasonField id={`tr-alasan-${l.lineId}`} label="Alasan beda jumlah" value={reasons[l.lineId] ?? ""} onChange={(v) => setReasons({ ...reasons, [l.lineId]: v })} />
          ) : null}
        </div>
      ))}
      <ErrorText>{error}</ErrorText>
      <BigButton variant="success" onClick={() => void receive()}>
        Terima transfer
      </BigButton>
    </li>
  );
}

function ReceiptForm() {
  const { ref, send } = usePos();
  const [source, setSource] = useState<"supplier" | "other" | null>("supplier");
  const [supplier, setSupplier] = useState("");
  const [noteNo, setNoteNo] = useState("");
  const [qty, setQty] = useState<Record<string, number | null>>({});
  const [cost, setCost] = useState<Record<string, number | null>>({});
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  async function submit() {
    setError(null);
    const lines = (ref?.materials ?? []).filter((m) => (qty[m.id] ?? 0) > 0).map((m) => ({ productId: m.id, quantity: qty[m.id]!, unitCost: cost[m.id] ?? null }));
    if (!lines.length) return setError("Isi jumlah bahan yang diterima.");
    if (source === "supplier") {
      if (!supplier.trim()) return setError("Tulis nama pemasok.");
      if (!noteNo.trim()) return setError("Isi nomor nota pemasok.");
      if (!photo) return setError("Ambil foto nota pemasok.");
    }
    try {
      await send(
        "m6.consumable_receipt.create",
        { receiptId: newId(), source, supplierName: supplier.trim() || null, supplierNoteNumber: noteNo.trim() || null, lines },
        `Terima bahan ${lines.map((l) => l.quantity).reduce((a, b) => a + b, 0)} pcs`,
        photo ? [{ kind: "supplier_note", blob: photo.blob, capturedAt: photo.capturedAt }] : [],
      );
      setDone(true);
      setQty({});
      setCost({});
      setPhoto(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal dicatat.");
    }
  }
  return (
    <PosSection title="Terima bahan dari pemasok lain">
      {done ? <Banner tone="success">Penerimaan bahan tercatat — stok bertambah.</Banner> : null}
      <ChoiceButtons
        label="Sumber"
        value={source}
        onChange={setSource}
        options={[
          { value: "supplier", label: "Pemasok (nota)" },
          { value: "other", label: "Lainnya" },
        ]}
      />
      {source === "supplier" ? (
        <>
          <ReasonField id="pemasok" label="Nama pemasok" value={supplier} onChange={setSupplier} />
          <ReasonField id="nota" label="Nomor nota" value={noteNo} onChange={setNoteNo} />
          <PhotoCapture label="Foto nota pemasok" onCapture={setPhoto} onClear={() => setPhoto(null)} />
        </>
      ) : null}
      {(ref?.materials ?? []).map((m) => (
        <div key={m.id} className="grid gap-2 sm:grid-cols-2">
          <NumberField id={`terima-${m.id}`} label={`${m.name} diterima`} suffix={m.unit} value={qty[m.id] ?? null} onChange={(v) => setQty({ ...qty, [m.id]: v })} />
          <NumberField id={`harga-${m.id}`} label="Harga satuan (nota)" prefix="Rp" value={cost[m.id] ?? null} onChange={(v) => setCost({ ...cost, [m.id]: v })} />
        </div>
      ))}
      <ErrorText>{error}</ErrorText>
      <BigButton variant="secondary" icon={<PackagePlus aria-hidden />} onClick={() => void submit()}>
        Catat penerimaan bahan
      </BigButton>
    </PosSection>
  );
}

const ADJUST_REASONS: readonly { value: NonNullable<StockCountPayload["lines"][number]["reason"]>; label: string }[] = [
  { value: "damaged", label: "Rusak" },
  { value: "lost", label: "Hilang" },
  { value: "miscount", label: "Salah catat" },
  { value: "other", label: "Lainnya" },
];

function StockCountForm() {
  const { ref, figures, send } = usePos();
  const [physical, setPhysical] = useState<Record<string, number | null>>({});
  const [reasons, setReasons] = useState<Record<string, StockCountPayload["lines"][number]["reason"]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!ref) return null;
  const expected = expectedClosingStock(ref.materials, figures?.usage ?? {});
  async function submit() {
    setError(null);
    const lines: StockCountPayload["lines"] = [];
    for (const m of ref!.materials) {
      const q = physical[m.id];
      if (q === null || q === undefined) return setError(`Isi hitungan ${m.name}.`);
      const diff = q - expected[m.id]!;
      if (diff !== 0 && !reasons[m.id]) return setError(`${m.name}: selisih ${diff} — pilih alasan.`);
      if (reasons[m.id] === "other" && (notes[m.id]?.trim().length ?? 0) < 3) return setError(`${m.name}: tulis keterangan alasan Lainnya.`);
      lines.push({ productId: m.id, physicalQty: q, reason: diff !== 0 ? reasons[m.id] : null, reasonNote: notes[m.id]?.trim() || null });
    }
    try {
      await send("m6.stock_count.submit", { stockCountId: newId(), lines }, "Opname mingguan");
      setDone("Opname tercatat. Selisih diajukan ke pemilik; saldo berubah setelah disetujui.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal dicatat.");
    }
  }
  return (
    <PosSection title="Opname mingguan" testId="opname">
      {ref.stockCountThisWeek ? (
        <Banner tone="info">Opname minggu ini sudah dikirim ({ref.stockCountThisWeek.status === "approved" ? "sesuai/ disetujui" : "menunggu persetujuan"}).</Banner>
      ) : (
        <Banner tone="warning">Opname minggu ini belum dilakukan.</Banner>
      )}
      {done ? <Banner tone="success">{done}</Banner> : null}
      {ref.materials.map((m) => {
        const q = physical[m.id] ?? null;
        const diff = q === null ? null : q - expected[m.id]!;
        return (
          <div key={m.id} className="flex flex-col gap-2 rounded-xl border p-3">
            <NumberField id={`opname-${m.id}`} label={`${m.name} (hitung fisik)`} suffix={m.unit} value={q} onChange={(v) => setPhysical({ ...physical, [m.id]: v })} />
            {q !== null ? <p className="text-base">Saldo sistem: {expected[m.id]} · selisih {diff! > 0 ? "+" : ""}{diff}</p> : null}
            {diff ? (
              <>
                <ChoiceButtons label={`Alasan ${m.name}`} value={reasons[m.id] ?? null} onChange={(v) => setReasons({ ...reasons, [m.id]: v })} options={ADJUST_REASONS} />
                {reasons[m.id] === "other" ? <ReasonField id={`opname-ket-${m.id}`} label="Keterangan" value={notes[m.id] ?? ""} onChange={(v) => setNotes({ ...notes, [m.id]: v })} /> : null}
              </>
            ) : null}
          </div>
        );
      })}
      <ErrorText>{error}</ErrorText>
      <BigButton onClick={() => void submit()}>Kirim opname</BigButton>
    </PosSection>
  );
}

export function StockView() {
  const { ref, figures } = usePos();
  if (!ref) return null;
  const expected = expectedClosingStock(ref.materials, figures?.usage ?? {});
  return (
    <div className="flex flex-col gap-4">
      <PosSection title="Stok bahan (seharusnya)" testId="stok-bahan">
        <ul className="grid gap-1 text-lg">
          {ref.materials.map((m) => (
            <li key={m.id} className="flex justify-between">
              <span>{m.name}</span>
              <span className="tabular font-semibold">
                {expected[m.id]} {m.unit}
              </span>
            </li>
          ))}
        </ul>
      </PosSection>
      {ref.transfers.length ? (
        <PosSection title={`Transfer internal dari toko (${ref.transfers.length})`}>
          <ul className="flex flex-col gap-2">
            {ref.transfers.map((tr) => (
              <TransferItem key={tr.id} transfer={tr} />
            ))}
          </ul>
        </PosSection>
      ) : null}
      <ReceiptForm />
      <StockCountForm />
    </div>
  );
}
