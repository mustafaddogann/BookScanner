/**
 * Shared types for Supabase Edge Functions
 * Gate 9: Resolver + Scoring + Verification + Acceptance
 */

// ============================================================================
// Request/Response Types
// ============================================================================

export interface ResolveRequest {
  sessionId: string;
  candidateId: string;
  evidenceHash: string;
  evidenceTier: EvidenceTier;
  queries: QueryCandidate[];
  isbnCandidates: IsbnCandidate[];
}

export interface QueryCandidate {
  query: string;
  confidence: number;
  source: 'ocr' | 'ai';
  titleHint?: string;
  authorHint?: string;
}

export interface IsbnCandidate {
  isbn: string;
  confidence: number;
}

export type EvidenceTier = 'strong' | 'usable' | 'weak' | 'unusable';

export interface ResolveResponse {
  status: ResolveStatus;
  cacheHit: boolean;
  quotaRemaining: number;
  matches: ScoredMatch[];
  acceptanceDecision: AcceptanceDecision;
  canonicalBook: ResolvedBook | null;
  verificationFlags: VerificationFlag[];
  processingTimeMs: number;
  resolutionMetrics?: ResolutionMetrics;
}

export type ResolveStatus =
  | 'resolved'
  | 'ambiguous'
  | 'no-match'
  | 'rate-limited'
  | 'error';

// ============================================================================
// Book Types
// ============================================================================

export interface ResolvedBook {
  title: string;
  authors: string[];
  isbn13: string | null;
  isbn10: string | null;
  publisher: string | null;
  publishYear: number | null;
  edition: string | null;
  coverUrl: string | null;
  source: BookSource;
  sourceId: string;
  pageCount?: number;
  subjects?: string[];
}

export type BookSource = 'openLibrary' | 'googleBooks' | 'manual' | 'ocr';

// ============================================================================
// Scoring Types
// ============================================================================

export interface ScoredMatch {
  book: ResolvedBook;
  score: MatchScore;
}

export interface MatchScore {
  composite: number;
  signals: MatchSignals;
  normalizedSignals: NormalizedSignals;
}

export interface MatchSignals {
  titleSimilarity: number;
  authorPresence: number;
  isbnMatch: number;
  wordCoverage: number;
  resultRank: number;
  genericPenalty: number;
}

export interface NormalizedSignals {
  titleSimilarity: number;
  authorPresence: number;
  isbnMatch: number;
  wordCoverage: number;
  resultRank: number;
  genericPenalty: number;
}

// Scoring weights (must sum to 1.0)
export const SCORING_WEIGHTS = {
  titleSimilarity: 0.30,
  authorPresence: 0.25,
  isbnMatch: 0.20,
  wordCoverage: 0.15,
  resultRank: 0.05,
  genericPenalty: 0.05, // Subtracted
} as const;

// ============================================================================
// Verification Types
// ============================================================================

export interface VerificationFlag {
  flag: VerificationFlagType;
  severity: 'error' | 'warning' | 'info';
  message: string;
  penalty: number;
}

export type VerificationFlagType =
  | 'author-mismatch'
  | 'isbn-mismatch'
  | 'token-coverage-low'
  | 'suspicious-edition'
  | 'year-implausible'
  | 'publisher-mismatch'
  | 'edition-conflict';

export const VERIFICATION_PENALTIES: Record<VerificationFlagType, number> = {
  'isbn-mismatch': 0.40,
  'author-mismatch': 0.25,
  'publisher-mismatch': 0.20,
  'token-coverage-low': 0.20,
  'suspicious-edition': 0.15,
  'edition-conflict': 0.15,
  'year-implausible': 0.10,
};

// ============================================================================
// Acceptance Decision Types
// ============================================================================

export type AcceptanceDecision =
  | AcceptanceAutoAccept
  | AcceptanceSuggest
  | AcceptanceAmbiguous
  | AcceptanceNoMatch;

export interface AcceptanceAutoAccept {
  type: 'auto-accept';
  book: ResolvedBook;
  confidence: number;
  reason: string;
}

export interface AcceptanceSuggest {
  type: 'suggest';
  book: ResolvedBook;
  confidence: number;
  alternatives: ResolvedBook[];
  reason: string;
}

export interface AcceptanceAmbiguous {
  type: 'ambiguous';
  candidates: ResolvedBook[];
  reason: string;
}

export interface AcceptanceNoMatch {
  type: 'no-match';
  reason: string;
  fallbackToOcr: boolean;
}

// Tier-based thresholds
export const ACCEPTANCE_THRESHOLDS: Record<
  EvidenceTier,
  { autoAccept: number; suggest: number; ambiguous: number }
> = {
  strong: { autoAccept: 0.85, suggest: 0.70, ambiguous: 0.50 },
  usable: { autoAccept: 0.88, suggest: 0.75, ambiguous: 0.55 },
  weak: { autoAccept: 0.95, suggest: 0.85, ambiguous: 0.70 },
  unusable: { autoAccept: 1.0, suggest: 1.0, ambiguous: 1.0 },
};

// ============================================================================
// Cache Types
// ============================================================================

export interface CacheEntry {
  provider: string;
  queryType: string;
  queryHash: string;
  responseJson: OpenLibraryResponse | null;
  expiresAt: Date;
  hitCount: number;
}

export interface OpenLibrarySearchResponse {
  numFound: number;
  start: number;
  docs: OpenLibraryDoc[];
}

export interface OpenLibraryDoc {
  key: string;
  title: string;
  author_name?: string[];
  author_key?: string[];
  isbn?: string[];
  publisher?: string[];
  publish_year?: number[];
  first_publish_year?: number;
  edition_count?: number;
  cover_i?: number;
  subject?: string[];
  number_of_pages_median?: number;
}

export interface OpenLibraryIsbnResponse {
  key?: string;
  title: string;
  authors?: Array<{ key: string }>;
  publishers?: string[];
  publish_date?: string;
  isbn_13?: string[];
  isbn_10?: string[];
  covers?: number[];
  number_of_pages?: number;
  subjects?: string[];
}

export type OpenLibraryResponse =
  | OpenLibrarySearchResponse
  | OpenLibraryIsbnResponse;

// ============================================================================
// Rate Limiting Types
// ============================================================================

export interface RateLimitState {
  count: number;
  windowStart: number;
}

export const RATE_LIMIT = {
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 30, // 30 requests per minute per IP
} as const;

// ============================================================================
// Telemetry Types
// ============================================================================

export interface ResolverEvent {
  eventType:
    | 'resolve_request'
    | 'cache_hit'
    | 'cache_miss'
    | 'provider_call'
    | 'provider_error'
    | 'rate_limit'
    | 'decision_made'
    | 'correction_applied';
  provider?: string;
  queryType?: string;
  evidenceTier?: EvidenceTier;
  durationMs?: number;
  matchCount?: number;
  decisionType?: string;
  topScore?: number;
  dominanceGap?: number;
  errorCode?: string;
  quotaRemaining?: number;
}

export interface ResolutionMetrics {
  cache: {
    catalogHits: number;
    resolverCacheHits: number;
    resolverCacheMisses: number;
  };
  fallback: {
    triggered: boolean;
    openLibraryIsbnCalls: number;
    openLibrarySearchCalls: number;
  };
  timingsMs: {
    supabaseLookup: number;
    fallbackLookup: number;
    scoringAndDecision: number;
    total: number;
  };
}
