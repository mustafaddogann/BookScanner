-- Resolver cache-first improvement: store confidence for write-through fallback matches
-- Migration: 20260218000001_add_books_catalog_source_confidence.sql

ALTER TABLE public.books_catalog
  ADD COLUMN IF NOT EXISTS source_confidence REAL
  CHECK (source_confidence IS NULL OR (source_confidence >= 0 AND source_confidence <= 1));

COMMENT ON COLUMN public.books_catalog.source_confidence IS
  'Confidence score from resolver decision when metadata is persisted from fallback';

NOTIFY pgrst, 'reload schema';
