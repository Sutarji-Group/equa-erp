"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { M11ActionState } from "./action-state";

/**
 * Formulir Server Action layar Akuntansi: galat layanan berbahasa Indonesia tampil apa adanya, toast saat berhasil,
 * pratinjau impor (bagan akun/aset) ditampilkan sebagai tabel, dan pindah halaman bila aksi mengembalikan `redirectTo`.
 * Tetap berfungsi tanpa JavaScript (form action).
 */
export function M11ActionForm({
  action,
  children,
  submitLabel = "Simpan",
  variant = "default",
  className,
  testId,
  resetOnSuccess = true,
  extraButtons,
}: {
  action: (state: M11ActionState, formData: FormData) => Promise<M11ActionState>;
  children?: ReactNode;
  submitLabel?: string;
  variant?: "default" | "outline" | "destructive" | "secondary";
  className?: string;
  testId?: string;
  resetOnSuccess?: boolean;
  /** Tombol kirim tambahan (mis. `name="mode" value="preview"`). */
  extraButtons?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, {} as M11ActionState);
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (!state.ok) return;
    if (state.message) toast.success(state.message);
    if (state.redirectTo) router.push(state.redirectTo);
    else if (resetOnSuccess && !state.preview) ref.current?.reset();
  }, [state, resetOnSuccess, router]);
  return (
    <form ref={ref} action={formAction} className={cn("grid gap-3", className)} data-testid={testId}>
      {children}
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
      {state.preview ? (
        <div className="overflow-x-auto rounded-md border" data-testid={testId ? `${testId}-pratinjau` : undefined}>
          <p className="border-b px-3 py-2 text-sm font-medium">{state.preview.summary}</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-3 py-1">Baris</th>
                <th className="px-3 py-1">Kode</th>
                <th className="px-3 py-1">Nama</th>
                <th className="px-3 py-1">Tindakan</th>
                <th className="px-3 py-1">Masalah</th>
              </tr>
            </thead>
            <tbody>
              {state.preview.rows.map((r) => (
                <tr key={`${r.line}-${r.code}`} className={r.errors.length ? "bg-destructive/5" : undefined}>
                  <td className="px-3 py-1">{r.line}</td>
                  <td className="px-3 py-1 font-mono">{r.code}</td>
                  <td className="px-3 py-1">{r.name}</td>
                  <td className="px-3 py-1">{r.action}</td>
                  <td className="px-3 py-1 text-destructive">{r.errors.join("; ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={variant} disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
          {submitLabel}
        </Button>
        {extraButtons}
      </div>
    </form>
  );
}
