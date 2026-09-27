import type { Metadata } from "next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const metadata: Metadata = { title: "Masuk" };

/**
 * Placeholder Sprint 0 (F1). Alur masuk sebenarnya (kata sandi + TOTP 2FA, sesi DB) dibangun modul M10
 * (docs/ARCHITECTURE.md §6).
 */
export default function MasukPage() {
  return (
    <main className="flex flex-1 items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">EQUA</CardTitle>
          <CardDescription>Masuk ke Program Digitalisasi Terpadu EQUA.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" aria-describedby="masuk-catatan">
            <div className="grid gap-2">
              <Label htmlFor="username">Nama pengguna</Label>
              <Input id="username" name="username" autoComplete="username" required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Kata sandi</Label>
              <Input id="password" name="password" type="password" autoComplete="current-password" required />
            </div>
            <Button type="submit" className="w-full" disabled>
              Masuk
            </Button>
          </form>
        </CardContent>
        <CardFooter>
          <p id="masuk-catatan" className="text-sm text-muted-foreground">
            Halaman masuk sedang disiapkan. Hubungi admin sistem bila Anda belum memiliki akun.
          </p>
        </CardFooter>
      </Card>
    </main>
  );
}
