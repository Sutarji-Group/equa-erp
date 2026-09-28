# Izin yang dipakai registri navigasi web kantor

Sumber: `src/components/shared/nav/registry.ts` (FUI). Dokumen ini untuk **agen platform inti / M10** agar setiap string
izin di bawah dimasukkan ke katalog RBAC (`src/server/core/rbac/matrix.ts`) dan dipetakan ke peran.

## Konvensi

- Bentuk: `<modul>.<sumberdaya>.<aksi>` — huruf kecil, `snake_case` untuk sumber daya (nama entitas glosarium
  `docs/ARCHITECTURE.md` §4), mis. `m2.order.read`, `m4.incoming_transfer.read`, `m1.import.create`.
- Modul: `m1`…`m12` (Bab 7 PRD), `p3` (kemitraan RL-7/Tahap 3), `core` (tidak dipakai registri).
- Aksi yang dipakai menu: `read` (melihat halaman), `create` (halaman yang tujuannya membuat, mis. Pesanan baru,
  Impor, Dicatat kantor). Aksi lain (`update`, `approve`, `close`, `export`, `void`, …) ditetapkan modul masing-masing
  di katalog RBAC — menu tidak memerlukannya.
- `permission: null` = semua pengguna web kantor yang sudah masuk (Beranda, Notifikasi, Pengaturan notifikasi, Bantuan).
- `filterNavByPermissions(perms)` menerima wildcard pada daftar izin pengguna: `*` (semua), `m2.*`, `m2.order.*`.
  Katalog RBAC tidak wajib memakai wildcard; fitur ini hanya kemudahan (mis. pengguna demo `["*"]`).
- Menyembunyikan menu **bukan** otorisasi. Setiap halaman/aksi tetap memanggil `authorize(ctx, perm)` di lapisan layanan.
- Registri adalah berkas bersama: **hanya tambah** item/izin baru; jangan ubah `id`, `href`, atau string izin yang ada.
  Setelah menambah, jalankan `pnpm tsx tools/gen-nav-permissions.ts` untuk memperbarui bagian otomatis di bawah.

## Usulan pemetaan awal peran → izin menu (BRD 4.2, PRD 3.2, US-M10-03)

Usulan FUI untuk memudahkan penyusunan matriks; keputusan akhir di matriks RBAC (pemisahan tugas dipaksakan layanan).

| Peran | Izin menu (baca kecuali disebut) |
|---|---|
| Pemilik (`owner`) | Semua izin di daftar, **kecuali** `m2.order.create`, `m3.office_entry.create`, `m1.import.create` (pemilik tidak menginput transaksi harian). |
| Admin Keuangan (`finance_admin`) | `m4.*` (semua halaman kas), `m5.*`, `m11.*`, `m9.daily_summary.read`, `m9.monthly_report.read`, `m9.report.read`, `m9.inbox.read`, `m10.approval.read`, `m10.sync_health.read`, `m3.office_entry.create`, `m6.outlet.read`, `m7.*` (baca), `m8.water_balance.read`, `m1.customer.read`, `m1.product.read`, `p3.subscription.read`, `p3.partner.read`, `m5.opening_balance.read`, `m11.opening_balance.read`. **Tidak**: `m2.order.create`. |
| Dispatcher (`dispatcher`) | `m2.*`, `m1.customer.read`, `m1.tariff_zone.read`, `m1.truck.read`, `m1.pool_location.read`, `m12.*`, `m10.approval.read` (penyetuju tunai→tempo lapangan), `m10.sync_health.read` (perangkat truk), `m9.report.read`, `m9.performance.read`, `p3.partner_supply.read`. **Tidak**: `m4.*`. |
| Admin sistem (`system_admin`) | `m10.user.read`, `m10.role.read`, `m10.device.read`, `m10.sync_health.read`, `m10.access_review.read`, `m10.personal_data.read`, `m10.audit_log.read` (tanpa nilai keuangan), `m1.employee.read`, `m1.import.create`, `m10.parameter.read` (baca). **Tidak**: `m4.*`, `m11.*` tulis. |
| Akuntan (`accountant`, baca-saja) | `m11.*` (baca), `m9.monthly_report.read`, `m9.report.read`, `m5.aging.read`, `m5.invoice.read`, `m10.audit_log.read` (objek keuangan). |
| Kasir toko (`store_cashier`) | Umumnya memakai POS; bila memakai web: `m7.stock.read`, `m7.supplier.read`, `m7.purchase_receipt.read`, `m7.stock_count.read`, `m7.reorder.read`. |
| Pemilik mitra (`partner_owner`) | Portal `/mitra/*` (bukan menu kantor); tidak ada izin menu kantor. |
| Pembina wilayah (`regional_coach`) | `p3.partner.read`, `p3.partner_supply.read`, `m8.quality_test.read` (Tahap 3). |
| Sopir, Kernet, Operator depot, Operator produksi | Aplikasi lapangan/POS saja; tidak ada izin menu kantor. |

## Daftar otomatis

<!-- BEGIN:AUTO nav-permissions -->

### Daftar izin unik

```text
m1.customer.read
m1.data_signoff.read
m1.employee.read
m1.import.create
m1.outlet.read
m1.pool_location.read
m1.product.read
m1.tariff_zone.read
m1.truck.read
m1.water_meter.update
m1.water_source.read
m10.access_review.read
m10.approval.read
m10.audit_log.read
m10.device.read
m10.parameter.read
m10.personal_data.read
m10.role.read
m10.support_ticket.create
m10.sync_health.read
m10.tenant.read
m10.user.read
m11.account.read
m11.financial_report.read
m11.fixed_asset.read
m11.journal.read
m11.journal_mapping.read
m11.ledger.read
m11.opening_balance.read
m11.payable.read
m11.period.read
m11.reconciliation.read
m11.tax.read
m12.fleet_event.read
m12.fuel_estimate.read
m12.position.read
m12.trip_history.read
m2.crew_assignment.read
m2.order.create
m2.order.read
m2.recurring_order.read
m2.schedule.read
m3.office_entry.create
m3.office_entry.read
m3.payment_report.read
m3.trip_incident.read
m4.cash_day.read
m4.cash_position.read
m4.deposit.read
m4.discrepancy.read
m4.incoming_transfer.read
m4.office_cash.read
m4.petty_cash.read
m4.restitution.read
m5.aging.read
m5.credit_exposure.read
m5.customer_payment.read
m5.invoice.read
m5.monthly_invoice.read
m5.opening_balance.read
m5.receivable.read
m5.reminder.read
m6.outlet.read
m7.product_performance.read
m7.purchase_receipt.read
m7.reorder.read
m7.report.read
m7.stock.read
m7.stock_count.read
m7.supplier.read
m7.supplier_payable.read
m8.production.read
m8.quality_test.read
m8.truck_fill.read
m8.utilization.read
m8.water_balance.read
m9.daily_summary.read
m9.inbox.read
m9.kpi.read
m9.monthly_report.read
m9.performance.read
m9.report.read
m9.trend.read
p3.partner.read
p3.partner_supply.read
p3.subscription.read
p3.support_request.read
```

### Rute → izin

| Grup | Rute | Label | Izin | Catatan |
|---|---|---|---|---|
| Beranda | `/beranda` | Beranda | _(semua pengguna web kantor)_ |  |
| Beranda | `/kotak-masuk` | Kotak masuk | `m9.inbox.read` | lencana `inbox` |
| Beranda | `/persetujuan` | Persetujuan | `m10.approval.read` | lencana `approvals` |
| Beranda | `/notifikasi` | Notifikasi | _(semua pengguna web kantor)_ | lencana `notifications` |
| Pesanan & jadwal | `/pesanan` | Pesanan | `m2.order.read` |  |
| Pesanan & jadwal | `/pesanan/baru` | Pesanan baru | `m2.order.create` |  |
| Pesanan & jadwal | `/pesanan/[id]` | Rincian pesanan | `m2.order.read` | tidak tampil di sidebar |
| Pesanan & jadwal | `/jadwal` | Papan jadwal | `m2.schedule.read` |  |
| Pesanan & jadwal | `/jadwal/kru` | Jadwal kru | `m2.crew_assignment.read` |  |
| Pesanan & jadwal | `/langganan` | Pesanan berulang | `m2.recurring_order.read` |  |
| Pesanan & jadwal | `/sopir-kantor/dicatat-kantor` | Dicatat kantor | `m3.office_entry.create` |  |
| Pesanan & jadwal | `/sopir-kantor/kendala` | Kendala sopir | `m3.trip_incident.read` |  |
| Pesanan & jadwal | `/sopir-kantor/laporan` | Laporan sopir | `m3.office_entry.read` / `m3.payment_report.read` |  |
| Kas & setoran | `/kas` | Kas hari ini | `m4.cash_position.read` |  |
| Kas & setoran | `/kas/setoran` | Setoran | `m4.deposit.read` |  |
| Kas & setoran | `/kas/selisih` | Selisih | `m4.discrepancy.read` |  |
| Kas & setoran | `/kas/transfer` | Transfer masuk | `m4.incoming_transfer.read` |  |
| Kas & setoran | `/kas/kantor` | Kas kantor & setor bank | `m4.office_cash.read` |  |
| Kas & setoran | `/kas/kas-kecil` | Kas kecil | `m4.petty_cash.read` |  |
| Kas & setoran | `/kas/tutup` | Tutup kas | `m4.cash_day.read` |  |
| Kas & setoran | `/kas/ganti-rugi` | Ganti rugi | `m4.restitution.read` |  |
| Piutang | `/piutang` | Ringkasan piutang | `m5.receivable.read` |  |
| Piutang | `/piutang/faktur` | Faktur | `m5.invoice.read` |  |
| Piutang | `/piutang/pelunasan` | Pelunasan | `m5.customer_payment.read` |  |
| Piutang | `/piutang/umur` | Umur piutang | `m5.aging.read` |  |
| Piutang | `/piutang/pengingat` | Pengingat jatuh tempo | `m5.reminder.read` |  |
| Piutang | `/piutang/faktur-bulanan` | Faktur bulanan | `m5.monthly_invoice.read` |  |
| Piutang | `/piutang/saldo-awal` | Saldo awal piutang | `m5.opening_balance.read` |  |
| Piutang | `/piutang/status-kredit` | Status kredit | `m5.credit_exposure.read` |  |
| Piutang | `/piutang/faktur/[id]` | Rincian faktur | `m5.invoice.read` | tidak tampil di sidebar |
| Piutang | `/piutang/pelunasan/[id]` | Rincian pelunasan | `m5.customer_payment.read` | tidak tampil di sidebar |
| Piutang | `/piutang/pelanggan/[id]` | Kartu piutang | `m5.aging.read` / `m5.credit_exposure.read` | tidak tampil di sidebar |
| Depot & toko | `/outlet` | Pemantauan outlet | `m6.outlet.read` |  |
| Depot & toko | `/outlet/[id]` | Rincian outlet | `m6.outlet.read` | tidak tampil di sidebar |
| Depot & toko | `/outlet/shift/[id]` | Rincian shift | `m6.outlet.read` | tidak tampil di sidebar |
| Depot & toko | `/outlet/laporan` | Laporan outlet | `m6.outlet.read` |  |
| Depot & toko | `/outlet/tenant` | Tenant & paket POS | `m10.tenant.read` |  |
| Depot & toko | `/toko/barang` | Barang & stok toko | `m7.stock.read` |  |
| Depot & toko | `/toko/pemasok` | Pemasok | `m7.supplier.read` |  |
| Depot & toko | `/toko/pembelian` | Penerimaan barang | `m7.purchase_receipt.read` |  |
| Depot & toko | `/toko/opname` | Opname | `m7.stock_count.read` |  |
| Depot & toko | `/toko/pesan-ulang` | Pesan ulang | `m7.reorder.read` |  |
| Depot & toko | `/toko/utang` | Utang pemasok | `m7.supplier_payable.read` |  |
| Depot & toko | `/toko/laporan` | Laporan toko | `m7.report.read` / `m7.product_performance.read` |  |
| Depot & toko | `/toko/barang/[id]` | Rincian barang toko | `m7.stock.read` | tidak tampil di sidebar |
| Depot & toko | `/toko/pembelian/[id]` | Rincian nota pembelian | `m7.purchase_receipt.read` | tidak tampil di sidebar |
| Depot & toko | `/toko/opname/[id]` | Rincian opname | `m7.stock_count.read` | tidak tampil di sidebar |
| Produksi air | `/produksi/neraca-air` | Neraca air | `m8.water_balance.read` |  |
| Produksi air | `/produksi/utilisasi` | Utilisasi kapasitas | `m8.utilization.read` |  |
| Produksi air | `/produksi/mutu` | Mutu air | `m8.quality_test.read` |  |
| Produksi air | `/produksi/pengisian` | Pengisian & pasokan | `m8.truck_fill.read` |  |
| Produksi air | `/produksi/kelola-meter` | Meter sumber air | `m8.production.read` / `m1.water_meter.update` |  |
| Produksi air | `/produksi/neraca-air/rincian` | Rincian neraca harian | `m8.water_balance.read` | tidak tampil di sidebar |
| Armada | `/armada/peta` | Peta truk | `m12.position.read` |  |
| Armada | `/armada/riwayat` | Riwayat perjalanan | `m12.trip_history.read` |  |
| Armada | `/armada/kejadian` | Kejadian armada | `m12.fleet_event.read` |  |
| Armada | `/armada/perangkat` | Perangkat GPS | `m12.fleet_event.read` |  |
| Armada | `/armada/bbm` | BBM & zona | `m12.fuel_estimate.read` |  |
| Laporan | `/laporan/hari-ini` | Hari ini (H+0) | `m9.daily_summary.read` |  |
| Laporan | `/laporan/bulanan` | Laba kotor bulanan | `m9.monthly_report.read` |  |
| Laporan | `/laporan/katalog` | Katalog laporan | `m9.report.read` |  |
| Laporan | `/laporan/kinerja` | Kinerja sopir & depot | `m9.performance.read` |  |
| Laporan | `/laporan/tren` | Tren | `m9.trend.read` |  |
| Laporan | `/laporan/kpi` | KPI program | `m9.kpi.read` |  |
| Akuntansi | `/akuntansi/akun` | Bagan akun | `m11.account.read` |  |
| Akuntansi | `/akuntansi/pemetaan` | Pemetaan jurnal otomatis | `m11.journal_mapping.read` |  |
| Akuntansi | `/akuntansi/jurnal` | Jurnal | `m11.journal.read` |  |
| Akuntansi | `/akuntansi/buku-besar` | Buku besar | `m11.ledger.read` |  |
| Akuntansi | `/akuntansi/laporan` | Laporan keuangan | `m11.financial_report.read` |  |
| Akuntansi | `/akuntansi/aset` | Aset tetap | `m11.fixed_asset.read` |  |
| Akuntansi | `/akuntansi/rekonsiliasi` | Rekonsiliasi bank & kas | `m11.reconciliation.read` |  |
| Akuntansi | `/akuntansi/periode` | Periode | `m11.period.read` |  |
| Akuntansi | `/akuntansi/pajak` | Pajak | `m11.tax.read` |  |
| Akuntansi | `/akuntansi/saldo-awal` | Saldo awal | `m11.opening_balance.read` |  |
| Akuntansi | `/akuntansi/utang` | Utang usaha | `m11.payable.read` |  |
| Data master | `/master/pelanggan` | Pelanggan | `m1.customer.read` |  |
| Data master | `/master/produk` | Produk & harga | `m1.product.read` |  |
| Data master | `/master/zona` | Zona tarif | `m1.tariff_zone.read` |  |
| Data master | `/master/armada` | Armada & kru | `m1.truck.read` |  |
| Data master | `/master/depot` | Depot & toko | `m1.outlet.read` |  |
| Data master | `/master/sumber-air` | Sumber air | `m1.water_source.read` |  |
| Data master | `/master/pool` | Pool/garasi | `m1.pool_location.read` |  |
| Data master | `/master/karyawan` | Karyawan | `m1.employee.read` |  |
| Data master | `/master/impor` | Impor data awal | `m1.import.create` |  |
| Data master | `/master/tanda-tangan` | Tanda tangan data awal | `m1.data_signoff.read` |  |
| Kemitraan | `/kemitraan` | Mitra depot | `p3.partner.read` |  |
| Kemitraan | `/kemitraan/pasokan` | Pasokan & neraca mitra | `p3.partner_supply.read` |  |
| Kemitraan | `/kemitraan/langganan` | Tagihan langganan | `p3.subscription.read` |  |
| Kemitraan | `/kemitraan/dukungan` | Dukungan teknis | `p3.support_request.read` |  |
| Akses & pengaturan | `/akses/pengguna` | Pengguna | `m10.user.read` |  |
| Akses & pengaturan | `/akses/peran` | Peran & matriks | `m10.role.read` |  |
| Akses & pengaturan | `/akses/perangkat` | Perangkat | `m10.device.read` |  |
| Akses & pengaturan | `/akses/sinkron` | Perangkat & sinkron | `m10.sync_health.read` |  |
| Akses & pengaturan | `/akses/tinjauan` | Tinjauan hak akses | `m10.access_review.read` |  |
| Akses & pengaturan | `/akses/data-pribadi` | Data pribadi | `m10.personal_data.read` |  |
| Akses & pengaturan | `/audit` | Jejak audit | `m10.audit_log.read` |  |
| Akses & pengaturan | `/pengaturan/parameter` | Parameter | `m10.parameter.read` |  |
| Akses & pengaturan | `/pengaturan/notifikasi` | Pengaturan notifikasi | _(semua pengguna web kantor)_ |  |
| Akses & pengaturan | `/bantuan` | Bantuan | `m10.support_ticket.create` |  |

<!-- END:AUTO nav-permissions -->
