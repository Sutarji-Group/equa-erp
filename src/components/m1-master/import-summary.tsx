import { KeyValueList, type KeyValueItem } from "@/components/shared/key-value-list";
import { formatRupiah } from "@/lib/money";

/**
 * Ringkasan hasil impor data awal (US-M1-06 KP-4): jumlah per segmen/zona, alamat terkunci, daftar Tempo migrasi &
 * total batas — ditampilkan di laporan batch dan layar tanda tangan pemilik. Komponen server (tanpa interaksi).
 */
export type ImportSummaryData = {
  kind?: string;
  created?: number;
  merged?: number;
  excluded?: number;
  bySegment?: Record<string, number>;
  byZone?: Record<string, number>;
  byRole?: Record<string, number>;
  addressesLocked?: number;
  addressesUnlocked?: number;
  tempoMigrasi?: { customerId: string; code: string; name: string; creditLimit: number; paymentTermDays: number }[];
  tempoMigrasiTotalLimit?: number;
  averagePrice?: number;
  depots?: number;
  stores?: number;
  meters?: number;
};

function counts(map: Record<string, number> | undefined): string | null {
  if (!map) return null;
  const entries = Object.entries(map).sort(([a], [b]) => a.localeCompare(b, "id"));
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}: ${v}`).join(" · ");
}

export function ImportSummaryView({ summary, showTempo = true }: { summary: ImportSummaryData; showTempo?: boolean }) {
  const items: KeyValueItem[] = [{ label: "Data baru", value: summary.created ?? 0 }];
  if (summary.merged) items.push({ label: "Digabung ke yang ada", value: summary.merged });
  items.push({ label: "Dikecualikan", value: summary.excluded ?? 0 });
  const seg = counts(summary.bySegment);
  if (seg) items.push({ label: "Per segmen", value: seg, full: true });
  const zone = counts(summary.byZone);
  if (zone) items.push({ label: "Per zona", value: zone, full: true });
  const role = counts(summary.byRole);
  if (role) items.push({ label: "Per peran", value: role, full: true });
  if (summary.addressesLocked !== undefined) items.push({ label: "Alamat terkunci / belum dikunci", value: `${summary.addressesLocked} / ${summary.addressesUnlocked ?? 0}` });
  if (summary.averagePrice) items.push({ label: "Rata-rata harga per rit", value: formatRupiah(summary.averagePrice) });
  if (summary.depots !== undefined) items.push({ label: "Depot / toko", value: `${summary.depots} / ${summary.stores ?? 0}` });
  if (summary.meters !== undefined) items.push({ label: "Meter air", value: summary.meters });
  if (summary.tempoMigrasi) items.push({ label: "Tempo migrasi", value: `${summary.tempoMigrasi.length} pelanggan · total batas ${formatRupiah(summary.tempoMigrasiTotalLimit ?? 0)}` });
  return (
    <div className="grid gap-3">
      <KeyValueList columns={3} items={items} />
      {showTempo && summary.tempoMigrasi && summary.tempoMigrasi.length > 0 ? (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <caption className="px-3 py-2 text-left text-xs text-muted-foreground">Pelanggan lama berstatus Tempo migrasi (ditetapkan saat pemilik menandatangani)</caption>
            <thead>
              <tr className="border-b text-left">
                <th className="px-3 py-2 font-medium">Pelanggan</th>
                <th className="px-3 py-2 text-right font-medium">Batas kredit</th>
                <th className="px-3 py-2 text-right font-medium">Tempo</th>
              </tr>
            </thead>
            <tbody>
              {summary.tempoMigrasi.map((t) => (
                <tr key={t.customerId} className="border-b last:border-0">
                  <td className="px-3 py-2">
                    {t.name} <span className="text-muted-foreground">{t.code}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatRupiah(t.creditLimit)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.paymentTermDays} hari</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
