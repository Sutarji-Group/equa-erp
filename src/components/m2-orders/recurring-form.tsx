"use client";

import { LoaderCircle } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { saveRecurringAction } from "@/app/(office)/langganan/actions";
import { searchCustomersAction, type CustomerOption } from "@/app/(office)/pesanan/actions";
import { SearchCombobox } from "@/components/shared/search-combobox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { SELECT_CLASS } from "./fields";

const DAYS = [
  { v: 1, l: "Sen" },
  { v: 2, l: "Sel" },
  { v: 3, l: "Rab" },
  { v: 4, l: "Kam" },
  { v: 5, l: "Jum" },
  { v: 6, l: "Sab" },
  { v: 7, l: "Min" },
];

export type RecurringInitial = {
  id: string;
  customer: CustomerOption;
  addressId: string;
  pattern: "weekly" | "interval";
  daysOfWeek: number[];
  intervalDays: number | null;
  tankCount: number;
  requestedTime: string | null;
  paymentMethod: "cash" | "transfer" | "credit" | "internal";
  startDate: string;
  endDate: string | null;
  notes: string | null;
};

/** Formulir pola langganan (US-M2-06 KP-1): pelanggan, alamat, hari/interval, tangki, jam, cara bayar, mulai/berakhir. */
export function RecurringForm({ today, initial, onDone }: { today: string; initial?: RecurringInitial; onDone?: () => void }) {
  const [customer, setCustomer] = useState<CustomerOption | null>(initial?.customer ?? null);
  const [addressId, setAddressId] = useState(initial?.addressId ?? "");
  const [pattern, setPattern] = useState<"weekly" | "interval">(initial?.pattern ?? "weekly");
  const [days, setDays] = useState<number[]>(initial?.daysOfWeek ?? []);
  const [intervalDays, setIntervalDays] = useState(initial?.intervalDays ?? 3);
  const [tankCount, setTankCount] = useState(initial?.tankCount ?? 1);
  const [requestedTime, setRequestedTime] = useState(initial?.requestedTime?.slice(0, 5) ?? "");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "transfer" | "credit">(initial?.paymentMethod === "credit" ? "credit" : initial?.paymentMethod === "transfer" ? "transfer" : "cash");
  const [startDate, setStartDate] = useState(initial?.startDate ?? today);
  const [endDate, setEndDate] = useState(initial?.endDate ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  function save() {
    if (!customer || !addressId) {
      setError("Pilih pelanggan dan alamat kirim.");
      return;
    }
    setError(null);
    start(async () => {
      const r = await saveRecurringAction(initial?.id ?? null, {
        customerId: customer.value,
        addressId,
        pattern,
        daysOfWeek: pattern === "weekly" ? days : null,
        intervalDays: pattern === "interval" ? intervalDays : null,
        tankCount,
        requestedTime: requestedTime || null,
        paymentMethod,
        startDate,
        endDate: endDate || null,
        notes: notes || null,
      });
      if (r.error) setError(r.error);
      else {
        toast.success(r.message ?? "Tersimpan.");
        if (!initial) {
          setCustomer(null);
          setAddressId("");
          setDays([]);
          setNotes("");
        }
        onDone?.();
      }
    });
  }

  return (
    <div className="grid gap-3" role="form" aria-label={initial ? "Ubah pola langganan" : "Pola langganan baru"}>
      <div className="grid gap-1.5">
        <Label htmlFor={`rc-customer-${initial?.id ?? "new"}`}>Pelanggan</Label>
        {initial ? (
          <Input id={`rc-customer-${initial.id}`} value={initial.customer.label} readOnly />
        ) : (
          <SearchCombobox<CustomerOption>
            id="rc-customer-new"
            value={customer}
            onValueChange={(c) => {
              setCustomer(c);
              setAddressId(c?.lastAddressId ?? c?.addresses[0]?.id ?? "");
              setRequestedTime(c?.fixedReceiveTime ?? "");
            }}
            search={(q) => searchCustomersAction(q)}
            placeholder="Cari pelanggan…"
          />
        )}
      </div>
      {customer ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`rc-addr-${initial?.id ?? "new"}`}>Alamat kirim</Label>
          <select id={`rc-addr-${initial?.id ?? "new"}`} className={SELECT_CLASS} value={addressId} onChange={(e) => setAddressId(e.target.value)}>
            {customer.addresses.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label} — {a.addressText}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`rc-pattern-${initial?.id ?? "new"}`}>Pola</Label>
          <select id={`rc-pattern-${initial?.id ?? "new"}`} className={SELECT_CLASS} value={pattern} onChange={(e) => setPattern(e.target.value as "weekly" | "interval")}>
            <option value="weekly">Hari tertentu setiap minggu</option>
            <option value="interval">Setiap sekian hari</option>
          </select>
        </div>
        {pattern === "weekly" ? (
          <fieldset className="grid gap-1.5">
            <legend className="text-sm font-medium">Hari</legend>
            <div className="flex flex-wrap gap-2">
              {DAYS.map((d) => (
                <label key={d.v} className="flex items-center gap-1 text-sm">
                  <input type="checkbox" className="accent-primary" checked={days.includes(d.v)} onChange={(e) => setDays((cur) => (e.target.checked ? [...cur, d.v] : cur.filter((x) => x !== d.v)))} />
                  {d.l}
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor={`rc-int-${initial?.id ?? "new"}`}>Setiap (hari)</Label>
            <Input id={`rc-int-${initial?.id ?? "new"}`} type="number" min={1} value={intervalDays} onChange={(e) => setIntervalDays(Number(e.target.value) || 1)} />
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor={`rc-tank-${initial?.id ?? "new"}`}>Jumlah tangki</Label>
          <Input id={`rc-tank-${initial?.id ?? "new"}`} type="number" min={1} value={tankCount} onChange={(e) => setTankCount(Math.max(1, Number(e.target.value) || 1))} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`rc-time-${initial?.id ?? "new"}`}>Jam diminta</Label>
          <Input id={`rc-time-${initial?.id ?? "new"}`} type="time" value={requestedTime} onChange={(e) => setRequestedTime(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`rc-pay-${initial?.id ?? "new"}`}>Cara bayar</Label>
          <select id={`rc-pay-${initial?.id ?? "new"}`} className={SELECT_CLASS} value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as "cash")}>
            <option value="cash">Tunai</option>
            <option value="transfer">Transfer</option>
            <option value="credit" disabled={customer?.creditStatus === "cash"}>
              Tempo{customer?.creditStatus === "cash" ? " (tidak tersedia)" : ""}
            </option>
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`rc-start-${initial?.id ?? "new"}`}>Mulai</Label>
          <Input id={`rc-start-${initial?.id ?? "new"}`} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`rc-end-${initial?.id ?? "new"}`}>Berakhir (opsional)</Label>
          <Input id={`rc-end-${initial?.id ?? "new"}`} type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`rc-notes-${initial?.id ?? "new"}`}>Catatan</Label>
        <Textarea id={`rc-notes-${initial?.id ?? "new"}`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div>
        <Button type="button" onClick={save} disabled={busy}>
          {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
          {initial ? "Simpan perubahan pola" : "Buat pola langganan"}
        </Button>
      </div>
    </div>
  );
}
