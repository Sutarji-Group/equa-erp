"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { LoaderCircle, ShieldOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import { FieldPinLogin } from "@/components/auth/field-pin-login";
import { LockScreen } from "@/components/auth/lock-screen";
import { PinEnrollForm } from "@/components/auth/pin-enroll-form";
import { BigButton } from "@/components/field/big-button";
import {
  DEFAULT_POLICY,
  enrollWithCode,
  fieldDb,
  forgetDevice,
  isScreenLocked,
  knownUsers,
  lastActivityAt,
  lockScreen,
  loginWithPin,
  refreshDeviceUsers,
  setWipeHandler,
  startSyncWorker,
  switchUser,
  touchActivity,
  unlockScreen,
  type CredentialItem,
  type DeviceItem,
  type FieldHome,
  type KnownUser,
  type PublicDevice,
} from "@/client/offline";
import { useOnline, useSyncStatus, type SyncStatus } from "@/client/offline/hooks";

export type FieldSession = {
  user: { id: string; name: string; roleLabel: string; roles: string[]; employeeId: string };
  device: PublicDevice;
  sync: SyncStatus;
  /** Aplikasi perlu diperbarui (versi < `app.min_supported_version`, NFR-32). */
  updateRequired: boolean;
  lock: () => void;
  switchUser: () => void;
};

const FieldSessionContext = createContext<FieldSession | null>(null);

/** Sesi lapangan aktif (hanya di dalam `<FieldGate>`). */
export function useFieldSession(): FieldSession {
  const ctx = useContext(FieldSessionContext);
  if (!ctx) throw new Error("useFieldSession harus dipakai di dalam <FieldGate>.");
  return ctx;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 p-6">{children}</div>;
}

function Loading({ text = "Memuat aplikasi…" }: { text?: string }) {
  return (
    <Centered>
      <LoaderCircle className="size-10 animate-spin text-primary" aria-hidden />
      <p className="text-lg">{text}</p>
    </Centered>
  );
}

type Snapshot = {
  device: DeviceItem | null;
  activeUserId: string | null;
  locked: boolean;
  credential: CredentialItem | null;
};

/**
 * Gerbang aplikasi lapangan: perangkat wajib teraktivasi (→ /aktivasi-perangkat), perangkat diarahkan ke berandanya
 * (truk → /sopir, outlet → /pos, sumber air → /produksi), login PIN (online/offline) atau aktivasi akun baru, kunci
 * layar otomatis setelah PAR-37 menit tidak aktif, worker sinkron, dan perintah hapus jarak jauh.
 */
export function FieldGate({ home, children }: { home: FieldHome; children: ReactNode }) {
  const router = useRouter();
  const online = useOnline();
  const [mode, setMode] = useState<"login" | "enroll">("login");
  const [users, setUsers] = useState<KnownUser[]>([]);

  const snap = useLiveQuery<Snapshot | undefined>(async () => {
    const db = fieldDb();
    const device = (await db.device.get("device")) ?? null;
    const activeUserId = ((await db.meta.get("activeUserId"))?.value as string | null | undefined) ?? null;
    const locked = await isScreenLocked();
    const credential = activeUserId ? ((await db.credentials.get(activeUserId)) ?? null) : null;
    return { device, activeUserId, locked, credential };
  }, []);
  const sync = useSyncStatus(snap?.activeUserId ?? null);

  const device = snap?.device ?? null;
  const idleMinutes = device?.params?.screenLockMinutes ?? snap?.credential?.policy.idleMinutes ?? DEFAULT_POLICY.idleMinutes;

  // Perangkat belum aktif / salah beranda.
  useEffect(() => {
    if (snap === undefined) return;
    if (!snap.device) router.replace("/aktivasi-perangkat");
    else if (snap.device.device.home !== home) router.replace(snap.device.device.home);
  }, [snap, home, router]);

  // Worker sinkron + perintah hapus jarak jauh.
  useEffect(() => {
    if (!device) return;
    setWipeHandler(() => window.location.replace("/aktivasi-perangkat?dihapus=1"));
    const stop = startSyncWorker();
    return () => {
      stop();
      setWipeHandler(null);
    };
  }, [device]);

  // Daftar pengguna di layar PIN (daftar tersimpan + perbarui saat daring).
  const needLogin = !!device && !snap?.activeUserId;
  useEffect(() => {
    if (!needLogin) return;
    let cancelled = false;
    void knownUsers().then((list) => !cancelled && setUsers(list));
    if (online) {
      refreshDeviceUsers()
        .then(() => knownUsers())
        .then((list) => !cancelled && setUsers(list))
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [needLogin, online]);

  // Kunci layar otomatis (PAR-37).
  const readyUser = !!snap?.activeUserId && !snap.locked;
  useEffect(() => {
    if (!readyUser) return;
    let last = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - last > 15_000) {
        last = now;
        void touchActivity(now);
      }
    };
    const check = async () => {
      const at = await lastActivityAt();
      if (at && Date.now() - at > idleMinutes * 60_000) await lockScreen();
    };
    void check();
    const timer = setInterval(() => void check(), 30_000);
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, [readyUser, idleMinutes]);

  const session = useMemo<FieldSession | null>(() => {
    if (!device || !snap?.credential || snap.locked) return null;
    const c = snap.credential;
    return {
      user: { id: c.userId, name: c.name, roleLabel: c.roleLabel, roles: c.roles, employeeId: c.employeeId },
      device: device.device,
      sync,
      updateRequired: !!device.updateRequired,
      lock: () => void lockScreen(),
      switchUser: () => void switchUser(),
    };
  }, [device, snap, sync]);

  if (snap === undefined || !device || device.device.home !== home) return <Loading />;

  if (device.device.status === "blocked") {
    return (
      <Centered>
        <ShieldOff className="size-12 text-destructive" aria-hidden />
        <h1 className="text-2xl font-bold">Perangkat diblokir</h1>
        <p className="max-w-sm text-center text-lg">
          Admin sistem memblokir perangkat ini. Aplikasi tidak dapat dipakai. Hubungi admin sistem; data yang belum terkirim tetap
          tersimpan.
        </p>
      </Centered>
    );
  }
  if (device.device.status === "inactive") {
    return (
      <Centered>
        <h1 className="text-2xl font-bold">Perangkat perlu diaktifkan ulang</h1>
        <p className="max-w-sm text-center text-lg">
          Admin sistem menerbitkan kode aktivasi baru untuk perangkat ini. Data yang belum terkirim tetap tersimpan dan dikirim
          setelah aktivasi ulang serta masuk dengan PIN.
        </p>
        <div className="w-full max-w-sm">
          <BigButton
            onClick={async () => {
              await forgetDevice();
              router.replace("/aktivasi-perangkat");
            }}
          >
            Masukkan kode aktivasi baru
          </BigButton>
        </div>
      </Centered>
    );
  }

  if (!snap.activeUserId || !snap.credential) {
    if (mode === "enroll") {
      return (
        <Centered>
          <PinEnrollForm
            onCancel={() => setMode("login")}
            onSubmit={async (code, pin) => {
              await enrollWithCode(code, pin);
              setMode("login");
            }}
          />
        </Centered>
      );
    }
    return (
      <Centered>
        <FieldPinLogin
          users={users.map((u) => ({ id: u.id, name: u.name, roleLabel: u.roleLabel }))}
          deviceLabel={[device.device.name, device.device.unitLabel].filter(Boolean).join(" · ")}
          onLogin={async (userId, pin) => {
            await loginWithPin(userId, pin);
          }}
          footer={
            <button
              type="button"
              onClick={() => setMode("enroll")}
              className="min-h-12 w-full rounded-xl px-4 text-base font-semibold text-primary underline-offset-4 hover:underline"
            >
              Pengguna baru? Aktifkan akun dengan kode dari admin sistem
            </button>
          }
        />
      </Centered>
    );
  }

  if (snap.locked) {
    return (
      <LockScreen
        userName={snap.credential.name}
        pendingCount={sync.pendingCount}
        onUnlock={async (pin) => {
          await unlockScreen(pin);
        }}
        onSwitchUser={() => void switchUser()}
      />
    );
  }

  return <FieldSessionContext.Provider value={session}>{children}</FieldSessionContext.Provider>;
}
