"use client";

import { enumOptions } from "@/lib/labels";

import { ActionForm } from "./action-form";
import type { ActionState } from "./action-state";
import { CoordinatePicker } from "./coordinate-picker";
import { DuplicatePanel } from "./duplicate-panel";
import { FormGrid, SelectField, TextAreaField, TextField, type Option } from "./fields";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** Bidang alamat kirim (label, teks, koordinat dari peta, zona manual beralasan). */
export function AddressFields({ zones }: { zones: Option[] }) {
  return (
    <div className="grid gap-3 rounded-md border p-3">
      <p className="text-sm font-medium">Alamat kirim</p>
      <FormGrid>
        <TextField label="Label alamat" name="addr_label" defaultValue="Utama" required />
        <TextField label="Catatan alamat" name="addr_notes" placeholder="Patokan, akses truk" />
      </FormGrid>
      <TextAreaField label="Alamat" name="addr_text" required placeholder="Jl. …, Kecamatan" />
      <CoordinatePicker namePrefix="addr_" />
      <FormGrid>
        <SelectField label="Zona manual (bila tanpa koordinat / di batas zona)" name="addr_zone" options={zones} placeholder="— Otomatis dari koordinat —" />
        <TextField label="Alasan zona manual" name="addr_zone_reason" placeholder="Wajib bila zona manual dipilih" />
      </FormGrid>
      <p className="text-xs text-muted-foreground">Tanpa koordinat, alamat berstatus &quot;Belum dikunci&quot;; koordinat diusulkan dari lokasi Selesai rit pertama untuk dikonfirmasi.</p>
    </div>
  );
}

/** Formulir pelanggan baru (US-M1-01 KP-1): status kredit otomatis Tunai; batas dari segmen. */
export function CustomerCreateForm({ action, zones }: { action: Action; zones: Option[] }) {
  return (
    <ActionForm action={action} submitLabel="Simpan pelanggan" resetOnSuccess={false} renderState={(s) => <DuplicatePanel state={s} />} aria-label="Formulir pelanggan baru">
      <FormGrid>
        <TextField label="Nama pelanggan" name="name" required autoComplete="off" />
        <SelectField label="Segmen" name="segment" required options={enumOptions("customer_segment")} placeholder="— Pilih segmen —" />
        <TextField label="Nomor WA" name="waPhone" required inputMode="tel" placeholder="0812-3456-7890" />
        <TextField label="Nama kontak" name="contactName" />
        <TextField label="Jam terima tetap" name="fixedReceiveTime" type="time" hint="Terisi otomatis di pesanan (BR-21)." />
        <TextField label="Kode pelanggan (opsional)" name="code" placeholder="PLG-0101" />
      </FormGrid>
      <TextAreaField label="Catatan khusus" name="notes" placeholder="Akses lokasi, jam terima, patokan — ikut ke aplikasi sopir" />
      <AddressFields zones={zones} />
      <p className="text-xs text-muted-foreground">Status kredit pelanggan baru = Tunai (BR-01). Batas kredit mengikuti segmen (PAR-10); perubahan hanya lewat persetujuan pemilik.</p>
    </ActionForm>
  );
}

/** Formulir ubah data pelanggan (bukan status kredit/batas/tempo). */
export function CustomerEditForm({
  action,
  defaults,
  initialData,
}: {
  action: Action;
  defaults: { name: string; segment: string; waPhone: string; contactName: string | null; notes: string | null; fixedReceiveTime: string | null };
  initialData: boolean;
}) {
  return (
    <ActionForm action={action} submitLabel="Simpan perubahan" resetOnSuccess={false} renderState={(s) => <DuplicatePanel state={s} />}>
      <FormGrid>
        <TextField label="Nama pelanggan" name="name" defaultValue={defaults.name} required />
        <SelectField label="Segmen" name="segment" defaultValue={defaults.segment} options={enumOptions("customer_segment")} />
        <TextField label="Nomor WA" name="waPhone" defaultValue={defaults.waPhone} inputMode="tel" />
        <TextField label="Nama kontak" name="contactName" defaultValue={defaults.contactName ?? ""} />
        <TextField label="Jam terima tetap" name="fixedReceiveTime" type="time" defaultValue={defaults.fixedReceiveTime?.slice(0, 5) ?? ""} />
      </FormGrid>
      <TextAreaField label="Catatan khusus" name="notes" defaultValue={defaults.notes ?? ""} />
      {initialData ? <TextField label="Alasan koreksi (data awal)" name="correctionReason" required hint="Pelanggan hasil impor data awal hanya diubah lewat koreksi berjejak (US-M1-06 KP-3)." /> : null}
    </ActionForm>
  );
}

/** Formulir tambah alamat. */
export function AddAddressForm({ action, zones }: { action: Action; zones: Option[] }) {
  return (
    <ActionForm action={action} submitLabel="Tambah alamat">
      <AddressFields zones={zones} />
    </ActionForm>
  );
}

/** Kunci koordinat alamat dari peta. */
export function CoordinateForm({ action, prefix, defaultValue }: { action: Action; prefix: string; defaultValue: { lat: number; lng: number } | null }) {
  return (
    <ActionForm action={action} submitLabel="Kunci koordinat" resetOnSuccess={false} variant="outline">
      <CoordinatePicker namePrefix={prefix} defaultValue={defaultValue} />
    </ActionForm>
  );
}
