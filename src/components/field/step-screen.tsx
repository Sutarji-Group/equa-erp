import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Batas langkah per tindakan lapangan (PRD 2.1: maksimal 3 langkah). */
export const MAX_FIELD_STEPS = 3;

export type StepScreenProps = {
  /** Label langkah (≤ 3), mis. `["Foto", "Penerima", "Bayar"]`. */
  steps: readonly string[];
  /** Indeks langkah aktif (mulai 0). */
  current: number;
  /** Judul langkah aktif, mis. "Foto bukti kirim". */
  title: ReactNode;
  /** Penjelasan singkat langkah. */
  description?: ReactNode;
  children: ReactNode;
  /** Tombol aksi langkah (BigButton "Lanjut"/"Simpan"). */
  actions?: ReactNode;
  className?: string;
};

/**
 * Pola layar bertahap lapangan (≤ 3 langkah) dengan indikator "Langkah n dari m". Navigasi (lanjut/kembali) diatur
 * pemanggil lewat `current` dan `actions`.
 */
export function StepScreen({ steps, current, title, description, children, actions, className }: StepScreenProps) {
  if (process.env.NODE_ENV !== "production" && steps.length > MAX_FIELD_STEPS) {
    console.warn(`StepScreen: ${steps.length} langkah melebihi batas ${MAX_FIELD_STEPS} langkah per tindakan (PRD 2.1).`);
  }
  const index = Math.min(Math.max(current, 0), steps.length - 1);
  return (
    <section data-slot="step-screen" className={cn("flex flex-1 flex-col gap-5", className)} aria-labelledby="step-title">
      <div className="space-y-3">
        <p className="text-base font-semibold text-muted-foreground">
          Langkah {index + 1} dari {steps.length}
        </p>
        <ol className="flex items-center gap-2" aria-label="Indikator langkah">
          {steps.map((label, i) => {
            const done = i < index;
            const active = i === index;
            return (
              <li key={label} className="flex min-w-0 flex-1 flex-col gap-1.5" aria-current={active ? "step" : undefined}>
                <span
                  className={cn(
                    "h-2 rounded-full",
                    done ? "bg-success" : active ? "bg-primary" : "bg-muted-foreground/25",
                  )}
                />
                <span
                  className={cn(
                    "flex items-center gap-1 truncate text-sm",
                    active ? "font-bold text-foreground" : "text-muted-foreground",
                  )}
                >
                  {done ? <Check className="size-4 shrink-0 text-success" aria-hidden /> : null}
                  {label}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="space-y-1">
        <h2 id="step-title" className="text-2xl font-bold">
          {title}
        </h2>
        {description ? <p className="text-base text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex flex-1 flex-col gap-4">{children}</div>
      {actions ? <div className="flex flex-col gap-3">{actions}</div> : null}
    </section>
  );
}
