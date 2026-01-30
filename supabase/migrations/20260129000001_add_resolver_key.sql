-- Gate 9 Extension: Add resolver_key column to books_catalog
-- Migration: 20260129000001_add_resolver_key.sql
--
-- Adds resolver_key for canonical book identification.
-- Format: "openlibrary:OLID:<olid>" or "openlibrary:ISBN:<isbn13>" or "googleBooks:<volumeId>"
--
-- IDEMPOTENT: Safe to run multiple times.

-- ============================================================================
-- Step 1: Add resolver_key column (if not exists)
-- ============================================================================

ALTER TABLE public.books_catalog
  ADD COLUMN IF NOT EXISTS resolver_key TEXT;

-- ============================================================================
-- Step 2: Create unique index (if not exists)
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS books_catalog_resolver_key_uidx
  ON public.books_catalog (resolver_key);

-- ============================================================================
-- Step 3: Backfill existing rows (optional - only where NULL)
-- ============================================================================

UPDATE public.books_catalog
SET resolver_key = provider || ':' || provider_id
WHERE resolver_key IS NULL
  AND provider IS NOT NULL
  AND provider_id IS NOT NULL;

-- ============================================================================
-- Step 4: Notify PostgREST to reload schema cache
-- ============================================================================

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON COLUMN public.books_catalog.resolver_key IS
  'Canonical identifier for the book (e.g., openlibrary:OLID:OL123M, openlibrary:ISBN:9780123456789)';
