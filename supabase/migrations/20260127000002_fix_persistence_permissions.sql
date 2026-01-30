-- Fix permissions for books_catalog and user_corrections
-- Migration: 20260127000002_fix_persistence_permissions.sql
--
-- Issues:
-- 1. books_catalog only allows authenticated, not anon
-- 2. user_corrections requires user_id NOT NULL
-- 3. Need anon policies for both tables

-- ============================================================================
-- Fix: user_corrections - make user_id nullable for anonymous corrections
-- ============================================================================

ALTER TABLE public.user_corrections
  ALTER COLUMN user_id DROP NOT NULL;

-- ============================================================================
-- Fix: books_catalog - allow anon users to insert/update
-- ============================================================================

-- Drop existing policies if they exist, then recreate
DROP POLICY IF EXISTS books_catalog_select_anon ON public.books_catalog;
DROP POLICY IF EXISTS books_catalog_insert_anon ON public.books_catalog;
DROP POLICY IF EXISTS books_catalog_update_anon ON public.books_catalog;

-- Allow anon to read all books
CREATE POLICY books_catalog_select_anon
  ON public.books_catalog
  FOR SELECT
  TO anon
  USING (true);

-- Allow anon to insert books
CREATE POLICY books_catalog_insert_anon
  ON public.books_catalog
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- Allow anon to update books
CREATE POLICY books_catalog_update_anon
  ON public.books_catalog
  FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- Fix: user_corrections - allow anon users
-- ============================================================================

-- Drop existing policies if they exist, then recreate
DROP POLICY IF EXISTS user_corrections_insert_anon ON public.user_corrections;
DROP POLICY IF EXISTS user_corrections_select_anon ON public.user_corrections;
DROP POLICY IF EXISTS user_corrections_update_anon ON public.user_corrections;

-- Allow anon to insert corrections
CREATE POLICY user_corrections_insert_anon
  ON public.user_corrections
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- Allow anon to read corrections
CREATE POLICY user_corrections_select_anon
  ON public.user_corrections
  FOR SELECT
  TO anon
  USING (true);

-- Allow anon to update corrections
CREATE POLICY user_corrections_update_anon
  ON public.user_corrections
  FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- Diagnostic: Log that migration ran
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE 'Migration 20260127000002_fix_persistence_permissions.sql completed';
END $$;
