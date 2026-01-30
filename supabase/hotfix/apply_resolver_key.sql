-- =============================================================================
-- HOTFIX: Add resolver_key to books_catalog
-- =============================================================================
--
-- PURPOSE: Apply this SQL via Supabase Dashboard → SQL Editor if not using CLI.
--
-- INSTRUCTIONS:
--   1. Open Supabase Dashboard → SQL Editor
--   2. Paste this entire file
--   3. Click "Run"
--   4. Verify output shows no errors
--
-- IDEMPOTENT: Safe to run multiple times.
-- =============================================================================

-- Step 1: Add resolver_key column (if not exists)
ALTER TABLE public.books_catalog
  ADD COLUMN IF NOT EXISTS resolver_key TEXT;

-- Step 2: Create unique index (if not exists)
CREATE UNIQUE INDEX IF NOT EXISTS books_catalog_resolver_key_uidx
  ON public.books_catalog (resolver_key);

-- Step 3: Backfill existing rows (only where NULL)
UPDATE public.books_catalog
SET resolver_key = provider || ':' || provider_id
WHERE resolver_key IS NULL
  AND provider IS NOT NULL
  AND provider_id IS NOT NULL;

-- Step 4: Notify PostgREST to reload schema cache
-- This is CRITICAL - without it, PostgREST will return PGRST204 errors
NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- VERIFICATION (optional - run separately to confirm)
-- =============================================================================
--
-- Check column exists:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'books_catalog' AND column_name = 'resolver_key';
--
-- Check index exists:
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'books_catalog' AND indexname = 'books_catalog_resolver_key_uidx';
--
-- Test upsert:
--   INSERT INTO books_catalog (resolver_key, provider, provider_id, title, authors)
--   VALUES ('test:123', 'test', '123', 'Test Book', ARRAY['Test Author'])
--   ON CONFLICT (resolver_key) DO UPDATE SET title = EXCLUDED.title
--   RETURNING id;
-- =============================================================================
