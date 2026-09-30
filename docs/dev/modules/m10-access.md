# Hand-off modul M10 — Pengguna, Hak Akses & Jejak Audit

PRD 7.10 (US-M10-01..07). Fondasi (F3a/F3c) sudah menyediakan auth web+2FA, perangkat & PIN, sesi, RBAC+SoD,
persetujuan, audit berantai, log akses, notifikasi, parameter, dan halaman inti. Modul ini melengkapi seluruh KP M10:
layanan administrasi akses, UI `/akses/*`, pemantauan, data pribadi, retensi, dan penyempurnaan `/audit`,
`/persetujuan`, `/bantuan`.

## API publik (`@/server/modules/m10-access`)

Semua fungsi layanan: `fn(ctx, input, opts?: { tx?: Tx })` → authorize → Zod → aturan + SoD → `runService(tx)` →
`audit.record` → notifikasi. Teruskan `tx` bila dipanggil dari transaksi modul lain.

### Pengguna, peran, lingkup (US-M10-01)
| Fungsi | Izin | Keterangan |
|---|---|---|
| `createUser(ctx, { employeeId, username, role, scopes[], reason, initialLoad? })` → `{ user, approval }` | `m10.user.create` | Tepat satu karyawan (BR-36), peran katalog, lingkup sesuai peran (`scopeRuleFor`). Status Menunggu persetujuan; permintaan `account_create`. `initialLoad` = akun awal go-live (tanpa permintaan; ditutup setelah daftar ditandatangani). |
| `requestRoleChange(ctx, { userId, role, mode: "replace"\|"add", validUntil?, scopes?, reason })` | `m10.role.request` | `replace` → `role_grant` (pindah peran; peran lama & lingkup tak sesuai dicabut saat disetujui). `add` → `multi_role` (masa berlaku wajib). PTB-31 via `sod.assertRoleCombination` SEBELUM diajukan. |
| `requestScopeExtension(ctx, { userId, scopes[], validUntil?, reason })` | `m10.scope.request` | `scope_extension`. |
| `requestReactivation(ctx, { userId, role, scopes?, reason })` | `m10.user.create` | Akun nonaktif → `account_create` mode `reactivate`. |
| `revokeRole` / `revokeScope(ctx, { userId, roleId\|scopeId, reason })` | `m10.role.revoke` / `m10.scope.revoke` | Seketika tanpa persetujuan (BR-37). |
| `deactivateUser(ctx, { userId, reason })` → `{ sessionsRevoked, devicesBlocked[], requestsCancelled }` | `m10.user.deactivate` | `revokeAllSessions` + `blockDevice` untuk perangkat yang dipegang + batalkan permintaan akses terbuka. Tidak untuk akun sendiri. |
| `deactivateInTx(tx, ctx, userId, reason, { rule, exitDate })` | — (internal/sistem) | Dipakai handler tanggal keluar dengan `systemContext` (pelaku "Sistem", aturan BR-37). |
| `resetPin` / `issueInitialPin` | `m10.user.reset_pin` | Bungkus `issuePinEnrollment` (core memberi tahu pemilik `user.pin_reset`). |
| `resetPassword(ctx, { userId, reason })` → `{ temporaryPassword }` | `m10.user.reset_password` | Sementara ≥ 10 karakter, `must_change_password`, sesi web dicabut, notifikasi `user.password_reset`; akun pemilik juga e-mail (7.10.6). |
| `resetTwoFactor(ctx, { userId, reason })` | `m10.user.reset_totp` | Bungkus core `resetTotp` + e-mail bila akun pemilik. |
| `listUsers`, `getUserDetail`, `listEmployeesWithoutAccount`, `listScopeOptions` | `m10.user.read` | Tampilan. |
| `prepareInitialAccountsSignoff`, `signInitialAccounts(ctx, signoffId)`, `initialAccountsStatus` | `m10.user.create` / `m10.initial_accounts.sign` | Akun awal go-live lewat `data_signoffs` kelompok `initial_accounts` (KP-8, NFR-34). Penyusun ≠ penanda tangan (SOD-01). |
| `accessReviewList(ctx, quarter?)`, `markAccessReviewed(ctx, { quarter, notes })` | `m10.access_review.read` / `.mark` | KP-6: penanda `no_login` (> `access.review_inactive_days`), `multi_role`, `multi_role_expired`. |
| `accessChangesOn(tx, tenantId, date)`, `dailyAccessSummary(now)` | — | KP-7 → notifikasi pemilik `access.daily_summary`. |
| `handleEmployeeExited(tx, payload, now)`, `runExitDateSweep(now)` | — | KP-5 (event M1 + job harian). |

### Perangkat & sinkron (US-M10-02, US-M10-07)
| Fungsi | Izin |
|---|---|
| `registerDevice`, `issueActivationCode`, `blockDevice`, `requestWipe` (re-export core) | `m10.device.*` |
| `listDevices`, `getDeviceDetail(ctx, id)` → pemakaian, login gagal, sesi (pemegang aktual per sesi, `isHolder`), insiden | `m10.device.read` |
| `updateDeviceAssignment(ctx, { deviceId, name?, truckId\|outletId\|waterSourceId, holderEmployeeId, isSpare, notes, reason })` | `m10.device.update` (pindah unit memutus sesi) |
| `listSyncHealth(ctx)` (Dispatcher: hanya perangkat truk), `listSyncConflicts(ctx)` | `m10.sync_health.read`, `m10.sync_conflict.read` |
| `setMinAppVersion(ctx, { version, reason })`, `getAppVersionPolicy(tx, date)` | `m10.app_version.update` (baru; admin sistem) — menulis parameter `app.min_supported_version` mulai hari ini, aturan audit NFR-32 |
| `raiseIncident(tx, { tenantId, kind, severity?, title, description?, objectType?, objectId?, detectedAt?, dedupe?, alsoNotify?, now? })` → `{ incident, created }` | — (untuk modul lain, mis. **M12 perangkat GPS mati**); tanpa duplikat insiden terbuka untuk kejadian+objek yang sama; notifikasi `incident.opened` |
| `acknowledgeIncident`, `resolveIncident`, `listIncidents` (+ `incidentMetrics`) | `m10.incident.update` / `.read` — target `monitoring.incident_targets` (30 menit / 4 jam) |
| `runMonitoring(now, db?)` | job — sinkron gagal massal, layanan tidak dapat diakses (jeda denyut), GPS mati |
| `listSupportTickets`, `answerSupportTicket`, `closeSupportTicket`, `myTicketsForField`, `remindUnansweredTickets` | `m10.support_ticket.read/answer/create` |

### Pemisahan tugas, persetujuan, audit (US-M10-03/04/05)
- `roleMatrixView()` (murni): matriks + `SOD_RULES` + kombinasi terlarang.
- `listDenials(ctx)` (`m10.access_log.read`): percobaan ditolak 30 hari + per pengguna/hari (`alerted` > 3).
- `listAccessLogs(ctx, { event?, username?, userId?, success?, from?, to? })` (`m10.access_log.read`).
- `describeApprovalRules(tx, businessDate)`: seluruh jenis 6.2a dengan nilai ambang parameter yang berlaku.

### Data pribadi, retensi, cadangan (US-M10-06)
- **Untuk modul lain (murni):** `viewPolicy(ctx, { ownTripToday? })` → `{ customer: "full"|"name_only", employeeSensitive, exportPii }`;
  `maskCustomerPii(ctx, row, { ownTripToday? })` (WA disamarkan `maskPhone`, alamat → wilayah `regionOnly`, koordinat &
  nama kontak null); `employeeDataAccess(ctx, employeeId, "pin"|"discrepancy_history"|"restitution"|"contact")` →
  `full|without_values|none`; `redactEmployeeValues(row, access, keys)`.
- `requestAnonymization(ctx, { subjectType: "customer"|"employee", subjectId, reason })` (`m10.anonymization.request`),
  `resubmitAnonymization`, `listAnonymizationRequests`, `anonymizationCandidates`, `executeAnonymization(tx, ctx, row)`,
  `openReceivableOf(tx, customerId)`.
- `runRetention(now, db?)`, `retentionPolicy`, `retentionOverview`, `ARCHIVABLE_ATTACHMENT_KINDS`.
- `recordBackupStatus(ctx, …)` (`m10.backup_status.create`), `backupOverview(ctx)` (`m10.backup_status.read`).

## Event
- **Ditangani:** `employee.exited` `{ employeeId, exitDate, tenantId }` (dari M1; ditambahkan ke `events.types.ts`) →
  `m10-access:employee-exited` (savepoint). Tanggal keluar ≤ hari ini → nonaktif seketika; di masa depan → job
  `m10.users.exit_date` pada harinya. **M1 WAJIB memancarkan event ini saat tanggal keluar ditetapkan.**
- **Dipancarkan:** tidak ada event domain baru (perubahan akses dicatat di jejak audit; efek ke modul lain lewat
  `buildActorContext` yang selalu membaca peran/lingkup/status terkini).

## Sinkron lapangan
- Pull `m10.support_tickets` → `FieldTicket[]` (laporan milik pengguna: status, jawaban, tenggat).
- Perintah `m10.support_ticket.close` `{ ticketId, note? }` (izin `m10.support_ticket.create`; idempoten; pelapor saja).
- Laporan baru dari perangkat memakai perintah inti `core.support.report`.
- Komponen siap pakai: `@/components/m10-access/field-support-panel` (`<FieldSupportPanel />`) untuk dipasang di menu
  Bantuan aplikasi sopir/POS/produksi (di dalam `<FieldGate>`).

## Persetujuan (handler di `approvals.ts`)
| Jenis | Disetujui | Ditolak/dibatalkan | Lewat tenggat |
|---|---|---|---|
| `account_create` | akun + peran + lingkup aktif (mode `create`/`reactivate`) | pemberian ditolak; akun baru → nonaktif | `escalate` (D-08): tetap terbuka, ditandai, akun tidak aktif |
| `role_grant` | peran baru aktif; peran lama & lingkup tak sesuai dicabut | pemberian ditolak | `escalate` |
| `multi_role` | peran tambahan aktif s.d. masa berlaku | pemberian ditolak | tanpa tenggat |
| `scope_extension` | lingkup baru aktif | pemberian ditolak | `escalate` |
| `anonymization` | anonimisasi dijalankan (ditunda bila piutang terbuka) | status ditolak | tanpa tenggat |
Kombinasi peran diperiksa ulang saat disetujui (bila kini terlarang → `ROLE_COMBINATION_FORBIDDEN`, pemilik diminta menolak).

## Notifikasi (baru di katalog)
`access.daily_summary` (pemilik), `user.password_reset` (pemilik), `user.deactivated` (pemilik, penonaktifan otomatis),
`access_review.due` (pemilik), `anonymization.deferred` (admin sistem/pemohon), `anonymization.executed`,
`backup.failed` (admin sistem, pemilik), `support.ticket_answered` (pelapor). Dipakai dari katalog lama:
`incident.opened`, `sync.mass_failure`, `support.feedback_unanswered`, `user.pin_reset`, `user.totp_reset`.

## Parameter (baru, fallback registri)
`access.review_inactive_days {days:60}`, `monitoring.mass_sync_failure {devices_gt:3, minutes_gt:30}`,
`monitoring.service_down {minutes_gt:15}`, `monitoring.incident_targets {response_minutes:30, recovery_hours:4}`,
`backup.policy {daily_max_age_hours:26, restore_tests_per_year:2}`. Dipakai: PAR-07, PAR-25, PAR-29, PAR-30, PAR-47,
PAR-52, PAR-87, `app.min_supported_version`, `notifications.digest_recipients`.

## Izin (baru)
`m10.app_version.update` [SA], `m10.initial_accounts.sign` [O], `m10.access_log.export` [O].

## Job
`m10.users.exit_date` (00.10), `m10.monitor.health` (5 menit), `m10.support.unanswered` (08.00),
`m10.access.daily_summary` (22.15), `m10.access_review.reminder` (bulanan tgl 1; bulan akhir kuartal),
`m10.retention.daily` (02.30), `m10.anonymization.deferred` (07.00).

## Laporan (Excel/PDF)
`m10.users`, `m10.access_review`, `m10.devices`, `m10.device_usage` (`deviceId`), `m10.sync_health`, `m10.access_log`,
`m10.denials`, `m10.incidents`, `m10.support_tickets`, `m10.backup_status`, `m10.anonymization` (+ core
`core.rbac_matrix`, `core.audit_log`).

## Rute
`/akses` (ringkasan), `/akses/pengguna`, `/akses/pengguna/[id]`, `/akses/peran`, `/akses/perangkat`,
`/akses/perangkat/[id]`, `/akses/sinkron`, `/akses/tinjauan`, `/akses/data-pribadi`; penyempurnaan `/audit`
(tab **Log akses** `?tab=akses`, filter objek/tindakan), `/bantuan` (kotak helpdesk, pelapor tandai selesai),
`/persetujuan` (`?id=` dari tautan push tampil teratas; tabel aturan 6.2a).

## Aturan penting & keputusan desain
1. **Akses tidak pernah aktif tanpa keputusan pemilik** (D-08): semua pemberian berstatus `pending` dan terikat
   `approval_request_id`; handler mengaktifkan hanya baris yang tertaut permintaan itu.
2. **Pencabutan seketika**: status `revoked`/`inactive`; tidak ada DELETE. `buildActorContext` membaca status terkini
   sehingga web & lapangan langsung terdampak; nonaktif juga memutus sesi & memblokir perangkat yang dipegang.
3. **Admin sistem tidak mengubah akses akunnya sendiri** (SOD-01; BRD 10.4 "2–3 orang IT").
4. **Versi minimal** diatur admin sistem (bukan pemilik) karena rilis aplikasi adalah tanggung jawab tim IT (NFR-32);
   ditulis langsung ke tabel parameter dengan jejak audit (aturan NFR-32), tanpa notifikasi 6.2b.
5. **Layanan tidak dapat diakses** dideteksi dari jeda denyut job pemantauan (tidak ada tick = layanan/penjadwal tidak
   terjangkau) pada jam layanan; dicatat saat layanan kembali.
6. **Anonimisasi** menulis langsung kolom data pribadi di tabel M1/M2/P2 (`customers`, `customer_addresses`, `trips`,
   `wa_message_logs`, `customer_accounts`) — lintas modul yang disengaja karena kewajiban UU PDP dimiliki M10; catatan
   keuangan & jejak audit tidak disentuh.
7. **Akun awal go-live**: mode `initialLoad` hanya sampai ada tanda tangan `initial_accounts` berstatus signed.

## Hal belum selesai / catatan integrasi
- M1 harus memancarkan `employee.exited` (payload di atas) saat tanggal keluar diisi/diubah.
- M12 sebaiknya memanggil `raiseIncident(tx, { kind: "gps_device_dead", objectType: "device", objectId })` saat
  mendeteksi GPS mati (job M10 juga mendeteksinya dari `devices.gps_last_position_at`; tidak ada duplikat).
- Alur login belum memaksa ganti kata sandi saat `must_change_password = true` (berkas core `web-login.ts`).
- Aplikasi lapangan (M3/M6/M8) perlu memasang `<FieldSupportPanel />` di menu Bantuan.
- Jejak audit menyimpan riwayat nilai lama (termasuk data pribadi sebelum anonimisasi) — append-only NFR-11; dicatat
  sebagai risiko kepatuhan untuk komite (penyamaran per kolom di jejak audit butuh keputusan PM).

## Pengerasan S5 (paket A) — status butir di atas
- **B-08 SELESAI**: login web/portal dengan `must_change_password = true` → sesi hanya membuka `/akun/kata-sandi`
  (`requireOfficeSession`/`requirePortalSession` mengalihkan; `webActorFromToken` menolak API). Ubah kata sandi mandiri
  untuk SEMUA pengguna web (menu pengguna kantor "Ubah kata sandi", tombol di portal mitra): `changeOwnPassword(token,
  input)` di `src/server/core/auth/password-change.ts` — kata sandi saat ini wajib, ≥ 10 karakter, beda dari lama &
  nama pengguna; sesi web lain dicabut; jejak audit + log akses `password_changed`; salah kata sandi dihitung PAR-36.
  Uji `tests/core/auth-password-change.test.ts`, E2E `e2e/m10-access.spec.ts`.
- **B-09 SELESAI** (D-09 butir 1): `queryForActor` (halaman `/audit`, ekspor `core.audit_log`) menyamarkan nilai data
  pribadi (`AUDIT_CUSTOMER_PII_KEYS`) pada baris milik pelanggan yang sudah dianonimkan bagi semua peran KECUALI pemilik
  (`maskAnonymizedPii`, dapat dipakai modul lain). Jejak tetap append-only. Uji `tests/m10-access/audit-pii.test.ts`.
- **B-42 SELESAI**: `/akses/perangkat/[id]` perangkat GPS menyematkan `GpsHealthCard` M12 (`getGpsDeviceHealth`, izin
  `m12.fleet_event.read`); job `m10.monitor.health` hanya MENGHITUNG GPS mati untuk ringkasan — insiden & peringatan
  `gps.device_dead` milik M12 (tidak ada ganda). Uji `tests/m10-access/monitoring.test.ts`.
- **B-60 SELESAI** (D-10 butir 5): `access.request_pending` dipertahankan sebagai alias terdokumentasi di katalog
  (komentar), tidak dikirim; permintaan akses tetap `approval.requested` (satu notifikasi). Uji
  `tests/m10-access/notification-alias.test.ts`.
- **B-71 SELESAI** (D-11 butir 1): izin portal Tahap 3 terdaftar sebagai izin bersyarat `partner_portal_phase3` di
  `CONDITIONAL_GRANTS` (tampil "Bersyarat" di ekspor matriks peran). Uji `tests/core/rbac.test.ts`.
- `<FieldSupportPanel />` kini terpasang di /sopir (M3), /produksi (M8), dan /pos depot & toko (M6/M7, B-03).

## Perbaikan audit S5B (paket A)

- **Anonimisasi (US-M10-06 KP-2, PTB-36)**: `openReceivableOf` = definisi piutang M5 (`getReceivableBalance`: faktur
  bersisa + `unbilled_charges`) → `{ count, amount, unbilled, blocked }`; rit tempo belum ditagih juga menunda.
- **Ringkasan akses harian (US-M10-01 KP-7)**: jendela = sejak `windowEnd` ringkasan terakhir (jejak `access_summary`)
  sampai sekarang; perubahan 22.15–24.00 masuk ringkasan berikutnya. Baru: `accessChangesBetween(tx, tenantId, start, end)`.
- **Versi minimal (US-M10-07 KP-4, NFR-32)**: ditegakkan server — push dari versi lama dijawab `retry`
  `APP_UPDATE_REQUIRED` (antrean tertahan), login PIN daring ditolak 426, log perangkat `update_required`
  (`src/server/core/sync/app-version.ts`).
- **Retensi GPS (US-M12-01 KP-6, PTB-33)**: `runRetention` menghapus GPS mentah lewat M12 `purgeExpiredPositions`
  (ringkasan rit/hari dipastikan dulu; impor dinamis karena M12 mengimpor M10).
- **/persetujuan (NFR-15/19)**: kartu menampilkan `approvalObjectText` (label objek Indonesia + nomor dokumen dari
  payload), tanpa UUID.
- Uji: `tests/m10-access/{personal-data,users,monitoring,sod-approvals}.test.ts` (judul US-M10-06 KP-2/KP-3,
  US-M10-01 KP-7, US-M10-07 KP-4, US-M10-04 KP-2).
