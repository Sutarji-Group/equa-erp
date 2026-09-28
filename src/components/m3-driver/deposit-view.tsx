"use client";

/**
 * Setor & riwayat (US-M3-07): ringkasan dihitung sistem — rit Selesai/Gagal, tunai per rit, pelunasan, transfer (di luar
 * kas), tempo, pengeluaran, total seharusnya disetor. "Setor" aktif bila tidak ada rit Berangkat/Tiba; menekan Setor
 * mengunci ringkasan (Diajukan). Cara setor: serah fisik (bawaan) / setor bank dengan slip bila diizinkan pemilik.
 * Riwayat 90 hari: diterima, selisih, alasan, status + keterangan sopir atas selisih.
 */
import { HandCoins, Receipt } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { M3_ATTACHMENT_KINDS, M3_COMMANDS, type DepositSubmitPayload } from "@/client/m3-driver/contract";
import { BigButton } from "@/components/field/big-button";
import { PhotoCapture, type CapturedPhoto } from "@/components/field/photo-capture";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal, toWibParts } from "@/lib/time";

import { useDriver } from "./driver-context";
import { Banner, Choices, ErrorText, FigureRow, Section, TextField } from "./ui";

function subscribeMinute(callback: () => void): () => void {
  const timer = setInterval(callback, 30_000);
  return () => clearInterval(timer);
}

/** Jam WIB perangkat "HH:mm" (diperbarui tiap 30 detik; stabil dalam satu menit). */
export function useWibTime(): string {
  return useSyncExternalStore(
    subscribeMinute,
    () => toWibParts(new Date()).time,
    () => "00:00",
  );
}

export function SetorView() {
  const { today, figures, myTrips, send, go, canAct, depositSubmitted } = useDriver();
  const [method, setMethod] = useState<"physical" | "bank_slip">("physical");
  const [slip, setSlip] = useState<CapturedPhoto | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wibTime = useWibTime();
  if (!today || !figures) return <Banner tone="info">Memuat data setoran…</Banner>;
  if (!canAct) return <Banner tone="info">{today.readOnlyReason}</Banner>;
  const late = wibTime > today.settings.cashCloseTime;
  const blocked = figures.activeTrips > 0 ? "Masih ada rit Berangkat/Tiba. Selesaikan atau tandai gagal dulu sebelum Setor." : null;
  const submit = async () => {
    setError(null);
    if (blocked) return setError(blocked);
    if (method === "bank_slip" && !slip) return setError("Ambil foto slip setoran bank.");
    setBusy(true);
    try {
      const payload: DepositSubmitPayload = {
        method,
        note: note.trim() || null,
        manifest: {
          completedTripIds: myTrips.filter((t) => t.status === "completed").map((t) => t.id),
          failedTripIds: myTrips.filter((t) => t.status === "failed").map((t) => t.id),
          collectionIds: today.collections.map((c) => c.id),
          expenseIds: today.expenses.map((e) => e.id),
        },
        deviceExpectedNet: figures.cashOnHand,
      };
      await send(M3_COMMANDS.depositSubmit, payload, `Setor ${formatRupiah(figures.cashOnHand)}`, method === "bank_slip" && slip ? [{ kind: M3_ATTACHMENT_KINDS.depositSlip, blob: slip.blob, capturedAt: slip.capturedAt }] : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menyimpan setoran.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4" data-testid="setor">
      <Section title="Ringkasan hari ini (dihitung sistem)">
        <FigureRow label="Rit Selesai" value={figures.completedTrips} />
        <FigureRow label="Rit Gagal" value={figures.failedTrips} />
        {figures.cashTrips.map((c) => (
          <FigureRow key={c.tripId} label={`Tunai ${c.tripNumber} · ${c.customerName}`} value={formatRupiah(c.amount)} />
        ))}
        <FigureRow label="Pelunasan tunai" value={formatRupiah(figures.collectionsCash)} />
        <FigureRow label="Transfer (di luar kas)" value={formatRupiah(figures.transfers + figures.collectionsTransfer)} />
        <FigureRow label="Tempo" value={formatRupiah(figures.credit)} />
        {figures.underpayments > 0 ? <FigureRow label="Kurang bayar pelanggan" value={formatRupiah(figures.underpayments)} /> : null}
        <FigureRow label="Pengeluaran dari kas" value={`− ${formatRupiah(figures.expensesFromCash)}`} />
        {figures.expensesPersonal > 0 ? <FigureRow label="Pengeluaran uang pribadi (diganti kantor)" value={formatRupiah(figures.expensesPersonal)} /> : null}
        <FigureRow label="Total seharusnya disetor" value={formatRupiah(figures.cashOnHand)} strong testId="seharusnya-disetor" />
      </Section>
      <BigButton variant="secondary" icon={<Receipt aria-hidden />} onClick={() => go({ name: "expense", tripId: null })}>
        Catat pengeluaran (BBM, tol, parkir)
      </BigButton>
      {depositSubmitted ? (
        <Banner tone="success" testId="setoran-diajukan">
          Setoran {today.deposit?.number ?? ""} diajukan{today.deposit?.local ? " (tersimpan di ponsel, terkirim saat ada sinyal)" : ""}. {today.deposit?.method === "bank_slip" ? "Admin Keuangan mencocokkan slip dengan mutasi bank." : "Serahkan uang ke Admin Keuangan hari ini."}
        </Banner>
      ) : (
        <Section title="Setor">
          {late ? <Banner tone="warning">Lewat batas tutup kas {today.settings.cashCloseTime.replace(":", ".")} — setoran tetap dapat diajukan dengan penanda terlambat.</Banner> : null}
          {today.deposit?.reopenReason ? <Banner tone="info">Setoran dibuka kembali Admin Keuangan: {today.deposit.reopenReason}</Banner> : null}
          {today.allowBankDeposit ? (
            <Choices<"physical" | "bank_slip">
              label="Cara setor"
              value={method}
              onChange={setMethod}
              options={[
                { value: "physical", label: "Serah ke Admin Keuangan" },
                { value: "bank_slip", label: "Setor ke bank (slip)" },
              ]}
            />
          ) : (
            <p className="text-base">Cara setor: serahkan uang langsung ke Admin Keuangan hari ini.</p>
          )}
          {method === "bank_slip" ? <PhotoCapture label="Foto slip setoran" compress={{ maxBytes: today.settings.maxPhotoKb * 1024 }} onCapture={setSlip} onClear={() => setSlip(null)} /> : null}
          <TextField id="setor-catatan" label="Catatan (opsional)" value={note} onChange={setNote} />
          {blocked ? <Banner tone="warning">{blocked}</Banner> : null}
          <ErrorText>{error}</ErrorText>
          <BigButton size="xl" icon={<HandCoins aria-hidden />} loading={busy} disabled={!!blocked} onClick={submit}>
            Setor {formatRupiah(figures.cashOnHand)}
          </BigButton>
          <p className="text-sm text-muted-foreground">Setelah Setor, ringkasan terkunci dan tidak ada rit baru hari ini kecuali Admin Keuangan membuka kembali.</p>
        </Section>
      )}
    </div>
  );
}

export function HistoryView() {
  const { history, send } = useDriver();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  if (!history) return <Banner tone="info">Riwayat setoran belum diunduh. Tekan &quot;Kirim sekarang&quot; saat ada sinyal.</Banner>;
  return (
    <div className="flex flex-col gap-3" data-testid="riwayat-setoran">
      <p className="text-base text-muted-foreground">Setoran & selisih Anda {history.days} hari terakhir.</p>
      {history.rows.length === 0 ? <p className="rounded-xl border-2 border-dashed p-4 text-center text-base">Belum ada setoran.</p> : null}
      {history.rows.map((r) => (
        <Section key={r.id} title={`${formatTanggal(r.businessDate, { weekday: false })} · ${r.number}`}>
          <FigureRow label="Status" value={label("deposit_status", r.status)} />
          <FigureRow label="Seharusnya disetor" value={formatRupiah(r.expectedNet)} />
          {r.receivedAmount !== null ? <FigureRow label="Diterima Admin Keuangan" value={formatRupiah(r.receivedAmount)} /> : null}
          {r.discrepancyAmount ? <FigureRow label="Selisih" value={formatRupiah(r.discrepancyAmount, { signed: true })} strong /> : null}
          {r.discrepancyReason ? <FigureRow label="Alasan" value={label("discrepancy_reason", r.discrepancyReason)} /> : null}
          {r.discrepancies.map((d) => (
            <p key={d.id} className="text-base">
              Selisih {formatRupiah(d.amount, { signed: true })}: {label("discrepancy_status", d.status)}
              {d.decisionReason ? ` — ${d.decisionReason}` : ""}
            </p>
          ))}
          {r.submittedLate ? <p className="text-sm text-warning-foreground">Diajukan terlambat.</p> : null}
          {r.depositorNote ? <p className="text-base">Keterangan Anda: {r.depositorNote}</p> : null}
          {(r.status === "received" || r.status === "closed") && r.discrepancyAmount ? (
            <div className="flex flex-col gap-2">
              <TextField id={`ket-${r.id}`} label="Tambah keterangan atas selisih" value={notes[r.id] ?? ""} onChange={(v) => setNotes((c) => ({ ...c, [r.id]: v }))} multiline />
              <BigButton
                variant="secondary"
                onClick={async () => {
                  setError(null);
                  const note = (notes[r.id] ?? "").trim();
                  if (note.length < 3) return setError("Tulis keterangan.");
                  try {
                    await send(M3_COMMANDS.depositNote, { depositId: r.id, note }, `Keterangan setoran ${r.number}`);
                    setNotes((c) => ({ ...c, [r.id]: "" }));
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Gagal menyimpan.");
                  }
                }}
              >
                Kirim keterangan
              </BigButton>
            </div>
          ) : null}
        </Section>
      ))}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
