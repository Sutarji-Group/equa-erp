"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { DeviceActivationForm } from "@/components/auth/device-activation-form";
import { activateWithCode, fieldDb } from "@/client/offline";

/**
 * Aktivasi perangkat lapangan/POS dengan kode 8 karakter dari admin sistem (US-M10-02 KP-1). Perangkat yang sudah
 * aktif langsung diarahkan ke berandanya (truk → /sopir, outlet → /pos, sumber air → /produksi).
 */
export default function AktivasiPerangkatPage() {
  const router = useRouter();
  const [wiped, setWiped] = useState(false);
  const device = useLiveQuery(async () => (await fieldDb().device.get("device")) ?? null, [], undefined);

  useEffect(() => {
    const flag = new URLSearchParams(window.location.search).get("dihapus") === "1";
    const t = setTimeout(() => setWiped(flag), 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (device) router.replace(device.device.home);
  }, [device, router]);

  if (device === undefined || device) {
    return (
      <main className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 p-6">
        <LoaderCircle className="size-10 animate-spin text-primary" aria-hidden />
        <p className="text-lg">Memuat…</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh flex-1 flex-col justify-center gap-6 p-6">
      {wiped ? (
        <p role="alert" className="mx-auto w-full max-w-sm rounded-xl border-2 border-warning bg-warning/15 p-4 text-base">
          Data aplikasi di perangkat ini telah dihapus atas perintah admin sistem. Hubungi admin sistem untuk mengaktifkan ulang.
        </p>
      ) : null}
      <DeviceActivationForm
        onSubmit={async (code) => {
          const dev = await activateWithCode(code);
          router.replace(dev.device.home);
        }}
      />
    </main>
  );
}
