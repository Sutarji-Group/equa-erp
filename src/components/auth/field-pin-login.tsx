"use client";

import { ArrowLeft, UserRound } from "lucide-react";
import { type ReactNode, useState } from "react";

import { PinPad } from "@/components/field/pin-pad";
import { formatJam } from "@/lib/time";

export type DeviceUser = {
  id: string;
  name: string;
  /** Mis. "Sopir", "Kernet". */
  roleLabel?: string;
};

export type FieldPinLoginProps = {
  /** Pengguna yang pernah aktif di perangkat ini. */
  users: readonly DeviceUser[];
  /** Verifikasi PIN (offline via verifier). Lempar `Error(pesan)` bila salah, mis. "PIN salah. Sisa 3 kali". */
  onLogin: (userId: string, pin: string) => void | Promise<void>;
  /** Pesan galat dari luar. */
  error?: ReactNode;
  /** Pengguna terkunci sampai waktu ini (5 kali salah → 15 menit, PAR-36). */
  lockedUntil?: Date | string | null;
  /** Label perangkat, mis. "Perangkat truk F 1234 AB". */
  deviceLabel?: string;
  /** Tautan/aksi tambahan (mis. "Pengguna baru? Hubungi admin sistem"). */
  footer?: ReactNode;
};

/** Pesan terkunci. */
export function lockedMessage(lockedUntil: Date | string): string {
  return `Terlalu banyak PIN salah. Coba lagi pukul ${formatJam(lockedUntil)} atau hubungi admin sistem.`;
}

/**
 * Masuk aplikasi lapangan: pilih pengguna di perangkat (sopir/kernet bergantian) lalu PIN 6 digit.
 * Satu pengguna → langsung ke PIN.
 */
export function FieldPinLogin({ users, onLogin, error, lockedUntil, deviceLabel, footer }: FieldPinLoginProps) {
  const [selectedId, setSelectedId] = useState<string | null>(users.length === 1 ? users[0]!.id : null);
  const [pinError, setPinError] = useState<string | null>(null);
  const selected = users.find((u) => u.id === selectedId) ?? null;
  const locked = !!lockedUntil;

  if (!selected) {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Siapa yang memakai ponsel ini?</h1>
          {deviceLabel ? <p className="text-base text-muted-foreground">{deviceLabel}</p> : null}
        </div>
        {users.length === 0 ? (
          <p className="rounded-xl border-2 border-dashed p-4 text-center text-base text-muted-foreground">
            Belum ada pengguna di perangkat ini. Minta admin sistem mengaktifkan akun Anda.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {users.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(u.id);
                    setPinError(null);
                  }}
                  className="flex min-h-16 w-full items-center gap-3 rounded-xl border-2 bg-card p-4 text-left hover:bg-accent focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none"
                >
                  <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <UserRound className="size-6" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-lg font-semibold">{u.name}</span>
                    {u.roleLabel ? <span className="block text-base text-muted-foreground">{u.roleLabel}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {footer}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
      {users.length > 1 ? (
        <button
          type="button"
          onClick={() => {
            setSelectedId(null);
            setPinError(null);
          }}
          className="inline-flex min-h-12 items-center gap-2 self-start rounded-xl px-2 text-base font-semibold hover:bg-accent"
        >
          <ArrowLeft className="size-5" aria-hidden />
          Ganti pengguna
        </button>
      ) : null}
      <PinPad
        title={`Halo, ${selected.name}`}
        description={locked ? undefined : "Masukkan PIN 6 angka Anda."}
        error={locked && lockedUntil ? lockedMessage(lockedUntil) : (pinError ?? error)}
        disabled={locked}
        onComplete={async (pin) => {
          setPinError(null);
          try {
            await onLogin(selected.id, pin);
          } catch (err) {
            setPinError(err instanceof Error && err.message ? err.message : "PIN salah. Coba lagi.");
          }
        }}
      />
      {footer ? <div className="text-center">{footer}</div> : null}
    </div>
  );
}
