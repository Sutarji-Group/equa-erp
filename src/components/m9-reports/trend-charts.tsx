"use client";

import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { TrendPoint } from "@/client/m9-reports/types";
import { formatRupiah } from "@/lib/money";

/**
 * Grafik tren (US-M9-06 KP-1): omzet per lini (batang bertumpuk + garis omzet luar), rit selesai vs terjadwal, galon,
 * dan piutang (saldo + % lewat tempo). Angka dari `computeTrend` (definisi sama dengan H+0 & laporan bulanan).
 */
const compact = (v: number) =>
  Math.abs(v) >= 1_000_000_000 ? `${(v / 1_000_000_000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} M` : Math.abs(v) >= 1_000_000 ? `${(v / 1_000_000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} jt` : Math.abs(v) >= 1_000 ? `${(v / 1_000).toLocaleString("id-ID", { maximumFractionDigits: 0 })} rb` : v.toLocaleString("id-ID");

function ChartBox({ title, children }: { title: string; children: React.ReactElement }) {
  return (
    <figure className="min-w-0 rounded-xl border bg-card p-3">
      <figcaption className="mb-2 text-sm font-medium">{title}</figcaption>
      <div className="h-56 w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

export function TrendCharts({ points }: { points: TrendPoint[] }) {
  const data = points.map((p) => ({ ...p, overduePctValue: p.overduePct }));
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2" data-testid="trend-charts">
      <ChartBox title="Omzet per lini">
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
          <YAxis tickFormatter={compact} tick={{ fontSize: 11 }} width={48} />
          <Tooltip formatter={(v) => formatRupiah(Number(v))} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="L2" name="L2 Truk" stackId="rev" fill="var(--chart-1)" />
          <Bar dataKey="L3" name="L3 Depot" stackId="rev" fill="var(--chart-2)" />
          <Bar dataKey="L4" name="L4 Toko" stackId="rev" fill="var(--chart-3)" />
          <Line dataKey="internal" name="Transfer internal" stroke="var(--chart-5)" strokeDasharray="4 4" dot={false} />
        </ComposedChart>
      </ChartBox>
      <ChartBox title="Rit selesai vs terjadwal">
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 11 }} width={36} allowDecimals={false} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="tripsScheduled" name="Terjadwal" fill="var(--chart-4)" />
          <Line dataKey="tripsCompleted" name="Selesai" stroke="var(--chart-1)" strokeWidth={2} />
        </ComposedChart>
      </ChartBox>
      <ChartBox title="Galon depot">
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 11 }} width={40} allowDecimals={false} />
          <Tooltip />
          <Bar dataKey="gallons" name="Galon" fill="var(--chart-2)" />
        </ComposedChart>
      </ChartBox>
      <ChartBox title="Piutang: saldo & % lewat tempo">
        <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
          <YAxis yAxisId="rp" tickFormatter={compact} tick={{ fontSize: 11 }} width={48} />
          <YAxis yAxisId="pct" orientation="right" tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 11 }} width={40} />
          <Tooltip formatter={(v, name) => (name === "% lewat tempo" ? `${Number(v).toLocaleString("id-ID")}%` : formatRupiah(Number(v)))} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar yAxisId="rp" dataKey="receivableBalance" name="Saldo" fill="var(--chart-3)" />
          <Line yAxisId="pct" dataKey="overduePctValue" name="% lewat tempo" stroke="var(--destructive)" strokeWidth={2} />
        </ComposedChart>
      </ChartBox>
    </div>
  );
}
