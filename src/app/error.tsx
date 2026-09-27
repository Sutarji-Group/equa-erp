"use client";

import { Button } from "@/components/ui/button";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">Terjadi kesalahan</h1>
      <p className="max-w-md text-muted-foreground">
        Halaman ini gagal dimuat. Coba lagi; bila masih gagal, periksa koneksi internet atau hubungi admin sistem.
      </p>
      <Button onClick={() => reset()}>Coba lagi</Button>
    </main>
  );
}
