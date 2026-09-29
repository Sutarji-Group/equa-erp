# M2 — Pesanan & Penjadwalan Rit (catatan pengembang)

Kode: `src/server/modules/m2-orders/` (API publik HANYA `index.ts`), UI `src/app/(office)/{pesanan,jadwal,langganan}/**` +
`src/components/m2-orders/**`, uji `tests/m2-orders/**` (orders, schedule, lifecycle, seed), E2E `e2e/m2-orders.spec.ts`,
seed demo `src/db/seed/demo-m2-orders.ts`. PRD 7.2 (US-M2-01..11), Bab 5.2 (siklus pesanan/rit), 6.2a (persetujuan
tempo/kurang bayar kedua), 6.3 (notifikasi), BR-06/10/20/21/22/24/38, PTB-01/13/14/18/25/27.

## 1. Kontrak untuk modul lain

Fungsi `ctx`-first: `authorize → parseInput(zod) → aturan + SoD (sod.assertNotFinanceAdminOnOrders) → runService(tx) →
audit.record → emit`, semua menerima `opts.tx`. Fungsi `tx`-first tidak memeriksa izin (pemanggil sudah terotorisasi).

| Pemakai | Fungsi | Tanda tangan ringkas | Catatan |
| --- | --- | --- | --- |
| M5, M7 | `computeCreditExposure` | `(tx, customerId, { extraAmount?, excludeOrderId? }) → CreditExposure` | SATU batas lintas lini (BR-06, PTB-25). `exposure = openInvoices (invoices.outstanding_amount > 0, semua lini) + unbilledCharges (unbilled_charges belum difakturkan) + openCreditOrders (harga rit tempo pesanan aktif yang Ditugaskan/Berangkat/Tiba & tidak ditarik) + extraAmount`; `remaining`, `exceedsLimit`. |
| M5, M7 | `evaluateCreditOrder` | `(tx, customerId, amount, { excludeOrderId? }) → CreditCheck` | `{ok:true}` atau `{ok:false, reason: "cash_customer"\|"on_hold"\|"over_limit", canRequestApproval, message, exposure}`. |
| M5 | `underpaymentStatus` | `(tx, customerId) → { openCount, openAmount, collect, secondUnpaid }` | Faktur kurang bayar terbuka (PTB-18); `collect` ≥ 1, `secondUnpaid` ≥ 2 (`SECOND_UNDERPAYMENT_OPEN_INVOICES`). |
| UI/M9 | `getCreditExposure` | `(ctx, customerId, { extraAmount?, tx? })` | Versi ber-`authorize` (`m2.order.read`). |
| M3 | pull `m2.schedule` | `DriverSchedule = { date, revision: Record<scheduleId, number>, trips: DriverTrip[] }` | Lihat §4. |
| M3, M12 | `driverSchedule` | `(tx, ctx, date, since) → DriverSchedule \| undefined` | Dipakai provider pull; `undefined` bila tak berubah sejak `since`. |
| semua | `deriveOrderStatus` | `(trips[]) → OrderStatus` | Status pesanan dari rit (Bab 5.2). `awaiting_approval`/`cancelled` hanya lewat alurnya. |
| semua | `schedulingBlockers` | `(tx, order, { forPublish?, trip? }) → SchedulingBlocker[]` | Kode: `awaiting_approval`, `locked`, `credit_rejected`, `reconfirmation`, `second_underpayment`, `provisional_price` (hanya saat terbit), `credit_hold`. |
| M9 | `monthlyCancelFailReport`, `kpi06Report`, `overridesReport`, `orderCounters` | `(ctx, month 'YYYY-MM', { tx? })` | KPI-06, US-M2-09 KP-4, tinjauan 6.2c. |
| UI | `createOrder` | `(ctx, CreateOrderInput) → CreateOrderResult` | `status: "created" \| "duplicate" \| "credit_blocked" \| "cancelled_duplicate"`. Setelah PAR-05 untuk hari ini → `DomainError AFTER_CUTOFF` kecuali `forceSameDayReason`. |
| UI | `cancelOrder`, `rescheduleOrder`, `changePaymentMethod`, `reconfirmOrder`, `updateOrderNotes`, `refreshOrderPrice`, `requestCreditApproval`, `requestUnderpaymentApproval` | `(ctx, orderId, input)` | Lihat `schemas.ts`. |
| UI | `getBoard`, `assignTrip`, `unassignTrip`, `reorderTrips`, `moveTripInLane`, `applySuggestedOrder`, `publishSchedule`, `publishAllSchedules`, `resolveTripConflict`, `scheduleChangeHistory` | `(ctx, input)` | Papan US-M2-03. |
| UI | `resolveDayCrews`, `driverCandidates`, `setDailyDriver`, `setRosterEntry`, `setTruckDayStatus`, `getWeekRoster`, `listCrewAssignments`, `driverDepositLocks`, `truckCapacity` | | Kru US-M2-10/11. `resolveDayCrews(tx, tenantId, date, today, truckIds?)`: penetapan harian > roster > sopir default (kecuali libur/keluar/bertugas di truk lain). |
| UI/job | `createRecurringOrder`, `updateRecurringOrder`, `setRecurringStatus`, `listRecurringOrders`, `listRecurringFailures`, `resolveRecurringFailure`, `generateRecurringOrders(now, { db?, tenantId? })`, `runRecurringGenerationNow(ctx)` | | US-M2-06. |
| UI | `previewOrderConfirmation`, `sendOrderConfirmation(ctx, orderId, { provider? })`, `getOrderConfirmationTemplate`, `updateOrderConfirmationTemplate` | | US-M2-07. |

## 2. Event

Dipancarkan (tambahan `events.types.ts` + baris `tests/core/events.test.ts`):

- `order.created` `{ orderId, number, customerId, addressId, requestedDate, tankCount, pricePerTrip, totalAmount,
  paymentMethod, source, isInternal, internalOutletId?, recurringOrderId?, status }`.
- `order.status_changed` `{ orderId, number, customerId, from, to, reason?, cancelReason? }` — setiap transisi (kantor,
  persetujuan, maupun turunan event rit).
- `trip.published` (katalog lama) `{ scheduleId, truckId, tripIds, revision }` — revisi 0 = terbit pertama.

Ditangani (`events.ts`, handler terisolasi savepoint):

| Event | Handler | Efek |
| --- | --- | --- |
| `trip.departed` | `m2-orders:order_in_delivery` | Pesanan → Dalam pengiriman (`firstDepartedAt`); rit yang ditarik kantor tetapi sudah berangkat → `syncConflict`. |
| `trip.completed` | `m2-orders:order_completed` | Pesanan → Selesai bila semua rit aktif Selesai; penanda dobel dibersihkan; konflik bila rit ditarik/truk beda. |
| `trip.failed` | `m2-orders:trip_failed` | `trip_incidents` (bila belum ada), rit pengganti (urutan berikutnya, belum terjadwal), `needsReschedule`; ≥ PAR-17 gagal berturut → `reconfirmationRequired` pesanan aktif pelanggan (BR-24) + notifikasi `trip.failed` tinggi. |
| `credit_status.changed` | `m2-orders:credit_hold_trips` | Ke Ditahan: rit tempo belum berangkat ditandai `creditHoldFlaggedAt` + notifikasi `order.credit_hold_trips` (PTB-27). Dari Ditahan: penanda dilepas. |

## 3. Persetujuan (`approvals.ts`) & notifikasi

| Jenis | objectType | Pengaju → pemutus | Disetujui | Ditolak | Lewat tenggat |
| --- | --- | --- | --- | --- | --- |
| `credit_order` | `order` | Dispatcher → Pemilik | Pesanan Baru, dapat dijadwalkan; eksposur & batas saat keputusan dicatat; batas tidak berubah | Pesanan Baru, blocker `credit_rejected` sampai tunai/batal | Cara bayar pesanan & rit → tunai + notifikasi dispatcher |
| `second_underpayment_order` | `order` | Dispatcher → Pemilik | Dapat dijadwalkan | Blocker `second_underpayment` sampai lunas | Sama dengan ditolak |

Tenggat = `approvalDeadline(now, requestedDate, PAR-07 start, PAR-07 end)`: awal jam layanan tanggal kirim (bila sudah
lewat → akhir jam layanan hari itu, lalu pagi berikutnya). Payload memuat `link: /pesanan/<id>`, eksposur, alasan.
Pembatalan pesanan membatalkan pengajuan terbuka (`systemContext`).

Notifikasi (6.3): tambahan katalog `order.recurring_failed` (dispatcher) dan `order.credit_hold_trips` (dispatcher,
tinggi); memakai yang sudah ada `order.duplicate`, `order.unscheduled`, `trip.failed`, `truck.trips_need_reassignment`.

## 4. Sinkron (`sync.ts`)

Pull `m2.schedule` (peran driver/helper): rit TERBIT hari ini untuk `ctx.scope.truckIds` (lingkup harian dari
penetapan kru US-M2-11 via `substituteDriverConditions`), urut `routeOrder`. `DriverTrip` memuat nomor rit/pesanan,
pelanggan, WA, alamat + koordinat, `requestedTime`, catatan pelanggan/alamat/pesanan (US-M2-08 KP-2), harga, cara
bayar, volume rencana, internal/depot tujuan, `collectUnderpayment` + `underpaymentOutstanding` (PTB-18), `locked` +
`lockMessage` (BR-10). Rit yang ditarik hilang pada pull berikutnya. M2 tidak punya perintah lapangan.

## 5. Pekerjaan terjadwal (`jobs.ts`)

`m2.recurring_generate` 00.20 (idempoten per pola/tanggal; horizon H+PAR-34; gagal → `recurring_order_failures` +
notifikasi) · `m2.unscheduled_morning` pada PAR-07 `start` (rit hari ini belum terjadwal/terbit → `order.unscheduled`).

## 6. Laporan ekspor (`reports.ts`, `/api/export/<kunci>`)

`m2.orders`, `m2.customer_history`, `m2.cancel_fail_monthly`, `m2.kpi06_monthly`, `m2.overrides_monthly`
(`m2.order.export`) · `m2.schedule` (`m2.schedule.read`) · `m2.crew_assignments`, `m2.crew_roster`
(`m2.crew_assignment.read`) · `m2.recurring_orders`, `m2.recurring_failures` (`m2.recurring_order.read`). Kolom alamat
ber-PII (`m9.report.export_pii` + tujuan).

## 7. Rute UI

`/pesanan` (`?q,status,dari,sampai,truk,pelanggan,bayar,penanda`; `?tampil=laporan&bulan=YYYY-MM`; `?tampil=template`),
`/pesanan/baru`, `/pesanan/[id]`, `/jadwal?tanggal=YYYY-MM-DD`, `/jadwal/kru?tanggal=`, `/langganan`. Tidak ada entri nav
baru (laporan & template = tab di `/pesanan`). Papan: DnD HTML5 + tombol (aksesibel), `router.refresh()` tiap 20 dtk.

## 8. Aturan kunci

- Nomor `nextNumber(tx, "order", bizDate)` → `P-YY-NNNNNN`; rit `…/n`; pengganti = urutan berikutnya.
- Harga dikunci saat pesanan dibuat (`resolveTruckWaterPrice` M1; internal `resolveInternalTransferPrice` + produk
  `AIR-TRUK-INT`). Harga sementara (alamat tanpa zona) tidak dapat diterbitkan sampai diperbarui (PTB-13 `refreshOrderPrice`).
- Dobel: pelanggan + tanggal sama dengan pesanan aktif → keputusan wajib (tambahan beralasan / batalkan alasan `duplicate`).
- BR-21 `compareBr21`: jam diminta → jam terima tetap → dibuat lebih awal. Kapasitas truk/hari = `truck_day_status.tripCapacity` ?? PAR-33 (peringatan, bukan blokir).
- Terbit: revisi 0 lalu `version+1`; perubahan setelah terbit (`schedule_change_logs`) → `pendingChanges` → terbit ulang.
- BR-10: setoran sopir (sumber driver) dengan `businessDate < min(date, today)` belum Ditutup → sopir tidak dapat
  ditetapkan (`DRIVER_LOCKED_BR10`), rit tampil terkunci di pull.
- Batal: tidak bila Dalam pengiriman; rit belum berangkat ditarik; pengajuan terbuka dibatalkan.
- Admin Keuangan ditolak menulis pesanan (SoD `assertNotFinanceAdminOnOrders`).

## 9. Keputusan desain

1. Pesanan yang persetujuan tempo-nya lewat tenggat menjadi tunai (bukan batal) + dispatcher diberi tahu (6.2a).
2. "Batalkan yang ini" pada dobel tetap membuat pesanan berstatus Dibatalkan (alasan `duplicate`) agar KPI-06 terukur.
3. Status pesanan diturunkan dari rit; Terjadwal = semua rit aktif punya truk & terbit.
4. Seed demo memakai nomor `P-YY-9000xx` (tidak bertabrakan dengan urutan) dan DILEWATI saat snapshot uji Vitest
   (tanggal relatif hari ini); `seed.test.ts` memanggilnya dengan `now` tetap + `{ force: true }`.
5. Template WA konfirmasi diedit dari M2 (tab Template WA, izin `m1.wa_template.*`), menulis tabel `wa_templates` (versi baru, lama dinonaktifkan; variabel wajib divalidasi).
6. `order`/`trip` bukan objek finansial di audit (sesuai `tests/core/audit.test.ts`).

## 10. Belum/terbuka

- ARCHITECTURE §8 perlu mencantumkan `order.created` dan `order.status_changed`.
- M3 wajib: konsumsi pull `m2.schedule`, pancarkan `trip.departed/completed/failed` (payload katalog), hormati `locked`.
- Kunci PAR-83 (belum dipakai M2) dan KPI-07 (rit terealisasi vs terjadwal) diserahkan ke M9/M12.
- US-M2-01 KP-7 (< 60 dtk/pesanan) diverifikasi UAT manusia; E2E hanya proksi waktu.

## 11. S5 pengerasan — paket B

- **B-35** `computeCreditExposure` = M5 `computeExposure` (satu batas kredit lintas lini PTB-25): kini memuat penjualan
  tempo toko Sah yang belum difakturkan (`uninvoicedStoreCredit`, shift toko masih terbuka); opsi baru `excludeSaleId`.
  Pesan penolakan menyebut komponen tempo toko. M7 `storeCreditExposure` memakai angka yang sama. Uji
  `tests/integration/credit-exposure.test.ts` (`B-35 …`).
- **B-64** `createOrder` menerima `source` (`office` bawaan | `customer_app` | `partner_portal`; kanal non-kantor hanya
  untuk pelaku sistem — pengguna kantor ditolak) dan `slot` (PAR-73); `order.created` memuat `source` & `slot`
  (tambahan katalog event: `OrderCreatedPayload.slot?`). P2 & P3 tidak lagi memperbarui kolom setelah pesanan dibuat
  (berkas P3 `service/portal-orders.ts` ikut disesuaikan). Uji `tests/p2-customer/orders.test.ts`,
  `tests/p3-partner/phase3-pos-orders.test.ts`.
- **B-55** rincian pesanan `/pesanan/[id]`: kolom "Jurnal" per rit Selesai (`JournalLink`, hanya pemegang
  `m11.journal.read`). **B-24**: formulir memakai `useFlashActionState`.

## 12. Perbaikan audit S5B (paket A)

- **US-M2-02 KP-2**: `recomputeOrderStatus` memancarkan `order.status_changed { from, to, reason }` pada SETIAP
  transisi turunan rit (terbit, dalam pengiriman, selesai, kembali Baru) — P2 tidak perlu emit manual.
- **Bab 5.2**: pesanan yang punya rit Selesai berstatus minimal Dalam pengiriman; `cancelOrder` atas pesanan terkirim
  sebagian menarik sisa rit lalu pesanan menjadi Selesai (audit `cancel_remaining`).
- **US-M2-05 KP-3/KP-6**: `changePaymentMethod` hanya menggugurkan persetujuan tempo (`only: "credit"`), bukan
  persetujuan kurang bayar kedua.
- **BR-24 / PTB-01**: rit internal gagal berturut tidak mewajibkan konfirmasi ulang pelanggan.
- **PTB-18**: saat terbit ulang, penghalang kurang bayar kedua/konfirmasi ulang hanya untuk rit yang belum terbit.
- Uji: `tests/m2-orders/status-fixes.test.ts` (5), `tests/p2-customer/orders.test.ts` (KP-4 alur nyata).
