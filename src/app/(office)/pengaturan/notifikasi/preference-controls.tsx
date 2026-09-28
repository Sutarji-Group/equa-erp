"use client";

import { Lock } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { setPreferenceAction, setQuietHoursAction } from "./actions";

const MODES = [
  { value: "immediate", label: "Seketika" },
  { value: "daily_digest", label: "Ringkasan harian" },
  { value: "off", label: "Mati" },
] as const;

type Mode = (typeof MODES)[number]["value"];

export function PreferenceSelect({ event, mode, canDisable, label }: { event: string; mode: Mode; canDisable: boolean; label: string }) {
  const [value, setValue] = useState<Mode>(mode);
  const [pending, start] = useTransition();
  if (!canDisable) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <Lock className="size-3.5" aria-hidden />
        Kritis — selalu seketika
      </span>
    );
  }
  return (
    <Select
      value={value}
      disabled={pending}
      onValueChange={(next) => {
        const prev = value;
        setValue(next as Mode);
        start(async () => {
          const r = await setPreferenceAction(event, next as Mode);
          if (r?.error) {
            setValue(prev);
            toast.error(r.error);
          }
        });
      }}
    >
      <SelectTrigger className="w-48" aria-label={`Mode notifikasi ${label}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MODES.map((m) => (
          <SelectItem key={m.value} value={m.value}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function QuietHoursForm({ start: initialStart, end: initialEnd, defaultText }: { start: string; end: string; defaultText: string }) {
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [pending, run] = useTransition();
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await setQuietHoursAction(start && end ? { start, end } : null);
          if (r?.error) toast.error(r.error);
          else toast.success("Jam tenang tersimpan.");
        });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="quiet-start">Mulai</Label>
        <Input id="quiet-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} className="w-32" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="quiet-end">Selesai</Label>
        <Input id="quiet-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="w-32" />
      </div>
      <Button type="submit" disabled={pending}>
        Simpan
      </Button>
      <Button
        type="button"
        variant="ghost"
        disabled={pending}
        onClick={() =>
          run(async () => {
            const r = await setQuietHoursAction(null);
            if (r?.error) toast.error(r.error);
            else {
              setStart("");
              setEnd("");
              toast.success(`Kembali ke bawaan (${defaultText}).`);
            }
          })
        }
      >
        Pakai bawaan
      </Button>
    </form>
  );
}
