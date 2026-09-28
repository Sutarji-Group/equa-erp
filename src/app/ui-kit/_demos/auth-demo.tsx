"use client";

import { useState } from "react";
import { toast } from "sonner";

import { DeviceActivationForm } from "@/components/auth/device-activation-form";
import { FieldPinLogin } from "@/components/auth/field-pin-login";
import { LoginForm } from "@/components/auth/login-form";
import { TotpEnrollCard } from "@/components/auth/totp-enroll-card";
import { TotpForm } from "@/components/auth/totp-form";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function AuthDemo() {
  const [lockedUntil, setLockedUntil] = useState<Date | null>(null);
  return (
    <div className="grid gap-10">
      <section className="grid justify-items-center gap-6 lg:grid-cols-2 lg:items-start">
        <LoginForm
          onSubmit={async (v) => {
            await wait(500);
            if (v.password !== "rahasia-demo") return { error: "Nama pengguna atau kata sandi salah. Periksa lalu coba lagi." };
            toast.success(`Masuk sebagai ${v.username}`);
          }}
          footer='Demo: kata sandi "rahasia-demo".'
        />
        <TotpForm
          userName="Pengguna Demo"
          onSubmit={async (code) => {
            await wait(400);
            if (code !== "123456") throw new Error("Kode tidak cocok. Periksa jam ponsel lalu coba lagi. (Demo: 123456)");
            toast.success("Verifikasi berhasil");
          }}
          onCancel={() => toast("Kembali ke halaman masuk")}
        />
        <TotpEnrollCard
          otpauthUrl="otpauth://totp/EQUA:demo?secret=JBSWY3DPEHPK3PXP&issuer=EQUA"
          secret="JBSWY3DPEHPK3PXP"
          onVerify={async (code) => {
            await wait(400);
            if (code !== "123456") throw new Error("Kode tidak cocok. (Demo: 123456)");
            toast.success("2FA aktif");
          }}
        />
      </section>
      <section data-theme="field" className="grid gap-10 rounded-xl border p-6 lg:grid-cols-2">
        <DeviceActivationForm
          onSubmit={async (code) => {
            await wait(500);
            if (code !== "ABCD1234") throw new Error("Kode tidak dikenal atau kedaluwarsa. Minta kode baru ke admin sistem. (Demo: ABCD-1234)");
            toast.success("Perangkat aktif");
          }}
        />
        <FieldPinLogin
          deviceLabel="Perangkat truk F 8123 AB"
          users={[
            { id: "u1", name: "Budi Santoso", roleLabel: "Sopir" },
            { id: "u2", name: "Asep Hidayat", roleLabel: "Kernet" },
          ]}
          lockedUntil={lockedUntil}
          onLogin={async (_userId, pin) => {
            await wait(200);
            if (pin === "000000") {
              setLockedUntil(new Date(Date.now() + 15 * 60_000));
              return;
            }
            if (pin !== "123456") throw new Error("PIN salah. Sisa 4 kali percobaan. (Demo: 123456; 000000 = terkunci)");
            toast.success("Masuk");
          }}
        />
      </section>
    </div>
  );
}
