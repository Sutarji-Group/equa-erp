"use client";

import Link from "next/link";

import { ChangePasswordForm } from "@/components/auth/change-password-form";

import { changePasswordAction } from "./actions";

/** Formulir ubah kata sandi yang memanggil Server Action (galat server tampil sebagai pesan tindakan). */
export function ChangePasswordClient({ forced, username, home }: { forced: boolean; username: string; home: string }) {
  return (
    <ChangePasswordForm
      forced={forced}
      username={username}
      onSubmit={async (values) => {
        const result = await changePasswordAction(values);
        return result ? { error: result.error, field: result.field } : undefined;
      }}
      footer={
        forced ? (
          "Setelah diganti, sesi di perangkat lain diputus dan harus masuk lagi."
        ) : (
          <>
            Setelah diganti, sesi di perangkat lain diputus.{" "}
            <Link href={home} className="text-primary underline">
              Kembali
            </Link>
          </>
        )
      }
    />
  );
}
