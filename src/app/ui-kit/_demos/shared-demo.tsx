"use client";

import { Banknote, CircleDollarSign, Droplets, Plus, Truck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { ApprovalCountBadge } from "@/components/shared/approval-count-badge";
import { ConfirmWithReasonDialog } from "@/components/shared/confirm-with-reason-dialog";
import { DataTable, dataTableColumns } from "@/components/shared/data-table";
import { DateInput } from "@/components/shared/date-input";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { ExportButtons } from "@/components/shared/export-buttons";
import {
  FormFieldCheckbox,
  FormFieldDate,
  FormFieldLiter,
  FormFieldMoney,
  FormFieldSelect,
  FormFieldText,
  FormFieldTextarea,
  FormRootError,
  FormSubmitButton,
  useZodForm,
} from "@/components/shared/form-fields";
import { LiterInput, MoneyInput } from "@/components/shared/integer-input";
import { KeyValueList } from "@/components/shared/key-value-list";
import { KpiTile } from "@/components/shared/kpi-tile";
import { KpiGridSkeleton, ListSkeleton, TableSkeleton } from "@/components/shared/loading-skeletons";
import { MapPicker, MapView } from "@/components/shared/map/map-view";
import { LiterText, MoneyText } from "@/components/shared/money-text";
import { NotificationBell } from "@/components/shared/notification-bell";
import { PageHeader } from "@/components/shared/page-header";
import { type ComboboxOption, SearchCombobox } from "@/components/shared/search-combobox";
import { SectionCard } from "@/components/shared/section-card";
import { StatusBadge, STATUS_TONES } from "@/components/shared/status-badge";
import { Timeline } from "@/components/shared/timeline";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import type { LatLng } from "@/lib/geo";
import { type EnumName, enumOptions, enumValues } from "@/lib/labels";
import { zRupiahPositive } from "@/lib/money";
import { formatTanggal, toBusinessDate } from "@/lib/time";

import { DEMO_NOW, DEMO_ORDERS, type DemoOrderRow, demoAgo, searchDemoCustomers } from "./sample-data";

const col = dataTableColumns<DemoOrderRow>();
const orderColumns = col.columns([
  col.accessor("number", { header: "Nomor", cell: (c) => <span className="font-medium">{c.getValue()}</span> }),
  col.accessor("customer", { header: "Pelanggan" }),
  col.accessor("businessDate", {
    header: "Tanggal",
    cell: (c) => formatTanggal(c.getValue(), { weekday: false }),
    meta: { hideOnMobile: true },
  }),
  col.accessor("truck", { header: "Truk", meta: { hideOnMobile: true } }),
  col.accessor("volumeL", { header: "Volume", cell: (c) => <LiterText value={c.getValue()} />, meta: { align: "right", hideOnMobile: true } }),
  col.accessor("total", { header: "Total", cell: (c) => <MoneyText value={c.getValue()} />, meta: { align: "right" } }),
  col.accessor("status", {
    header: "Status",
    cell: (c) => <StatusBadge enumName="order_status" value={c.getValue()} />,
    meta: { searchable: false },
  }),
]);

const demoFormSchema = z.object({
  customerName: z.string().trim().min(3, { error: "Nama pelanggan minimal 3 huruf." }),
  volumeL: z.number({ error: "Isi volume." }).int().positive({ error: "Volume harus lebih dari 0 L." }),
  price: zRupiahPositive,
  serviceDate: z.string({ error: "Pilih tanggal layanan." }).min(1, { error: "Pilih tanggal layanan." }),
  creditStatus: z.enum(enumValues("credit_status"), { error: "Pilih status kredit." }),
  notes: z.string().max(200, { error: "Catatan maksimal 200 karakter." }).optional(),
  whatsappConfirm: z.boolean(),
});

const VOID_REASONS = [
  { code: "wrong_product", label: "Salah produk" },
  { code: "wrong_quantity", label: "Salah jumlah" },
  { code: "customer_cancelled", label: "Pelanggan batal" },
  { code: "wrong_payment", label: "Salah cara bayar" },
];

const TRUCK_MARKERS = [
  { id: "t1", position: { lat: -6.8205, lng: 107.1398 }, label: "F 8123 AB", tone: "success" as const, popup: "Berangkat · rit 2 dari 5" },
  { id: "t2", position: { lat: -6.7419, lng: 107.0412 }, label: "F 8456 CD", tone: "primary" as const, popup: "Tiba di pelanggan" },
  { id: "t3", position: { lat: -6.7865, lng: 107.1862 }, label: "F 8789 EF", tone: "danger" as const, popup: "GPS mati > 15 menit" },
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 space-y-4">
      <h2 className="border-b pb-2 text-xl font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function SharedDemo() {
  const [money, setMoney] = useState<number | null>(1_250_000);
  const [liter, setLiter] = useState<number | null>(5_000);
  const [date, setDate] = useState<string | null>(() => toBusinessDate());
  const [customer, setCustomer] = useState<ComboboxOption | null>(null);
  const [picked, setPicked] = useState<LatLng | null>(null);

  const form = useZodForm(demoFormSchema, {
    defaultValues: { customerName: "", volumeL: 5_000, price: 200_000, whatsappConfirm: true, notes: "" },
  });

  return (
    <div className="space-y-12">
      <Section id="page-header" title="PageHeader · ExportButtons · lencana topbar">
        <PageHeader
          title="Pesanan"
          description="Semua pesanan air truk. Ketuk baris untuk rinciannya."
          meta={<StatusBadge enumName="order_status" value="scheduled" />}
          backHref="/ui-kit"
          actions={
            <>
              <ExportButtons excelHref="#excel" pdfHref="#pdf" />
              <Button>
                <Plus aria-hidden />
                Pesanan baru
              </Button>
            </>
          }
        />
        <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
          <ApprovalCountBadge count={4} overdueCount={1} />
          <ApprovalCountBadge count={0} />
          <NotificationBell
            count={3}
            items={[
              { id: "n1", title: "Selisih setoran Rp 150.000", body: "Budi · F 8123 AB · tenggat 22.00", at: DEMO_NOW, unread: true, severity: "critical", href: "#" },
              { id: "n2", title: "Transfer tidak ditemukan", body: "Rp 1.200.000 · BCA", at: demoAgo(60), unread: true, severity: "warning" },
              { id: "n3", title: "Faktur F-26-000045 lunas", at: demoAgo(1440) },
            ]}
            onMarkAllRead={() => toast.success("Semua notifikasi ditandai dibaca.")}
          />
        </div>
      </Section>

      <Section id="status" title="StatusBadge (enum → label & warna)">
        <div className="space-y-3">
          {(Object.keys(STATUS_TONES) as EnumName[]).map((e) => (
            <div key={e} className="flex flex-wrap items-center gap-2">
              <code className="w-44 shrink-0 text-xs text-muted-foreground">{e}</code>
              {enumValues(e).map((v) => (
                <StatusBadge key={v} enumName={e} value={v} />
              ))}
            </div>
          ))}
        </div>
      </Section>

      <Section id="kpi" title="KpiTile (dashboard H+0)">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <KpiTile label="Omzet L2 air truk" value={<MoneyText value={8_450_000} />} hint="38 rit selesai" href="#" icon={Truck} unclosed />
          <KpiTile label="Kas: seharusnya vs diterima" value={<MoneyText value={-150_000} signed />} tone="danger" hint="Seharusnya Rp 12.300.000" href="#" icon={Banknote} unclosed />
          <KpiTile label="Galon depot" value="412 galon" hint="3 depot" icon={Droplets} href="#" />
          <KpiTile label="Piutang lewat tempo" value={<MoneyText value={3_200_000} />} tone="warning" hint="KPI-04: 7,5%" icon={CircleDollarSign} />
          <KpiTile label="Pengecualian menunggu" value="5" hrefLabel="Buka kotak masuk" href="#" />
          <KpiTile label="H+0 terbit" value="Terkunci 22.14" tone="success" hint="Diterbitkan otomatis setelah tutup kas" />
        </div>
      </Section>

      <Section id="table" title="DataTable (urut, cari, paginasi, baris dapat diklik)">
        <DataTable
          columns={orderColumns}
          data={DEMO_ORDERS}
          getRowId={(r) => r.id}
          pageSize={10}
          initialSorting={[{ id: "number", desc: true }]}
          searchPlaceholder="Cari nomor, pelanggan, truk…"
          onRowClick={(r) => toast(`Buka ${r.number}`)}
          exportSlot={<ExportButtons excelHref="#excel" />}
          caption="Daftar pesanan contoh"
        />
        <DataTable columns={orderColumns} data={[]} emptyTitle="Belum ada pesanan hari ini" emptyDescription="Pesanan yang dibuat Dispatcher akan muncul di sini." />
      </Section>

      <Section id="inputs" title="MoneyInput · LiterInput · DateInput (WIB) · SearchCombobox">
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm font-medium">MoneyInput</p>
            <MoneyInput value={money} onValueChange={setMoney} aria-label="Jumlah rupiah" />
            <p className="text-xs text-muted-foreground">Nilai: {money === null ? "null" : money}</p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">LiterInput</p>
            <LiterInput value={liter} onValueChange={setLiter} aria-label="Volume liter" />
            <p className="text-xs text-muted-foreground">Nilai: {liter === null ? "null" : liter}</p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">DateInput</p>
            <DateInput value={date} onValueChange={setDate} clearable />
            <p className="text-xs text-muted-foreground">Nilai: {date ?? "null"}</p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">SearchCombobox (async, ≥ 2 karakter)</p>
            <SearchCombobox value={customer} onValueChange={setCustomer} search={searchDemoCustomers} placeholder="Pilih pelanggan" clearable />
            <p className="text-xs text-muted-foreground">Nilai: {customer?.value ?? "null"}</p>
          </div>
        </div>
      </Section>

      <Section id="form" title="Form helpers (react-hook-form + Zod)">
        <SectionCard title="Contoh formulir" description="Validasi Zod dengan pesan Indonesia; nilai uang/liter integer.">
          <Form {...form}>
            <form
              noValidate
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={form.handleSubmit(async (values) => {
                await new Promise((r) => setTimeout(r, 600));
                if (values.customerName.toLowerCase().includes("tolak")) {
                  form.setError("root", { message: "Pelanggan berstatus Ditahan. Ajukan pembukaan ke pemilik." });
                  return;
                }
                toast.success("Tersimpan", { description: JSON.stringify(values) });
              })}
            >
              <FormRootError control={form.control} className="sm:col-span-2" />
              <FormFieldText control={form.control} name="customerName" label="Nama pelanggan" required description='Ketik "tolak" untuk mencoba galat server.' />
              <FormFieldSelect control={form.control} name="creditStatus" label="Status kredit" options={enumOptions("credit_status")} required />
              <FormFieldLiter control={form.control} name="volumeL" label="Volume" required />
              <FormFieldMoney control={form.control} name="price" label="Harga" required />
              <FormFieldDate control={form.control} name="serviceDate" label="Tanggal layanan" required />
              <FormFieldCheckbox control={form.control} name="whatsappConfirm" label="Kirim konfirmasi WA" description="Membuka WhatsApp dengan pesan terisi." variant="switch" />
              <FormFieldTextarea control={form.control} name="notes" label="Catatan" className="sm:col-span-2" />
              <div className="sm:col-span-2">
                <FormSubmitButton control={form.control}>Simpan pesanan</FormSubmitButton>
              </div>
            </form>
          </Form>
        </SectionCard>
      </Section>

      <Section id="dialogs" title="ConfirmWithReasonDialog (alasan wajib)">
        <div className="flex flex-wrap gap-3">
          <ConfirmWithReasonDialog
            trigger={<Button variant="destructive">Tolak penjelasan selisih</Button>}
            title="Tolak penjelasan selisih?"
            description="Sopir akan diberi tahu. Alasan wajib diisi."
            confirmLabel="Tolak"
            destructive
            onConfirm={(r) => {
              toast.success(`Ditolak: ${r.reason}`);
            }}
          />
          <ConfirmWithReasonDialog
            trigger={<Button variant="outline">Void transaksi</Button>}
            title="Void transaksi DP1-260927-0012?"
            description="Transaksi tetap tampil bertanda di-void."
            reasons={VOID_REASONS}
            confirmLabel="Void"
            destructive
            onConfirm={async (r) => {
              await new Promise((res) => setTimeout(res, 500));
              toast.success(`Void: ${r.reason} (kode ${r.reasonCode})`);
            }}
          />
        </div>
      </Section>

      <Section id="detail" title="SectionCard · KeyValueList · Timeline">
        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title="Rincian rit" actions={<StatusBadge enumName="trip_status" value="completed" />}>
            <KeyValueList
              items={[
                { label: "Nomor rit", value: "P-26-000121/1" },
                { label: "Pelanggan", value: "Pondok Pesantren Al-Ikhlas" },
                { label: "Volume terkirim", value: <LiterText value={4_500} />, hint: "Volume parsial: tangki penuh" },
                { label: "Harga", value: <MoneyText value={225_000} /> },
                { label: "Catatan", value: null },
                { label: "Alamat", value: "Kp. Babakan RT 02/05, Cugenang, Cianjur", full: true },
              ]}
            />
          </SectionCard>
          <SectionCard title="Riwayat status">
            <Timeline
              items={[
                { id: "1", title: "Rit selesai", at: DEMO_NOW, actor: "Budi (Sopir) · Aplikasi lapangan", status: { enumName: "trip_status", value: "completed" }, description: "Jarak ke titik alamat 85 m." },
                { id: "2", title: "Tiba", at: demoAgo(40), actor: "Budi (Sopir)", status: { enumName: "trip_status", value: "arrived" } },
                { id: "3", title: "Berangkat", at: demoAgo(80), actor: "Budi (Sopir)", status: { enumName: "trip_status", value: "departed" } },
                { id: "4", title: "Ditugaskan", at: demoAgo(1200), actor: "Sari (Dispatcher) · Web kantor", status: { enumName: "trip_status", value: "assigned" } },
              ]}
            />
          </SectionCard>
        </div>
      </Section>

      <Section id="map" title="MapView (marker berlabel, polyline, geofence) · MapPicker">
        <MapView
          markers={TRUCK_MARKERS}
          polylines={[
            {
              id: "route",
              positions: [
                { lat: -6.8205, lng: 107.1398 },
                { lat: -6.805, lng: 107.12 },
                { lat: -6.7419, lng: 107.0412 },
              ],
              tone: "primary",
              dashed: true,
            },
          ]}
          circles={[{ id: "src", center: { lat: -6.7702, lng: 107.0891 }, radiusM: 300, tone: "success", label: "Sumber air A (geofence 300 m)" }]}
          ariaLabel="Peta posisi truk contoh"
        />
        <MapPicker value={picked} onValueChange={setPicked} radiusM={200} />
      </Section>

      <Section id="states" title="EmptyState · ErrorState · LoadingSkeletons">
        <div className="grid gap-4 lg:grid-cols-2">
          <EmptyState title="Belum ada setoran" description="Setoran sopir muncul setelah sopir menekan Setor di aplikasi." action={<Button variant="outline">Muat ulang</Button>} />
          <ErrorState onRetry={() => toast("Mencoba lagi…")} />
          <KpiGridSkeleton count={3} className="lg:col-span-2" />
          <TableSkeleton rows={3} />
          <ListSkeleton rows={3} />
        </div>
      </Section>
    </div>
  );
}
