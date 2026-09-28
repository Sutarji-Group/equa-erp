"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { DateInput } from "@/components/shared/date-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { setParameterAction } from "./actions";

type FieldKind = "number" | "boolean" | "text" | "json";

function kindOf(v: unknown): FieldKind {
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string" || v === null) return "text";
  return "json";
}

function initialDraft(value: unknown): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      const kind = kindOf(v);
      out[k] = kind === "boolean" ? Boolean(v) : kind === "json" ? JSON.stringify(v, null, 2) : v === null ? "" : String(v);
    }
  }
  return out;
}

/** Formulir ubah parameter (pemilik): isian per kunci nilai + tanggal berlaku + alasan wajib. */
export function ParamEditForm({ paramKey, value, minDate }: { paramKey: string; value: unknown; minDate: string }) {
  const fields = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : [];
  const [draft, setDraft] = useState(() => initialDraft(value));
  const [effectiveFrom, setEffectiveFrom] = useState<string | null>(minDate);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function build(): unknown {
    const out: Record<string, unknown> = {};
    for (const [k, original] of fields) {
      const kind = kindOf(original);
      const raw = draft[k];
      if (kind === "number") out[k] = raw === "" ? null : Number(raw);
      else if (kind === "boolean") out[k] = Boolean(raw);
      else if (kind === "json") out[k] = JSON.parse(String(raw));
      else out[k] = original === null && raw === "" ? null : String(raw);
    }
    return out;
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        let json: string;
        try {
          json = JSON.stringify(build());
        } catch {
          setError("Isian daftar/objek tidak valid (format JSON).");
          return;
        }
        start(async () => {
          const r = await setParameterAction(paramKey, json, effectiveFrom ?? "", reason);
          if (r?.error) setError(r.error);
          else {
            toast.success(`Parameter ${paramKey} tersimpan dan berlaku mulai ${effectiveFrom}.`);
            setReason("");
          }
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map(([k, original]) => {
          const kind = kindOf(original);
          const id = `param-${paramKey}-${k}`;
          if (kind === "boolean") {
            return (
              <div key={k} className="flex items-center gap-2">
                <Checkbox id={id} checked={Boolean(draft[k])} onCheckedChange={(c) => setDraft((d) => ({ ...d, [k]: c === true }))} />
                <Label htmlFor={id}>{k}</Label>
              </div>
            );
          }
          return (
            <div key={k} className={kind === "json" ? "grid gap-1.5 sm:col-span-2" : "grid gap-1.5"}>
              <Label htmlFor={id}>{k}</Label>
              {kind === "json" ? (
                <Textarea id={id} rows={4} className="font-mono text-xs" value={String(draft[k] ?? "")} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} />
              ) : (
                <Input
                  id={id}
                  inputMode={kind === "number" ? "decimal" : undefined}
                  value={String(draft[k] ?? "")}
                  onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`param-${paramKey}-from`}>Berlaku mulai</Label>
          <DateInput id={`param-${paramKey}-from`} value={effectiveFrom} onValueChange={setEffectiveFrom} min={minDate} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`param-${paramKey}-reason`}>Alasan perubahan</Label>
          <Input id={`param-${paramKey}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Wajib, minimal 5 karakter" />
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={pending}>
          Simpan perubahan
        </Button>
      </div>
    </form>
  );
}
