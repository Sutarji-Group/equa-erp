"use client";

import { Lock } from "lucide-react";
import { type ReactNode, useState } from "react";

import { PinPad } from "@/components/field/pin-pad";

import { lockedMessage } from "./field-pin-login";

export type LockScreenProps = {
  userName: string;
  /** Buka kunci dengan PIN. Lempar `Error(pesan)` bila salah. */
  onUnlock: (pin: string) => void | Promise<void>;
  /** Ganti pengguna (antrean pengguna ini TIDAK dihapus, Bab 6.5). */
  onSwitchUser?: () => void;
  error?: ReactNode;
  lockedUntil?: Date | string | null;
  /** Jumlah data belum terkirim (menenangkan: data aman). */
  pendingCount?: number;
};

/**
 * Layar terkunci aplikasi lapangan/POS (otomatis setelah 10 menit tidak aktif, PAR-37). Data & antrean tetap utuh;
 * buka dengan PIN.
 */
export function LockScreen({ userName, onUnlock, onSwitchUser, error, lockedUntil, pendingCount = 0 }: LockScreenProps) {
  const [pinError, setPinError] = useState<string | null>(null);
  const locked = !!lockedUntil;
  return (
    <div role="dialog" aria-modal="true" aria-label="Layar terkunci" className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background p-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex size-16 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Lock className="size-8" aria-hidden />
        </span>
        <p className="text-base text-muted-foreground">Layar terkunci</p>
        {pendingCount > 0 ? (
          <p className="text-base font-medium">{pendingCount} data tersimpan aman di ponsel dan akan terkirim otomatis.</p>
        ) : null}
      </div>
      <PinPad
        title={userName}
        description={locked ? undefined : "Masukkan PIN untuk membuka."}
        error={locked && lockedUntil ? lockedMessage(lockedUntil) : (pinError ?? error)}
        disabled={locked}
        onComplete={async (pin) => {
          setPinError(null);
          try {
            await onUnlock(pin);
          } catch (err) {
            setPinError(err instanceof Error && err.message ? err.message : "PIN salah. Coba lagi.");
          }
        }}
      />
      {onSwitchUser ? (
        <button
          type="button"
          onClick={onSwitchUser}
          className="min-h-12 rounded-xl px-4 text-base font-semibold text-primary underline-offset-4 hover:underline"
        >
          Bukan {userName}? Ganti pengguna
        </button>
      ) : null}
    </div>
  );
}
