-- Gate 9 Extension: Canonical Books Catalog
-- Migration: 20260127000001_books_catalog.sql
--
-- Creates persistent storage for resolved books:
-- 1. books_catalog - Canonical book records with stable UUIDs
-- 2. Adds book_id FK to user_corrections for linking

-- ============================================================================
-- Table: books_catalog
-- ============================================================================
-- Canonical persistent storage for resolved books.
-- Each unique book (by provider+provider_id) gets a stable UUID.
-- ISBNs are unique when present.

CREATE TABLE IF NOT EXISTS public.books_catalog (
  -- Primary key: stable UUID for this book
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Provider identification (canonical key)
  provider TEXT NOT NULL CHECK (provider IN ('openLibrary', 'googleBooks')),
  provider_id TEXT NOT NULL,

  -- ISBNs (unique when present)
  isbn13 TEXT CHECK (isbn13 IS NULL OR LENGTH(isbn13) = 13),
  isbn10 TEXT CHECK (isbn10 IS NULL OR LENGTH(isbn10) = 10),

  -- Book metadata
  title TEXT NOT NULL,
  authors TEXT[] NOT NULL DEFAULT '{}',
  publisher TEXT,
  publish_year TEXT,
  cover_url TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Unique constraints
  CONSTRAINT books_catalog_provider_unique UNIQUE (provider, provider_id),
  CONSTRAINT books_catalog_isbn13_unique UNIQUE (isbn13),
  CONSTRAINT books_catalog_isbn10_unique UNIQUE (isbn10)
);

-- Indexes for common lookups
CREATE INDEX IF NOT EXISTS idx_books_catalog_provider
  ON public.books_catalog (provider, provider_id);

CREATE INDEX IF NOT EXISTS idx_books_catalog_isbn13
  ON public.books_catalog (isbn13)
  WHERE isbn13 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_books_catalog_isbn10
  ON public.books_catalog (isbn10)
  WHERE isbn10 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_books_catalog_title
  ON public.books_catalog USING gin (to_tsvector('english', title));

-- Auto-update updated_at trigger
CREATE TRIGGER books_catalog_updated_at
  BEFORE UPDATE ON public.books_catalog
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Alter: user_corrections - Add book_id FK
-- ============================================================================
-- Link corrections to canonical books for stable identity.

ALTER TABLE public.user_corrections
  ADD COLUMN IF NOT EXISTS book_id UUID REFERENCES public.books_catalog(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_user_corrections_book_id
  ON public.user_corrections (book_id)
  WHERE book_id IS NOT NULL;

-- ============================================================================
-- Row Level Security (RLS)
-- ============================================================================

ALTER TABLE public.books_catalog ENABLE ROW LEVEL SECURITY;

-- Service role has full access (for Edge Functions)
CREATE POLICY books_catalog_service_all
  ON public.books_catalog
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated users can read all books
CREATE POLICY books_catalog_select_auth
  ON public.books_catalog
  FOR SELECT
  TO authenticated
  USING (true);

-- Authenticated users can insert books
CREATE POLICY books_catalog_insert_auth
  ON public.books_catalog
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Authenticated users can update books
CREATE POLICY books_catalog_update_auth
  ON public.books_catalog
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- Upsert Function
-- ============================================================================
-- Upserts a book and returns the stable book ID.
-- Uses provider + provider_id as the conflict key.

CREATE OR REPLACE FUNCTION upsert_book(
  p_provider TEXT,
  p_provider_id TEXT,
  p_title TEXT,
  p_authors TEXT[],
  p_isbn13 TEXT DEFAULT NULL,
  p_isbn10 TEXT DEFAULT NULL,
  p_publisher TEXT DEFAULT NULL,
  p_publish_year TEXT DEFAULT NULL,
  p_cover_url TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_book_id UUID;
BEGIN
  INSERT INTO public.books_catalog (
    provider,
    provider_id,
    isbn13,
    isbn10,
    title,
    authors,
    publisher,
    publish_year,
    cover_url
  )
  VALUES (
    p_provider,
    p_provider_id,
    NULLIF(p_isbn13, ''),
    NULLIF(p_isbn10, ''),
    p_title,
    COALESCE(p_authors, '{}'),
    NULLIF(p_publisher, ''),
    NULLIF(p_publish_year, ''),
    NULLIF(p_cover_url, '')
  )
  ON CONFLICT (provider, provider_id) DO UPDATE SET
    isbn13 = COALESCE(EXCLUDED.isbn13, books_catalog.isbn13),
    isbn10 = COALESCE(EXCLUDED.isbn10, books_catalog.isbn10),
    title = EXCLUDED.title,
    authors = EXCLUDED.authors,
    publisher = COALESCE(EXCLUDED.publisher, books_catalog.publisher),
    publish_year = COALESCE(EXCLUDED.publish_year, books_catalog.publish_year),
    cover_url = COALESCE(EXCLUDED.cover_url, books_catalog.cover_url),
    updated_at = NOW()
  RETURNING id INTO v_book_id;

  RETURN v_book_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON TABLE public.books_catalog IS
  'Canonical persistent storage for resolved books with stable UUIDs';
COMMENT ON COLUMN public.books_catalog.id IS
  'Stable UUID for this book - use as canonical reference';
COMMENT ON COLUMN public.books_catalog.provider IS
  'Metadata provider source (openLibrary, googleBooks)';
COMMENT ON COLUMN public.books_catalog.provider_id IS
  'Provider-specific identifier (OLID, volumeId)';
COMMENT ON FUNCTION upsert_book IS
  'Upserts a book by provider+provider_id and returns the stable book ID';
