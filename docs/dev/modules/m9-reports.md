# M9 — Laporan & Dashboard Pemilik (catatan pengembang)

Cakupan: US-M9-01..07 (PRD 7.9), FR-M9-01..06, NFR-03/04/19/23/35, BR-29/30/32/33/39, KPI-01..11. M9 **tidak memiliki
transaksi usaha**: setiap angka dihitung dari M2–M8, M11, M12 lewat **satu definisi** (`metrics.ts`). Tulisan M9 hanya:
snapshot H+0 & addenda, snapshot laporan Final, input KPI-10, periode paralel (lembar pencocokan, tarik nota kertas).
Panduan pengguna: `docs/guides/m9-reports.md`. Uji: `tests/m9-reports/*` (37+ uji, semua KP M & S), E2E
`e2e/m9-reports.spec.ts` + `e2e/m9-reports.mobile.spec.ts`.

## 1. Arsitektur singkat

```
src/server/modules/m9-reports/
  metrics.ts          SATU definisi: revenueDaily/ForRange (L2/L3/L4 + internal), cashForDay (m4.buildCashPosition),
                      receivablesAsOf/Flow/ForRange (rekonstruksi as-of + KPI-04), tripsDaily (per tanggal jadwal),
                      gallonsDaily (m6.salesAggregates), exceptionsForRange (persetujuan, selisih, rit gagal,
                      m12.fleetDaySummary, m8 utilisasi/susut/produksi), discrepanciesAwaitingOwner (+KPI-03 24 jam)
  service/h0.ts       computeDaySnapshot, getDailyDashboard (rentang, snapshot terbit vs live, addenda, lazy catch-up),
                      publishDailySummary (idempoten, terlambat > PAR m9.report_rules.h0_publish_minutes, notifikasi),
                      publishPendingSummaries (job/tampilan), markSummaryReviewed, decideDiscrepancyFromDashboard
                      (→ m4.decideDiscrepancy), getDailyDrilldown (truk→rit, depot→shift, selisih→setoran, piutang→pelanggan)
  service/addenda.ts  addendumFromEvent: event terlambat sinkron / koreksi atas tanggal yang H+0-nya sudah terbit →
                      `daily_summary_addenda` (idempoten per objek+jenis), delta angka; snapshot TIDAK diubah
  service/monthly.ts  computeMonthlyFigures (jurnal M11 per PERIODE; biaya langsung = akun beban `5-`; eliminasi
                      `accounts.is_internal_transfer`), getMonthlyReport (Sementara/Final), finalizeMonthlyReport
                      (report_snapshots, revisi saat periode dibuka & dikunci ulang), monthlyDrilldown (akun → jurnal →
                      transaksi sumber), exportMonthlyReport (Final: berkas pertama disimpan sbg lampiran → byte identik)
  service/catalog.ts  REPORT_CATALOG (19 baris = 7.9.4 + ekspor jurnal M11), missingCatalogReports, getReportCatalog
  service/inbox.ts    getInbox (kelompok + urut lewat tenggat + KPI-03), actOnInboxItem (layanan modul pemilik objek)
  service/performance.ts  sopir/truk & depot/operator per bulan; peringkat per kelompok sebanding; deret nihil selisih M4
  service/trends.ts   13 minggu/bulan (Σ harian metrics), perubahan vs periode sebelumnya
  service/kpi.ts      computeKpiMonth (KPI-01..11 rumus PRD 1.3), getKpiReport (riwayat sejak pilot), setOwnerHours,
                      fieldAdoption (KPI-11 dari sync_commands per peran lapangan)
  service/parallel.ts periode paralel NFR-35: start/check/withdraw/extend, par84Status, persetujuan paper_withdrawal_early
```

## 2. API publik (`index.ts`)
- Metrics (tx-first, tanpa otorisasi): `revenueForRange`, `tripsForRange`, `gallonsForRange`, `receivablesAsOf`,
  `receivablesForRange`, `cashForDay`, `exceptionsForRange`, `discrepanciesAwaitingOwner`, `sum*`, `*Daily`.
- H+0: `getDailyDashboard(ctx, { range?, date? })`, `getDailyDrilldown(ctx, { kind, from, to, id? })`,
  `markSummaryReviewed(ctx, { date })`, `decideDiscrepancyFromDashboard(ctx, { discrepancyId, decision, reason? })`,
  `publishDailySummary(tx, {...})`, `publishPendingSummaries(now, db?)`, `listDailySummaries`, `listAddenda`.
- Bulanan: `getMonthlyReport(ctx, { month })`, `monthlyDrilldown(ctx, { month, profitCenter?, accountId? })`,
  `exportMonthlyReport(ctx, { month, format })`, `finalizeLockedPeriods(now)`, `computeMonthlyFigures`, `shiftMonth`.
- Katalog/kotak masuk/kinerja/tren/KPI/paralel: `getReportCatalog`, `missingCatalogReports`, `getInbox`,
  `actOnInboxItem`, `inboxCount`, `getPerformance`, `getTrend`, `getKpiReport`, `setOwnerHours`, `fieldAdoption`,
  `startParallelPeriod`, `recordParallelCheck`, `withdrawPaper`, `extendParallelPeriod`, `listParallelUnits`,
  `listParallelChecks`, `parallelUnitOptions`, `par84Status`.

## 3. Event
### 3.1 Dipancarkan
Tidak ada event domain baru (M9 tidak punya transaksi usaha; tidak ada konsumen). Notifikasi: `daily_summary.published`
(pemilik), `monthly_report.final` (pemilik, akuntan), `inbox.explanation_requested` (pemohon/Admin Keuangan/Dispatcher/
operator produksi).
### 3.2 Didengar (`events.ts`, terisolasi savepoint)
| Event | Handler | Fungsi |
|---|---|---|
| `cash_day.closed` | `m9-reports:publish_h0` | Terbitkan H+0 terkunci + notifikasi (galat tidak menggagalkan tutup kas; job cadangan) |
| `trip.completed`, `trip.failed`, `pos_sale.recorded`, `pos_sale.voided`, `collection.recorded`, `deposit.received`, `trip_payment.reversed`, `payment.reversed`, `credit_note.issued`, `invoice.written_off`, `trip.corrected`, `store_return.recorded`, … (`ADDENDUM_EVENT_TYPES`) | `m9-reports:addenda:<type>` | Addendum bertanda untuk tanggal yang H+0-nya sudah terbit |
| `period.locked` (M11) | `m9-reports:monthly_final` | Simpan versi Final laporan bulanan + notifikasi |

## 4. Lapangan & pull
Tidak ada (web kantor daring). Sopir/operator melihat kinerjanya di aplikasinya lewat modul pemiliknya (M3/M6).

## 5. Registrasi
- Job: `m9.h0.publish_pending` (5 menit; cadangan terbit H+0 ≤ `h0_catch_up_days`), `m9.monthly.finalize` (harian 06.30).
  Tampilan H+0 juga menjalankan catch-up bila ada hari kas tertutup tanpa ringkasan.
- Persetujuan: `paper_withdrawal_early` (onApproved → `withdrawn_date` + `early_withdrawal_approved_by`; onRejected/
  onExpired/onCancelled → catatan, tanpa perubahan data).
- Laporan (`reports.ts`, modul `m9`): `m9.daily_summary`, `m9.daily_summaries`, `m9.monthly_gross_profit`,
  `m9.water_cost_per_liter`, `m9.gross_revenue_pkp`, `m9.trip_realization` (KPI-07, B-11), `m9.performance_drivers`,
  `m9.performance_outlets`, `m9.trend_weekly`, `m9.trend_monthly`, `m9.kpi`, `m9.parallel_run_checks`.
- Audit (`audit.ts`): label objek/field, objek keuangan (`daily_summary`, `report_snapshot`), akses lampiran
  `report_snapshot` (izin `m9.monthly_report.read`, tenant sama).

## 6. UI kantor (setiap halaman `requirePermission`)
| Rute | Izin | Isi |
|---|---|---|
| `/laporan` | — | alih ke layar pertama yang boleh dibuka |
| `/laporan/hari-ini` | `m9.daily_summary.read` | H+0 enam blok, rentang, riwayat, rincian `?rinci=truk|depot|selisih|piutang`, setujui/tolak selisih, tandai ditinjau, addenda |
| `/laporan/bulanan` (+ `/ekspor` route) | `m9.monthly_report.read` | laba kotor per lini + konsolidasi, rincian `?lini=&akun=`, pembanding, biaya air/liter, PKP; ekspor Final identik (CSRF same-origin) |
| `/laporan/katalog` | `m9.report.read` | 19 baris 7.9.4; unduh Excel/PDF (`/api/export/<kunci>`; PII → formulir tujuan) |
| `/laporan/kinerja` | `m9.performance.read` | sopir/truk, depot/operator |
| `/laporan/tren` | `m9.trend.read` | grafik Recharts (`src/components/m9-reports/trend-charts.tsx`) + tabel |
| `/laporan/kpi` | `m9.kpi.read` | KPI-01..11, riwayat, formulir KPI-10 (pemilik) |
| `/laporan/periode-paralel` | `m9.parallel_run.read` (+ `.create` untuk formulir) | unit, lembar harian, tarik/perpanjang |
| `/kotak-masuk` | `m9.inbox.read` | kelompok tindakan + info |
| `/beranda` (blok) | `m9.daily_summary.read` | `OwnerTodayBlock`: omzet luar, selisih kas, kotak masuk |

Server Action: `src/app/(office)/laporan/actions.ts`, `src/app/(office)/kotak-masuk/actions.ts`.
Komponen: `src/components/m9-reports/*` (tombol/formulir aksi, isian, grafik, blok beranda).

## 7. Aturan & keputusan desain
- **Satu definisi**: omzet L2 = Σ harga rit pelanggan Selesai per `completion_business_date`; L3/L4 = transaksi POS yang
  dihitung (`m6.COUNTED_SALE`) per jenis outlet; internal (rit `is_internal`, transfer toko→depot) terpisah (BR-33).
  Rit per truk = tanggal **jadwal** (terbit). Piutang = rekonstruksi as-of akhir rentang (faktur − alokasi s.d. tanggal).
  Rentang = Σ harian (uji KP-7 & US-M9-06 KP-2 membuktikan kesamaan H+0 = tren = operasional bulanan).
- **H+0 terkunci**: snapshot JSON di `daily_summaries.snapshot` saat terbit; data terlambat/koreksi → addenda. Tampilan
  hari yang sudah terbit memakai snapshot; hari berjalan dihitung live berlabel "belum ditutup".
- **Final = periode Dikunci** (7.9.3, BR-32). Ditutup → masih Sementara. Pembukaan kembali → Sementara; kunci ulang →
  revisi baru, revisi lama `superseded_by_id` (tetap tersimpan). Jurnal atas bulan terkunci masuk periode berikut
  (`originPeriod`) — Final tidak berubah.
- **M11 belum aktif** (flag `accounting.m11_active` mati): omzet operasional + pengeluaran rit diterima (L2) + pembelian
  toko (L4), berlabel "Belum lengkap — M11 belum aktif" (KP-5).
- **Biaya air/liter**: debit−kredit akun beban L1 (jurnal non-alokasi) per `water_source_id`; tanpa sumber → dibagi
  proporsional liter; ÷ liter pengisian M8 (`fillTotalsByDay`).
- **KPI-11** tidak menghitung kernet (hanya pengemudi pengganti — tidak dapat dibedakan); peran: sopir, operator depot,
  kasir toko, operator produksi. KPI-06 = definisi M2 (`kpi06Report`).
- **Kotak masuk** dibangun dari data modul (bukan salinan): butir hilang saat diputuskan di modul mana pun. Tindakan
  memanggil layanan modul pemilik objek (SoD & otorisasi modul itu berlaku).
- **Ekspor Final identik**: berkas pertama per format disimpan sebagai lampiran `report_snapshot` (`kind =
  report_final_xlsx|pdf`); unduhan berikut menyajikan byte yang sama + tetap mencatat `export_logs` & log akses.

## 8. Tambahan berkas bersama (append-only)
- `src/lib/labels.ts`: `approval_type.paper_withdrawal_early`, `summary_addendum_kind.late_deposit`, `h0_range`,
  `kpi_status`, `inbox_group`, `performance_group`, `parallel_status`.
- `src/server/core/rbac/permissions.ts`: `m9.parallel_run.read` [O, FA, SA], `m9.parallel_run.create` [FA, SA].
- `src/server/core/approvals/registry.ts`: `paper_withdrawal_early`.
- `src/server/core/notifications/catalog.ts`: `monthly_report.final`, `inbox.explanation_requested`.
- `src/server/core/params-registry.ts`: `m9.report_rules`, `m9.kpi_targets`.
- `src/components/shared/nav/registry.ts`: `/laporan/periode-paralel` (+ `docs/nav-permissions.md` dibangkitkan ulang).
- `src/db/seed/index.ts`: panggilan `seedDemoM9Reports(tx)` setelah M12.
- `src/app/(office)/beranda/page.tsx`: `<OwnerTodayBlock ctx={ctx} />` (satu impor + satu baris).

## 9. Backlog & butir terbuka
| Butir | Status |
|---|---|
| B-11 KPI-07 di laporan | Selesai: laporan `m9.trip_realization` (per truk per hari, pelanggan/internal/gabungan) + KPI-07 di `/laporan/kpi` |
| B-29 H+0 dari `cash_day.closed` + satu ketuk | Selesai: handler `m9-reports:publish_h0`, `decideDiscrepancyFromDashboard` → `m4.decideDiscrepancy` |
| B-41 H+0 memakai sinyal M8 | Selesai: utilisasi (`computeUtilizationDays`), susut/status neraca, produksi belum lengkap di blok pengecualian; biaya air/liter memakai `fillTotalsByDay` (event `water_balance.computed` tidak diperlukan — tabel dibaca langsung) |
| B-44 H+0 memakai M12 | Selesai: `m12.fleetDaySummary` per hari di pengecualian; pola `locationDeviationPatterns` di kinerja sopir |

Terbuka (lihat juga laporan agen; nomor = `docs/dev/backlog.md`):
1. SELESAI S5 (B-58, lihat §10). Lencana hitungan **Kotak masuk** di menu (`badgeKey: "inbox"`) belum diisi — B-58 (`src/app/(office)/_shell-data.ts`;
   `m9.inboxCount` membangun seluruh kotak masuk → perlu hitungan ringan sebelum dipasang di setiap halaman).
2. Imutabilitas `daily_summaries.snapshot` setelah terbit dijaga layanan (tidak ada jalur UPDATE); penjaga DB
   (`IMMUTABLE_COLUMN_GUARDS` di hardening) milik core — B-59.
3. `access.request_pending` di katalog notifikasi tidak dipakai (M10 memakai `approval.requested`) — B-60.
4. SELESAI S5 (B-54, lihat §10). Satu definisi PKP: blok PKP laporan bulanan & `m9.gross_revenue_pkp` menghitung sendiri; tampilkan/pakai
   `m11.pkpStatus` (US-M11-08 KP-4) — B-54.

Diselesaikan saat integrasi M9 + M11 (B-61): katalog memakai laporan terdaftar M11 — baris "Laba kotor … laba rugi,
neraca, arus kas" = `m9.monthly_gross_profit` + `m11.profit_loss`, `m11.balance_sheet`, `m11.cash_flow`; baris "Ekspor
jurnal format konsultan" = `m11.journals` dengan layar `/akuntansi/pajak` (template konsultan `/akuntansi/pajak/ekspor`,
log ekspor yang sama). `pendingKeys` tidak lagi dipakai katalog (tipe tetap untuk modul menyusul). Pengirim
`period.not_closed`, `tax.pkp_threshold`, `period.reopened` kini ada (M11) → dihapus dari `PENDING_EMITTERS` uji
`US-M9-04 KP-1`. Uji lintas modul `tests/integration/m9-m11.test.ts`.

## 10. S5 pengerasan — paket B

- **B-58** lencana "Kotak masuk": `inboxBadgeCount(ctx, { approvalItems?, fresh? })` = hitungan COUNT terindeks per
  kelompok + cache 30 detik per pengguna (`clearInboxBadgeCache()`; dikosongkan setelah tindakan kotak masuk);
  `_shell-data.ts` kantor mengisi `counts.inbox` (galat tidak menggagalkan kerangka). Uji `tests/m9-reports/inbox.test.ts`
  (`B-58 …`; `NOW` = siang WIB hari ini agar tidak bergantung jam dinding).
- **B-54** satu definisi PKP: `pkpDashboard(ctx)` = `m11.pkpStatus` (dasbor pemilik); blok PKP laporan bulanan memakai
  M11 bila aktif (`pkp.source = "m11"`, proyeksi `avg3`/`projectedPeriod`); snapshot Final lama tanpa kolom tersebut
  dibaca dengan nilai bawaan. Uji `tests/integration/m9-m11.test.ts`.
- **B-66** kinerja sopir/truk (US-M9-05): penilaian pelanggan aplikasi (`p2.ratingAggregates`: jumlah, rata-rata,
  jumlah nilai ≤ 2) dan keluhan bulan itu (`p2.complaintMonthlyReport`) per truk + ringkasan `CustomerFeedbackSummary`
  di `/laporan/kinerja`. Uji `tests/m9-reports/performance.test.ts`.
- **B-24** kontrol tindakan kotak masuk memakai `useFlashActionState`.

## 11. S5-B perbaikan temuan audit (tim B)

- **Konsolidasi satu definisi dengan M11 (US-M9-02 KP-1/KP-2, BR-33).** `accountAggregates` menandai baris jurnal bersumber
  transfer internal (`m11.INTERNAL_TRANSFER_SOURCES`, mis. HPP toko atas barang yang dikirim ke depot) → ikut dieliminasi
  seperti akun internal; `consolidate(lines, markupRealized)` mengurangkan markup harga mitra yang terpakai sebagai beban
  bahan depot (`m11.computeInternalMarkup(...).realized`) dari biaya gabungan (`eliminatedCost` ikut bertambah). Laba
  gabungan (laba kotor − beban operasional) = laba bersih konsolidasi M11.
- **Biaya per liter per sumber dari jurnal manual (KP-6).** Jurnal manual M11 kini membawa `waterSourceId` per baris
  (wajib/“gabungan” untuk beban L1) — `costBySource` M9 tidak lagi hanya pembagian liter untuk biaya manual.
- **Ekspor Final laporan keuangan M11 identik** lewat inti ekspor (lihat hand-off M11 §13).
- Uji: `tests/m11-accounting/audit-s5b.test.ts` (`US-M9-02 KP-2 …`, `US-M9-02 KP-6 …`).
