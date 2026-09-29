"use client";

import { LoaderCircle } from "lucide-react";
import { useMemo, useState, useTransition } from "react";

import { useFlashActionState } from "@/components/shared/use-flash-action";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { enumOptions } from "@/lib/labels";
import { formatRupiah, parseRupiah } from "@/lib/money";
import { cn } from "@/lib/utils";

import type { CashActionState } from "./action-state";
import { prepareCashFormData } from "./prepare-form-data";

export type PendingExpense = { id: string; label: string; amount: number; fundingSource: "cash_on_hand" | "personal" };

const DENOMINATIONS = [100_000, 50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100] as const;

const input = "h-10 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:text-sm";

/**
 * Formulir terima setoran (US-M4-02 KP-2/3/6): jumlah fisik (+ rincian pecahan opsional), verifikasi pengeluaran rit satu
 * per satu (terima/tolak), selisih dihitung langsung = diterima − (seharusnya − pengeluaran diterima). Selisih ≠ 0 →
 * alasan wajib dari daftar; setelah batas tutup kas → alasan terlambat wajib. Angka seharusnya hanya ditampilkan.
 */
export function ReceiveDepositForm({
  action,
  expectedCash,
  acceptedCashExpenses,
  pendingExpenses,
  late,
  cutoff,
  threshold,
}: {
  action: (state: CashActionState, formData: FormData) => Promise<CashActionState>;
  expectedCash: number;
  acceptedCashExpenses: number;
  pendingExpenses: PendingExpense[];
  late: boolean;
  cutoff: string;
  threshold: number;
}) {
  const [state, formAction, pending] = useFlashActionState(action, {} as CashActionState);
  const [preparing, startPreparing] = useTransition();
  const busy = pending || preparing;
  const submit = (fd: FormData) => {
    startPreparing(async () => {
      const prepared = await prepareCashFormData(fd);
      startPreparing(() => formAction(prepared));
    });
  };
  const [received, setReceived] = useState<string>("");
  const [decisions, setDecisions] = useState<Record<string, "accept" | "reject" | undefined>>({});
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [useDenominations, setUseDenominations] = useState(false);

  const denomTotal = useMemo(() => DENOMINATIONS.reduce((s, d) => s + d * (Number(counts[d] ?? 0) || 0), 0), [counts]);
  const receivedValue = useDenominations ? denomTotal : (parseRupiah(received) ?? 0);
  const newlyAccepted = pendingExpenses.filter((e) => decisions[e.id] === "accept" && e.fundingSource === "cash_on_hand").reduce((s, e) => s + e.amount, 0);
  const expectedNet = expectedCash - acceptedCashExpenses - newlyAccepted;
  const undecided = pendingExpenses.filter((e) => !decisions[e.id]).length;
  const diff = receivedValue - expectedNet;
  const hasInput = useDenominations ? denomTotal > 0 : received.trim() !== "";

  return (
    <form action={submit} className="grid gap-4" data-testid="form-terima-setoran">
      {pendingExpenses.length ? (
        <fieldset className="grid gap-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">Verifikasi pengeluaran rit (PTB-20)</legend>
          {pendingExpenses.map((e) => (
            <div key={e.id} className="grid gap-2 border-b pb-2 last:border-b-0 last:pb-0 sm:grid-cols-[1fr_auto]">
              <div className="text-sm">
                <span className="font-medium">{e.label}</span> — {formatRupiah(e.amount)}
                <span className="block text-xs text-muted-foreground">{e.fundingSource === "personal" ? "Uang pribadi (diterima → diganti dari kas kantor)" : "Dari kas di tangan"}</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="inline-flex items-center gap-1">
                  <input type="radio" name={`exp_${e.id}`} value="accept" onChange={() => setDecisions((d) => ({ ...d, [e.id]: "accept" }))} /> Terima
                </label>
                <label className="inline-flex items-center gap-1">
                  <input type="radio" name={`exp_${e.id}`} value="reject" onChange={() => setDecisions((d) => ({ ...d, [e.id]: "reject" }))} /> Tolak
                </label>
                {decisions[e.id] === "reject" ? <input name={`expreason_${e.id}`} placeholder="Alasan tolak" aria-label="Alasan tolak pengeluaran" className="h-8 rounded-md border px-2 text-sm" required /> : null}
              </div>
            </div>
          ))}
          {undecided ? <p className="text-xs text-warning-foreground">{undecided} pengeluaran belum diputuskan.</p> : null}
        </fieldset>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {useDenominations ? (
          <div className="grid gap-2 text-sm sm:col-span-2">
            <span className="font-medium">Rincian pecahan (lembar/keping)</span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {DENOMINATIONS.map((d) => (
                <label key={d} className="grid gap-1 text-xs">
                  {formatRupiah(d)}
                  <input name={`den_${d}`} inputMode="numeric" value={counts[d] ?? ""} onChange={(ev) => setCounts((c) => ({ ...c, [d]: ev.target.value.replace(/[^0-9]/g, "") }))} className="h-9 rounded-md border px-2 text-sm" />
                </label>
              ))}
            </div>
            <input type="hidden" name="receivedAmount" value={String(denomTotal)} />
          </div>
        ) : (
          <label className="grid gap-1 text-sm font-medium">
            Jumlah fisik diterima (Rp)
            <input name="receivedAmount" inputMode="numeric" required value={received} onChange={(ev) => setReceived(ev.target.value)} placeholder="0" className={input} />
          </label>
        )}
        <label className="inline-flex items-center gap-2 self-end text-sm">
          <input type="checkbox" checked={useDenominations} onChange={(ev) => setUseDenominations(ev.target.checked)} /> Isi rincian pecahan (opsional)
        </label>
      </div>

      <div className="grid gap-1 rounded-md bg-muted/50 p-3 text-sm" aria-live="polite" data-testid="hitung-selisih" data-expected-net={expectedNet}>
        <div className="flex justify-between">
          <span>Seharusnya − pengeluaran diterima</span>
          <span className="font-medium">{formatRupiah(expectedNet)}</span>
        </div>
        <div className="flex justify-between">
          <span>Diterima</span>
          <span className="font-medium">{hasInput ? formatRupiah(receivedValue) : "—"}</span>
        </div>
        <div className="flex justify-between border-t pt-1">
          <span>Selisih</span>
          <span className={cn("font-semibold", hasInput && diff < 0 && "text-destructive", hasInput && diff > 0 && "text-success")}>{hasInput ? formatRupiah(diff, { signed: true }) : "—"}</span>
        </div>
        {hasInput && Math.abs(diff) >= threshold ? <p className="text-xs text-destructive">Selisih ≥ {formatRupiah(threshold)} diteruskan ke pemilik (≤ 24 jam); setoran tetap dapat ditutup setelah diberi alasan.</p> : null}
      </div>

      {hasInput && diff !== 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm font-medium">
            Alasan selisih
            <select name="discrepancyReason" required defaultValue="" className={input}>
              <option value="" disabled>
                Pilih alasan…
              </option>
              {enumOptions("discrepancy_reason").map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Keterangan (wajib untuk &quot;Lainnya&quot;)
            <input name="discrepancyNote" className={input} />
          </label>
          <label className="grid gap-1 text-sm font-medium sm:col-span-2">
            Foto uang rusak/palsu (opsional)
            <input name="evidence" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="text-sm" />
          </label>
        </div>
      ) : null}

      {late ? (
        <label className="grid gap-1 text-sm font-medium">
          Alasan terlambat (diterima setelah {cutoff.replace(":", ".")} atau hari berikutnya)
          <input name="lateReason" required className={input} />
        </label>
      ) : null}

      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" name="close" defaultChecked /> Tutup setoran sekaligus (membuka kunci rit sopir hari berikutnya)
      </label>

      {state.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.ok && state.message ? (
        <p role="status" className="text-sm text-success">
          {state.message}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
          Terima setoran
        </Button>
      </div>
    </form>
  );
}
