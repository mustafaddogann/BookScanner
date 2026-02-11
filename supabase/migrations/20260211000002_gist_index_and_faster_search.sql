-- Add GiST index for fast trigram distance ordering + simplify search function
-- Migration: 20260211000002_gist_index_and_faster_search.sql
--
-- GIN indexes support the % operator (filtering) but NOT <-> ordering.
-- GiST indexes support both % filtering AND <-> distance ordering.
-- Adding a GiST index allows the query planner to use index-only scans.

-- ============================================================================
-- Step 1: Add GiST index (supports both % and <-> operators)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_books_catalog_title_trgm_gist
  ON public.books_catalog USING gist (title gist_trgm_ops);

-- ============================================================================
-- Step 2: Simplified + fast search function
-- ============================================================================

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
  WHERE bc.title % p_query
  ORDER BY bc.title <-> p_query
  LIMIT p_limit;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ============================================================================
-- Step 3: Ensure permissions
-- ============================================================================

GRANT EXECUTE ON FUNCTION search_books_fuzzy TO anon;
GRANT EXECUTE ON FUNCTION search_books_fuzzy_title_author TO anon;
GRANT SELECT ON public.books_catalog TO anon;

NOTIFY pgrst, 'reload schema';
