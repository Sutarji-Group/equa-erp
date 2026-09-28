"use client";

import { useState } from "react";

import { DataTable, dataTableColumns } from "@/components/shared/data-table";
import { ExportButtons } from "@/components/shared/export-buttons";
import { KpiTile } from "@/components/shared/kpi-tile";
import { MoneyText } from "@/components/shared/money-text";
import { OfficeBreadcrumbLabel, OfficeShell } from "@/components/shared/office-shell";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import { DEMO_NOW, DEMO_ORDERS, type DemoOrderRow, demoAgo } from "./sample-data";

const col = dataTableColumns<DemoOrderRow>();
const columns = col.columns([
  col.accessor("number", { header: "Nomor" }),
  col.accessor("customer", { header: "Pelanggan" }),
  col.accessor("total", { header: "Total", cell: (c) => <MoneyText value={c.getValue()} />, meta: { align: "right" } }),
  col.accessor("status", { header: "Status", cell: (c) => <StatusBadge enumName="order_status" value={c.getValue()} /> }),
]);

const DISPATCHER_PERMS = ["m2.order.read", "m2.order.create", "m2.schedule.read", "m2.crew_assignment.read", "m1.customer.read", "m12.position.read", "m10.approval.read"];

export function OfficeDemo() {
  const [asDispatcher, setAsDispatcher] = useState(false);
  return (
    <OfficeShell
      user={asDispatcher ? { name: "Sari Rahayu", roleLabels: ["Dispatcher"] } : { name: "Pengguna Demo", roleLabels: ["Pemilik"] }}
      permissions={asDispatcher ? DISPATCHER_PERMS : ["*"]}
      counts={{ approvals: 3, approvalsOverdue: 1, notifications: 12, inbox: 2 }}
      notifications={[
        { id: "n1", title: "Selisih setoran Rp 150.000", body: "Budi · F 8123 AB", at: DEMO_NOW, unread: true, severity: "critical", href: "/ui-kit" },
        { id: "n2", title: "Pesanan tempo menunggu persetujuan", at: demoAgo(120), unread: true, severity: "warning" },
      ]}
      searchSlot={<Input type="search" placeholder="Cari pelanggan, pesanan…" aria-label="Pencarian global" />}
      environmentLabel="Demo"
      signOutAction={() => {
        // Demo: tidak keluar.
      }}
    >
      <OfficeBreadcrumbLabel label="Demo kerangka kantor" />
      <PageHeader
        title="Hari ini"
        description="Contoh isi halaman di dalam OfficeShell. Coba ciutkan menu, buka di ponsel, dan ganti peran."
        actions={
          <div className="flex items-center gap-2">
            <Switch id="as-dispatcher" checked={asDispatcher} onCheckedChange={setAsDispatcher} />
            <Label htmlFor="as-dispatcher">Lihat sebagai Dispatcher</Label>
          </div>
        }
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile label="Omzet L2" value={<MoneyText value={8_450_000} />} unclosed href="#" />
        <KpiTile label="Omzet L3" value={<MoneyText value={2_060_000} />} unclosed href="#" />
        <KpiTile label="Selisih kas" value={<MoneyText value={-150_000} signed />} tone="danger" unclosed href="#" />
        <KpiTile label="Rit selesai" value="38 / 42" href="#" />
      </div>
      <DataTable columns={columns} data={DEMO_ORDERS} pageSize={10} exportSlot={<ExportButtons excelHref="#" pdfHref="#" />} rowHref={() => "/ui-kit/kantor"} />
    </OfficeShell>
  );
}
