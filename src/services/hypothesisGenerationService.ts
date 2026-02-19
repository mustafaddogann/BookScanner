/**
 * Hypothesis Generation Service (Gate 8)
 *
 * Generates hypothesis data for the resolver (Gate 9):
 * - Evidence tier classification
 * - Search candidates (queries for metadata lookup)
 * - ISBN candidates
 * - UI guess (for immediate display, NOT canonical)
 *
 * IMPORTANT: Gate 8 output is NOT canonical.
 * Canonical truth comes from the resolver (Gate 9).
 */

import type {
  BookCandidate,
  BookEvidence,
  BookHypothesis,
  EvidenceTier,
  SearchCandidate,
  UIGuess,
} from '../types';
import { TIER_MULTIPLIERS } from './evidenceQualityService';
import { generateMergedEvidenceCandidate } from './searchCandidateService';
import { extractSpineFieldEvidence } from './spineFieldExtractionService';
import {
  generateHypotheses as generateResolverHypotheses,
  generateBoostHypotheses,
  getQuerySet,
} from './queryHypotheses';
import { extractIsbnsFromText } from '../utils/isbnUtils';
import { isMetadataVerboseDebug, isFieldExtractionEnabled } from '../config/debug';

// ============================================================================
// Configuration
// ============================================================================

/** Evidence tier thresholds */
const TIER_THRESHOLDS = {
  strong: {
    minConfidence: 0.85,
    minLines: 3,
    minAlnumRatio: 0.80,
  },
  usable: {
    minConfidence: 0.70,
    minLines: 2,
    minAlnumRatio: 0.65,
  },
  weak: {
    minConfidence: 0.50,
    minLines: 1,
  },
};

/** Keep Supabase resolver query fan-out bounded to avoid request timeouts */
const MAX_RESOLVER_SEARCH_CANDIDATES = 8;

function toQueryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function extractEvidenceLines(evidence: BookEvidence): string[] {
  if (evidence.mergedLines.length > 0) {
    return evidence.mergedLines.map((line) => line.text);
  }

  if (evidence.mergedTextBlock.trim().length > 0) {
    return evidence.mergedTextBlock
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  return [];
}

// ============================================================================
// Evidence Tier Classification
// ============================================================================

/**
 * Classify evidence tier for a book candidate
 *
 * Rules:
 * - strong: avgConfidence >= 0.85 AND >= 3 lines AND alnumRatio >= 0.80
 * - usable: avgConfidence >= 0.70 AND >= 2 lines AND alnumRatio >= 0.65
 * - weak: avgConfidence >= 0.50 AND >= 1 line
 * - unusable: everything else
 *
 * @param evidence - Book evidence from candidate
 * @returns Evidence tier
 */
export function classifyEvidenceTier(evidence: BookEvidence): EvidenceTier {
  const lines = evidence.mergedLines;

  if (lines.length === 0) {
    return 'unusable';
  }

  // Calculate average confidence
  const avgConfidence =
    lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length;

  // Calculate alnum ratio (proportion of alphanumeric characters)
  const fullText = evidence.mergedTextBlock;
  const alnumCount = (fullText.match(/[a-zA-Z0-9]/g) || []).length;
  const alnumRatio = fullText.length > 0 ? alnumCount / fullText.length : 0;

  // Check strong criteria
  if (
    avgConfidence >= TIER_THRESHOLDS.strong.minConfidence &&
    lines.length >= TIER_THRESHOLDS.strong.minLines &&
    alnumRatio >= TIER_THRESHOLDS.strong.minAlnumRatio
  ) {
    return 'strong';
  }

  // Check usable criteria
  if (
    avgConfidence >= TIER_THRESHOLDS.usable.minConfidence &&
    lines.length >= TIER_THRESHOLDS.usable.minLines &&
    alnumRatio >= TIER_THRESHOLDS.usable.minAlnumRatio
  ) {
    return 'usable';
  }

  // Check weak criteria
  if (
    avgConfidence >= TIER_THRESHOLDS.weak.minConfidence &&
    lines.length >= TIER_THRESHOLDS.weak.minLines
  ) {
    return 'weak';
  }

  return 'unusable';
}

// ============================================================================
// ISBN Extraction
// ============================================================================

/**
 * Extract and validate ISBN candidates from evidence
 * Uses extractIsbnsFromText which already validates and normalizes
 *
 * @param evidence - Book evidence
 * @returns Array of validated, normalized ISBN strings
 */
export function extractIsbnCandidates(evidence: BookEvidence): string[] {
  // extractIsbnsFromText already validates, normalizes, and converts to ISBN-13
  return extractIsbnsFromText(evidence.mergedTextBlock);
}

// ============================================================================
// UI Guess Generation
// ============================================================================

/**
 * Generate UI guess using line labeling pipeline
 * NOT canonical - for immediate display only
 *
 * @param evidence - Book evidence
 * @returns UI guess or null if unusable
 */
export function generateUIGuess(evidence: BookEvidence): UIGuess | null {
  if (!isFieldExtractionEnabled()) {
    // Fallback: use raw merged text as title, no author
    const title = evidence.mergedTextBlock.split('\n')[0]?.trim() || null;
    return title ? { title, author: null, confidence: 0.3 } : null;
  }

  try {
    const fieldEvidence = extractSpineFieldEvidence(evidence);

    const bestTitle = fieldEvidence.titleCandidates[0];
    const bestAuthor = fieldEvidence.authorCandidates[0];

    if (!bestTitle && !bestAuthor) {
      return null;
    }

    // Calculate combined confidence
    const titleConf = bestTitle?.confidence ?? 0;
    const authorConf = bestAuthor?.confidence ?? 0;
    const confidence =
      bestTitle && bestAuthor
        ? (titleConf + authorConf) / 2
        : titleConf || authorConf;

    return {
      title: bestTitle?.value ?? null,
      author: bestAuthor?.value ?? null,
      confidence,
    };
  } catch (error) {
    if (isMetadataVerboseDebug()) {
      console.error('[HypothesisGeneration] Error generating UI guess:', error);
    }
    return null;
  }
}

// ============================================================================
// Search Candidate Generation
// ============================================================================

/**
 * Build search candidates for resolver
 *
 * @param evidence - Book evidence
 * @param evidenceTier - Classified evidence tier
 * @param isbnCandidates - Extracted ISBN candidates
 * @returns Array of search candidates
 */
export function buildSearchCandidates(
  evidence: BookEvidence,
  evidenceTier: EvidenceTier,
  isbnCandidates: string[],
  uiGuess: UIGuess | null = null
): SearchCandidate[] {
  const candidates: SearchCandidate[] = [];

  // Skip for unusable evidence
  if (evidenceTier === 'unusable') {
    return [];
  }

  // 1. Add ISBN-based candidates (highest priority)
  // Create a SearchCandidate for each ISBN
  for (const isbn of isbnCandidates) {
    const isbnCandidate: SearchCandidate = {
      query: isbn,
      isbn,
      confidence: 0.95 * TIER_MULTIPLIERS[evidenceTier],
      cropIndex: -1,
      tier: evidenceTier,
      tokens: [isbn],
    };
    candidates.push(isbnCandidate);
  }

  const perFieldTitleHint = evidence.perFieldHints?.titleHints[0];
  const perFieldAuthorHint = evidence.perFieldHints?.authorHints[0];
  const titleHint = perFieldTitleHint ?? uiGuess?.title ?? undefined;

  // Use best available author hint for resolver scoring.
  // Penalties are tuned to avoid over-punishing noisy OCR hints.
  const queryAuthorHint = perFieldAuthorHint ?? uiGuess?.author ?? undefined;

  const evidenceLines = extractEvidenceLines(evidence);
  const pass1HypothesisResult = generateResolverHypotheses(
    evidenceLines,
    titleHint ?? null,
    queryAuthorHint ?? null
  );

  const pass1Hypotheses = pass1HypothesisResult.hypotheses;
  let combinedHypotheses = [...pass1Hypotheses];

  // Add boost hypotheses for additional recall when pass1 is sparse.
  if (combinedHypotheses.length < MAX_RESOLVER_SEARCH_CANDIDATES) {
    const pass1QuerySet = getQuerySet(pass1Hypotheses);
    const boostResult = generateBoostHypotheses(
      evidenceLines,
      pass1QuerySet,
      titleHint ?? null,
      queryAuthorHint ?? null
    );
    combinedHypotheses = [
      ...combinedHypotheses,
      ...boostResult.hypotheses,
    ];
  }

  for (let i = 0; i < combinedHypotheses.length; i++) {
    if (candidates.length >= MAX_RESOLVER_SEARCH_CANDIDATES) {
      break;
    }

    const hypothesis = combinedHypotheses[i];
    candidates.push({
      query: hypothesis.query,
      confidence: Math.max(0.45, (0.95 - i * 0.06) * TIER_MULTIPLIERS[evidenceTier]),
      cropIndex: -1,
      tier: evidenceTier,
      tokens: toQueryTokens(hypothesis.query),
      titleHint,
      authorHint: queryAuthorHint,
    });
  }

  // 3. Keep merged evidence as a final fallback if hypotheses were sparse
  if (candidates.length < MAX_RESOLVER_SEARCH_CANDIDATES) {
    const mergedCandidate = generateMergedEvidenceCandidate(evidence, evidenceTier);
    if (mergedCandidate) {
      const duplicate = candidates.some(
        (candidate) =>
          candidate.query.trim().toLowerCase() ===
          mergedCandidate.query.trim().toLowerCase()
      );

      if (!duplicate) {
        candidates.push({
          ...mergedCandidate,
          titleHint: titleHint ?? mergedCandidate.titleHint,
          authorHint: queryAuthorHint,
        });
      }
    }
  }

  // Sort by confidence
  candidates.sort((a, b) => b.confidence - a.confidence);

  return candidates;
}

// ============================================================================
// Main Hypothesis Generation
// ============================================================================

/**
 * Hypothesis result - same as BookHypothesis but used internally
 */
export type HypothesisResult = BookHypothesis;

/**
 * Generate hypothesis for a single book candidate
 *
 * @param candidate - Book candidate with merged evidence
 * @returns Hypothesis result
 */
export function generateHypothesis(candidate: BookCandidate): HypothesisResult {
  const evidence = candidate.evidence;

  // 1. Classify evidence tier
  const evidenceTier = classifyEvidenceTier(evidence);

  if (isMetadataVerboseDebug()) {
    console.log(
      `[HypothesisGeneration] Candidate ${candidate.id}: tier=${evidenceTier}, ` +
        `lines=${evidence.mergedLines.length}, tierMultiplier=${TIER_MULTIPLIERS[evidenceTier]}`
    );
  }

  // 2. If unusable, return empty hypothesis
  if (evidenceTier === 'unusable') {
    return {
      evidenceTier,
      searchCandidates: [],
      isbnCandidates: [],
      uiGuess: null,
    };
  }

  // 3. Extract ISBN candidates
  const isbnCandidates = extractIsbnCandidates(evidence);

  if (isMetadataVerboseDebug() && isbnCandidates.length > 0) {
    console.log(
      `[HypothesisGeneration] Found ISBNs: ${isbnCandidates.join(', ')}`
    );
  }

  // 4. Generate UI guess
  const uiGuess = generateUIGuess(evidence);

  // 5. Build search candidates
  const searchCandidates = buildSearchCandidates(
    evidence,
    evidenceTier,
    isbnCandidates,
    uiGuess
  );

  if (isMetadataVerboseDebug() && uiGuess) {
    console.log(
      `[HypothesisGeneration] UI guess: title="${uiGuess.title}", ` +
        `author="${uiGuess.author}", confidence=${uiGuess.confidence.toFixed(2)}`
    );
  }

  return {
    evidenceTier,
    searchCandidates,
    isbnCandidates,
    uiGuess,
  };
}

/**
 * Apply hypothesis to a book candidate
 * Updates the candidate with Gate 8 hypothesis in isolated sub-object.
 * NEVER writes to legacy display fields.
 *
 * @param candidate - Book candidate
 * @returns Updated candidate with hypothesis sub-object
 */
export function applyHypothesis(candidate: BookCandidate): BookCandidate {
  const hypothesis = generateHypothesis(candidate);

  return {
    ...candidate,
    // Write hypothesis to isolated sub-object - NEVER to top-level display fields
    hypothesis,
    // Initialize resolver decision as pending
    resolverDecision: 'pending',
  };
}

/**
 * Generate hypotheses for all book candidates
 *
 * @param candidates - Array of book candidates
 * @returns Updated candidates with hypothesis fields
 */
export function generateHypotheses(candidates: BookCandidate[]): BookCandidate[] {
  return candidates.map(applyHypothesis);
}
