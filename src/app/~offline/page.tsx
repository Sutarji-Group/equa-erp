import type { Metadata } from "next";

export const metadata: Metadata = { title: "Tanpa sinyal", manifest: "/lapangan.webmanifest" };

/**
 * Halaman cadangan PWA saat halaman yang diminta belum tersimpan di perangkat dan sinyal tidak ada (service worker
 * `src/app/sw.ts`). Statis agar dapat di-precache.
 */
export default function OfflinePage() {
  return (
    <main data-theme="field" className="flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-bold">Tidak ada sinyal</h1>
      <p className="max-w-sm text-lg">
        Halaman ini belum tersimpan di ponsel. Data yang sudah Anda catat tetap aman dan terkirim otomatis saat sinyal
        kembali.
      </p>
      <p className="max-w-sm text-base text-muted-foreground">Buka kembali aplikasi dari beranda ponsel, atau coba lagi saat ada sinyal.</p>
      <a href="/aktivasi-perangkat" className="min-h-12 rounded-xl bg-primary px-6 py-3 text-lg font-semibold text-primary-foreground">
        Buka aplikasi lapangan
      </a>
    </main>
  );
}
