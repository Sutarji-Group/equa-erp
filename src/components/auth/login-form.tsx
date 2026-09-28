"use client";

import { Eye, EyeOff } from "lucide-react";
import { type ReactNode, useState } from "react";
import { z } from "zod";

import { FormFieldText, FormRootError, FormSubmitButton, useZodForm } from "@/components/shared/form-fields";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";

export const loginFormSchema = z.object({
  username: z.string().trim().min(1, { error: "Isi nama pengguna." }),
  password: z.string().min(1, { error: "Isi kata sandi." }),
});

export type LoginFormValues = z.output<typeof loginFormSchema>;

export type LoginFormProps = {
  /** Kirim kredensial. Lempar `Error(pesan)` atau kembalikan `{ error }` untuk menampilkan pesan. */
  onSubmit: (values: LoginFormValues) => void | { error?: string } | Promise<void | { error?: string }>;
  /** Pesan galat dari server (mis. "Nama pengguna atau kata sandi salah."). */
  error?: ReactNode;
  defaultUsername?: string;
  /** Catatan di bawah formulir. */
  footer?: ReactNode;
};

/** Formulir masuk web kantor (nama pengguna + kata sandi). Presentasional: autentikasi di `onSubmit`. */
export function LoginForm({ onSubmit, error, defaultUsername = "", footer }: LoginFormProps) {
  const [showPassword, setShowPassword] = useState(false);
  const form = useZodForm(loginFormSchema, { defaultValues: { username: defaultUsername, password: "" } });

  async function submit(values: LoginFormValues) {
    try {
      const result = await onSubmit(values);
      if (result && result.error) form.setError("root", { message: result.error });
    } catch (err) {
      form.setError("root", { message: err instanceof Error && err.message ? err.message : "Gagal masuk. Coba lagi." });
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-2xl">Masuk</CardTitle>
        <CardDescription>Program Digitalisasi Terpadu EQUA</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="grid gap-4" noValidate>
            {error ? (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <FormRootError control={form.control} />
            <FormFieldText control={form.control} name="username" label="Nama pengguna" autoComplete="username" autoFocus />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Kata sandi</FormLabel>
                  <div className="relative">
                    <FormControl>
                      <Input {...field} type={showPassword ? "text" : "password"} autoComplete="current-password" className="pr-10" />
                    </FormControl>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="absolute top-0.5 right-0.5"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? "Sembunyikan kata sandi" : "Tampilkan kata sandi"}
                      aria-pressed={showPassword}
                    >
                      {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                    </Button>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormSubmitButton control={form.control} className="w-full" pendingLabel="Memeriksa…">
              Masuk
            </FormSubmitButton>
          </form>
        </Form>
      </CardContent>
      <CardFooter>
        <p className="text-sm text-muted-foreground">
          {footer ?? "Lupa kata sandi atau belum punya akun? Hubungi admin sistem."}
        </p>
      </CardFooter>
    </Card>
  );
}
