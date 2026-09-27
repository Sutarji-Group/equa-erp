import type { ReactNode } from "react";

/** Layout aplikasi lapangan: tema kontras tinggi (teks dasar 18px) untuk sopir, operator produksi, dan kasir POS. */
export default function FieldLayout({ children }: { children: ReactNode }) {
  return (
    <div data-theme="field" className="flex min-h-dvh flex-1 flex-col">
      {children}
    </div>
  );
}
