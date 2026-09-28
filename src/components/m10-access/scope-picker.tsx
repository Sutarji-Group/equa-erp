import type { ScopeOption } from "@/server/modules/m10-access";

type Groups = { trucks: ScopeOption[]; depots: ScopeOption[]; stores: ScopeOption[]; sources: ScopeOption[] };

const GROUPS: { key: keyof Groups; title: string; hint: string }[] = [
  { key: "trucks", title: "Truk", hint: "Sopir/Kernet" },
  { key: "depots", title: "Depot", hint: "Operator depot" },
  { key: "stores", title: "Toko", hint: "Kasir toko" },
  { key: "sources", title: "Sumber air", hint: "Operator produksi" },
];

/**
 * Pilihan unit lingkup (kotak centang `name="scope"`, nilai `jenis:id`) — US-M10-01 KP-3. Peran kantor mendapat lingkup
 * tenant otomatis sehingga tidak perlu memilih unit.
 */
export function ScopePicker({ options, name = "scope", idPrefix = "lingkup" }: { options: Groups; name?: string; idPrefix?: string }) {
  return (
    <fieldset className="grid gap-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">Lingkup unit (untuk peran lapangan/POS)</legend>
      <p className="text-xs text-muted-foreground">Peran kantor otomatis berlingkup seluruh EQUA. Sopir/Kernet → truk, Operator depot → depot, Kasir → toko, Operator produksi → sumber air.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {GROUPS.map((g) => (
          <div key={g.key} className="grid content-start gap-1">
            <p className="text-xs font-semibold uppercase text-muted-foreground">
              {g.title} <span className="font-normal normal-case">· {g.hint}</span>
            </p>
            {options[g.key].map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-sm" htmlFor={`${idPrefix}-${o.value}`}>
                <input type="checkbox" id={`${idPrefix}-${o.value}`} name={name} value={o.value} className="size-4" />
                {o.label}
              </label>
            ))}
          </div>
        ))}
      </div>
    </fieldset>
  );
}
