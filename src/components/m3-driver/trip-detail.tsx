"use client";

/**
 * Detail rit (US-M3-01 KP-2/KP-3): catatan khusus, telepon/WA pelanggan, navigasi (koordinat atau teks alamat), HARGA
 * PESANAN (satu-satunya harga, BR-19), faktur terbuka (Terima pelunasan), penanda internal depot; tindakan sesuai status
 * (Berangkat/Tiba/Selesai/Gagal/Kendala/Minta tempo) — tiap tindakan ≤ 3 ketukan dari daftar rit.
 */
import { AlertTriangle, HandCoins, MapPin, MessageCircle, Navigation, Phone, Truck, XCircle } from "lucide-react";
import { useState } from "react";

import { M3_COMMANDS, navigationUrl, normalizePhoneForWa, sortInvoicesForCollection } from "@/client/m3-driver/contract";
import { BigButton } from "@/components/field/big-button";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatJam, formatTanggal } from "@/lib/time";

import { useDriver } from "./driver-context";
import { TripStatusBadge, useTripActions } from "./trip-list";
import { Banner, ErrorText, FigureRow, Section, TextField } from "./ui";

function CreditRequest({ tripId }: { tripId: string }) {
  const { trip, send, session } = useDriver();
  const t = trip(tripId)!;
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const req = t.creditRequest;
  if (t.isInternal || t.paymentMethod === "credit") return null;
  if (req && req.status !== "rejected" && req.status !== "expired" && req.status !== "cancelled") {
    return (
      <Banner tone={req.status === "approved" ? "success" : "info"}>
        Permintaan tempo {req.number ?? ""}:{" "}
        {req.status === "approved" ? "DISETUJUI Dispatcher — pilih Tempo saat Selesai." : req.status === "queued" ? "tersimpan di ponsel, menunggu sinyal." : "menunggu keputusan Dispatcher…"}
      </Banner>
    );
  }
  return (
    <details className="rounded-xl border-2 p-3">
      <summary className="min-h-12 cursor-pointer text-base font-semibold">Pelanggan minta tempo?</summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-base text-muted-foreground">
          Sopir tidak memutuskan kredit. Ajukan ke Dispatcher (hanya saat ada sinyal; pelanggan Tempo & dalam batas). Bila tidak disetujui atau tanpa sinyal, kekurangan dicatat sebagai kurang bayar.
        </p>
        {req?.status === "rejected" ? <Banner tone="danger">Permintaan sebelumnya ditolak: {req.decisionReason}</Banner> : null}
        <TextField id="alasan-tempo" label="Alasan" value={reason} onChange={setReason} placeholder="Mis. pelanggan minta ditagih akhir bulan" />
        <ErrorText>{error}</ErrorText>
        <BigButton
          variant="secondary"
          disabled={!session.sync.online}
          onClick={async () => {
            setError(null);
            if (reason.trim().length < 3) return setError("Tulis alasan permintaan tempo.");
            try {
              await send(M3_COMMANDS.fieldCredit, { tripId, reason: reason.trim() }, `Minta tempo ${t.number}`);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Gagal mencatat.");
            }
          }}
        >
          {session.sync.online ? "Minta persetujuan tempo" : "Tanpa sinyal — catat kurang bayar"}
        </BigButton>
      </div>
    </details>
  );
}

export function TripDetailView({ tripId }: { tripId: string }) {
  const { trip, today, go, canAct } = useDriver();
  const actions = useTripActions();
  const t = trip(tripId);
  if (!t || !today) return <Banner tone="danger">Rit tidak ditemukan (mungkin ditarik Dispatcher). Kembali ke daftar rit.</Banner>;
  const phone = normalizePhoneForWa(t.customerPhone);
  const invoices = sortInvoicesForCollection(today.invoicesByCustomer[t.customerId] ?? []);
  const blocked = actions.blockReason(t);
  return (
    <div className="flex flex-col gap-4" data-testid="detail-rit">
      <Section>
        <div className="flex flex-wrap items-center gap-2">
          <TripStatusBadge status={t.status} />
          <span className="text-base font-semibold">{t.number}</span>
          {t.routeOrder ? <span className="text-base text-muted-foreground">urutan {t.routeOrder}</span> : null}
        </div>
        <h2 className="text-xl font-bold">{t.isInternal ? `Internal — ${t.destinationOutletName ?? "Depot"}` : t.customerName}</h2>
        {t.isInternal ? <Banner tone="info">Rit internal pasokan depot (PTB-01): bukti = volume diserahkan + foto; tanpa pembayaran.</Banner> : null}
        <p className="text-base">
          {t.addressLabel ? <strong>{t.addressLabel}: </strong> : null}
          {t.addressText}
        </p>
        <FigureRow label="Volume" value={`${t.plannedVolumeL.toLocaleString("id-ID")} L`} />
        {t.requestedTime ? <FigureRow label="Jam diminta" value={t.requestedTime.replace(":", ".")} /> : null}
        {!t.isInternal ? (
          <>
            <FigureRow label="Cara bayar" value={label("payment_method", t.paymentMethod)} />
            <FigureRow label="Harga pesanan" value={formatRupiah(t.price)} strong testId="harga-pesanan" />
          </>
        ) : null}
        {t.contactName ? <FigureRow label="Kontak" value={t.contactName} /> : null}
        {t.creditHold ? <Banner tone="danger">Pelanggan Ditahan: minta pembayaran tunai/transfer.</Banner> : null}
        {t.collectUnderpayment ? <Banner tone="warning">Tagih kurang bayar sebelumnya (lihat faktur di bawah).</Banner> : null}
        {t.update ? (
          <Banner tone="info">
            Diperbarui {formatJam(t.update.at)}: {t.update.summary.join("; ")}
          </Banner>
        ) : null}
      </Section>

      {t.hasSpecialNotes ? (
        <Section title="Catatan khusus" testId="catatan-khusus">
          {t.customerNotes ? <p className="text-base">Pelanggan: {t.customerNotes}</p> : null}
          {t.addressNotes ? <p className="text-base">Lokasi: {t.addressNotes}</p> : null}
          {t.orderNotes ? <p className="text-base">Pesanan: {t.orderNotes}</p> : null}
        </Section>
      ) : null}

      <div className="grid grid-cols-3 gap-2">
        <a href={phone ? `tel:+${phone}` : undefined} aria-disabled={!phone} className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border-2 text-base font-semibold aria-disabled:opacity-40">
          <Phone className="size-6" aria-hidden /> Telepon
        </a>
        <a href={phone ? `https://wa.me/${phone}` : undefined} target="_blank" rel="noreferrer" aria-disabled={!phone} className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border-2 text-base font-semibold aria-disabled:opacity-40">
          <MessageCircle className="size-6" aria-hidden /> WA
        </a>
        <a href={navigationUrl(t)} className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border-2 text-base font-semibold" data-testid="navigasi">
          <Navigation className="size-6" aria-hidden /> Navigasi
        </a>
      </div>
      {!t.coordinateLocked || t.lat === null ? <Banner tone="info">Navigasi memakai teks alamat — titik alamat akan dikunci saat Selesai.</Banner> : null}

      {!t.isInternal && invoices.length > 0 ? (
        <Section title="Faktur terbuka pelanggan" testId="faktur-terbuka">
          <p className="text-sm text-muted-foreground">Data sinkron {formatTanggal(today.generatedAt, { weekday: false })} {formatJam(today.generatedAt)}</p>
          <ul className="flex flex-col gap-1">
            {invoices.map((i) => (
              <li key={i.id} className="flex justify-between gap-2 text-base">
                <span>
                  {i.number} · {formatTanggal(i.issueDate, { weekday: false })}
                  {i.isUnderpayment ? <strong className="ml-1 text-destructive">tagih kurang bayar</strong> : null}
                </span>
                <span className="tabular-nums">{formatRupiah(i.outstanding)}</span>
              </li>
            ))}
          </ul>
          {canAct ? (
            <BigButton variant="secondary" icon={<HandCoins aria-hidden />} onClick={() => go({ name: "collect", tripId: t.id })}>
              Terima pelunasan
            </BigButton>
          ) : null}
        </Section>
      ) : null}

      {canAct ? (
        <div className="flex flex-col gap-2">
          {t.status === "assigned" ? (
            <BigButton size="xl" icon={<Truck aria-hidden />} loading={actions.busy === t.id} disabled={!!blocked} onClick={() => actions.depart(t)}>
              Berangkat
            </BigButton>
          ) : null}
          {t.status === "assigned" && blocked ? <Banner tone="warning">{blocked}</Banner> : null}
          {t.status === "departed" ? (
            <BigButton size="xl" icon={<MapPin aria-hidden />} loading={actions.busy === t.id} onClick={() => actions.arrive(t)}>
              Tiba
            </BigButton>
          ) : null}
          {t.status === "arrived" || t.status === "departed" ? (
            <>
              <BigButton size="xl" variant="success" onClick={() => go({ name: "complete", tripId: t.id })}>
                Selesai &amp; bayar
              </BigButton>
              {t.status === "arrived" ? <CreditRequest tripId={t.id} /> : null}
              <div className="grid grid-cols-2 gap-2">
                <BigButton variant="danger" icon={<XCircle aria-hidden />} onClick={() => go({ name: "fail", tripId: t.id })}>
                  Rit gagal
                </BigButton>
                <BigButton variant="outline" icon={<AlertTriangle aria-hidden />} onClick={() => go({ name: "incident", tripId: t.id })}>
                  Kendala
                </BigButton>
              </div>
            </>
          ) : null}
          {t.status === "completed" && !t.isInternal ? (
            <BigButton variant="secondary" icon={<MessageCircle aria-hidden />} onClick={() => go({ name: "receipt", tripId: t.id })} disabled={t.receiptStatus !== "none"}>
              {t.receiptStatus === "sent" ? "Struk WA sudah dikirim" : t.receiptStatus === "skipped" ? "Struk WA dilewati" : "Kirim struk WA"}
            </BigButton>
          ) : null}
          {t.status === "completed" || t.status === "failed" ? <Banner tone="info">Rit ini sudah {label("trip_status", t.status)} dan terkunci. Koreksi hanya oleh Admin Keuangan.</Banner> : null}
          {actions.notice ? <Banner tone="warning">{actions.notice}</Banner> : null}
          <ErrorText>{actions.error}</ErrorText>
        </div>
      ) : null}
    </div>
  );
}
