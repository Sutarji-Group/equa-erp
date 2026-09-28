"use client";

import { Ban, Landmark, LockKeyhole, Play } from "lucide-react";
import { useState } from "react";

import { expectedClosingStock, saleStatusText, stockReasonRequired, voidNeedsApproval, type PosSaleRef, type VoidSalePayload } from "@/client/m6-pos/contract";
import { newId } from "@/lib/ids";
import { formatRupiah } from "@/lib/money";
import { formatJam, formatTanggal } from "@/lib/time";
import { cn } from "@/lib/utils";
import { BigButton } from "@/components/field/big-button";
import { PhotoCapture, type CapturedPhoto } from "@/components/field/photo-capture";

import { usePos } from "./pos-context";
import { Banner, ChoiceButtons, ErrorText, NumberField, PosSection, ReasonField } from "./ui";

const VOID_REASONS: readonly { value: VoidSalePayload["reason"]; label: string }[] = [
  { value: "wrong_product", label: "Salah produk" },
  { value: "wrong_quantity", label: "Salah jumlah" },
  { value: "customer_cancelled", label: "Pelanggan batal" },
  { value: "wrong_payment_method", label: "Salah cara bayar" },
  { value: "other", label: "Lainnya" },
];

// =====================================================================================================================
// Buka shift (US-M6-02 KP-1)
// =====================================================================================================================

export function OpenShiftView() {
  const { ref, send } = usePos();
  const fixed = ref?.settings.fixedOpeningCash ?? 0;
  const [counted, setCounted] = useState<number | null>(fixed);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const differs = counted !== null && counted !== fixed;

  async function open() {
    setError(null);
    if (counted === null) return setError("Isi hasil hitung kas awal.");
    if (differs && note.trim().length < 3) return setError("Hitungan kas awal berbeda dari kas awal tetap — isi keterangannya.");
    setBusy(true);
    try {
      await send("m6.shift.open", { shiftId: newId(), openingCashCounted: counted, openingNote: differs ? note.trim() : null }, `Buka shift · kas awal ${formatRupiah(counted)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal membuka shift.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <PosSection title="Buka shift" testId="buka-shift">
        <p className="text-base">
          Kas awal tetap outlet: <strong className="tabular text-xl">{formatRupiah(fixed)}</strong>. Hitung uang di laci, lalu konfirmasi.
        </p>
        <NumberField id="kas-awal" label="Hasil hitung kas awal" prefix="Rp" value={counted} onChange={setCounted} />
        {differs ? <ReasonField id="kas-awal-alasan" label="Keterangan beda kas awal" value={note} onChange={setNote} /> : null}
        <div>
          <p className="text-base font-semibold">Stok awal bahan (dari sistem)</p>
          <ul className="mt-1 grid gap-1 text-base">
            {(ref?.materials ?? []).map((m) => (
              <li key={m.id} className="flex justify-between">
                <span>{m.name}</span>
                <span className="tabular font-semibold">
                  {m.balance} {m.unit}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <ErrorText>{error}</ErrorText>
        <BigButton size="xl" icon={<Play aria-hidden />} loading={busy} onClick={() => void open()}>
          Buka shift
        </BigButton>
      </PosSection>
      {ref?.lastClosedShift ? (
        <p className="text-base text-muted-foreground">
          Shift terakhir ditutup {ref.lastClosedShift.closedAt ? `${formatTanggal(ref.lastClosedShift.closedAt)} ${formatJam(ref.lastClosedShift.closedAt)}` : ref.lastClosedShift.businessDate}.
        </p>
      ) : null}
    </div>
  );
}

// =====================================================================================================================
// Transaksi shift + void (US-M6-03)
// =====================================================================================================================

function VoidForm({ sale, onDone, onReplace }: { sale: PosSaleRef; onDone: () => void; onReplace: (sale: PosSaleRef) => void }) {
  const { ref, send } = usePos();
  const [reason, setReason] = useState<VoidSalePayload["reason"] | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const approval = ref ? voidNeedsApproval(sale.total, ref.settings) : false;

  async function submit() {
    setError(null);
    if (!reason) return setError("Pilih alasan void.");
    if (reason === "other" && note.trim().length < 3) return setError("Tulis keterangan untuk alasan Lainnya.");
    try {
      await send("m6.pos_sale.void", { saleId: sale.id, reason, note: note.trim() || null }, `Void ${sale.number ?? sale.localNumber}`);
      setDone(approval ? "Void menunggu persetujuan pemilik. Transaksi tetap dihitung sampai disetujui." : "Transaksi di-void.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Void gagal dicatat.");
    }
  }

  if (done) {
    return (
      <div className="flex flex-col gap-3">
        <Banner tone="success">{done}</Banner>
        <div className="grid gap-2 sm:grid-cols-2">
          <BigButton variant="secondary" onClick={() => onReplace(sale)}>
            Buat transaksi pengganti
          </BigButton>
          <BigButton variant="outline" onClick={onDone}>
            Selesai
          </BigButton>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="form-void">
      {approval ? <Banner tone="warning">Nilai di atas {formatRupiah(ref!.settings.voidApprovalAbove)}: void perlu persetujuan pemilik.</Banner> : null}
      <ChoiceButtons label="Alasan void" value={reason} onChange={setReason} options={VOID_REASONS} />
      {reason === "other" ? <ReasonField id={`void-${sale.id}`} label="Keterangan" value={note} onChange={setNote} /> : null}
      <ErrorText>{error}</ErrorText>
      <div className="grid gap-2 sm:grid-cols-2">
        <BigButton variant="danger" icon={<Ban aria-hidden />} onClick={() => void submit()}>
          Void transaksi ini
        </BigButton>
        <BigButton variant="outline" onClick={onDone}>
          Batal
        </BigButton>
      </div>
    </div>
  );
}

export function ShiftSales({ onReplace }: { onReplace: (sale: PosSaleRef) => void }) {
  const { shift, productName } = usePos();
  const [voiding, setVoiding] = useState<string | null>(null);
  const sales = [...(shift?.sales ?? [])].reverse();
  if (!sales.length) return <p className="text-base text-muted-foreground">Belum ada transaksi di shift ini.</p>;
  return (
    <ul className="flex flex-col gap-2" aria-label="Transaksi shift">
      {sales.map((s) => (
        <li key={s.id} className={cn("rounded-xl border-2 p-3", s.status === "voided" && "opacity-70")} data-status={s.status}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-base font-semibold">
              {s.number ?? s.localNumber} · {formatJam(s.soldAt)}
            </p>
            <p className="tabular text-lg font-bold">{formatRupiah(s.total)}</p>
          </div>
          <p className="text-sm text-muted-foreground">
            {s.lines.map((l) => `${productName(l.productId)} × ${l.quantity}`).join(", ")} · {s.paymentMethod === "qris" ? "QRIS" : "Tunai"}
          </p>
          <p className={cn("text-base", s.status === "voided" ? "text-destructive" : s.status === "void_pending" ? "text-warning-foreground" : "text-success")}>
            {saleStatusText(s)}
            {s.priceMismatch ? " · harga beda dari master" : ""}
            {s.replacesSaleId ? " · pengganti" : ""}
          </p>
          {s.status === "valid" && !s.isReversal ? (
            voiding === s.id ? (
              <div className="mt-2">
                <VoidForm sale={s} onDone={() => setVoiding(null)} onReplace={onReplace} />
              </div>
            ) : (
              <button type="button" onClick={() => setVoiding(s.id)} className="mt-2 min-h-12 rounded-xl border-2 px-4 text-base font-semibold text-destructive hover:bg-destructive/10">
                Void…
              </button>
            )
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// =====================================================================================================================
// Setor sebagian (US-M6-02 KP-2)
// =====================================================================================================================

export function PartialDepositForm() {
  const { shift, figures, send } = usePos();
  const [amount, setAmount] = useState<number | null>(null);
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!shift || !figures) return null;
  async function submit() {
    setError(null);
    if (!amount || amount <= 0) return setError("Isi jumlah yang disetor.");
    if (amount > figures!.expectedDrawer) return setError("Jumlah melebihi kas di laci.");
    if (!photo) return setError("Ambil foto slip setor bank.");
    try {
      await send("m6.shift_deposit.partial", { depositId: newId(), shiftId: shift!.id, amount }, `Setor sebagian ${formatRupiah(amount)}`, [
        { kind: "bank_slip", blob: photo.blob, capturedAt: photo.capturedAt },
      ]);
      setDone(true);
      setAmount(null);
      setPhoto(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setor sebagian gagal dicatat.");
    }
  }
  return (
    <PosSection title="Setor sebagian (setor bank)" testId="setor-sebagian">
      {done ? <Banner tone="success">Setor sebagian tercatat. Simpan slip aslinya.</Banner> : null}
      <NumberField id="setor-sebagian" label="Jumlah disetor ke bank" prefix="Rp" value={amount} onChange={setAmount} hint={`Kas di laci menurut sistem: ${formatRupiah(figures.expectedDrawer)}`} />
      <PhotoCapture label="Foto slip setor bank" onCapture={setPhoto} onClear={() => setPhoto(null)} />
      <ErrorText>{error}</ErrorText>
      <BigButton variant="secondary" icon={<Landmark aria-hidden />} onClick={() => void submit()}>
        Catat setor sebagian
      </BigButton>
    </PosSection>
  );
}

// =====================================================================================================================
// Tutup shift (US-M6-02 KP-3)
// =====================================================================================================================

export function CloseShiftForm({ onClosed }: { onClosed: () => void }) {
  const { shift, figures, ref, send, productName } = usePos();
  const [counted, setCounted] = useState<number | null>(null);
  const [cashReason, setCashReason] = useState("");
  const [physical, setPhysical] = useState<Record<string, number | null>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!shift || !figures || !ref) return null;
  const expectedStock = expectedClosingStock(ref.materials, figures.usage);
  const cashDiff = counted === null ? null : counted - figures.expectedDrawer;
  const tolerance = ref.settings.stockTolerance;

  async function close() {
    setError(null);
    if (counted === null) return setError("Isi jumlah kas fisik di laci.");
    if (cashDiff !== 0 && cashReason.trim().length < 3) return setError("Kas fisik berbeda — isi alasan selisih kas.");
    for (const m of ref!.materials) {
      const q = physical[m.id];
      if (q === null || q === undefined) return setError(`Isi stok fisik ${m.name}.`);
      if (stockReasonRequired(q - expectedStock[m.id]!, tolerance) && (reasons[m.id]?.trim().length ?? 0) < 3) return setError(`Stok ${m.name} berbeda — isi alasannya.`);
    }
    setBusy(true);
    try {
      await send(
        "m6.shift.close",
        {
          shiftId: shift!.id,
          closingCashCounted: counted,
          cashDifferenceReason: cashDiff !== 0 ? cashReason.trim() : null,
          stock: ref!.materials.map((m) => ({
            productId: m.id,
            physicalQty: physical[m.id]!,
            reason: reasons[m.id]?.trim() || null,
            deviceExpectedQty: expectedStock[m.id]!,
          })),
          saleIds: shift!.sales.filter((s) => !s.isReversal).map((s) => s.id),
          voidedSaleIds: shift!.sales.filter((s) => s.status === "voided" || s.status === "void_pending").map((s) => s.id),
          deviceExpectedDrawer: figures!.expectedDrawer,
        },
        `Tutup shift · setor ${formatRupiah(figures!.depositAmount)}`,
      );
      onClosed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tutup shift gagal dicatat.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PosSection title="Tutup shift" testId="tutup-shift">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-base">
        <dt>Kas awal tetap</dt>
        <dd className="tabular text-right">{formatRupiah(shift.openingCash)}</dd>
        <dt>Penjualan tunai</dt>
        <dd className="tabular text-right">{formatRupiah(figures.cashSales)}</dd>
        <dt>QRIS ({figures.qrisCount})</dt>
        <dd className="tabular text-right">{formatRupiah(figures.qrisSales)}</dd>
        <dt>Void ({figures.voidCount})</dt>
        <dd className="tabular text-right">{formatRupiah(figures.voidAmount)}</dd>
        {figures.voidPendingCount ? (
          <>
            <dt>Void menunggu persetujuan</dt>
            <dd className="text-right">{figures.voidPendingCount} (tetap dihitung)</dd>
          </>
        ) : null}
        <dt>Setor sebagian</dt>
        <dd className="tabular text-right">{formatRupiah(shift.partialDepositTotal)}</dd>
        <dt className="font-bold">Tunai seharusnya di laci</dt>
        <dd className="tabular text-right text-xl font-bold" data-testid="tunai-seharusnya">
          {formatRupiah(figures.expectedDrawer)}
        </dd>
        <dt className="font-bold">Jumlah disetor</dt>
        <dd className="tabular text-right font-bold">{formatRupiah(figures.depositAmount)}</dd>
      </dl>
      <div>
        <p className="text-base font-semibold">Penjualan per produk</p>
        <ul className="text-base">
          {figures.byProduct.map((p) => (
            <li key={p.productId} className="flex justify-between">
              <span>
                {productName(p.productId)} × {p.quantity}
              </span>
              <span className="tabular">{formatRupiah(p.amount)}</span>
            </li>
          ))}
        </ul>
      </div>
      <NumberField id="kas-fisik" label="Kas fisik di laci (hitung)" prefix="Rp" value={counted} onChange={setCounted} />
      {cashDiff !== null && cashDiff !== 0 ? (
        <>
          <Banner tone="warning">Selisih kas {formatRupiah(cashDiff, { signed: true })} (dihitung sistem).</Banner>
          <ReasonField id="alasan-kas" label="Alasan selisih kas" value={cashReason} onChange={setCashReason} />
        </>
      ) : null}
      <p className="text-base font-semibold">Stok fisik bahan utama</p>
      {ref.materials.map((m) => {
        const q = physical[m.id] ?? null;
        const diff = q === null ? null : q - expectedStock[m.id]!;
        return (
          <div key={m.id} className="flex flex-col gap-2 rounded-xl border p-3">
            <NumberField
              id={`stok-${m.id}`}
              label={`${m.name} (fisik)`}
              suffix={m.unit}
              value={q}
              onChange={(v) => setPhysical({ ...physical, [m.id]: v })}
              hint={`Pemakaian seharusnya ${figures.usage[m.id] ?? 0} · stok seharusnya ${expectedStock[m.id]}`}
            />
            {diff !== null && stockReasonRequired(diff, tolerance) ? (
              <ReasonField id={`alasan-${m.id}`} label={`Alasan selisih ${diff > 0 ? "+" : ""}${diff}`} value={reasons[m.id] ?? ""} onChange={(v) => setReasons({ ...reasons, [m.id]: v })} />
            ) : null}
          </div>
        );
      })}
      <ErrorText>{error}</ErrorText>
      <BigButton size="xl" variant="danger" icon={<LockKeyhole aria-hidden />} loading={busy} onClick={() => void close()}>
        Tutup shift
      </BigButton>
    </PosSection>
  );
}
