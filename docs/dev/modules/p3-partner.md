# P3 — Kemitraan: Paket Minimum Mitra Fase 1 (RL-7) + Portal Kemitraan Tahap 3 (catatan pengembang)

Kode: `src/server/modules/p3-partner/` (API publik HANYA `index.ts`), UI kantor `src/app/(office)/kemitraan/**`, portal
pemilik mitra `src/app/(portal)/mitra/**`, komponen `src/components/p3-partner/**`, uji `tests/p3-partner/**`, E2E
`e2e/p3-partner.spec.ts`, seed demo `src/db/seed/demo-p3-partner.ts`, panduan `docs/guides/p3-partner.md`.
PRD Bab 9 (9.10 = RL-7 US-P3-08..11; 9.5 = Tahap 3 US-P3-01..07), 6.2a, NFR-30, D-02/D-03 (PTB-55..59, PTB-61), D-07, D-10.

- **RL-7 (AKTIF, tanpa flag):** US-P3-08 pasokan & neraca air mitra, US-P3-09 tagihan langganan sistem, US-P3-10
  portal baca-saja pemilik mitra + laporan bulanan, US-P3-11 dukungan teknis (SLA 48 jam). Backlog B-07 (M10 akun &
  tablet tenant mitra) dan B-13 (portal memakai fungsi laporan M6) SELESAI.
- **Tahap 3 (flag `phase3.partner_portal`, bawaan MATI; global atau per tenant):** US-P3-01..07. Semua layanan Tahap 3
  memeriksa flag (`assertPortalEnabled`/`authorizePortalAction`); layar menampilkan `Phase3Disabled` bila mati.
- Istilah UI "Mitra Depot EQUA"/"Kemitraan Depot EQUA" kecuali flag `partner.franchise_terms` (PTB-57) → `partnerTerms()`.

## 1. Model tenant & isolasi (NFR-30)

- Data operasional mitra (outlet, POS, shift, stok, buku air, pasokan diterima, daftar periksa mutu, dukungan) hidup di
  **tenant mitra** (`tenants.kind = partner`). Pelanggan mitra, pesanan air, faktur, pelunasan hidup di **tenant EQUA**
  (`kind = owner`); pelanggan mitra ditautkan lewat `customers.is_equa_partner/partner_tenant_id/partner_outlet_id`.
- Layanan kantor P3 WAJIB pelaku tenant EQUA (`assertOwnerTenant`). Layanan portal WAJIB pelaku pemilik mitra pada
  tenantnya (`assertPartnerActor`, tenant = `ctx.tenantId`, tidak pernah parameter). Parameter outlet/tenant/faktur
  milik tenant lain → `ForbiddenError` + log akses (`denyCrossTenant`; di luar transaksi `recordDenial`).
- Hak baca EQUA atas data mitra = `EQUA_READ_RIGHTS` (label `partner_read_right`), tampil di rincian mitra & portal.
- Lampiran: kantor `GET /kemitraan/lampiran/[id]` (`readPartnerAttachmentForEqua`), portal `GET /mitra/lampiran/[id]`
  (`readPartnerAttachmentForPortal`; termasuk tanda tangan penerima rit pelanggan mitranya).

## 2. API publik (`index.ts`, ringkas — semua `fn(ctx, input, opts?: { tx })` kecuali disebut)

| Area | Fungsi |
| --- | --- |
| Bersama | `partnerTerms(tx)`, `portalEnabled(tx, tenantId?)`, `assertPortalEnabled(tx, tenantId?)`, `LIVE_CONTRACT_STATUSES` |
| Mitra (US-P3-08) | `listPartners`, `getPartnerDetail(ctx, tenantId)`, `partnerFormOptions`, `linkPartnerCustomer({customerId, tenantId, outletId, reason})`, `registerPartnerOperator({tenantId, outletId?, fullName, username, role: depot_operator\|partner_owner, reason})` (B-07 → M10 `createUser({tenantId})` + persetujuan pemilik), `registerPartnerDevice({tenantId, outletId, deviceCode, name, kind})` → kode aktivasi, `issuePartnerOperatorPin({tenantId, userId})`, `EQUA_READ_RIGHTS` |
| Pasokan & neraca | `supplyBoard(ctx, {month?, tenantId?})`, `partnerWaterBalance(tx, tenantId, month)` (tanpa otorisasi), `purchaseHistory(tx, tenantId, {from,to})`, `partnerPurchaseHistory`, `runPartnerWaterBalanceCheck(now, {db?, onExceeded?})`, `runWaterOrderSlaCheck(now, db?)` |
| Kontrak & tagihan | `createContract(CreateContractInput)` → Draf + persetujuan `partner_contract`, `proposeContractTerms` (berlaku bulan berikutnya), `listContracts`, `getContract`, `effectiveTerms(contract, periodMonth)`, `describeContractTerms`, `recordEvaluation`, `runContractLifecycle(now)`, `computePartnerBill(tx, contract, month)`, `runSubscriptionBilling(now)`, `runSubscriptionBillingNow(ctx, {month?})`, `billingPeriodFor(tx, date)`, `subscriptionBoard`, `royaltyDetail(ctx, {contractId, month})`, `disputePartnerInvoice` (portal, Tahap 3) |
| Portal (US-P3-10) | `portalHome(ctx, {month?})`, `portalSalesReport(ctx, {from?, to?, outletId?})`, `portalSupplyReport(ctx, {month?, outletId?})`, `portalInvoices`, `portalInvoice(ctx, id)`, `portalPurchaseHistory`, `portalMonthlyReports`, `portalMonthlyReport(ctx, period)`, `portalOpenTenant(ctx, tenantId)`; Tahap 3: `portalDashboard(ctx, {month?})` (= `partnerMetrics` tenant sendiri, `null` bila flag mati), `portalOrders`, `portalQuality(ctx, {month?})`, `portalSanctions`, `portalRoyaltyDetail(ctx, {month?})` |
| Laporan bulanan | `buildMonthlyReportData(tx, tenantId, month, now)`, `runMonthlyReports(now)` (terbit ≥ tgl `monthly_report_day`), `publishMonthlyReportsNow(ctx, {month?})`, `monthlyReportsOf(tx, tenantId)` |
| Dukungan (US-P3-11) | `submitSupportRequest` (portal), `respondSupportRequest`, `completeSupportRequest`, `linkSupportSparePart`, `listSupportRequests`, `getSupportRequest`, `supportSaleCandidates`, `supportSlaSummary(tx, tenantId, month, now)`, `runSupportSlaCheck(now)` |
| Tahap 3 US-P3-01 | `registerProspectFromPortal(input)` (publik), `createProspect`, `recordSurvey`, `assessLocation(tx, {lat,lng,date})`, `overrideRadius`, `submitProspect`, `createContractFromProspect`, `listProspects`, `getProspect`, `onboardingBoard`, `onboardingViews(tx, tenantId)`, `onboardingCandidates`, `completeOnboardingItem`, `signSop` (portal), `ONBOARDING_ITEMS` |
| US-P3-02 | `partnerSettingsView(ctx, {outletId})`, `updatePartnerPosSettings({outletId, prices[], fixedOpeningCash?, voidThreshold?, reason})` (portal; berlaku besok; batas `p3.partner_rules`) |
| US-P3-03 | `createPortalWaterOrder` → pesanan M2 (`source partner_portal`, harga zona − diskon Opsi A), `createPortalSparePartOrder`, `cancelPortalSparePartOrder`, `sparePartCatalog(tx, date)`, `pendingSparePartOrders(tx)`, `linkPortalOrderSale`, `portalOrdersOf(tx, tenantId)`, `discountedWaterPrice`, `portalOrderStatusText` |
| US-P3-05 | `recordPartnerQualityTest` (M8 `recordQualityTest` di tenant mitra), `scheduleAudit`, `conductAudit`, `closeAuditFollowUp`, `computeOutletScore(tx, outletId, month)`, `checklistCompliance`, `qualityBoard`, `qualityEvidence(tx, outletId)`, `runAuditChecks`, `runQualityMonthly`, `QUALITY_ITEMS` |
| US-P3-06 | `partnerDashboard`, `coachPortfolio` (termasuk jadwal audit dengan nama mitra/outlet), `partnershipEconomics`, `partnerMetrics(tx, tenant, month, today)` |
| US-P3-07 | `recordSanctionTrigger(tx, {...})`, `proposeSanction`, `liftSanction`, `listSanctions`, `sanctionsOfTenant(tx, tenantId)`, `activeSanctions`, `activeSupplySuspension`, `runSanctionChecks(now)`, `markPartnerDataExported` |

## 3. Event domain

**Dipancarkan:** `invoice.issued` (kind `partner_subscription`, `profitCenter L5`, faktur gabungan BR-05) dan
`partner.subscription_invoiced` (`amount` = pendapatan L5 saja: langganan + royalti + fee awal; `mergedWaterAmount`
BUKAN pendapatan baru — D-10 butir 1; M11 menjurnal L5). `credit_status.changed` saat kontrak disetujui mengubah
status kredit pelanggan mitra (batas kredit kontrak).

**Ditangani (`events.ts`):**

| Event | Handler | Efek |
| --- | --- | --- |
| `order.created` | `p3-partner:water_order_sla` | pesanan air pelanggan mitra → `orders.sla_due_at` = dibuat + PAR-76 |
| `trip.completed` | `p3-partner:supply_arrival` | rit pelanggan mitra Selesai → `water_supply_receipts` "Tiba" di outlet mitra (idempoten per rit) |
| `water_supply.confirmed` | `p3-partner:supply_difference` | selisih kirim–terima pasokan mitra → notifikasi Dispatcher EQUA |
| `order.created` | `p3-partner:supply_suspension` (`isolate: false`) | Tahap 3: penghentian pasokan berlaku → pesanan air DITOLAK (alasan & syarat) |
| `shift.opened` | `p3-partner:read_only_tenant` (`isolate: false`) | Tahap 3: tenant baca-saja tidak dapat membuka shift |
| `pos_sale.recorded` | `p3-partner:spare_part_order` | penjualan toko harga mitra → konfirmasi pesanan spare part portal |
| `credit_status.changed` | `p3-partner:credit_hold_trigger` | Ditahan pelanggan mitra → pemicu sanksi (Tahap 3) |

## 4. Sinkron, persetujuan, notifikasi, job, laporan

- **Sinkron:** perintah `p3.quality_checklist.submit` (operator depot mitra; idempoten per perintah; outlet-hari yang
  sudah terisi → `conflict`; foto per butir = lampiran berjenis `quality_photo_<butir>` atau `photoAttachmentId`).
  Pull `p3.partner_pos` (depot_operator: `readOnly`, `phase3`, `supplySuspended`, status & butir daftar periksa hari
  ini) dan `p3.store_partner_orders` (store_cashier: pesanan spare part portal menunggu).
- **Komponen POS:** `<PosQualityChecklist shiftId? />` (`src/components/p3-partner/pos-quality-checklist.tsx`, di dalam
  `<FieldGate>`) + pembangun muatan murni `buildChecklistCommand` (`checklist-command.ts`). M6 WAJIB memasangnya di
  aplikasi POS (menu Shift, setelah buka shift) — lihat §8.
- **Persetujuan** (`approvals.ts`, 6.2a): `partner_contract` (kind `create` → kontrak Aktif + batas kredit/tagihan
  bulanan pelanggan + mulai tagih outlet + wilayah eksklusif + daftar periksa onboarding; kind `terms_change` →
  berlaku bulan berikutnya), `partner_prospect`, `partner_sanction` (Teguran bersurat / penghentian pasokan /
  pemutusan + tenggat ekspor data PTB-58). Tanpa tenggat (onExpired = catatan).
- **Notifikasi** (katalog, tambahan): `partner.water_balance_exceeded`, `partner.subscription_invoiced`,
  `partner.support_submitted`, `partner.support_responded`, `partner.monthly_report_published`,
  `partner.contract_expiring`, `partner.evaluation_due`, `partner.sanction_triggered`, `partner.onboarding_completed`,
  `partner.prospect_registered`, `partner.spare_part_order`, `partner.quality_failed`, `partner.read_only`,
  `partner.data_export_due`; memakai yang ada `partner.water_order_sla`, `partner.support_sla`.
- **Job:** `p3.water_order_sla` & `p3.support_sla` (5 menit), `p3.contract_lifecycle` (00.30), `p3.subscription_billing`
  (00.40; terbit pada tanggal PAR-12), `p3.water_balance_monthly` (tgl 1), `p3.monthly_reports` (06.30; tgl ≥ 5),
  Tahap 3: `p3.sanction_checks` (07.00), `p3.audit_checks` (07.20), `p3.quality_monthly` (tgl 1).
- **Laporan ekspor** (`/api/export/<kunci>`): `p3.partners`, `p3.partner_supply`, `p3.partner_water_balance`,
  `p3.late_water_orders`, `p3.subscription_invoices`, `p3.support_requests`, `p3.partner_monthly` (PDF laporan bulanan;
  pemilik mitra hanya laporan terbit tenantnya), `p3.partner_sales`, `p3.partner_purchases`, `p3.contracts`,
  `p3.prospects`, `p3.sanctions`, `p3.quality_scores`, `p3.partner_dashboard`, `p3.coach_portfolio`,
  `p3.partnership_economics`, `p3.royalty_detail`, `p3.partner_data_export`.
- **Parameter:** PAR-12, 35, 76, 77, 78, 79, 80, 81 (Lampiran B) + `p3.partner_rules`, `p3.quality_weights`,
  `p3.economics_illustration` (registri, pemilik).

## 5. Rute

- Kantor (`requirePermission` di setiap halaman): `/kemitraan` (mitra), `/kemitraan/mitra/[id]` (rincian, akun &
  tablet mitra B-07), `/kemitraan/pasokan`, `/kemitraan/langganan`, `/kemitraan/dukungan` (+ `/[id]`),
  `/kemitraan/kontrak`; Tahap 3: `/kemitraan/calon` (+ `/[id]`), `/kemitraan/onboarding`, `/kemitraan/mutu`,
  `/kemitraan/sanksi`, `/kemitraan/dasbor`; lampiran `/kemitraan/lampiran/[id]`.
- Portal (`requirePortalSession`, `src/app/(portal)/mitra/_session.ts`; sesi `equa_session` dari
  `loginWithPassword(..., { interface: "portal" })`, hanya peran berantarmuka `portal`): `/mitra/masuk`,
  `POST /mitra/keluar`, `/mitra` (beranda), `/mitra/penjualan`, `/mitra/pasokan`, `/mitra/tagihan`,
  `/mitra/laporan-bulanan`, `/mitra/dukungan`, `/mitra/lampiran/[id]`; Tahap 3: `/mitra/pesanan`, `/mitra/mutu`,
  `/mitra/pengaturan`, `/mitra/sanksi`, publik `/mitra/daftar` (pendaftaran calon mitra).

## 6. Aturan penting & keputusan desain

1. Pemilik mitra baca-saja pada RL-7 (US-P3-10 KP-1): izin portal statis hanya `*.read` + `p3.support_request.create`.
   Tindakan portal Tahap 3 (`p3.portal_*`) TIDAK ada di matriks; diberikan BERSYARAT oleh `authorizePortalAction`
   bila flag Tahap 3 aktif untuk tenant itu (D-02) — selain itu ditolak & tercatat.
2. Tagihan langganan = outlet Aktif (`activated_on` & `billing_start_date` ≤ akhir bulan) × tarif kontrak berlaku bulan
   itu; terbit tanggal PAR-12 untuk bulan lalu; idempoten per kontrak-bulan; faktur bulanan dapat menggabungkan air &
   spare part tempo belum ditagih (BR-05). Koreksi = nota kredit M5 (faktur tidak dapat dihapus, DB menolak).
3. Parameter kontrak berubah → persetujuan pemilik → berlaku mulai periode berikutnya (`pending_terms`), berjejak.
4. Neraca air mitra = rumus M6 `waterPeriodBalance` (US-M6-05 KP-4): galon terjual × ukuran galon vs stok awal + air
   dari EQUA (+ sumber lain dicatat mitra); kelebihan > PAR-79 → pemilik (sekali per outlet-bulan).
5. Sanksi SELALU diputuskan pemilik (PTB-59), bertingkat tanpa melompati tahap; pemicu otomatis hanya mencatat.
   Pemutusan: kontrak Diputus, tenant nonaktif pada tanggal berakhir (job), ekspor data ≤ 30 hari, data tetap ada.
6. Mode baca-saja (US-P3-02 KP-4) hanya SETELAH teguran berlaku dan tunggakan > `read_only_overdue_days`; pulih
   otomatis saat lunas.
7. Laporan bulanan = snapshot saat terbit (tidak diubah); PDF dihasilkan ulang dari snapshot itu.
8. Seed demo menulis langsung (tanpa event) dan dilewati di Vitest kecuali `force: true`. Akun demo: `mitra1`
   (portal, kata sandi demo), `opmitra1` (POS mitra, PIN demo, tablet `TAB-MTR01`), `pembina1` (Pembina wilayah).

## 7. Perubahan di luar ruang modul (dilaporkan)

- M10 (B-07, perubahan minimal): `createUser` menerima `tenantId` (tenant mitra oleh admin sistem EQUA; persetujuan
  tetap di tenant EQUA); `src/server/modules/m10-access/service/partner-tenant.ts` baru (`resolvePartnerTenantTarget`,
  `asTenantActor`, `registerDeviceForTenant`, `issueInitialPinForTenant`) diekspor dari `m10-access/index.ts`.
- Berkas bersama (hanya tambah): skema `p3-partner.ts` (pesanan portal, evaluasi berkala + kolom tambahan), `labels.ts`,
  `events.types.ts` (field opsional `partner.subscription_invoiced`), `rbac/permissions.ts`, `approvals/registry.ts`
  (jenis sudah ada), `notifications/catalog.ts`, `params-registry.ts`, `nav/registry.ts` (+ `docs/nav-permissions.md`),
  `src/db/seed/index.ts` (panggilan `seedDemoP3Partner`).

## 8. Belum selesai / untuk modul lain

- **M6:** pasang `<PosQualityChecklist shiftId={shift?.id} />` di aplikasi POS depot (menu Shift) untuk outlet mitra
  (komponen menyembunyikan diri untuk outlet EQUA / flag mati). Sampai dipasang, daftar periksa harian hanya dapat
  dikirim lewat perintah sinkron (teruji).
- **M7:** layar POS toko menampilkan pull `p3.store_partner_orders` (pesanan spare part portal menunggu) — konfirmasi
  sudah otomatis dari `pos_sale.recorded` harga mitra.
- **Proxy:** `/mitra/*` tidak masuk matcher `src/proxy.ts` (berkas bersama); portal memeriksa sesi di layout server.
- UAT: uji penetrasi lintas tenant manual sebelum mitra pertama (9.6) melengkapi uji otomatis `tests/p3-partner/portal.test.ts`.

## 9. Pengerasan S5 (paket A)
- **B-72 SELESAI**: `<PosQualityChecklist />` terpasang di POS depot M6 — layar buka shift (menu Jual & Shift, `shiftId`
  null) dan menu Shift (shift terbuka). Menyembunyikan diri untuk outlet EQUA / flag Tahap 3 mati.
- **B-73 SELESAI**: POS toko M7 menampilkan pull `p3.store_partner_orders` + "Isi keranjang" harga mitra
  (`partner-orders-panel.tsx`); konfirmasi tetap otomatis dari `pos_sale.recorded`. Uji `tests/m7-store/partner-orders.test.ts`.
- **B-70 SELESAI** (D-11 butir 2): `/mitra/:path*` masuk matcher `src/proxy.ts` — tanpa cookie → `/mitra/masuk`
  (halaman publik portal `masuk`/`daftar`/`keluar` dilewatkan); pemeriksaan sesi sebenarnya tetap di layout server.
  Uji `tests/core/proxy.test.ts`.
- **B-71 SELESAI** (D-11 butir 1): `authorizePortalAction` kini memanggil `authorize(..., { conditions:
  { partner_portal_phase3 } })` terhadap izin bersyarat katalog (`CONDITIONAL_GRANTS`, tampil di ekspor matriks);
  syarat tidak terpenuhi → ditolak & tercatat di log akses seperti izin lain.
- B-08: portal mitra memaksa ganti kata sandi sementara (`requirePortalSession` → `/akun/kata-sandi`) dan menyediakan
  tombol "Ubah kata sandi" di kepala portal.

## 10. Perbaikan audit S5B (paket A)

- **Riwayat parameter kontrak (US-P3-04 KP-5, US-P3-09 KP-1)**: kolom baru `partner_contracts.terms_history`
  (`[{ effectiveFrom, before, approvalNumber, appliedAt }]`) diisi job siklus saat menerapkan `pending_terms`;
  `effectiveTerms(contract, periodMonth)` memakai parameter lama untuk bulan layanan < `effectiveFrom` — tagihan 00.40
  bulan lalu tetap bertarif lama walau siklus 00.30 sudah menerapkan tarif baru. Tanggal berlaku dihitung saat
  PERSETUJUAN (persetujuan terlambat → bulan sesudah persetujuan).
- **Nota kredit faktur mitra gabungan (US-P3-09 KP-2/KP-3, BR-05, US-M11-02)**: nota kredit koreksi atas faktur
  `partner_subscription` dibatasi sisa komponen L5 (langganan/royalti/fee awal) — `assertPartnerCreditNoteWithinL5`
  (berkas baru `src/server/modules/m5-receivables/service/partner-credit.ts`, dipanggil `requestCreditNote`); koreksi
  baris air lewat Koreksi rit M3. Formulir nota kredit faktur mitra menampilkan petunjuknya.
- **Flag Tahap 3 per tenant (US-P3-01 KP-5)**: pengingat kontrak berakhir & evaluasi berkala memeriksa
  `portalEnabled(tx, c.tenantId)`.
- **Versi POS di portal (PRD 9.7, NFR-32)**: `portalHome.posVersion` (`partnerPosVersion`: versi minimal berlaku,
  versi berikutnya + tanggal, versi per tablet mitra) + kartu "Versi aplikasi POS outlet" di beranda portal.
- Terbuka (lihat laporan S5B): jurnal pendapatan L5 bertanggal bulan layanan (M11, paket B); mitra dua outlet (dua
  pelanggan M1, satu kontrak).
