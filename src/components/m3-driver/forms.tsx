"use client";

/**
 * Formulir aksi lapangan sopir: rit gagal (US-M3-06 KP-1/KP-2), kendala (KP-3), keterangan perjalanan (KP-4, BR-25),
 * pelunasan (US-M3-05), pengeluaran (US-M3-08), struk WA (US-M3-03 KP-7 / US-M3-05 KP-5).
 */
import { MessageCircle } from "lucide-react";
import { useState } from "react";

import {
  allocateOldestFirst,
  M3_ATTACHMENT_KINDS,
  M3_COMMANDS,
  normalizePhoneForWa,
  renderTemplateText,
  sortInvoicesForCollection,
  waLink,
} from "@/client/m3-driver/contract";
import { currentPosition } from "@/client/m3-driver/geo";
import type { EnqueueAttachment } from "@/client/offline";
import { BigButton, bigButtonVariants } from "@/components/field/big-button";
import { PhotoCapture, type CapturedPhoto } from "@/components/field/photo-capture";
import { newId } from "@/lib/ids";
import { enumOptions, label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatTanggal } from "@/lib/time";

import { useDriver } from "./driver-context";
import { Banner, Choices, ErrorText, FigureRow, NumberField, Section, TextField } from "./ui";

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menyimpan. Coba lagi.");
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

function photoAttachment(kind: string, p: CapturedPhoto | null): EnqueueAttachment[] {
  return p ? [{ kind, blob: p.blob, capturedAt: p.capturedAt }] : [];
}

// =====================================================================================================================
// Rit gagal
// =====================================================================================================================

export function FailForm({ tripId }: { tripId: string }) {
  const { trip, send, go, today } = useDriver();
  const t = trip(tripId);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [disposition, setDisposition] = useState<string | null>(null);
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const s = useSubmit();
  if (!t || !today) return <Banner tone="danger">Rit tidak ditemukan.</Banner>;
  return (
    <Section title={`Rit gagal: ${t.number}`} testId="form-gagal">
      <Choices label="Alasan (wajib)" value={reason} onChange={setReason} options={enumOptions("trip_fail_reason")} />
      {reason === "other" || reason ? <TextField id="gagal-ket" label={reason === "other" ? "Keterangan (wajib)" : "Keterangan (opsional)"} value={note} onChange={setNote} /> : null}
      <Choices label="Air yang sudah dimuat" value={disposition} onChange={setDisposition} options={enumOptions("loaded_water_disposition")} columns={1} />
      <PhotoCapture label="Foto (opsional)" compress={{ maxBytes: today.settings.maxPhotoKb * 1024 }} onCapture={setPhoto} onClear={() => setPhoto(null)} />
      <ErrorText>{s.error}</ErrorText>
      <BigButton
        variant="danger"
        size="xl"
        loading={s.busy}
        onClick={() =>
          s.run(async () => {
            if (!reason) throw new Error("Pilih alasan rit gagal.");
            if (reason === "other" && note.trim().length < 3) throw new Error("Tulis keterangan alasan.");
            if (!disposition) throw new Error("Pilih tindak lanjut air yang sudah dimuat.");
            const { location } = await currentPosition();
            await send(M3_COMMANDS.fail, { tripId, reason, note: note.trim() || null, loadedWaterDisposition: disposition, location }, `Rit gagal ${t.number}`, photoAttachment(M3_ATTACHMENT_KINDS.failPhoto, photo));
            go({ name: "list" });
          })
        }
      >
        Simpan rit gagal
      </BigButton>
    </Section>
  );
}

// =====================================================================================================================
// Kendala
// =====================================================================================================================

export function IncidentForm({ tripId }: { tripId: string | null }) {
  const { trip, send, go, today } = useDriver();
  const t = tripId ? trip(tripId) : undefined;
  const [kind, setKind] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const s = useSubmit();
  const [done, setDone] = useState(false);
  if (!today) return null;
  if (done) {
    return (
      <Banner tone="success">
        Kendala tercatat dan dikirim ke Dispatcher.{kind === "truck_broken" ? " Status truk menjadi Perbaikan setelah dikonfirmasi Dispatcher." : ""}{" "}
        <button type="button" className="font-semibold underline" onClick={() => go(t ? { name: "trip", tripId: t.id } : { name: "list" })}>
          Kembali
        </button>
      </Banner>
    );
  }
  return (
    <Section title={`Lapor kendala${t ? ` (rit ${t.number})` : ""}`} testId="form-kendala">
      <p className="text-base text-muted-foreground">Rit tetap berjalan. Untuk rit yang tidak jadi dikirim, pakai &quot;Rit gagal&quot;.</p>
      <Choices
        label="Jenis kendala"
        value={kind}
        onChange={setKind}
        options={enumOptions("trip_incident_kind").filter((o) => o.value !== "trip_failed")}
      />
      <TextField id="kendala-ket" label="Catatan" value={description} onChange={setDescription} multiline />
      <PhotoCapture label="Foto kendala" compress={{ maxBytes: today.settings.maxPhotoKb * 1024 }} onCapture={setPhoto} onClear={() => setPhoto(null)} />
      <ErrorText>{s.error}</ErrorText>
      <BigButton
        loading={s.busy}
        onClick={() =>
          s.run(async () => {
            if (!kind) throw new Error("Pilih jenis kendala.");
            if (description.trim().length < 3) throw new Error("Tulis catatan kendala.");
            const { location } = await currentPosition();
            await send(M3_COMMANDS.incident, { incidentId: newId(), tripId: t?.id ?? null, kind, description: description.trim(), location }, `Kendala ${label("trip_incident_kind", kind)}`, photoAttachment(M3_ATTACHMENT_KINDS.incidentPhoto, photo));
            setDone(true);
          })
        }
      >
        Kirim ke Dispatcher
      </BigButton>
    </Section>
  );
}

// =====================================================================================================================
// Keterangan perjalanan (BR-25)
// =====================================================================================================================

export function TasksView() {
  const { today, send } = useDriver();
  const [texts, setTexts] = useState<Record<string, string>>({});
  const s = useSubmit();
  if (!today) return null;
  if (today.explanationTasks.length === 0) return <Banner tone="success">Tidak ada permintaan keterangan perjalanan.</Banner>;
  return (
    <div className="flex flex-col gap-3">
      <Banner tone="info">Isi keterangan hari ini juga. Keterangan yang belum diisi saat tutup kas dilaporkan ke pemilik.</Banner>
      {today.explanationTasks.map((task) => (
        <Section key={task.fleetEventId} title={task.kindLabel}>
          <p className="text-base">
            {task.truckCode ? `Truk ${task.truckCode} · ` : ""}
            {formatTanggal(task.startedAt, { weekday: false })} {new Date(task.startedAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" })}
            {task.distanceM ? ` · ${(task.distanceM / 1000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} km` : ""}
          </p>
          <TextField id={`ket-${task.fleetEventId}`} label="Keterangan Anda" value={texts[task.fleetEventId] ?? ""} onChange={(v) => setTexts((c) => ({ ...c, [task.fleetEventId]: v }))} multiline />
          <BigButton
            variant="secondary"
            loading={s.busy}
            onClick={() =>
              s.run(async () => {
                const text = (texts[task.fleetEventId] ?? "").trim();
                if (text.length < 5) throw new Error("Tulis keterangan (minimal 5 huruf).");
                await send(M3_COMMANDS.explanation, { fleetEventId: task.fleetEventId, explanation: text }, `Keterangan perjalanan ${task.kindLabel}`);
              })
            }
          >
            Kirim keterangan
          </BigButton>
        </Section>
      ))}
      <ErrorText>{s.error}</ErrorText>
    </div>
  );
}

// =====================================================================================================================
// Pelunasan (US-M3-05)
// =====================================================================================================================

export function CollectForm({ tripId }: { tripId: string }) {
  const { trip, today, send } = useDriver();
  const t = trip(tripId);
  const invoices = t && today ? sortInvoicesForCollection(today.invoicesByCustomer[t.customerId] ?? []) : [];
  const oldest = [...invoices].sort((a, b) => a.issueDate.localeCompare(b.issueDate))[0];
  const [selected, setSelected] = useState<string[]>(oldest ? [oldest.id] : []);
  const total = invoices.filter((i) => selected.includes(i.id)).reduce((s, i) => s + i.outstanding, 0);
  const [amount, setAmount] = useState<number | null>(oldest?.outstanding ?? null);
  const [method, setMethod] = useState<"cash" | "transfer">("cash");
  const [proof, setProof] = useState<CapturedPhoto | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const s = useSubmit();
  if (!t || !today) return <Banner tone="danger">Rit tidak ditemukan.</Banner>;
  if (savedId) return <ReceiptView paymentId={savedId} tripId={t.id} />;
  const allocation = allocateOldestFirst(
    invoices.filter((i) => selected.includes(i.id)),
    amount ?? 0,
  );
  return (
    <Section title={`Terima pelunasan: ${t.customerName}`} testId="form-pelunasan">
      <p className="text-sm text-muted-foreground">Faktur dari data sinkron terakhir. Pilih faktur (bawaan: yang tertua); pelunasan sebagian boleh.</p>
      <ul className="flex flex-col gap-2">
        {invoices.map((i) => (
          <li key={i.id}>
            <label className="flex min-h-14 items-center gap-3 rounded-xl border-2 p-3 text-base">
              <input
                type="checkbox"
                className="size-6"
                checked={selected.includes(i.id)}
                onChange={(e) => setSelected((cur) => (e.target.checked ? [...cur, i.id] : cur.filter((x) => x !== i.id)))}
              />
              <span className="flex-1">
                {i.number} · {formatTanggal(i.issueDate, { weekday: false })}
                {i.isUnderpayment ? <strong className="ml-1 text-destructive">tagih kurang bayar</strong> : null}
              </span>
              <span className="tabular-nums">{formatRupiah(i.outstanding)}</span>
            </label>
          </li>
        ))}
      </ul>
      <FigureRow label="Sisa faktur terpilih" value={formatRupiah(total)} />
      <Choices<"cash" | "transfer">
        label="Cara bayar"
        value={method}
        onChange={setMethod}
        options={[
          { value: "cash", label: "Tunai" },
          { value: "transfer", label: "Transfer" },
        ]}
      />
      <NumberField id="jumlah-pelunasan" label="Jumlah diterima" prefix="Rp" value={amount} onChange={setAmount} hint="Uang fisik / jumlah transfer sesuai bukti." />
      {method === "transfer" ? <PhotoCapture label="Foto bukti transfer" compress={{ maxBytes: today.settings.maxPhotoKb * 1024 }} onCapture={setProof} onClear={() => setProof(null)} /> : null}
      {allocation.allocations.length ? (
        <p className="text-base text-muted-foreground">
          Dialokasikan: {allocation.allocations.map((a) => `${invoices.find((i) => i.id === a.invoiceId)?.number} ${formatRupiah(a.amount)}`).join(", ")}
        </p>
      ) : null}
      <ErrorText>{s.error}</ErrorText>
      <BigButton
        variant="success"
        loading={s.busy}
        onClick={() =>
          s.run(async () => {
            if (selected.length === 0) throw new Error("Pilih minimal satu faktur.");
            if (!amount || amount <= 0) throw new Error("Isi jumlah pelunasan.");
            if (amount > total) throw new Error(`Jumlah melebihi sisa faktur terpilih (${formatRupiah(total)}). Pilih faktur lain atau kurangi jumlah.`);
            if (method === "transfer" && !proof) throw new Error("Ambil foto bukti transfer.");
            const paymentId = newId();
            await send(
              M3_COMMANDS.collection,
              { paymentId, customerId: t.customerId, tripId: t.id, method, amount, invoiceIds: selected },
              `Pelunasan ${t.customerName} ${formatRupiah(amount)}`,
              method === "transfer" ? photoAttachment(M3_ATTACHMENT_KINDS.collectionProof, proof) : [],
            );
            setSavedId(paymentId);
          })
        }
      >
        Simpan pelunasan
      </BigButton>
    </Section>
  );
}

// =====================================================================================================================
// Pengeluaran (US-M3-08)
// =====================================================================================================================

export function ExpenseForm({ tripId }: { tripId: string | null }) {
  const { today, send, go, myTrips } = useDriver();
  const [kind, setKind] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [source, setSource] = useState<"cash_on_hand" | "personal">("cash_on_hand");
  const [forTrip, setForTrip] = useState<string>(tripId ?? "");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const s = useSubmit();
  if (!today) return null;
  const tripOptions = (today.trips.length ? today.trips : myTrips).filter((t) => t.status !== "assigned");
  return (
    <div className="flex flex-col gap-3">
      <Section title="Catat pengeluaran" testId="form-pengeluaran">
        <Choices label="Jenis" value={kind} onChange={setKind} options={enumOptions("trip_expense_kind")} />
        <NumberField id="jumlah-pengeluaran" label="Jumlah" prefix="Rp" value={amount} onChange={setAmount} />
        <Choices<"cash_on_hand" | "personal"> label="Sumber dana" value={source} onChange={setSource} options={enumOptions("expense_funding_source")} />
        <label className="flex flex-col gap-1.5 text-base font-medium" htmlFor="rit-pengeluaran">
          Terkait rit
          <select id="rit-pengeluaran" value={forTrip} onChange={(e) => setForTrip(e.target.value)} className="min-h-14 rounded-xl border-2 bg-background px-3 text-lg">
            <option value="">Hari ini (tanpa rit tertentu)</option>
            {tripOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.number} — {t.customerName}
              </option>
            ))}
          </select>
        </label>
        <TextField id="pengeluaran-ket" label="Catatan (opsional)" value={note} onChange={setNote} />
        <PhotoCapture label="Foto nota (wajib)" compress={{ maxBytes: today.settings.maxPhotoKb * 1024 }} onCapture={setPhoto} onClear={() => setPhoto(null)} />
        <Banner tone="info">Pengeluaran menunggu verifikasi Admin Keuangan saat setoran diterima. Dari kas di tangan: mengurangi uang yang disetor.</Banner>
        <ErrorText>{s.error}</ErrorText>
        <BigButton
          loading={s.busy}
          onClick={() =>
            s.run(async () => {
              if (!kind) throw new Error("Pilih jenis pengeluaran.");
              if (!amount || amount <= 0) throw new Error("Isi jumlah pengeluaran.");
              if (!photo) throw new Error("Ambil foto nota.");
              await send(
                M3_COMMANDS.expense,
                { expenseId: newId(), tripId: forTrip || null, kind, amount, fundingSource: source, note: note.trim() || null },
                `Pengeluaran ${label("trip_expense_kind", kind)} ${formatRupiah(amount)}`,
                photoAttachment(M3_ATTACHMENT_KINDS.expenseReceipt, photo),
              );
              go({ name: "setor" });
            })
          }
        >
          Simpan pengeluaran
        </BigButton>
      </Section>
      {today.expenses.length ? (
        <Section title="Pengeluaran hari ini">
          {today.expenses.map((e) => (
            <FigureRow key={e.id} label={`${label("trip_expense_kind", e.kind)} · ${label("expense_funding_source", e.fundingSource)} · ${label("expense_status", e.status)}`} value={formatRupiah(e.amount)} />
          ))}
        </Section>
      ) : null}
    </div>
  );
}

// =====================================================================================================================
// Struk WA
// =====================================================================================================================

/** Struk rit (tripId) atau bukti pelunasan (paymentId) lewat tautan WA satu ketukan; lewati dengan alasan. */
export function ReceiptView({ tripId, paymentId }: { tripId: string; paymentId?: string }) {
  const { trip, today, send, go } = useDriver();
  const t = trip(tripId);
  const [skip, setSkip] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const s = useSubmit();
  if (!t || !today) return <Banner tone="danger">Rit tidak ditemukan.</Banner>;
  const phone = normalizePhoneForWa(t.customerPhone);
  const kind = paymentId ? "payment_receipt" : "trip_receipt";
  const pay = today.payments.find((p) => p.tripId === t.id);
  const collection = paymentId ? today.collections.find((c) => c.id === paymentId) : undefined;
  const outstanding = (today.invoicesByCustomer[t.customerId] ?? []).reduce((sum, i) => sum + i.outstanding, 0);
  const text = renderTemplateText(today.receiptTemplates[kind] ?? "", {
    nama_usaha: today.company.name,
    nomor_rit: t.number,
    nama_pelanggan: t.customerName,
    tanggal: formatTanggal(today.date, { weekday: false }),
    volume: `${(t.deliveredVolumeL ?? t.plannedVolumeL).toLocaleString("id-ID")} L`,
    harga: formatRupiah(t.price),
    cara_bayar: pay ? label("payment_method", pay.method) : label("payment_method", t.paymentMethod),
    nama_penerima: t.recipientName,
    sisa_piutang: pay?.method === "credit" || (pay?.underpaymentAmount ?? 0) > 0 || outstanding > 0 ? `Sisa piutang: ${formatRupiah(outstanding + (pay?.method === "credit" ? pay.expectedAmount : (pay?.underpaymentAmount ?? 0)))}` : null,
    jumlah: collection ? formatRupiah(collection.amount) : null,
    daftar_faktur: collection ? collection.allocations.map((a) => a.invoiceNumber ?? "").join(", ") : null,
  });
  const record = (action: "opened" | "skipped") =>
    send(
      M3_COMMANDS.receipt,
      { kind, tripId: t.id, customerPaymentId: paymentId ?? null, action, reasonCode: action === "skipped" ? skip : null, reasonText: action === "skipped" ? note.trim() || null : null, toPhone: phone, renderedText: text },
      action === "opened" ? `Struk WA ${t.number}` : `Struk WA dilewati ${t.number}`,
    );
  return (
    <Section title={paymentId ? "Bukti pelunasan WA" : "Kirim struk WA"} testId="struk-wa">
      <Banner tone="success">{paymentId ? "Pelunasan tercatat." : "Rit Selesai & pembayaran tercatat."}</Banner>
      <pre className="rounded-xl border-2 bg-muted/40 p-3 text-base whitespace-pre-wrap">{text}</pre>
      {phone ? (
        <a
          href={waLink(phone, text)}
          target="_blank"
          rel="noreferrer"
          className={bigButtonVariants({ variant: "success", size: "xl" })}
          onClick={() => {
            void record("opened").then(() => go({ name: "list" }));
          }}
        >
          <MessageCircle className="size-6" aria-hidden /> Kirim struk WA
        </a>
      ) : (
        <Banner tone="warning">Nomor WA pelanggan tidak ada/tidak valid — lewati dengan alasan.</Banner>
      )}
      <Choices label="Lewati struk" value={skip} onChange={setSkip} options={enumOptions("receipt_skip_reason")} />
      {skip === "other" ? <TextField id="struk-ket" label="Keterangan" value={note} onChange={setNote} /> : null}
      <ErrorText>{s.error}</ErrorText>
      <BigButton
        variant="outline"
        loading={s.busy}
        disabled={!skip}
        onClick={() =>
          s.run(async () => {
            if (skip === "other" && note.trim().length < 3) throw new Error("Tulis alasan singkat.");
            if (kind === "trip_receipt") await record("skipped");
            go({ name: "list" });
          })
        }
      >
        Lewati & kembali ke daftar rit
      </BigButton>
    </Section>
  );
}
