import type { ScopeOptions } from "@/server/modules/m10-access";

import { NativeSelect } from "./fields";

/** Satu pilihan unit (truk/depot/toko/sumber air) bernilai `jenis:id` untuk penetapan perangkat. */
export function UnitSelect({ id, options, defaultValue, name = "unit" }: { id: string; options: ScopeOptions; defaultValue?: string; name?: string }) {
  return (
    <NativeSelect id={id} name={name} defaultValue={defaultValue ?? ""}>
      <option value="">Tanpa unit (cadangan)</option>
      <optgroup label="Truk">
        {options.trucks.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="Depot">
        {options.depots.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="Toko">
        {options.stores.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="Sumber air">
        {options.sources.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </optgroup>
    </NativeSelect>
  );
}

/** Pilihan pemegang perangkat (karyawan aktif). */
export function HolderSelect({ id, options, defaultValue }: { id: string; options: ScopeOptions; defaultValue?: string | null }) {
  return (
    <NativeSelect id={id} name="holderEmployeeId" defaultValue={defaultValue ?? ""}>
      <option value="">Tanpa pemegang tetap</option>
      {options.employees.map((e) => (
        <option key={e.id} value={e.id}>
          {e.label}
        </option>
      ))}
    </NativeSelect>
  );
}
