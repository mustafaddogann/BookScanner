-- Resolver Attempts Audit Trail
-- Migration: 20260130000001_resolver_attempts.sql
--
-- Creates table: public.resolver_attempts
-- Stores per-candidate resolver outcomes for observability.

CREATE TABLE IF NOT EXISTS public.resolver_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  session_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  evidence_tier TEXT NOT NULL,
  hypotheses_count INTEGER NOT NULL,

  top_match_resolver_key TEXT,
  top_match_title TEXT,
  top_match_authors TEXT[],
  top_score REAL,

  decision TEXT NOT NULL,
  reason TEXT,

  CONSTRAINT resolver_attempts_session_candidate_unique
    UNIQUE (session_id, candidate_id)
);

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_resolver_attempts_session
  ON public.resolver_attempts (session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_resolver_attempts_candidate
  ON public.resolver_attempts (candidate_id, created_at DESC);

-- Enable RLS
ALTER TABLE public.resolver_attempts ENABLE ROW LEVEL SECURITY;

-- Service role has full access
CREATE POLICY resolver_attempts_service_all
  ON public.resolver_attempts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Allow anon (dev) read/write for client-side observability
CREATE POLICY resolver_attempts_select_anon
  ON public.resolver_attempts
  FOR SELECT
  TO anon
  USING (true);

CREATE POLICY resolver_attempts_insert_anon
  ON public.resolver_attempts
  FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY resolver_attempts_update_anon
  ON public.resolver_attempts
  FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);

-- Allow authenticated users (if present) read/write
CREATE POLICY resolver_attempts_select_auth
  ON public.resolver_attempts
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY resolver_attempts_insert_auth
  ON public.resolver_attempts
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY resolver_attempts_update_auth
  ON public.resolver_attempts
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.resolver_attempts IS
  'Per-candidate resolver outcomes for observability and audit';
