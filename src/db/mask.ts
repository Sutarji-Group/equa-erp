/**
 * Penyamaran data pribadi untuk LINGKUNGAN UJI (NFR-27): salinan data produksi yang dipakai uji/UAT tidak boleh memuat
 * nomor WA, alamat, nama penerima, atau koordinat rumah nyata. Dipanggil `pnpm db:mask` (scripts/db-mask.ts) yang
 * MENOLAK berjalan di lingkungan produksi. Catatan keuangan (nominal, tanggal, relasi) tetap utuh — hanya identitas.
 *
 * Deterministik per baris (dari id/kode) agar hasil uji dapat diulang; nomor tetap unik bila kolomnya unik.
 */
import { sql } from "drizzle-orm";

import type { Db } from "./client";
import {
  customerAccountRequests,
  customerAccounts,
  customerAddresses,
  customers,
  customerSessions,
  employees,
  otpCodes,
  outlets,
  partnerProspects,
  phoneChangeRequests,
  suppliers,
  trips,
  waMessageLogs,
} from "./schema";

/** Nomor WA uji 628000xxxxxxx dari id baris (deterministik, tidak dapat ditelusuri balik). */
const fakePhone = (idCol: unknown) => sql`'628000' || lpad((abs(hashtext(${idCol}::text)) % 10000000)::text, 7, '0')`;
/** Koordinat dibulatkan 2 desimal (±1 km) — zona/tarif masih masuk akal, rumah tidak dapat ditunjuk. */
const roughCoord = (col: unknown) => sql`case when ${col} is null then null else round((${col})::numeric, 2)::double precision end`;

export type MaskSummary = Record<string, number>;

/** Samarkan seluruh kolom data pribadi pada DB tujuan (satu transaksi). Kembalikan jumlah baris per tabel. */
export async function maskPersonalData(db: Db): Promise<MaskSummary> {
  return db.transaction(async (tx) => {
    const out: MaskSummary = {};
    const count = async (key: string, p: Promise<unknown[]>) => {
      out[key] = (await p).length;
    };
    await count(
      "customers",
      tx
        .update(customers)
        .set({ name: sql`'Pelanggan uji ' || coalesce(${customers.code}, left(${customers.id}::text, 8))`, waPhone: fakePhone(customers.id), contactName: null, notes: null })
        .returning({ id: customers.id }),
    );
    await count(
      "customerAddresses",
      tx
        .update(customerAddresses)
        .set({
          addressText: sql`'Alamat uji ' || left(${customerAddresses.id}::text, 8)`,
          notes: null,
          lat: roughCoord(customerAddresses.lat),
          lng: roughCoord(customerAddresses.lng),
          proposedLat: roughCoord(customerAddresses.proposedLat),
          proposedLng: roughCoord(customerAddresses.proposedLng),
        })
        .returning({ id: customerAddresses.id }),
    );
    await count(
      "trips",
      tx
        .update(trips)
        .set({
          recipientName: null,
          departedLat: roughCoord(trips.departedLat),
          departedLng: roughCoord(trips.departedLng),
          arrivedLat: roughCoord(trips.arrivedLat),
          arrivedLng: roughCoord(trips.arrivedLng),
          completedLat: roughCoord(trips.completedLat),
          completedLng: roughCoord(trips.completedLng),
          failLat: roughCoord(trips.failLat),
          failLng: roughCoord(trips.failLng),
        })
        .returning({ id: trips.id }),
    );
    await count("waMessageLogs", tx.update(waMessageLogs).set({ toPhone: "0", renderedText: "[disamarkan]" }).returning({ id: waMessageLogs.id }));
    await count("customerAccounts", tx.update(customerAccounts).set({ phone: fakePhone(customerAccounts.id), displayName: null }).returning({ id: customerAccounts.id }));
    await count("customerSessions", tx.update(customerSessions).set({ ip: null, userAgent: null }).returning({ id: customerSessions.id }));
    await count("otpCodes", tx.delete(otpCodes).returning({ id: otpCodes.id }));
    await count("phoneChangeRequests", tx.update(phoneChangeRequests).set({ oldPhone: "0", newPhone: "0" }).returning({ id: phoneChangeRequests.id }));
    await count("customerAccountRequests", tx.update(customerAccountRequests).set({ detail: null }).returning({ id: customerAccountRequests.id }));
    await count(
      "employees",
      tx
        .update(employees)
        .set({ fullName: sql`'Karyawan uji ' || coalesce(${employees.employeeNo}, left(${employees.id}::text, 8))`, nickname: null, phone: null, workLocation: null })
        .returning({ id: employees.id }),
    );
    await count("outlets", tx.update(outlets).set({ phone: null }).returning({ id: outlets.id }));
    await count("suppliers", tx.update(suppliers).set({ contactName: null, phone: null, address: null }).returning({ id: suppliers.id }));
    await count(
      "partnerProspects",
      tx
        .update(partnerProspects)
        .set({ waPhone: fakePhone(partnerProspects.id), proposedAddress: null, proposedLat: roughCoord(partnerProspects.proposedLat), proposedLng: roughCoord(partnerProspects.proposedLng) })
        .returning({ id: partnerProspects.id }),
    );
    return out;
  });
}
