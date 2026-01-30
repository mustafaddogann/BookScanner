-- Gate 9: Resolver Database Schema
-- Migration: 20260123000001_resolver_tables.sql
--
-- Creates tables for:
-- 1. resolver_cache - Cached responses from metadata providers
-- 2. user_corrections - User-submitted corrections to book metadata
-- 3. resolver_events - Telemetry for resolver performance (non-PII)

-- ============================================================================
-- Table: resolver_cache
-- ============================================================================
-- Caches responses from external metadata providers (Open Library, etc.)
-- to reduce API calls and improve response times.

CREATE TABLE IF NOT EXISTS public.resolver_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Provider identification
  provider TEXT NOT NULL CHECK (provider IN ('openLibrary', 'googleBooks', 'isbndb')),
  query_type TEXT NOT NULL CHECK (query_type IN ('isbn', 'search', 'title_author')),

  -- Query hash for deduplication (SHA-256 of normalized query)
  query_hash TEXT NOT NULL,

  -- Original query for debugging (not used for lookups)
  query_text TEXT,

  -- Cached response
  response_json JSONB NOT NULL,

  -- Cache validity
  expires_at TIMESTAMPTZ NOT NULL,

  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TIMESTAMPTZ,

  -- Unique constraint for cache lookups
  CONSTRAINT resolver_cache_provider_query_unique
    UNIQUE (provider, query_type, query_hash)
);

-- Hot-path lookup index (use expires_at as a range condition in queries)
CREATE INDEX IF NOT EXISTS idx_resolver_cache_lookup
  ON public.resolver_cache (provider, query_type, query_hash, expires_at);

-- Index for cache cleanup
CREATE INDEX IF NOT EXISTS idx_resolver_cache_expires
  ON public.resolver_cache (expires_at);

-- ============================================================================
-- Table: user_corrections
-- ============================================================================
-- Stores user-submitted corrections to book metadata.
-- Used for learning and improving future resolutions.

CREATE TABLE IF NOT EXISTS public.user_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- User identification (from Supabase Auth)
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Link to resolved book (one of these must be set)
  resolver_key TEXT,  -- Provider:ID (e.g., "openLibrary:OL12345W")
  evidence_hash TEXT, -- SHA-256 of OCR evidence (for unresolved books)

  -- Corrected fields (null = not corrected)
  corrected_title TEXT,
  corrected_authors TEXT[], -- Array of author names
  corrected_isbn13 TEXT CHECK (corrected_isbn13 IS NULL OR LENGTH(corrected_isbn13) = 13),
  corrected_isbn10 TEXT CHECK (corrected_isbn10 IS NULL OR LENGTH(corrected_isbn10) = 10),
  corrected_publisher TEXT,
  corrected_publish_year INTEGER CHECK (
    corrected_publish_year IS NULL OR
    (corrected_publish_year >= 1400 AND corrected_publish_year <= 2100)
  ),
  corrected_edition TEXT,

  -- Original values (for audit trail)
  original_title TEXT,
  original_authors TEXT[],
  original_isbn13 TEXT,

  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Session context (non-PII)
  session_id TEXT,
  candidate_id TEXT,

  -- Ensure at least one key is set
  CONSTRAINT user_corrections_key_check
    CHECK (resolver_key IS NOT NULL OR evidence_hash IS NOT NULL)
);

-- Index for user's corrections
CREATE INDEX IF NOT EXISTS idx_user_corrections_user
  ON public.user_corrections (user_id, created_at DESC);

-- Index for resolver key lookups
CREATE INDEX IF NOT EXISTS idx_user_corrections_resolver_key
  ON public.user_corrections (resolver_key)
  WHERE resolver_key IS NOT NULL;

-- Index for evidence hash lookups
CREATE INDEX IF NOT EXISTS idx_user_corrections_evidence_hash
  ON public.user_corrections (evidence_hash)
  WHERE evidence_hash IS NOT NULL;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_corrections_updated_at
  BEFORE UPDATE ON public.user_corrections
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Table: resolver_events
-- ============================================================================
-- Telemetry for resolver performance analysis (non-PII).
-- Used for monitoring, optimization, and debugging.

CREATE TABLE IF NOT EXISTS public.resolver_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Event identification
  event_type TEXT NOT NULL CHECK (event_type IN (
    'resolve_request',
    'cache_hit',
    'cache_miss',
    'provider_call',
    'provider_error',
    'rate_limit',
    'decision_made',
    'correction_applied'
  )),

  -- Non-PII context
  provider TEXT,
  query_type TEXT,
  evidence_tier TEXT CHECK (evidence_tier IN ('strong', 'usable', 'weak', 'unusable')),

  -- Performance metrics
  duration_ms INTEGER,
  match_count INTEGER,

  -- Decision metrics
  decision_type TEXT CHECK (decision_type IN (
    'auto-accept', 'suggest', 'ambiguous', 'no-match', NULL
  )),
  top_score REAL,
  dominance_gap REAL,

  -- Error tracking (no PII)
  error_code TEXT,

  -- Rate limiting
  quota_remaining INTEGER,

  -- Timestamp
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_resolver_events_created
  ON public.resolver_events (created_at DESC);

-- Index for event type analysis
CREATE INDEX IF NOT EXISTS idx_resolver_events_type
  ON public.resolver_events (event_type, created_at DESC);

-- Partition by month for efficient cleanup (optional, for high-volume)
-- CREATE TABLE resolver_events_template (LIKE resolver_events INCLUDING ALL);

-- ============================================================================
-- Row Level Security (RLS)
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE public.resolver_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resolver_events ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- RLS Policies: resolver_cache
-- ============================================================================
-- Only Edge Functions (service role) can read/write cache.
-- Clients cannot access cache directly.

-- Service role has full access (for Edge Functions)
CREATE POLICY resolver_cache_service_all
  ON public.resolver_cache
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Anon and authenticated users have NO access
-- (No policy = no access when RLS is enabled)

-- ============================================================================
-- RLS Policies: user_corrections
-- ============================================================================
-- Users can only CRUD their own corrections.

-- Users can view their own corrections
CREATE POLICY user_corrections_select_own
  ON public.user_corrections
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Users can insert their own corrections
CREATE POLICY user_corrections_insert_own
  ON public.user_corrections
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Users can update their own corrections
CREATE POLICY user_corrections_update_own
  ON public.user_corrections
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Users can delete their own corrections
CREATE POLICY user_corrections_delete_own
  ON public.user_corrections
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Service role has full access (for Edge Functions)
CREATE POLICY user_corrections_service_all
  ON public.user_corrections
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- RLS Policies: resolver_events
-- ============================================================================
-- Only Edge Functions (service role) can write events.
-- Read access is restricted to service role for analytics.

CREATE POLICY resolver_events_service_all
  ON public.resolver_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- Cache Cleanup Function
-- ============================================================================
-- Call periodically to remove expired cache entries.

CREATE OR REPLACE FUNCTION cleanup_expired_cache()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.resolver_cache
  WHERE expires_at < NOW();

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON TABLE public.resolver_cache IS
  'Cached responses from metadata providers (Open Library, etc.)';
COMMENT ON TABLE public.user_corrections IS
  'User-submitted corrections to book metadata';
COMMENT ON TABLE public.resolver_events IS
  'Telemetry for resolver performance (non-PII)';

COMMENT ON COLUMN public.resolver_cache.query_hash IS
  'SHA-256 hash of normalized query for deduplication';
COMMENT ON COLUMN public.resolver_cache.expires_at IS
  'Cache expiry time (default 7 days from creation)';

COMMENT ON COLUMN public.user_corrections.resolver_key IS
  'Provider:ID format (e.g., openLibrary:OL12345W)';
COMMENT ON COLUMN public.user_corrections.evidence_hash IS
  'SHA-256 of OCR evidence for unresolved books';
