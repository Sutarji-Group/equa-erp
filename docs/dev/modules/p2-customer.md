# P2 — Aplikasi Pelanggan, Tahap 2 (catatan pengembang)

Cakupan: US-P2-01..06 & US-P2-08 (PRD Bab 8; 8.1–8.7, PTB-50..54, PAR-72..75, NFR-29). **US-P2-07 (C) tidak dibangun**
(D-02). Semua di balik flag **`phase2.customer_app`** (bawaan mati; pemilik menyalakan lewat `/keluhan/akun` →
`setCustomerAppEnabled`, mencatat `flags.set` beralasan). Panduan pengguna: `docs/guides/p2-customer.md`. Uji:
`tests/p2-customer/*` (8 berkas, 53 uji, semua KP M & S yang dapat diotomatiskan), E2E `e2e/p2-customer.spec.ts`
(kantor) + `e2e/p2-customer.mobile.spec.ts` (PWA pelanggan).

## 1. Arsitektur singkat

Dua jenis pelaku:
- **Pelanggan** — `CustomerContext` (`service/common.ts`): autentikasi terpisah dari pengguna kantor (`customer_accounts`,
  `customer_sessions`, cookie `equa_pelanggan` httpOnly, sesi `p2.customer_app_rules.session_days` = 30 hari, OTP PAR-74
  lewat WhatsApp). Fungsi `(cctx, input)` memeriksa **kepemilikan** (akun → `customer_id` → alamat/pesanan/faktur milik
  sendiri, 8.6), lalu memanggil layanan M1/M2/M5 atas nama **Sistem** (`sysCtx(tenantId, now)`) sehingga aturan Tahap 1
  berlaku utuh (harga master, kredit, cek dobel, PAR-05). Audit pelanggan: `recordCustomerAudit` (sumber
  `customer_app`, pelaku = akun pelanggan).
- **Kantor** — `ActorContext`: pola baku `authorize → parseInput → aturan/SoD → runService → audit.record → emit`.

```
src/server/modules/p2-customer/
  service/common.ts        CustomerContext, sysCtx, appRules (p2.customer_app_rules), assertAppEnabled, isAppEnabled,
                           addServiceHours (PAR-07 jam layanan), maskPhone, firstName, recordCustomerAudit
  service/auth.ts          OTP masuk (PAR-74, batas kirim ulang/jam), sesi (hash token), verifikasi ulang pembayaran
                           (payment_reverify_minutes), ganti nomor 2 langkah (nomor lama → baru), revokeAccountSessions
  service/accounts.ts      completeRegistration (UU PDP; cocok nama ≥ name_match_min_pct → tertaut; tidak cocok →
                           pending_review + permintaan kantor 8.7; nomor baru → m1.createCustomer Tunai + titik peta),
                           verifyAccount (link/new_customer/reject), officeChangePhone, requestAccountDeletion
                           (nonaktif + anonim akun; permintaan ke Admin sistem), setCustomerAppEnabled, daftar akun
  service/addresses.ts     alamat milik sendiri; titik peta → m1.mapAddressToZone (zona & harga); titik terkunci tidak
                           dapat diubah pelanggan; applyCustomerPin
  service/slots.ts         slot PAR-73 dari kapasitas m2.getWeekRoster − rit terpesan; H+0 setelah PAR-05 ditutup
  service/orders.ts        quoteOrder (harga master + opsi bayar: tunai/transfer/digital/tempo via kontrol kredit),
                           placeOrder (idempoten clientRequestId; m2.createOrder lalu tandai source/slot/akun;
                           customer_app_orders + tenggat PAR-75), reorder, cancelMyOrder (≤ Berangkat, m2.cancelOrder),
                           getMyOrder (garis waktu), listAppOrders/confirmAppOrder/rejectAppOrder (Dispatcher)
  service/tracking.ts      posisi truk hanya saat rit Berangkat, hanya pesanan sendiri (PTB-54), dari M12
  service/billing.ts       tagihan terbuka (M5), riwayat PDF 24 bulan, faktur PDF milik sendiri, struk digital
  service/gateway.ts       PaymentGateway: midtransGateway (Core API QRIS/VA) & mockGateway (dev/uji; HMAC SESSION_SECRET)
  service/payments.ts      createPaymentIntent (faktur/semua/bayar di muka pesanan; wajib reverify), handleGatewayNotification
                           (tanda tangan, idempoten, Berhasil → customer_payments kanal digital + alokasi faktur tertua,
                           sisa → uang muka; emit collection.recorded + digital_payment.succeeded; bayar di muka →
                           orders/trips.payment_method = digital), expirePendingIntents, markIntentMatched
  service/subscriptions.ts langganan milik sendiri via m2.create/updateRecurringOrder; pengingat isi ulang (rata-rata jarak
                           pesanan); notifikasi kegagalan pembuatan pesanan langganan
  service/feedback.ts      penilaian 1–5 per rit Selesai; keluhan (foto → storage `complaint_photo`, kotak menurut jenis,
                           tenggat PAR-75 complaint_response_hours), tanggapan/penyelesaian/pindah kotak, sengketa faktur
                           (m5.disputeInvoice), laporan bulanan per jenis & per truk, ratingAggregates (untuk M9)
  service/messaging.ts     notifyCustomer: notifikasi aplikasi + web push (setelah commit) + WA template Cloud API
                           (dedupe `${dedupeKey}:wa`; `waEvenWithoutApp` untuk pelanggan tanpa aplikasi, US-P2-08)
  service/wa-cloud.ts      webhook WA: verifikasi challenge (WA_WEBHOOK_VERIFY_TOKEN), tanda tangan (WA_APP_SECRET),
                           status tidak pernah mundur, biaya per pesan sekali (p2.wa_pricing → wa_message_costs)
  service/inbox.ts         notifikasi pelanggan, langganan push
  service/events-logic.ts  handler event (§3.2)
  service/overview.ts      adoptionOverview (pemilik), prepaidTripsPull (sopir)
  web.ts                   (bukan API publik) cookie, getCustomer, requireCustomer, appEnabled, attemptCustomer
```

Tabel (`src/db/schema/p2-customer.ts`): `customer_accounts`, `customer_sessions`, `otp_codes`, `customer_account_requests`,
`phone_change_requests`, `customer_app_orders`, `payment_intents`, `trip_ratings`, `complaints`, `complaint_actions`,
`refill_reminder_prefs`, `customer_notifications`, `customer_push_subscriptions`, `wa_message_costs`,
`customer_download_logs`. Tidak ada DELETE: akun dinonaktifkan/dianonimkan, keluhan tidak dapat dihapus.

## 2. API publik (`index.ts`)
- Autentikasi: `requestLoginOtp(tx?, {phone, meta})`, `verifyLoginOtp`, `createCustomerSession`, `resolveCustomerSession`,
  `logoutCustomer`, `requestPaymentOtp(cctx)`, `verifyPaymentOtp(cctx,{code})`, `isReverified`, `startPhoneChange`,
  `confirmOldPhone`, `completePhoneChange`, `revokeAccountSessions`.
- Akun: `completeRegistration(cctx, {name, consent, address?})`, `getMyProfile`, `requestAccountDeletion`,
  `verifyAccount(ctx, {decision, requestId, …})`, `officeChangePhone`, `listAccounts`, `listAccountRequests`,
  `customerAppStatus`, `setCustomerAppEnabled(ctx, {enabled, reason})`, `linkedAccounts`, `nameSimilarity`.
- Alamat/slot/pesanan: `listMyAddresses`, `addMyAddress`, `updateMyAddress`, `deactivateMyAddress`,
  `slotAvailability(tx, {tenantId, now, from?, days?, tankCount})`, `quoteOrder`, `placeOrder(cctx, {addressId, tankCount,
  date, slot, paymentMethod, notes?, clientRequestId?})`, `reorder`, `cancelMyOrder(cctx, orderId, {reason})`,
  `listMyOrders`, `getMyOrder`, `getTracking`, `listAppOrders(ctx, {view})`, `confirmAppOrder(ctx, orderId, {note?})`,
  `rejectAppOrder(ctx, orderId, {reason})`, `notifyOverdueConfirmations(tx, now)`.
- Tagihan & bayar: `myBilling`, `myHistoryPdf`, `myInvoicePdf`, `myReceipt`, `readMyAttachment`,
  `createPaymentIntent(cctx, {target: invoice|all_invoices|order, invoiceId?, orderId?, method})`,
  `getMyPaymentIntent`, `handleGatewayNotification(body, headers)`, `simulateMockPayment` (hanya gerbang tiruan),
  `expirePendingIntents`, `markIntentMatched`, `listPaymentIntents(ctx)`, `prepaidTrips`, `activeGateway`,
  `digitalPaymentAvailable`, `setPaymentGatewayForTests`, `signMockNotification`.
- Langganan: `listMySubscriptions`, `saveMySubscription`, `setMySubscriptionStatus`, `refillEstimate`, `myRefillReminder`,
  `setRefillReminder`, `sendRefillReminders(tx, now)`, `notifyRecurringFailures(tx, now)`.
- Penilaian & keluhan: `rateDelivery(cctx, tripId, {rating, comment?})`, `submitComplaint`, `listMyComplaints`,
  `getMyComplaint`, `listComplaints(ctx, {box, status})`, `getComplaint`, `respondComplaint`, `resolveComplaint`,
  `reassignComplaint`, `disputeInvoiceFromComplaint`, `notifyOverdueComplaints`, `ratingOverview`,
  `ratingAggregates(tx, {tenantId, from, to})`, `complaintReport`, `complaintMonthlyReport`, `defaultBox`, `complaintBoxFor`.
- Pesan: `notifyCustomer(tx, {...})`, `customerWaProvider`, `cloudTemplateProvider`, `isAutoWaActive`,
  `WA_TEMPLATE_NAMES`, `listMyNotifications`, `unreadNotificationCount`, `markMyNotificationsRead`,
  `registerPushSubscription`, `handleWaStatusWebhook`, `verifyWaWebhookChallenge`, `verifyWaSignature`, `signWaWebhook`,
  `waCostSummary(ctx, {month})`.
- Ringkasan: `adoptionOverview(ctx, {month})`, `prepaidTripsPull(tx, ctx)`.

## 3. Event
### 3.1 Dipancarkan
| Event | Kapan | Muatan (tambahan P2 opsional di `events.types.ts`) |
|---|---|---|
| `order.created` (oleh M2) | `placeOrder` lewat `m2.createOrder` | muatan M2 (`source` = office — lihat isu terbuka) |
| `collection.recorded` | pembayaran digital Berhasil | `customerPaymentId, customerId, amount, channel: "digital", method, allocations[], advanceAmount, businessDate` |
| `digital_payment.succeeded` | idem | `paymentIntentId, customerId, amount, gatewayFee, method, invoiceIds, customerPaymentId, orderId, prepaid, gatewayOrderId, gateway, advanceAmount, businessDate` → M4 membuat transfer masuk untuk dicocokkan |
Notifikasi kantor (katalog 6.3, `customer_app.*`): `order_submitted`, `order_confirm_overdue`, `account_review`,
`deletion_requested`, `complaint_submitted`, `complaint_overdue`, `payment_succeeded`.
### 3.2 Didengar (`events.ts`, terisolasi savepoint)
| Event | Handler | Fungsi |
|---|---|---|
| `order.status_changed` | `p2-customer:order_status` | → `scheduled`: pesanan aplikasi Dikonfirmasi (jadwal di papan = konfirmasi) + notifikasi; pelanggan tanpa aplikasi mendapat WA konfirmasi otomatis bila Cloud API aktif. → `cancelled` oleh kantor: pemberitahuan beralasan |
| `trip.departed` | `p2-customer:trip_departed` | notifikasi "Dalam perjalanan" + tautan pelacakan |
| `trip.completed` | `p2-customer:trip_completed` | notifikasi Selesai + struk digital WA (`trip_receipt`) |
| `trip.failed` | `p2-customer:trip_failed` | notifikasi Gagal dengan alasan layak pelanggan |
| `transfer.matched` | `p2-customer:digital_matched` | transfer "pembayaran digital" dicocokkan → intent `matched` |

## 4. Lapangan & pull
PWA pelanggan daring (bukan outbox). Pull `p2.prepaid_trips` (peran driver/helper): rit hari ini pada truk dalam lingkup
harian yang sudah dibayar di muka → aplikasi sopir dapat menampilkan "sudah dibayar". Cara bayar rit juga sudah diubah ke
`digital` di M2 saat pembayaran Berhasil.

## 5. Registrasi
- Job: `p2.app_orders.overdue`, `p2.complaints.overdue`, `p2.payments.expire` (tiap 5 menit); `p2.refill.reminders`
  (harian 08.10); `p2.recurring.failures` (harian 06.05).
- Persetujuan: tidak ada (`approvals.ts` kosong beralasan: aktivasi aplikasi = keputusan pemilik lewat flag; sengketa
  memakai alur M5; anonimisasi memakai alur M10).
- Laporan (`reports.ts`, modul `p2`): `p2.app_orders`, `p2.complaints`, `p2.complaints_monthly`, `p2.ratings`,
  `p2.rating_comments`, `p2.payment_intents`, `p2.wa_costs`, `p2.customer_accounts` (berisi PII → tujuan ekspor wajib).
- Audit (`audit.ts`): label objek; `payment_intent` objek keuangan; akses lampiran `complaint` (izin
  `p2.complaint.read`, tenant sama).
- Parameter baru: `p2.customer_app_rules`, `p2.payment_rules`, `p2.wa_pricing`; memakai PAR-05/07/72..75.
- Izin baru: `p2.customer_account.verify`, `p2.app_order.read`, `p2.app_order.confirm`, `p2.wa_cost.read`,
  `p2.adoption.read` (izin `p2.customer_account.read`, `p2.complaint.*`, `p2.rating.read`, `p2.payment_intent.read`
  sudah ada di katalog S0).

## 6. Rute
| Rute | Pelaku | Isi |
|---|---|---|
| `/app/masuk`, `/app/daftar` | pelanggan | OTP WA; lengkapi pendaftaran (UU PDP, titik peta) / menunggu verifikasi |
| `/app`, `/app/pesan`, `/app/pesan/ulang` | pelanggan | beranda; pesan ≤ 4 langkah; pesan ulang |
| `/app/pesanan`, `/app/pesanan/[id]`, `/app/struk/[tripId]` | pelanggan | riwayat; garis waktu, peta truk, batal, bayar di muka, penilaian; struk |
| `/app/tagihan`, `/app/bayar/[id]`, `/app/bayar/verifikasi` | pelanggan | tagihan & PDF; QRIS/VA + status; OTP ulang |
| `/app/langganan`, `/app/keluhan(/baru, /[id])`, `/app/akun`, `/app/notifikasi` | pelanggan | langganan; keluhan; alamat, ganti nomor, hapus akun, pengingat; notifikasi |
| `/api/customer/{lampiran,faktur,riwayat,lacak,pembayaran,push}` | pelanggan | berkas milik sendiri, posisi truk, status bayar, langganan push (tolak lintas situs) |
| `/api/customer/webhook/pembayaran`, `/api/customer/webhook/wa` | gerbang / Meta | tanda tangan wajib (401 bila salah) |
| `/keluhan`, `/keluhan/[id]` | `p2.complaint.read` | kotak keluhan per kotak (Operasional/Tagihan), tanggapi/tutup/pindah/sengketa |
| `/keluhan/pesanan-aplikasi` | `p2.app_order.read` | konfirmasi/tolak ≤ PAR-75 |
| `/keluhan/penilaian` | `p2.rating.read` | rata-rata per truk/sopir, komentar |
| `/keluhan/pembayaran` | `p2.payment_intent.read` / `p2.wa_cost.read` | pembayaran digital; biaya WA |
| `/keluhan/laporan` | `p2.adoption.read` | adopsi & laporan bulanan keluhan |
| `/keluhan/akun` | `p2.customer_account.read` | aktivasi (pemilik), verifikasi akun, ganti nomor, daftar akun |

## 7. Aturan & keputusan desain
- Pesanan aplikasi = pesanan M2 biasa (`source = customer_app`, `slot`, `created_by_customer_account_id`); pilihan
  "Bayar sekarang" dibuat sebagai `cash` di M2 sampai Berhasil, lalu `orders/trips.payment_method = digital`.
- Harga tidak pernah dikirim klien: ringkasan & pesanan menghitung ulang dari master (`quoteOrder`).
- Konfirmasi Dispatcher dihitung dari `confirmAppOrder` ATAU status Terjadwal di papan; tenggat PAR-75 dihitung dalam jam
  layanan PAR-07 (`addServiceHours`).
- Pelanggan hanya melihat datanya sendiri; setiap unduhan PDF dicatat (`customer_download_logs`).
- OTP & pembayaran di produksi WAJIB WhatsApp Cloud API dan gerbang Midtrans; mode uji (kode OTP di layar, gerbang
  tiruan) hanya bila `devSecretsAllowed` (`ALLOW_DEV_SECRETS=1` / non-produksi).
- Seed demo (`src/db/seed/demo-p2-customer.ts`) idempoten, flag tetap mati; dilewati saat snapshot Vitest.

## 8. Isu terbuka / tindak lanjut modul lain
1. **M2**: `createOrder` belum menerima `source`/`slot` → `order.created` terpancar dengan `source: office`; P2
   memperbarui kolom setelahnya. Usul: parameter `source`/`slot` di M2.
2. **M11 — jurnal dobel pembayaran digital (TERKONFIRMASI saat cek akhir; DIPERBAIKI integrasi P3+P2, backlog B-62 — `digitalPayment()` hanya menjurnal `gateway_fee` bila `customerPaymentId` terisi, uji `tests/integration/p2-m11.test.ts`)**: satu pembayaran Berhasil memancarkan
   `collection.recorded` (kanal/cara `digital`) DAN `digital_payment.succeeded`. M11 menjurnal keduanya dengan pemetaan
   yang sama (`collection.recorded`/`transfer` dan `digital_payment.succeeded`/`default`, keduanya D 1-1301 / K 1-1401,
   `src/db/seed/accounting.ts`) → piutang terkredit dua kali. Usul perbaikan di M11 (`auto-journals.ts` `digitalPayment()`):
   bila `customerPaymentId` terisi, jurnal HANYA `gateway_fee` (pelunasan & uang muka sudah dari `collection.recorded`).
   M4 (`onCollectionRecorded`) sudah benar melewati kanal `digital`. Catatan M4: transfer masuk dibuat sebesar nilai
   bruto, sedangkan settlement gerbang = bruto − `gatewayFee` → pencocokan perlu memperhitungkan biaya gerbang.
   `wa_message_costs` masuk laporan biaya bulanan M11 (NFR-29).
3. **M3/M5**: tampilkan "sudah dibayar di muka" di aplikasi sopir memakai pull `p2.prepaid_trips` / cara bayar
   `digital`; rit `digital` tidak ditagih tunai dan tidak menjadi faktur kurang bayar.
4. **M9**: tampilkan `ratingAggregates` & `complaintReport` di kinerja sopir/truk (US-M9-05).
5. **Core**: `getWhatsAppProvider` masih mode tautan; P2 memakai `customerWaProvider()` (template Cloud API) sendiri.
6. Service worker belum menangani event `push` (langganan push tersimpan; pengiriman memakai pengirim yang dapat
   diganti) — perlu handler di `src/app/sw.ts` (berkas bersama PWA).
7. Batas ukuran unggahan foto keluhan mengikuti batas Server Action (B-18); pengaburan wajah foto belum ada.
8. `WA_WEBHOOK_VERIFY_TOKEN` / `WA_APP_SECRET` dibaca dari `process.env` (belum di `serverEnv()` bersama).
9. Anonimisasi data pelanggan setelah "Hapus akun" tetap lewat M10 (Admin sistem mencatat, pemilik menyetujui).
10. KP yang hanya dapat diuji saat UAT: layar ≤ 2 detik di 4G & pemesanan ≤ 60 detik (pengukuran manusia).
