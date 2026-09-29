"use client";

import { HandCoins } from "lucide-react";
import { useState } from "react";

import { outboxStatusText } from "@/client/offline";
import { useOutbox } from "@/client/offline/hooks";
import { label } from "@/lib/labels";
import { formatRupiah } from "@/lib/money";
import { formatJam, formatTanggal } from "@/lib/time";
import { cn } from "@/lib/utils";
import { BigButton } from "@/components/field/big-button";
import { PhotoCapture, type CapturedPhoto } from "@/components/field/photo-capture";
import { MyCashCard } from "@/components/m4-cash/my-cash-card";

import { usePos } from "./pos-context";
import { Banner, ChoiceButtons, ErrorText, PosSection } from "./ui";
import { OutboxItemActions } from "@/components/field/outbox-item-actions";

function DepositHandover() {
  const { ref, send } = usePos();
  const last = ref?.lastClosedShift;
  const [method, setMethod] = useState<"physical" | "bank_slip" | null>("physical");
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!last || last.depositStatus !== "not_deposited") return null;
  async function submit() {
    setError(null);
    if (method === "bank_slip" && !photo) return setError("Ambil foto slip setor bank.");
    try {
      await send(
        "m6.shift_deposit.submit",
        { shiftId: last!.id, method },
        `Serahkan setoran shift ${last!.businessDate}`,
        photo && method === "bank_slip" ? [{ kind: "bank_slip", blob: photo.blob, capturedAt: photo.capturedAt }] : [],
      );
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal dicatat.");
    }
  }
  return (
    <PosSection title="Setoran shift terakhir" testId="serah-setoran">
      {done ? (
        <Banner tone="success">Setoran ditandai Disetor. Admin Keuangan akan menerima dan menghitung selisihnya.</Banner>
      ) : (
        <>
          <p className="text-base">
            Shift {formatTanggal(last.businessDate)} — jumlah disetor {last.depositAmount !== null ? <strong>{formatRupiah(last.depositAmount)}</strong> : "dihitung saat terkirim"}.
          </p>
          <ChoiceButtons
            label="Cara setor"
            value={method}
            onChange={setMethod}
            options={[
              { value: "physical", label: "Serah fisik ke Admin Keuangan" },
              { value: "bank_slip", label: "Setor bank (slip)" },
            ]}
          />
          {method === "bank_slip" ? <PhotoCapture label="Foto slip setor bank" onCapture={setPhoto} onClear={() => setPhoto(null)} /> : null}
          <ErrorText>{error}</ErrorText>
          <BigButton variant="secondary" icon={<HandCoins aria-hidden />} onClick={() => void submit()}>
            Tandai sudah disetor
          </BigButton>
        </>
      )}
    </PosSection>
  );
}

function QueueList() {
  const { session } = usePos();
  const items = useOutbox(session.user.id, 30);
  const pending = items.filter((i) => i.status !== "sent" && i.status !== "rejected" && i.status !== "conflict").length;
  return (
    <PosSection title="Antrean data perangkat" testId="antrean">
      <p className="text-base">
        {pending ? `${pending} data tersimpan di perangkat, menunggu terkirim.` : "Semua data sudah terkirim."}
      </p>
      <ul className="flex flex-col gap-2">
        {items.map((i) => (
          <li key={i.id} className="rounded-xl border p-3" data-status={i.status}>
            <p className="text-base font-semibold">{i.label ?? i.type}</p>
            <p className={cn("text-base", i.status === "rejected" ? "text-destructive" : i.status === "sent" ? "text-success" : "text-warning-foreground")}>
              {outboxStatusText(i)} · {formatJam(new Date(i.createdAt))}
            </p>
            <OutboxItemActions item={i} />
          </li>
        ))}
      </ul>
    </PosSection>
  );
}

export function HistoryView() {
  const { ref, session } = usePos();
  return (
    <div className="flex flex-col gap-4">
      <DepositHandover />
      {/* B-28 (US-M4-03 KP-3, US-M4-02 KP-8): hasil penerimaan setoran, keputusan selisih & saldo ganti rugi saya. */}
      <MyCashCard userId={session.user.id} />
      <PosSection title="Riwayat shift saya (90 hari)" testId="riwayat-shift">
        {ref?.history.length ? (
          <ul className="flex flex-col gap-2">
            {ref.history.map((h) => (
              <li key={h.shiftId} className="rounded-xl border-2 p-3">
                <p className="text-base font-semibold">
                  {formatTanggal(h.businessDate)} · {label("shift_status", h.status)}
                </p>
                <p className="text-base">
                  Penjualan {formatRupiah(h.salesTotal)} · {h.gallonsSold} galon
                </p>
                {h.cashDifference !== null ? (
                  <p className={cn("text-base", h.cashDifference !== 0 && "text-destructive")}>
                    Selisih kas {formatRupiah(h.cashDifference, { signed: true })}
                    {h.cashDifferenceReason ? ` (${h.cashDifferenceReason})` : ""}
                  </p>
                ) : null}
                {h.stockDifferences.some((s) => s.difference) ? (
                  <p className="text-sm text-muted-foreground">
                    Selisih stok: {h.stockDifferences.filter((s) => s.difference).map((s) => `${s.name} ${s.difference! > 0 ? "+" : ""}${s.difference}`).join(", ")}
                  </p>
                ) : null}
                <p className="text-sm">
                  Setoran {h.depositAmount !== null ? formatRupiah(h.depositAmount) : "—"} · {label("shift_deposit_status", h.depositStatus)}
                  {h.depositReceivedAmount !== null ? ` · diterima ${formatRupiah(h.depositReceivedAmount)}` : ""}
                  {h.depositDiscrepancy ? ` · selisih ${formatRupiah(h.depositDiscrepancy, { signed: true })}` : ""}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-base text-muted-foreground">Belum ada riwayat shift.</p>
        )}
      </PosSection>
      <QueueList />
    </div>
  );
}
