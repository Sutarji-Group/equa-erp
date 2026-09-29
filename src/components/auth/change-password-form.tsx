"use client";

import { type ReactNode } from "react";
import { z } from "zod";

import { FormFieldText, FormRootError, FormSubmitButton, useZodForm } from "@/components/shared/form-fields";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Form } from "@/components/ui/form";

/** Aturan klien (server memeriksa ulang: kata sandi saat ini, beda dari lama & nama pengguna). */
export const changePasswordFormSchema = z
  .object({
    currentPassword: z.string().min(1, { error: "Isi kata sandi saat ini." }),
    newPassword: z.string().min(10, { error: "Kata sandi baru minimal 10 karakter." }).max(200, { error: "Kata sandi terlalu panjang (maksimal 200 karakter)." }),
    confirmPassword: z.string().min(1, { error: "Ketik ulang kata sandi baru." }),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { error: "Konfirmasi kata sandi baru tidak sama. Ketik ulang.", path: ["confirmPassword"] })
  .refine((v) => v.newPassword !== v.currentPassword, { error: "Kata sandi baru harus berbeda dari kata sandi saat ini.", path: ["newPassword"] });

export type ChangePasswordFormValues = z.output<typeof changePasswordFormSchema>;

export type ChangePasswordFormProps = {
  onSubmit: (values: ChangePasswordFormValues) => Promise<void | { error?: string; field?: keyof ChangePasswordFormValues }>;
  /** Kata sandi sementara hasil reset → wajib diganti sebelum memakai aplikasi. */
  forced?: boolean;
  username?: string;
  footer?: ReactNode;
};

/** Formulir ubah kata sandi mandiri (web kantor & portal mitra; B-08). */
export function ChangePasswordForm({ onSubmit, forced, username, footer }: ChangePasswordFormProps) {
  const form = useZodForm(changePasswordFormSchema, { defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" } });

  async function submit(values: ChangePasswordFormValues) {
    try {
      const result = await onSubmit(values);
      if (result?.error) form.setError(result.field ?? "root", { message: result.error });
    } catch (err) {
      form.setError("root", { message: err instanceof Error && err.message ? err.message : "Kata sandi gagal diubah. Coba lagi." });
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-2xl">Ubah kata sandi</CardTitle>
        <CardDescription>{username ? `Akun ${username}` : "Program Digitalisasi Terpadu EQUA"}</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="grid gap-4" noValidate>
            {forced ? (
              <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm" data-testid="wajib-ganti-sandi">
                Anda masuk dengan kata sandi sementara dari admin sistem. Buat kata sandi baru dulu sebelum melanjutkan.
              </p>
            ) : null}
            <FormRootError control={form.control} />
            <FormFieldText control={form.control} name="currentPassword" label={forced ? "Kata sandi sementara" : "Kata sandi saat ini"} type="password" autoComplete="current-password" autoFocus />
            <FormFieldText control={form.control} name="newPassword" label="Kata sandi baru" type="password" autoComplete="new-password" description="Minimal 10 karakter; jangan sama dengan nama pengguna." />
            <FormFieldText control={form.control} name="confirmPassword" label="Ulangi kata sandi baru" type="password" autoComplete="new-password" />
            <FormSubmitButton control={form.control} className="w-full" pendingLabel="Menyimpan…">
              Simpan kata sandi baru
            </FormSubmitButton>
          </form>
        </Form>
      </CardContent>
      <CardFooter>
        <p className="text-sm text-muted-foreground">{footer ?? "Setelah diganti, sesi di perangkat lain diputus dan harus masuk lagi."}</p>
      </CardFooter>
    </Card>
  );
}
