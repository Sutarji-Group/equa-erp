/**
 * P2 — posisi truk untuk pelanggan (US-P2-03 KP-2/KP-3/KP-5; PTB-54; 8.6 "privasi posisi").
 *
 * - Posisi HANYA selama rit berstatus Berangkat menuju alamat pelanggan tersebut; setelah Tiba/Selesai/Gagal, sebelum
 *   Berangkat, atau rit milik pelanggan lain → tidak ada posisi. Tidak ada riwayat posisi untuk pelanggan.
 * - Posisi = titik terbaru yang valid (perangkat GPS / ponsel cadangan / titik status) SETELAH waktu Berangkat dan tidak
 *   lebih tua dari ambang basi M12 (PAR-48). Tanpa posisi → "Posisi sementara tidak tersedia" (bukan posisi lama).
 * - Perkiraan tiba = jarak rute (`RoutingProvider`, peta komersial/garis lurus × 1,3; NFR-24) ÷ kecepatan rata-rata M12.
 * - Identitas: nomor polisi truk + nama depan sopir; kontak = kantor (Dispatcher), bukan ponsel sopir.
 */
import "server-only";

import { and, desc, eq, gte, lte } from "drizzle-orm";

import { customerAddresses, employees, gpsPositions, trips, trucks } from "@/db/schema";

import { getDb, type Tx } from "@/server/core/db";
import { routeDistance } from "@/server/core/maps";
import { m12Rules } from "@/server/modules/m12-fleet";

import { appRules, customerBusinessDate, firstName, loadOwnOrder, type CustomerContext } from "./common";

export type TrackingView =
  | {
      active: false;
      /** Alasan tanpa peta (bahasa pelanggan). */
      message: string;
      officePhone: string;
      refreshSeconds: number;
    }
  | {
      active: true;
      tripId: string;
      truckPlate: string | null;
      driverFirstName: string | null;
      destination: { lat: number; lng: number } | null;
      position: { lat: number; lng: number; at: string } | null;
      /** "Posisi sementara tidak tersedia" bila tanpa posisi segar (KP-5). */
      message: string | null;
      eta: { minutes: number; km: number; estimated: boolean } | null;
      officePhone: string;
      refreshSeconds: number;
    };

/** Status pelacakan pesanan pelanggan (dipakai halaman rincian & rute JSON penyegaran). */
export async function getTracking(cctx: CustomerContext, orderId: string, opts: { tx?: Tx } = {}): Promise<TrackingView> {
  const tx = opts.tx ?? getDb();
  const order = await loadOwnOrder(tx, cctx, orderId);
  const date = customerBusinessDate(cctx);
  const rules = await appRules(tx, date, cctx.tenantId);
  const base = { officePhone: rules.office_phone, refreshSeconds: rules.tracking_refresh_seconds };
  const [trip] = await tx
    .select({ t: trips, plate: trucks.plateNumber, driverName: employees.fullName, lat: customerAddresses.lat, lng: customerAddresses.lng })
    .from(trips)
    .leftJoin(trucks, eq(trucks.id, trips.truckId))
    .leftJoin(employees, eq(employees.id, trips.driverEmployeeId))
    .innerJoin(customerAddresses, eq(customerAddresses.id, trips.addressId))
    .where(and(eq(trips.orderId, order.id), eq(trips.customerId, order.customerId), eq(trips.status, "departed")))
    .orderBy(desc(trips.departedAt))
    .limit(1);
  if (!trip || !trip.t.truckId || !trip.t.departedAt) {
    return { active: false, message: "Peta posisi truk tampil saat truk berangkat menuju alamat Anda.", ...base };
  }
  const fleet = await m12Rules(tx, date, cctx.tenantId);
  const staleAfter = new Date(cctx.now.getTime() - fleet.staleMinutes * 60_000);
  const since = trip.t.departedAt > staleAfter ? trip.t.departedAt : staleAfter;
  const [pos] = await tx
    .select({ lat: gpsPositions.lat, lng: gpsPositions.lng, at: gpsPositions.deviceTime })
    .from(gpsPositions)
    .where(and(eq(gpsPositions.truckId, trip.t.truckId), eq(gpsPositions.isValid, true), gte(gpsPositions.deviceTime, since), lte(gpsPositions.deviceTime, cctx.now)))
    .orderBy(desc(gpsPositions.deviceTime))
    .limit(1);
  const destination = trip.lat != null && trip.lng != null ? { lat: trip.lat, lng: trip.lng } : null;
  let eta: { minutes: number; km: number; estimated: boolean } | null = null;
  if (pos && destination) {
    const d = await routeDistance({ lat: pos.lat, lng: pos.lng }, destination);
    eta = { km: Math.round(d.km * 10) / 10, minutes: Math.max(1, Math.round((d.km / fleet.fleet.eta_avg_speed_kmh) * 60)), estimated: d.estimated || d.method === "straight_line_x1_3" };
  }
  return {
    active: true,
    tripId: trip.t.id,
    truckPlate: trip.plate,
    driverFirstName: firstName(trip.driverName),
    destination,
    position: pos ? { lat: pos.lat, lng: pos.lng, at: pos.at.toISOString() } : null,
    message: pos ? null : "Posisi sementara tidak tersedia.",
    eta,
    ...base,
  };
}
