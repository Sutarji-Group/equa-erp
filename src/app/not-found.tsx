import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">Halaman tidak ditemukan</h1>
      <p className="max-w-md text-muted-foreground">
        Alamat yang Anda buka tidak ada atau sudah dipindahkan. Periksa kembali alamatnya atau kembali ke beranda.
      </p>
      <Button asChild>
        <Link href="/">Kembali ke beranda</Link>
      </Button>
    </main>
  );
}
