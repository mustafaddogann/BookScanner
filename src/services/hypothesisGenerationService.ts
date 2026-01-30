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
  isbnCandidates: string[]
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

  // 2. Add merged evidence candidate
  const mergedCandidate = generateMergedEvidenceCandidate(evidence, evidenceTier);
  if (mergedCandidate) {
    candidates.push(mergedCandidate);
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

  // 4. Build search candidates
  const searchCandidates = buildSearchCandidates(
    evidence,
    evidenceTier,
    isbnCandidates
  );

  // 5. Generate UI guess
  const uiGuess = generateUIGuess(evidence);

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
