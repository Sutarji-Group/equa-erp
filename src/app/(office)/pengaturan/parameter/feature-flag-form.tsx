"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { setFeatureFlagAction } from "./actions";

export type FlagOption = { key: string; label: string; tenantScope: boolean };
export type TenantOption = { id: string; name: string };

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Formulir pemilik: nyalakan/matikan fitur bertahap untuk semua tenant (global) atau SATU tenant (mis. portal kemitraan
 * Tahap 3 untuk satu mitra). Alasan wajib; perubahan berjejak di jejak audit (tambahan S5-C, docs/uat/gerbang-tahap.md).
 */
export function FeatureFlagForm({ flags, tenants }: { flags: FlagOption[]; tenants: TenantOption[] }) {
  const [key, setKey] = useState(flags[0]?.key ?? "");
  const [scope, setScope] = useState("");
  const [enabled, setEnabled] = useState("on");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const current = flags.find((f) => f.key === key);

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await setFeatureFlagAction(key, current?.tenantScope ? scope : "", enabled === "on", reason);
          if (r?.error) setError(r.error);
          else {
            toast.success(`${current?.label ?? key} ${enabled === "on" ? "dinyalakan" : "dimatikan"}.`);
            setReason("");
          }
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="flag-key">Fitur</Label>
          <select id="flag-key" className={selectClass} value={key} onChange={(e) => setKey(e.target.value)}>
            {flags.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="flag-scope">Berlaku untuk</Label>
          <select id="flag-scope" className={selectClass} value={current?.tenantScope ? scope : ""} disabled={!current?.tenantScope} onChange={(e) => setScope(e.target.value)}>
            <option value="">Semua tenant (global)</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                Tenant {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="flag-state">Status</Label>
          <select id="flag-state" className={selectClass} value={enabled} onChange={(e) => setEnabled(e.target.value)}>
            <option value="on">Nyalakan</option>
            <option value="off">Matikan</option>
          </select>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="flag-reason">Alasan (wajib)</Label>
        <Textarea
          id="flag-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Mis. prasyarat gerbang Tahap 3 terpenuhi, berita acara UAT tanggal …"
          rows={2}
        />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div>
        <Button type="submit" disabled={pending || !key}>
          {pending ? "Menyimpan…" : "Simpan perubahan fitur"}
        </Button>
      </div>
    </form>
  );
}
