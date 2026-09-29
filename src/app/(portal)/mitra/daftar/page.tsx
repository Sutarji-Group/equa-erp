import type { Metadata } from "next";
import Link from "next/link";

import { P3ActionForm } from "@/components/p3-partner/action-form";
import { Field, TextAreaField } from "@/components/p3-partner/fields";
import { Phase3Disabled } from "@/components/p3-partner/phase3-disabled";
import { getDb } from "@/server/core/db";
import * as p3 from "@/server/modules/p3-partner";

import { registerProspectAction } from "../actions";

export const metadata: Metadata = { title: "Daftar calon mitra" };
export const dynamic = "force-dynamic";

/**
 * Pendaftaran calon mitra di portal (Tahap 3 US-P3-01 KP-1): nama, badan usaha, kontak WA, lokasi usulan (titik
 * lintang/bujur), modal. Tanpa akun; hanya saat portal Tahap 3 aktif. Penilaian lokasi dilakukan sistem + pembina.
 */
export default async function ProspectRegistrationPage() {
  const db = getDb();
  const enabled = await p3.portalEnabled(db);
  const terms = await p3.partnerTerms(db);
  return (
    <main className="mx-auto grid w-full max-w-2xl flex-1 gap-6 p-4">
      <div>
        <p className="text-sm font-medium text-muted-foreground">{terms.program}</p>
        <h1 className="text-2xl font-semibold">Daftar calon mitra</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Isi data usaha dan lokasi usulan depot. Pembina wilayah EQUA akan menghubungi Anda untuk survei. Lokasi dinilai dari jarak ke sumber air & rute truk, wilayah eksklusif mitra lain, dan kapasitas air.
        </p>
      </div>
      {!enabled ? (
        <Phase3Disabled what="Pendaftaran calon mitra lewat portal" />
      ) : (
        <P3ActionForm action={registerProspectAction} submitLabel="Kirim pendaftaran" testId="form-daftar-mitra">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nama lengkap" name="name" required />
            <Field label="Badan usaha (opsional)" name="businessEntity" />
            <Field label="Nomor WhatsApp" name="waPhone" required inputMode="tel" placeholder="0812-3456-7890" />
            <Field label="Modal tersedia (Rp, opsional)" name="capitalAmount" inputMode="numeric" />
            <Field label="Lintang lokasi" name="lat" required inputMode="decimal" placeholder="-6.8200" hint="Salin dari Google Maps (tahan lama pada titik lokasi)." />
            <Field label="Bujur lokasi" name="lng" required inputMode="decimal" placeholder="107.1400" />
          </div>
          <TextAreaField label="Alamat lokasi usulan" name="proposedAddress" required rows={2} />
        </P3ActionForm>
      )}
      <p className="text-sm text-muted-foreground">
        Sudah menjadi mitra?{" "}
        <Link href="/mitra/masuk" className="text-primary underline">
          Masuk portal
        </Link>
      </p>
    </main>
  );
}
