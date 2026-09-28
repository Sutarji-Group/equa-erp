-- =====================================================================================================================
-- EQUA ERP — perbaikan data SEBELUM `pnpm db:push` pada DB dev yang sudah berisi data (idempoten; tidak berbuat apa pun
-- pada DB kosong atau DB yang sudah mutakhir). Dijalankan `applyPrePushFixups()` (src/db/hardening.ts).
--
-- drizzle-kit push tidak dapat menambah kolom NOT NULL tanpa bawaan ke tabel berisi data (ia mengusulkan TRUNCATE, yang
-- ditolak trigger tanpa-hapus) dan tidak dapat mengubah tipe kolom teks → enum yang berbawaan. Skrip ini menyiapkan
-- kolom tersebut (tambah + isi dari induk + NOT NULL) sehingga push berikutnya hanya menambah FK/indeks.
-- Produksi memakai migrasi `pnpm db:generate` + `pnpm db:migrate` (sertakan langkah yang sama saat membangkitkan).
-- Pemisah pernyataan: baris `--> statement-breakpoint`.
-- =====================================================================================================================

-- Tinjauan skema S0 (NFR-30): tenant_id disalin dari induk pada tabel anak.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT *
    FROM (VALUES
      ('product_prices', 'products', 'product_id'),
      ('stock_count_lines', 'stock_counts', 'stock_count_id'),
      ('consumable_receipt_lines', 'consumable_receipts', 'receipt_id'),
      ('purchase_receipt_lines', 'purchase_receipts', 'receipt_id'),
      ('internal_transfer_lines', 'internal_transfers', 'transfer_id'),
      ('quality_checklist_items', 'quality_checklists', 'checklist_id'),
      ('device_usage_logs', 'devices', 'device_id')
    ) AS v(child, parent, fk_col)
  LOOP
    IF to_regclass(format('public.%I', r.child)) IS NOT NULL
       AND to_regclass(format('public.%I', r.parent)) IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = r.child AND column_name = 'tenant_id'
       ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN tenant_id uuid', r.child);
      EXECUTE format(
        'UPDATE public.%I c SET tenant_id = p.tenant_id FROM public.%I p WHERE p.id = c.%I',
        r.child, r.parent, r.fk_col
      );
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id SET NOT NULL', r.child);
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint

-- Tinjauan skema S0 (7.6.6): nomor POS terbit di perangkat. Baris lama memakai nomor resmi sebagai nomor lokal.
DO $$
BEGIN
  IF to_regclass('public.pos_sales') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pos_sales' AND column_name = 'local_number'
     ) THEN
    ALTER TABLE public.pos_sales ADD COLUMN local_number text;
    ALTER TABLE public.pos_sales ADD COLUMN device_seq integer;
    UPDATE public.pos_sales SET local_number = number, device_seq = 0;
    ALTER TABLE public.pos_sales ALTER COLUMN local_number SET NOT NULL;
    ALTER TABLE public.pos_sales ALTER COLUMN device_seq SET NOT NULL;
  END IF;
END;
$$;
--> statement-breakpoint

-- Tinjauan skema S0 (US-M2-06): recurring_orders.created_via teks → enum order_source.
DO $$
BEGIN
  IF to_regclass('public.recurring_orders') IS NOT NULL
     AND to_regtype('public.order_source') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'recurring_orders' AND column_name = 'created_via'
         AND data_type = 'text'
     ) THEN
    ALTER TABLE public.recurring_orders ALTER COLUMN created_via DROP DEFAULT;
    ALTER TABLE public.recurring_orders
      ALTER COLUMN created_via TYPE public.order_source USING created_via::public.order_source;
    ALTER TABLE public.recurring_orders ALTER COLUMN created_via SET DEFAULT 'office';
  END IF;
END;
$$;
