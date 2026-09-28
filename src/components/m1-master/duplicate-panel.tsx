import Link from "next/link";

import type { ActionState } from "./action-state";

/** Daftar kandidat duplikat + konfirmasi (US-M1-01 KP-7: memperingatkan, tidak memblokir). */
export function DuplicatePanel({ state }: { state: ActionState }) {
  if (!state.duplicates?.length) return null;
  return (
    <div className="grid gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
      <p className="font-medium">Kandidat duplikat</p>
      <ul className="grid gap-1">
        {state.duplicates.map((d) => (
          <li key={d.customerId}>
            <Link href={`/master/pelanggan/${d.customerId}`} className="text-primary underline-offset-4 hover:underline" target="_blank">
              {d.name}
            </Link>{" "}
            <span className="text-muted-foreground">
              ({d.code ?? "tanpa kode"}
              {d.isActive ? "" : ", nonaktif"}) — {d.reasonText}
            </span>
          </li>
        ))}
      </ul>
      <label className="flex items-start gap-2">
        <input type="checkbox" name="confirmDuplicate" className="mt-0.5 size-4 accent-primary" />
        <span>Saya sudah memeriksa — ini pelanggan berbeda, tetap simpan.</span>
      </label>
      <input name="duplicateNote" placeholder="Catatan (opsional), mis. satu pemilik dua usaha" className="h-9 rounded-md border border-input bg-transparent px-3 text-sm" />
    </div>
  );
}
