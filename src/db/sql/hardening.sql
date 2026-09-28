-- =====================================================================================================================
-- EQUA ERP — pengerasan basis data (NFR-11, Bab 6.1 "tidak ada penghapusan", BR-38).
--
-- 1. Semua tabel bisnis di skema `public` MENOLAK DELETE dan TRUNCATE (koreksi = transaksi pembalik; master =
--    nonaktifkan). Dikecualikan: tabel teknis sementara `sessions`, `customer_sessions`, `otp_codes`,
--    `push_subscriptions`, `job_runs`.
-- 2. `audit_logs`, `access_logs`, `domain_events` bersifat append-only: UPDATE dan DELETE ditolak.
-- 3. Retensi terkontrol (US-M10-06 KP-3, PAR-29/PAR-52): DELETE pada `access_logs` (1 tahun) dan `gps_positions`
--    (12 bulan) hanya diizinkan untuk job retensi yang menjalankan `SET LOCAL equa.retention_purge = 'on'` dalam
--    transaksinya. Jejak audit (`audit_logs`) tidak pernah dapat dihapus.
--
-- Idempoten: aman dijalankan ulang (dipanggil `applyDbHardening()` setelah db:push / migrasi / pembuatan DB uji).
-- Tabel baru yang ditambahkan modul otomatis tercakup saat skrip ini dijalankan ulang.
-- SQLSTATE: EQ001 = penghapusan ditolak; EQ002 = catatan append-only diubah/dihapus.
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
END;
$$;
