"use client";

/**
 * Ganti nomor WhatsApp (US-P2-01 KP-4): nomor baru → kode ke nomor LAMA → kode ke nomor BARU. Tanpa akses nomor lama
 * → lewat Dispatcher (kantor).
 */
import { LoaderCircle } from "lucide-react";
import { useActionState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import type { P2ActionState } from "./action-state";

type Act = (s: P2ActionState, fd: FormData) => Promise<P2ActionState>;

function DevCode({ state }: { state: P2ActionState }) {
  const code = typeof state.data?.devCode === "string" ? state.data.devCode : null;
  return code ? (
    <p className="rounded-md border border-dashed border-warning bg-warning/10 p-2 text-sm">
      Mode uji: kode <strong className="tabular">{code}</strong>
    </p>
  ) : null;
}

function Err({ state }: { state: P2ActionState }) {
  return state.error ? (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{state.error}</AlertDescription>
    </Alert>
  ) : null;
}

export function PhoneChange({ start, confirmOld, complete }: { start: Act; confirmOld: Act; complete: Act }) {
  const [s1, a1, p1] = useActionState(start, {} as P2ActionState);
  const [s2, a2, p2] = useActionState(confirmOld, {} as P2ActionState);
  const [s3, a3, p3] = useActionState(complete, {} as P2ActionState);
  if (s3.ok) {
    return (
      <p role="status" className="text-sm text-success">
        {s3.message}
      </p>
    );
  }
  return (
    <div className="grid gap-3 text-sm">
      <form action={a1} className="grid gap-2">
        <label className="grid gap-1 font-medium">
          Nomor WhatsApp baru
          <input name="newPhone" type="tel" inputMode="tel" required className="h-11 rounded-md border border-input bg-background px-3 text-base" />
        </label>
        <Err state={s1} />
        <Button type="submit" size="sm" variant="outline" disabled={p1} className="w-fit">
          {p1 ? <LoaderCircle className="animate-spin" aria-hidden /> : null}Kirim kode ke nomor lama
        </Button>
      </form>
      {s1.ok ? (
        <form action={a2} className="grid gap-2">
          <p>{s1.message}</p>
          <DevCode state={s1} />
          <input name="code" inputMode="numeric" required aria-label="Kode dari nomor lama" className="h-11 rounded-md border border-input bg-background px-3 text-base" />
          <Err state={s2} />
          <Button type="submit" size="sm" disabled={p2} className="w-fit">
            Verifikasi nomor lama
          </Button>
        </form>
      ) : null}
      {s2.ok ? (
        <form action={a3} className="grid gap-2">
          <p>{s2.message}</p>
          <DevCode state={s2} />
          <input name="code" inputMode="numeric" required aria-label="Kode dari nomor baru" className="h-11 rounded-md border border-input bg-background px-3 text-base" />
          <Err state={s3} />
          <Button type="submit" size="sm" disabled={p3} className="w-fit">
            Ganti nomor
          </Button>
        </form>
      ) : null}
      <p className="text-xs text-muted-foreground">Nomor lama sudah tidak aktif? Hubungi kantor EQUA — Dispatcher dapat mengganti nomor setelah memverifikasi Anda.</p>
    </div>
  );
}
