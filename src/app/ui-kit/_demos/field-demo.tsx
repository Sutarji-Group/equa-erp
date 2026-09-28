"use client";

import { CircleCheckBig, MessageSquareWarning, Navigation, Phone, Truck } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { LockScreen } from "@/components/auth/lock-screen";
import { AmountConfirm } from "@/components/field/amount-confirm";
import { BigButton } from "@/components/field/big-button";
import { FieldListItem } from "@/components/field/field-list-item";
import { FieldShell } from "@/components/field/field-shell";
import { type CapturedPhoto, PhotoCapture } from "@/components/field/photo-capture";
import { SignaturePad, type SignaturePadHandle } from "@/components/field/signature-pad";
import { StepScreen } from "@/components/field/step-screen";
import { LiterText } from "@/components/shared/money-text";
import { StatusBadge, ToneBadge } from "@/components/shared/status-badge";

import { DEMO_TRIPS, demoAgo } from "./sample-data";

type Screen = "list" | "detail" | "complete";

export function FieldDemo() {
  const [screen, setScreen] = useState<Screen>("list");
  const [locked, setLocked] = useState(false);
  const [pending, setPending] = useState(2);
  const [syncing, setSyncing] = useState(false);
  const [step, setStep] = useState(0);
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [signed, setSigned] = useState(false);
  const [receiver, setReceiver] = useState("Pak Ahmad");
  const signatureRef = useRef<SignaturePadHandle>(null);

  if (locked) {
    return (
      <LockScreen
        userName="Budi Santoso"
        pendingCount={pending}
        onUnlock={(pin) => {
          if (pin !== "123456") throw new Error("PIN salah. Sisa 4 kali percobaan. (PIN demo: 123456)");
          setLocked(false);
        }}
        onSwitchUser={() => toast("Ganti pengguna (demo)")}
      />
    );
  }

  function syncNow() {
    setSyncing(true);
    setTimeout(() => {
      setSyncing(false);
      setPending(0);
      toast.success("Semua data terkirim.");
    }, 1200);
  }

  const shellProps = {
    userName: "Budi Santoso",
    roleLabel: "Sopir",
    unitLabel: "F 8123 AB",
    pendingCount: pending,
    syncing,
    lastSyncedAt: demoAgo(3),
    onSyncNow: syncNow,
    onLock: () => setLocked(true),
  };

  if (screen === "complete") {
    const steps = ["Foto", "Penerima", "Bayar"];
    return (
      <FieldShell {...shellProps} title="Selesaikan rit" onBack={() => (step > 0 ? setStep(step - 1) : setScreen("detail"))}>
        {step === 0 ? (
          <StepScreen
            steps={steps}
            current={0}
            title="Foto bukti kirim"
            description="Ambil foto tangki/meteran dari kamera."
            actions={
              <BigButton disabled={!photo} onClick={() => setStep(1)}>
                Lanjut
              </BigButton>
            }
          >
            <PhotoCapture label="Ambil foto bukti kirim" onCapture={setPhoto} onClear={() => setPhoto(null)} />
          </StepScreen>
        ) : step === 1 ? (
          <StepScreen
            steps={steps}
            current={1}
            title="Penerima"
            description="Nama dan tanda tangan penerima."
            actions={
              <BigButton disabled={receiver.trim().length < 2 || !signed} onClick={() => setStep(2)}>
                Lanjut
              </BigButton>
            }
          >
            <label className="flex flex-col gap-2 text-lg font-semibold">
              Nama penerima
              <input
                value={receiver}
                onChange={(e) => setReceiver(e.target.value)}
                className="min-h-14 rounded-xl border-2 border-input bg-background px-4 text-lg font-normal focus-visible:ring-4 focus-visible:ring-ring/60 focus-visible:outline-none"
              />
            </label>
            <SignaturePad ref={signatureRef} onChange={(empty) => setSigned(!empty)} />
          </StepScreen>
        ) : (
          <StepScreen steps={steps} current={2} title="Pembayaran tunai" description="Harga dari pesanan; tidak dapat diubah.">
            <AmountConfirm
              label="Uang tunai diterima"
              expected={225_000}
              max={225_000}
              maxMessage="Jumlah lebih besar tidak dapat dicatat. Berikan kembalian di lapangan."
              reasons={[
                { code: "customer_short", label: "Uang pelanggan kurang" },
                { code: "customer_dispute", label: "Pelanggan keberatan harga" },
              ]}
              onConfirm={async (r) => {
                const png = await signatureRef.current?.toBlob();
                setPending((p) => p + 1);
                toast.success(`Rit selesai · ${r.amount.toLocaleString("id-ID")}${r.changed ? ` (alasan: ${r.reason})` : ""}`, {
                  description: `Foto ${photo ? Math.round(photo.sizeBytes / 1024) : 0} KB · tanda tangan ${png ? Math.round(png.size / 1024) : 0} KB · tersimpan di ponsel`,
                });
                setScreen("list");
                setStep(0);
                setPhoto(null);
                setSigned(false);
              }}
            />
          </StepScreen>
        )}
      </FieldShell>
    );
  }

  if (screen === "detail") {
    const trip = DEMO_TRIPS[1]!;
    return (
      <FieldShell
        {...shellProps}
        title={trip.number}
        onBack={() => setScreen("list")}
        footer={
          <div className="flex flex-col gap-3">
            <BigButton variant="success" size="xl" icon={<CircleCheckBig aria-hidden />} onClick={() => setScreen("complete")}>
              Selesai
            </BigButton>
            <BigButton variant="danger" icon={<MessageSquareWarning aria-hidden />} onClick={() => toast("Rit gagal (demo)")}>
              Rit gagal
            </BigButton>
          </div>
        }
      >
        <div className="rounded-xl border-2 p-4">
          <p className="text-xl font-bold">{trip.customer}</p>
          <p className="text-base text-muted-foreground">{trip.address}</p>
          <p className="mt-2 text-lg font-semibold">
            <LiterText value={trip.volumeL} /> · {trip.payment} · jam {trip.time}
          </p>
          <div className="mt-3 rounded-lg bg-warning/25 p-3 text-base">
            <strong>Catatan khusus:</strong> Gerbang belakang, terima jam 08.00–16.00.
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <BigButton variant="secondary" icon={<Navigation aria-hidden />}>
            Navigasi
          </BigButton>
          <BigButton variant="secondary" icon={<Phone aria-hidden />}>
            Telepon
          </BigButton>
        </div>
        <OfflineToggleHint />
      </FieldShell>
    );
  }

  return (
    <FieldShell {...shellProps} title="Rit hari ini">
      <div className="flex flex-col gap-3">
        {DEMO_TRIPS.map((t) => (
          <FieldListItem
            key={t.id}
            leading={t.seq}
            title={t.customer}
            subtitle={t.address}
            meta={
              <>
                <LiterText value={t.volumeL} /> · {t.payment} · jam {t.time}
              </>
            }
            status={<StatusBadge enumName="trip_status" value={t.status} className="text-sm" />}
            highlight={t.status === "departed"}
            muted={t.status === "completed"}
            flags={t.note ? <ToneBadge tone="warning">Catatan khusus</ToneBadge> : undefined}
            onClick={() => setScreen("detail")}
          />
        ))}
      </div>
      <BigButton variant="outline" icon={<Truck aria-hidden />} onClick={() => toast("Setor (demo)")}>
        Setor hari ini
      </BigButton>
    </FieldShell>
  );
}

function OfflineToggleHint() {
  return (
    <p className="text-base text-muted-foreground">
      Coba mode pesawat / DevTools &quot;Offline&quot;: pita kuning muncul dan aksi tetap berjalan.
    </p>
  );
}
