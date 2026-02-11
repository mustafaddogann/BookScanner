-- Enable pg_trgm for fuzzy text search on books_catalog
-- Migration: 20260210000001_add_trgm_fuzzy_search.sql
--
-- Adds trigram-based fuzzy search to handle OCR-mangled book titles.
-- pg_trgm breaks text into 3-character sequences and measures similarity,
-- which is ideal for matching text with OCR errors (e.g., "denth" → "death").
--
-- IDEMPOTENT: Safe to run multiple times.

-- ============================================================================
-- Step 1: Enable pg_trgm extension
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================================
-- Step 2: Add GIN trigram indexes for fuzzy matching
-- ============================================================================

-- Trigram index on title (primary fuzzy search target)
CREATE INDEX IF NOT EXISTS idx_books_catalog_title_trgm
  ON public.books_catalog USING gin (title gin_trgm_ops);

-- Trigram index on flattened authors (for author fuzzy matching)
CREATE INDEX IF NOT EXISTS idx_books_catalog_authors_trgm
  ON public.books_catalog USING gin (array_to_string(authors, ' ') gin_trgm_ops);

-- ============================================================================
-- Step 3: Fuzzy search function
-- ============================================================================
-- Searches books_catalog by title similarity with optional author filter.
-- Returns top N matches above the similarity threshold.
-- Uses pg_trgm similarity() for ranking, which handles OCR errors well.

CREATE OR REPLACE FUNCTION search_books_fuzzy(
  p_query TEXT,
  p_limit INTEGER DEFAULT 5,
  p_threshold REAL DEFAULT 0.3
)
RETURNS TABLE (
  id UUID,
  provider TEXT,
  provider_id TEXT,
  isbn13 TEXT,
  isbn10 TEXT,
  title TEXT,
  authors TEXT[],
  publisher TEXT,
  publish_year TEXT,
  cover_url TEXT,
  resolver_key TEXT,
  similarity_score REAL
) AS $$
BEGIN
  RETURN QUERY
    SELECT
      bc.id,
      bc.provider,
      bc.provider_id,
      bc.isbn13,
      bc.isbn10,
      bc.title,
      bc.authors,
      bc.publisher,
      bc.publish_year,
      bc.cover_url,
      bc.resolver_key,
      similarity(bc.title, p_query)::REAL AS similarity_score
    FROM public.books_catalog bc
    WHERE similarity(bc.title, p_query) > p_threshold
    ORDER BY similarity(bc.title, p_query) DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- Step 4: Combined title + author fuzzy search
-- ============================================================================
-- For cases where we have both title and author evidence from OCR.

CREATE OR REPLACE FUNCTION search_books_fuzzy_title_author(
  p_title TEXT,
  p_author TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 5,
  p_title_threshold REAL DEFAULT 0.3,
  p_author_threshold REAL DEFAULT 0.25
)
RETURNS TABLE (
  id UUID,
  provider TEXT,
  provider_id TEXT,
  isbn13 TEXT,
  isbn10 TEXT,
  title TEXT,
  authors TEXT[],
  publisher TEXT,
  publish_year TEXT,
  cover_url TEXT,
  resolver_key TEXT,
  title_similarity REAL,
  author_similarity REAL,
  combined_score REAL
) AS $$
BEGIN
  RETURN QUERY
    SELECT
      bc.id,
      bc.provider,
      bc.provider_id,
      bc.isbn13,
      bc.isbn10,
      bc.title,
      bc.authors,
      bc.publisher,
      bc.publish_year,
      bc.cover_url,
      bc.resolver_key,
      similarity(bc.title, p_title)::REAL AS title_similarity,
      CASE
        WHEN p_author IS NOT NULL AND p_author != ''
          THEN similarity(array_to_string(bc.authors, ' '), p_author)::REAL
        ELSE 0.0::REAL
      END AS author_similarity,
      CASE
        WHEN p_author IS NOT NULL AND p_author != ''
          THEN (0.7 * similarity(bc.title, p_title) + 0.3 * similarity(array_to_string(bc.authors, ' '), p_author))::REAL
        ELSE similarity(bc.title, p_title)::REAL
      END AS combined_score
    FROM public.books_catalog bc
    WHERE similarity(bc.title, p_title) > p_title_threshold
      AND (
        p_author IS NULL
        OR p_author = ''
        OR similarity(array_to_string(bc.authors, ' '), p_author) > p_author_threshold
      )
    ORDER BY
      CASE
        WHEN p_author IS NOT NULL AND p_author != ''
          THEN 0.7 * similarity(bc.title, p_title) + 0.3 * similarity(array_to_string(bc.authors, ' '), p_author)
        ELSE similarity(bc.title, p_title)
      END DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- Step 5: Notify PostgREST to reload schema cache
-- ============================================================================

NOTIFY pgrst, 'reload schema';

COMMENT ON FUNCTION search_books_fuzzy IS
  'Fuzzy title search using pg_trgm trigram similarity. Ideal for OCR-mangled text matching.';
COMMENT ON FUNCTION search_books_fuzzy_title_author IS
  'Combined fuzzy title+author search with weighted scoring (70% title, 30% author).';
