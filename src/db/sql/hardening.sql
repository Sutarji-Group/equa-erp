-- =====================================================================================================================
-- EQUA ERP — pengerasan basis data (NFR-11, NFR-30, Bab 6.1 "tidak ada penghapusan", Bab 6.7, BR-32, BR-38).
--
-- 1. Semua tabel bisnis di skema `public` MENOLAK DELETE dan TRUNCATE (koreksi = transaksi pembalik; master =
--    nonaktifkan). Dikecualikan: tabel teknis sementara `sessions`, `customer_sessions`, `otp_codes`,
--    `push_subscriptions`, `job_runs`.
-- 2. Append-only (UPDATE ditolak, EQ002):
--    a. jejak: `audit_logs`, `access_logs`, `domain_events` (UPDATE & DELETE ditolak);
--    b. buku besar / ledger / alokasi: `journal_lines` (kecuali baris jurnal Draf/Ditolak yang masih disusun),
--       `stock_ledger`, `outlet_water_ledger`, `payment_allocations`, `supplier_payment_allocations`,
--       `office_cash_movements`, `trip_status_events`. Koreksi = baris pembalik (`reversal_of_id`, jumlah berlawanan).
-- 3. Penjaga kolom imutabel (EQ003) untuk transaksi tersimpan/terposting — lihat daftar per tabel di bagian 3.
--    Kolom yang MEMANG berubah oleh alur sah (status void, penanda pembalik, tautan setoran/faktur, status verifikasi)
--    tetap boleh diubah.
-- 4. Jurnal (US-M11-02 KP-3, US-M11-10 KP-3, BR-32, US-M11-09 KP-1, FR-M11-10):
--    a. constraint trigger DEFERRABLE INITIALLY DEFERRED: jurnal terposting seimbang
--       (Σ debit = Σ kredit = total_debit = total_credit > 0, minimal 2 baris) — EQ004, dicek saat COMMIT;
--    b. posting ke periode Ditutup/Dikunci ditolak — EQ005 (layanan memindahkan peristiwa terlambat ke periode terbuka
--       pertama dengan `origin_period`, FR-M11-10);
--    c. jurnal bertanggal sebelum tanggal cut-over akuntansi tenant ditolak kecuali `kind = 'opening_balance'` — EQ006.
-- 5. NFR-30 isolasi tenant: FK komposit (outlet_id, tenant_id) → outlets(id, tenant_id), (shift_id, tenant_id) →
--    shifts(id, tenant_id), (employee_id, tenant_id) → employees(id, tenant_id). Dikelola DI SINI (bukan drizzle-kit:
--    drizzle-kit menulis FK sebelum indeks unik tujuan dan menyembunyikan indeks yang dirujuk FK saat introspeksi,
--    sehingga `db:push` tidak idempoten). `scripts/db-push.ts` mengabaikan usulan DROP untuk constraint ini
--    (`HARDENING_MANAGED_CONSTRAINTS` di src/db/hardening.ts).
-- 6. Retensi terkontrol (US-M10-06 KP-3, PAR-29/PAR-52): DELETE pada `access_logs` (1 tahun) dan `gps_positions`
--    (12 bulan) hanya diizinkan untuk job retensi yang menjalankan `SET LOCAL equa.retention_purge = 'on'` dalam
--    transaksinya. Jejak audit (`audit_logs`) tidak pernah dapat dihapus.
--
-- Idempoten: aman dijalankan ulang (dipanggil `applyDbHardening()` setelah db:push / migrasi / pembuatan DB uji).
-- Tabel baru yang ditambahkan modul otomatis tercakup trigger no-delete saat skrip ini dijalankan ulang.
-- SQLSTATE (pesan Bahasa Indonesia; detail teknis di DETAIL):
--   EQ001 = penghapusan ditolak                 EQ002 = catatan append-only diubah/dihapus
--   EQ003 = kolom imutabel transaksi diubah     EQ004 = jurnal terposting tidak seimbang
--   EQ005 = posting ke periode Ditutup/Dikunci  EQ006 = jurnal sebelum cut-over akuntansi (selain saldo awal)
-- Pemisah pernyataan: baris `--> statement-breakpoint` (dieksekusi satu per satu).
-- =====================================================================================================================

CREATE OR REPLACE FUNCTION equa_forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND TG_TABLE_NAME IN ('access_logs', 'gps_positions')
     AND coalesce(current_setting('equa.retention_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Data tidak boleh dihapus. Lakukan koreksi dengan transaksi pembalik beralasan atau nonaktifkan datanya.'
    USING ERRCODE = 'EQ001', DETAIL = format('Tabel: %s; operasi: %s', TG_TABLE_NAME, TG_OP);
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION equa_forbid_append_only_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND TG_TABLE_NAME = 'access_logs'
     AND coalesce(current_setting('equa.retention_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Catatan jejak tidak dapat diubah atau dihapus oleh siapa pun.'
    USING ERRCODE = 'EQ002', DETAIL = format('Tabel: %s; operasi: %s', TG_TABLE_NAME, TG_OP);
END;
$$;
--> statement-breakpoint

-- Buku besar / ledger / alokasi: baris yang sudah dicatat tidak pernah di-UPDATE. Pengecualian tunggal: baris jurnal
-- yang induknya masih Draf/Ditolak (jurnal manual yang sedang disusun, belum menjadi buku besar).
CREATE OR REPLACE FUNCTION equa_forbid_ledger_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'journal_lines' THEN
    IF (SELECT status::text FROM journals WHERE id = OLD.journal_id) IN ('draft', 'rejected')
       AND (SELECT status::text FROM journals WHERE id = NEW.journal_id) IN ('draft', 'rejected') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Baris buku yang sudah dicatat tidak dapat diubah. Lakukan koreksi dengan baris pembalik beralasan.'
    USING ERRCODE = 'EQ002', DETAIL = format('Tabel: %s; operasi: %s', TG_TABLE_NAME, TG_OP);
END;
$$;
--> statement-breakpoint

-- Penjaga kolom imutabel (generik). Argumen trigger:
--   TG_ARGV[0] = 'deny'  → kolom yang disebut TIDAK boleh berubah (kolom lain bebas). Akhiran ':once' = boleh diisi
--                          sekali selama nilai lamanya masih NULL (mis. nomor resmi yang diberikan server saat sinkron).
--   TG_ARGV[0] = 'allow' → HANYA kolom yang disebut yang boleh berubah (kolom lain terkunci).
CREATE OR REPLACE FUNCTION equa_guard_immutable_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
  guard_mode text := TG_ARGV[0];
  allowed text[] := ARRAY[]::text[];
  changed text[] := ARRAY[]::text[];
  arg text;
  col text;
  k text;
  i int;
BEGIN
  IF guard_mode = 'allow' THEN
    FOR i IN 1 .. TG_NARGS - 1 LOOP
      allowed := allowed || TG_ARGV[i];
    END LOOP;
    FOR k IN SELECT jsonb_object_keys(new_row) LOOP
      IF NOT (k = ANY (allowed)) AND (old_row -> k) IS DISTINCT FROM (new_row -> k) THEN
        changed := changed || k;
      END IF;
    END LOOP;
  ELSE
    FOR i IN 1 .. TG_NARGS - 1 LOOP
      arg := TG_ARGV[i];
      col := split_part(arg, ':', 1);
      IF (old_row -> col) IS DISTINCT FROM (new_row -> col)
         AND NOT (arg LIKE '%:once' AND (old_row -> col) = 'null'::jsonb) THEN
        changed := changed || col;
      END IF;
    END LOOP;
  END IF;
  IF coalesce(array_length(changed, 1), 0) > 0 THEN
    RAISE EXCEPTION 'Nilai transaksi yang sudah tersimpan tidak dapat diubah. Lakukan koreksi dengan transaksi pembalik beralasan.'
      USING ERRCODE = 'EQ003', DETAIL = format('Tabel: %s; kolom: %s', TG_TABLE_NAME, array_to_string(changed, ', '));
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Tanggal cut-over akuntansi yang BERLAKU SAAT INI untuk tenant (parameter `accounting.cutover_date`, nilai
-- `{ "date": "YYYY-MM-01" | null }`): baris tenant diutamakan atas global (urutan sama dengan params.resolve), lalu
-- effective_from terbaru yang ≤ tanggal WIB hari ini (WIB = UTC+7 tetap, tanpa DST).
CREATE OR REPLACE FUNCTION equa_accounting_cutover_date(p_tenant uuid) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT nullif(p.value ->> 'date', '')::date
  FROM parameters p
  WHERE p.key = 'accounting.cutover_date'
    AND p.outlet_id IS NULL
    AND (p.tenant_id = p_tenant OR p.tenant_id IS NULL)
    AND p.effective_from <= ((now() AT TIME ZONE 'UTC') + interval '7 hours')::date
  ORDER BY (p.tenant_id IS NOT NULL) DESC, p.effective_from DESC
  LIMIT 1
$$;
--> statement-breakpoint

-- Jurnal terposting: periode harus Terbuka/Dibuka kembali (EQ005) dan tanggal ≥ cut-over kecuali saldo awal (EQ006).
-- Dicek saat baris menjadi 'posted' (INSERT langsung terposting atau UPDATE status → posted) atau saat periode/tanggal
-- jurnal terposting berubah (kolom itu juga terkunci penjaga imutabel).
CREATE OR REPLACE FUNCTION equa_guard_journal_posting() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  period_status text;
  period_label text;
  cutover date;
BEGIN
  IF NEW.status::text <> 'posted' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status::text = 'posted'
     AND NEW.period_id IS NOT DISTINCT FROM OLD.period_id
     AND NEW.journal_date IS NOT DISTINCT FROM OLD.journal_date THEN
    RETURN NEW;
  END IF;
  IF NEW.period_id IS NOT NULL THEN
    SELECT ap.status::text, ap.period INTO period_status, period_label FROM accounting_periods ap WHERE ap.id = NEW.period_id;
    IF period_status IN ('closed', 'locked') THEN
      RAISE EXCEPTION 'Periode % sudah ditutup atau dikunci; jurnal tidak dapat diposting ke periode itu. Posting ke periode terbuka pertama dengan penanda asal periode.', period_label
        USING ERRCODE = 'EQ005', DETAIL = format('Jurnal: %s; periode: %s (%s)', NEW.number, period_label, period_status);
    END IF;
  END IF;
  IF NEW.kind::text <> 'opening_balance' THEN
    cutover := equa_accounting_cutover_date(NEW.tenant_id);
    IF cutover IS NOT NULL AND NEW.journal_date < cutover THEN
      RAISE EXCEPTION 'Tanggal jurnal % sebelum tanggal cut-over akuntansi %; hanya jurnal saldo awal yang boleh bertanggal sebelum cut-over.', NEW.journal_date, cutover
        USING ERRCODE = 'EQ006', DETAIL = format('Jurnal: %s; jenis: %s', NEW.number, NEW.kind);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Baris jurnal baru tidak boleh masuk ke jurnal terposting pada periode Ditutup/Dikunci (EQ005).
CREATE OR REPLACE FUNCTION equa_guard_journal_line_period() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  journal_status text;
  journal_number text;
  period_status text;
  period_label text;
BEGIN
  SELECT j.status::text, j.number, ap.status::text, ap.period
    INTO journal_status, journal_number, period_status, period_label
  FROM journals j
  LEFT JOIN accounting_periods ap ON ap.id = j.period_id
  WHERE j.id = NEW.journal_id;
  IF journal_status = 'posted' AND period_status IN ('closed', 'locked') THEN
    RAISE EXCEPTION 'Periode % sudah ditutup atau dikunci; baris jurnal tidak dapat ditambahkan.', period_label
      USING ERRCODE = 'EQ005', DETAIL = format('Jurnal: %s; periode: %s (%s)', journal_number, period_label, period_status);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Keseimbangan jurnal terposting (constraint trigger DEFERRABLE INITIALLY DEFERRED → dicek saat COMMIT, sehingga
-- layanan boleh menyisipkan header jurnal lalu baris-barisnya dalam satu transaksi).
CREATE OR REPLACE FUNCTION equa_check_journal_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  jid uuid;
  j record;
  sum_debit bigint;
  sum_credit bigint;
  line_count int;
BEGIN
  IF TG_TABLE_NAME = 'journal_lines' THEN
    jid := NEW.journal_id;
  ELSE
    jid := NEW.id;
  END IF;
  SELECT id, number, status::text AS status, total_debit, total_credit INTO j FROM journals WHERE id = jid;
  IF j.id IS NULL OR j.status <> 'posted' THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    INTO sum_debit, sum_credit, line_count
  FROM journal_lines WHERE journal_id = jid;
  IF line_count < 2 OR sum_debit <> sum_credit OR sum_debit <> j.total_debit OR sum_credit <> j.total_credit
     OR j.total_debit <= 0 THEN
    RAISE EXCEPTION 'Jurnal % tidak seimbang: total debit harus sama dengan total kredit (minimal dua baris). Periksa baris jurnal sebelum memposting.', j.number
      USING ERRCODE = 'EQ004',
            DETAIL = format('Baris: %s; Σ debit: %s; Σ kredit: %s; total_debit: %s; total_credit: %s',
                            line_count, sum_debit, sum_credit, j.total_debit, j.total_credit);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. No-delete & 2a. jejak append-only
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  t text;
BEGIN
  FOR r IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('sessions', 'customer_sessions', 'otp_codes', 'push_subscriptions', 'job_runs')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS equa_no_delete ON public.%I', r.tablename);
    EXECUTE format(
      'CREATE TRIGGER equa_no_delete BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION equa_forbid_delete()',
      r.tablename
    );
    EXECUTE format('DROP TRIGGER IF EXISTS equa_no_truncate ON public.%I', r.tablename);
    EXECUTE format(
      'CREATE TRIGGER equa_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION equa_forbid_delete()',
      r.tablename
    );
  END LOOP;

  FOREACH t IN ARRAY ARRAY['audit_logs', 'access_logs', 'domain_events'] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS equa_append_only ON public.%I', t);
      EXECUTE format(
        'CREATE TRIGGER equa_append_only BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION equa_forbid_append_only_change()',
        t
      );
    END IF;
  END LOOP;

  -- 2b. Buku besar / ledger / alokasi / riwayat aksi lapangan: UPDATE ditolak (DELETE sudah ditolak equa_no_delete).
  FOREACH t IN ARRAY ARRAY[
    'journal_lines', 'stock_ledger', 'outlet_water_ledger', 'payment_allocations', 'supplier_payment_allocations',
    'office_cash_movements', 'trip_status_events'
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS equa_append_only ON public.%I', t);
      EXECUTE format(
        'CREATE TRIGGER equa_append_only BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION equa_forbid_ledger_update()',
        t
      );
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Penjaga kolom imutabel (trigger `equa_immutable`, SQLSTATE EQ003). Per tabel:
--
-- journals — HANYA saat OLD.status = 'posted' (mode allow). Boleh berubah: owner_reviewed_at, owner_reviewed_by
--   (tinjauan pemilik PTB-12), auto_reverse_on (akrual), updated_at. Selain itu terkunci; koreksi = jurnal pembalik
--   (`kind = 'reversal'`, `reversal_of_id`). Jurnal Draf/Diajukan/Disetujui bebas diubah layanan.
-- trip_payments — terkunci: tenant_id, trip_id, customer_id, driver_user_id, method, original_method, expected_amount,
--   received_amount, underpayment_amount, business_date, reversal_of_id, device_time, recorded_by_office.
--   Boleh berubah: deposit_id, invoice_id, incoming_transfer_id, transfer_proof_attachment_id, method_change_approval_id,
--   underpayment_reason, reversal_reason, correction_approval_id, reversed_at, reversed_by_id, synced_at, late_sync,
--   clock_skew_flagged, sync_command_id, device_id, office_record_reason, updated_at.
-- customer_payments — terkunci: tenant_id, customer_id, channel, method, amount, advance_amount, business_date, trip_id,
--   driver_user_id, reversal_of_id, device_time, recorded_by_office. Boleh berubah: deposit_id, incoming_transfer_id,
--   office_cash_movement_id, proof_attachment_id, payment_intent_id, notes, reversal_reason, correction_approval_id,
--   kolom sinkron (synced_at, late_sync, clock_skew_flagged, …), updated_at.
-- pos_sales — terkunci setelah tersimpan: tenant_id, outlet_id, shift_id, local_number, device_seq, device_id,
--   operator_user_id, customer_id, price_kind, business_date, sold_at, subtotal, discount_percent, discount_amount,
--   total, payment_method, cash_received, change_amount, replaces_sale_id, reversal_of_id, is_reversal, device_time,
--   recorded_by_office; `number` sekali isi (NULL → nomor resmi saat sinkron). Boleh berubah: status (void/persetujuan),
--   void_reason, void_note, void_requested_at, voided_at, voided_by, void_approval_id, discount_reason,
--   discount_approval_id, invoice_id, qris_reference, price_mismatch, credit_offline, receipt_printed, reversal_reason,
--   correction_approval_id, kolom sinkron, updated_at.
-- pos_sale_lines — terkunci: pos_sale_id, tenant_id, outlet_id, business_date, line_no, product_id, product_price_id,
--   quantity, unit_price, line_total, gallon_size_l; unit_cost sekali isi (HPP saat sinkron). Boleh berubah: updated_at.
-- meter_readings — terkunci: tenant_id, water_source_id, water_meter_id, business_date, phase, reading_l, read_at,
--   device_time, recorded_by_office. Boleh berubah: status, anomaly_note, adjustment_kind, adjustment_reason,
--   verified_by, verified_at, superseded_by_id + correction_reason (koreksi = baris baru), photo_attachment_id,
--   recorded_by, kolom sinkron, updated_at.
-- truck_fills — terkunci: tenant_id, water_source_id, truck_id, business_date, volume_l, filled_at, reversal_of_id,
--   device_time, recorded_by_office; trip_id sekali isi (pengisian tanpa rit dapat ditautkan kemudian). Boleh berubah:
--   status, volume_reason, is_depot_supply, unplanned_truck, geofence_mismatch, photo_attachment_id, recorded_by,
--   reversed_at, reversed_by_id, reversal_reason, kolom sinkron, updated_at.
-- invoices — terkunci: tenant_id, kind, customer_id, amount, issue_date, is_opening_balance; trip_id & pos_sale_id
--   sekali isi. Boleh berubah (alur pelunasan/sengketa/pengiriman): paid_amount, credited_amount, written_off_amount,
--   outstanding_amount (CHECK konsisten), status, paid_at, due_date, dispute_*, pdf_attachment_id, sent_at, sent_via,
--   pending_transfer_id, written_off_at, write_off_journal_id, write_off_approval_id, description, updated_at.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  g record;
  arg text;
  col text;
  args text[];
BEGIN
  FOR g IN
    SELECT *
    FROM (VALUES
      ('journals', 'OLD.status = ''posted''', ARRAY['allow', 'owner_reviewed_at', 'owner_reviewed_by', 'auto_reverse_on', 'updated_at']),
      ('trip_payments', NULL, ARRAY['deny', 'tenant_id', 'trip_id', 'customer_id', 'driver_user_id', 'method', 'original_method',
        'expected_amount', 'received_amount', 'underpayment_amount', 'business_date', 'reversal_of_id', 'device_time',
        'recorded_by_office']),
      ('customer_payments', NULL, ARRAY['deny', 'tenant_id', 'customer_id', 'channel', 'method', 'amount', 'advance_amount',
        'business_date', 'trip_id', 'driver_user_id', 'reversal_of_id', 'device_time', 'recorded_by_office']),
      ('pos_sales', NULL, ARRAY['deny', 'tenant_id', 'outlet_id', 'shift_id', 'number:once', 'local_number', 'device_seq',
        'device_id', 'operator_user_id', 'customer_id', 'price_kind', 'business_date', 'sold_at', 'subtotal',
        'discount_percent', 'discount_amount', 'total', 'payment_method', 'cash_received', 'change_amount',
        'replaces_sale_id', 'reversal_of_id', 'is_reversal', 'device_time', 'recorded_by_office']),
      ('pos_sale_lines', NULL, ARRAY['deny', 'pos_sale_id', 'tenant_id', 'outlet_id', 'business_date', 'line_no', 'product_id',
        'product_price_id', 'quantity', 'unit_price', 'line_total', 'unit_cost:once', 'gallon_size_l']),
      ('meter_readings', NULL, ARRAY['deny', 'tenant_id', 'water_source_id', 'water_meter_id', 'business_date', 'phase',
        'reading_l', 'read_at', 'device_time', 'recorded_by_office']),
      ('truck_fills', NULL, ARRAY['deny', 'tenant_id', 'water_source_id', 'truck_id', 'trip_id:once', 'business_date',
        'volume_l', 'filled_at', 'reversal_of_id', 'device_time', 'recorded_by_office']),
      ('invoices', NULL, ARRAY['deny', 'tenant_id', 'kind', 'customer_id', 'amount', 'issue_date', 'is_opening_balance',
        'trip_id:once', 'pos_sale_id:once'])
    ) AS v(tbl, cond, spec)
  LOOP
    IF to_regclass(format('public.%I', g.tbl)) IS NULL THEN
      CONTINUE;
    END IF;
    -- Salah ketik nama kolom akan membuat penjaga diam-diam tidak berlaku → tolak saat pemasangan.
    FOREACH arg IN ARRAY g.spec[2:] LOOP
      col := split_part(arg, ':', 1);
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = g.tbl AND column_name = col
      ) THEN
        RAISE EXCEPTION 'hardening.sql: kolom %.% tidak ada (penjaga imutabel)', g.tbl, col;
      END IF;
    END LOOP;
    SELECT array_agg(quote_literal(u.a) ORDER BY u.n) INTO args FROM unnest(g.spec) WITH ORDINALITY AS u(a, n);
    EXECUTE format('DROP TRIGGER IF EXISTS equa_immutable ON public.%I', g.tbl);
    EXECUTE format(
      'CREATE TRIGGER equa_immutable BEFORE UPDATE ON public.%I FOR EACH ROW %s EXECUTE FUNCTION equa_guard_immutable_columns(%s)',
      g.tbl,
      CASE WHEN g.cond IS NULL THEN '' ELSE format('WHEN (%s)', g.cond) END,
      array_to_string(args, ', ')
    );
  END LOOP;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Jurnal: periode & cut-over (BEFORE), keseimbangan (constraint trigger DEFERRED)
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.journals') IS NULL OR to_regclass('public.journal_lines') IS NULL THEN
    RETURN;
  END IF;
  DROP TRIGGER IF EXISTS equa_journal_posting ON public.journals;
  CREATE TRIGGER equa_journal_posting BEFORE INSERT OR UPDATE ON public.journals
    FOR EACH ROW EXECUTE FUNCTION equa_guard_journal_posting();

  DROP TRIGGER IF EXISTS equa_journal_line_period ON public.journal_lines;
  CREATE TRIGGER equa_journal_line_period BEFORE INSERT ON public.journal_lines
    FOR EACH ROW EXECUTE FUNCTION equa_guard_journal_line_period();

  DROP TRIGGER IF EXISTS equa_journal_balance ON public.journals;
  CREATE CONSTRAINT TRIGGER equa_journal_balance AFTER INSERT OR UPDATE ON public.journals
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW.status = 'posted') EXECUTE FUNCTION equa_check_journal_balance();

  DROP TRIGGER IF EXISTS equa_journal_balance ON public.journal_lines;
  CREATE CONSTRAINT TRIGGER equa_journal_balance AFTER INSERT OR UPDATE ON public.journal_lines
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION equa_check_journal_balance();
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. NFR-30: indeks unik (id, tenant_id) + FK komposit tenant (nama `*_tenant_fk`; daftar yang sama di
--    `TENANT_FOREIGN_KEYS`, src/db/hardening.ts — uji tests/db memastikan keduanya sinkron).
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.outlets') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS outlets_id_tenant_uq ON public.outlets (id, tenant_id);
  END IF;
  IF to_regclass('public.employees') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS employees_id_tenant_uq ON public.employees (id, tenant_id);
  END IF;
  IF to_regclass('public.shifts') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS shifts_id_tenant_uq ON public.shifts (id, tenant_id);
  END IF;

  FOR r IN
    SELECT *
    FROM (VALUES
      ('users', 'users_employee_tenant_fk', 'employee_id, tenant_id', 'employees'),
      ('shifts', 'shifts_outlet_tenant_fk', 'outlet_id, tenant_id', 'outlets'),
      ('shift_stock_counts', 'shift_stock_counts_outlet_tenant_fk', 'outlet_id, tenant_id', 'outlets'),
      ('shift_stock_counts', 'shift_stock_counts_shift_tenant_fk', 'shift_id, tenant_id', 'shifts'),
      ('pos_sales', 'pos_sales_outlet_tenant_fk', 'outlet_id, tenant_id', 'outlets'),
      ('pos_sales', 'pos_sales_shift_tenant_fk', 'shift_id, tenant_id', 'shifts'),
      ('pos_sale_lines', 'pos_sale_lines_outlet_tenant_fk', 'outlet_id, tenant_id', 'outlets'),
      ('stock_ledger', 'stock_ledger_outlet_tenant_fk', 'outlet_id, tenant_id', 'outlets'),
      ('stock_balances', 'stock_balances_outlet_tenant_fk', 'outlet_id, tenant_id', 'outlets'),
      ('stock_counts', 'stock_counts_outlet_tenant_fk', 'outlet_id, tenant_id', 'outlets'),
      ('consumable_receipts', 'consumable_receipts_outlet_tenant_fk', 'outlet_id, tenant_id', 'outlets'),
      ('water_supply_receipts', 'water_supply_receipts_outlet_tenant_fk', 'outlet_id, tenant_id', 'outlets'),
      ('outlet_water_ledger', 'outlet_water_ledger_outlet_tenant_fk', 'outlet_id, tenant_id', 'outlets'),
      ('deposits', 'deposits_outlet_tenant_fk', 'outlet_id, tenant_id', 'outlets'),
      ('deposits', 'deposits_shift_tenant_fk', 'shift_id, tenant_id', 'shifts'),
      ('purchase_receipts', 'purchase_receipts_outlet_tenant_fk', 'outlet_id, tenant_id', 'outlets'),
      ('reorder_items', 'reorder_items_outlet_tenant_fk', 'outlet_id, tenant_id', 'outlets'),
      ('quality_checklists', 'quality_checklists_outlet_tenant_fk', 'outlet_id, tenant_id', 'outlets'),
      ('product_prices', 'product_prices_outlet_tenant_fk', 'outlet_id, tenant_id', 'outlets'),
      ('internal_transfers', 'internal_transfers_from_outlet_tenant_fk', 'from_outlet_id, tenant_id', 'outlets'),
      ('internal_transfers', 'internal_transfers_to_outlet_tenant_fk', 'to_outlet_id, tenant_id', 'outlets')
    ) AS v(tbl, name, cols, ref_tbl)
  LOOP
    IF to_regclass(format('public.%I', r.tbl)) IS NULL OR to_regclass(format('public.%I', r.ref_tbl)) IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = r.name AND conrelid = format('public.%I', r.tbl)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES public.%I (id, tenant_id)',
        r.tbl, r.name, r.cols, r.ref_tbl
      );
    END IF;
  END LOOP;
END;
$$;
