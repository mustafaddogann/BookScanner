/**
 * Metadata Resolution Orchestrator
 *
 * Orchestrates the full metadata resolution pipeline:
 * QUALITY_CLASSIFY → HYPOTHESIZE → RESOLVE → VERIFY → DECIDE
 *
 * This service is the main entry point for running metadata resolution
 * after OCR + grouping completes.
 */

import type {
  EvidenceTier,
  SearchCandidate,
  ScoredMatch,
  AcceptanceDecision,
  ResolvedBook,
  OCRResult,
  BookCandidate,
  CropEvidenceClassification,
  EvidenceSummary,
  MetadataResolutionState,
} from '../types';
import type { DetectionRectifyInfo } from '../store/useAppStore';
import {
  classifyEvidence,
  type ClassifyEvidenceInput,
} from './evidenceQualityService';
import {
  generateSearchCandidates,
  type GenerateCandidatesInput,
} from './searchCandidateService';
import { scoreAndRankMatches } from './metadataResolverService';
import { makeDecision, makeOcrOnlyDecision } from './acceptanceDecisionService';
import {
  getMetadataLookupProvider,
} from './metadataLookupProviderFactory';
import { isDisabledProvider } from './metadataLookupProvider';
import { isMetadataVerboseDebug, isOfflineQueueEnabled } from '../config/debug';
import { queueForOfflineResolution } from './offlineResolutionQueue';

/**
 * Input for metadata resolution
 */
export interface MetadataResolutionInput {
  /** Session ID for queue persistence */
  sessionId: string;
  /** Rectification results with crop info */
  rectificationResults: DetectionRectifyInfo[];
  /** OCR results by crop index */
  ocrResultsByCropIndex: Record<number, OCRResult>;
  /** Book candidates from grouping (optional) */
  bookCandidates?: BookCandidate[];
}

/**
 * Output from metadata resolution
 */
export interface MetadataResolutionOutput {
  /** Per-crop evidence classifications */
  evidenceSummary: EvidenceSummary;
  /** Generated search candidates (for debugging) */
  searchCandidates?: SearchCandidate[];
  /** The acceptance decision */
  decision: AcceptanceDecision;
  /** Top scored matches (for debugging) */
  topMatches?: ScoredMatch[];
  /** Resolution state for storage */
  resolutionState: MetadataResolutionState;
  /** Whether resolution was queued for offline retry */
  queuedForOffline: boolean;
}

/**
 * Classify all crops and compute session-level evidence summary
 */
function classifyAllEvidence(
  rectificationResults: DetectionRectifyInfo[],
  ocrResultsByCropIndex: Record<number, OCRResult>
): EvidenceSummary {
  const classifications: CropEvidenceClassification[] = [];
  const tierCounts: Record<EvidenceTier, number> = {
    strong: 0,
    usable: 0,
    weak: 0,
    unusable: 0,
  };

  for (const rect of rectificationResults) {
    const cropIndex = rect.detectionIndex;
    const ocr = ocrResultsByCropIndex[cropIndex];

    // Build input for single crop classification
    const input: ClassifyEvidenceInput = {
      rectification: rect,
      ocr,
      blurScore: undefined, // Not available yet
    };

    // Classify and get full result
    const classification = classifyEvidence(input);
    classifications.push(classification);
    tierCounts[classification.tier]++;
  }

  // Determine session tier: best available tier with at least one crop
  let sessionTier: EvidenceTier = 'unusable';
  if (tierCounts.strong > 0) {
    sessionTier = 'strong';
  } else if (tierCounts.usable > 0) {
    sessionTier = 'usable';
  } else if (tierCounts.weak > 0) {
    sessionTier = 'weak';
  }

  return {
    sessionTier,
    cropClassifications: classifications,
    tierCounts,
  };
}

/**
 * Run the full metadata resolution pipeline
 *
 * @param input - Resolution input with crops, OCR, and optional book candidates
 * @returns Resolution output with decision and state
 */
export async function runMetadataResolution(
  input: MetadataResolutionInput
): Promise<MetadataResolutionOutput> {
  const { sessionId, rectificationResults, ocrResultsByCropIndex, bookCandidates } = input;
  const verbose = isMetadataVerboseDebug();

  if (verbose) {
    console.log('[MetadataOrchestrator] Starting resolution...');
    console.log(`[MetadataOrchestrator] Input: ${rectificationResults.length} crops, ${Object.keys(ocrResultsByCropIndex).length} OCR results`);
  }

  // =========================================================================
  // STAGE 1: QUALITY_CLASSIFY - Classify evidence quality for each crop
  // =========================================================================
  const evidenceSummary = classifyAllEvidence(rectificationResults, ocrResultsByCropIndex);

  if (verbose) {
    console.log(`[MetadataOrchestrator] Evidence tier: ${evidenceSummary.sessionTier}`);
    console.log(`[MetadataOrchestrator] Tier counts: strong=${evidenceSummary.tierCounts.strong}, usable=${evidenceSummary.tierCounts.usable}, weak=${evidenceSummary.tierCounts.weak}, unusable=${evidenceSummary.tierCounts.unusable}`);
  }

  // If all evidence is unusable, return early with no-match
  if (evidenceSummary.sessionTier === 'unusable') {
    if (verbose) {
      console.log('[MetadataOrchestrator] All evidence unusable, returning no-match');
    }
    const decision = makeOcrOnlyDecision(null);
    return {
      evidenceSummary,
      decision,
      resolutionState: {
        evidenceTier: 'unusable',
        decision,
        resolvedAt: new Date().toISOString(),
      },
      queuedForOffline: false,
    };
  }

  // =========================================================================
  // STAGE 2: HYPOTHESIZE - Generate search candidates
  // =========================================================================
  // Build input for candidate generation
  const candidateInput: GenerateCandidatesInput = {
    evidenceSummary,
    ocrResultsByCropIndex,
    // Use merged evidence from first book candidate if available
    mergedEvidence: bookCandidates?.[0]?.evidence,
  };

  const candidateResult = generateSearchCandidates(candidateInput);
  const searchCandidates = candidateResult.candidates;
  const fullTextBlock = candidateResult.fullTextBlock;

  if (verbose) {
    console.log(`[MetadataOrchestrator] Generated ${searchCandidates.length} search candidates`);
  }

  // If no valid candidates, return OCR-only
  if (searchCandidates.length === 0) {
    if (verbose) {
      console.log('[MetadataOrchestrator] No search candidates, returning OCR-only');
    }
    const decision = makeOcrOnlyDecision(null);
    return {
      evidenceSummary,
      searchCandidates,
      decision,
      resolutionState: {
        evidenceTier: evidenceSummary.sessionTier,
        searchCandidates: verbose ? searchCandidates : undefined,
        decision,
        resolvedAt: new Date().toISOString(),
      },
      queuedForOffline: false,
    };
  }

  // =========================================================================
  // STAGE 3: RESOLVE - Search and score matches
  // =========================================================================
  const provider = getMetadataLookupProvider();

  // Check if provider is disabled (offline mode)
  if (isDisabledProvider(provider)) {
    if (verbose) {
      console.log('[MetadataOrchestrator] Provider is disabled, returning OCR-only');
    }

    // Queue for offline resolution if enabled
    let queuedForOffline = false;
    if (isOfflineQueueEnabled()) {
      try {
        await queueForOfflineResolution({
          sessionId,
          searchCandidates,
          evidenceTier: evidenceSummary.sessionTier,
          timestamp: Date.now(),
        });
        queuedForOffline = true;
        if (verbose) {
          console.log('[MetadataOrchestrator] Queued for offline resolution');
        }
      } catch (e) {
        console.warn('[MetadataOrchestrator] Failed to queue for offline:', e);
      }
    }

    // Use best candidate for OCR-only decision
    const bestCandidate = searchCandidates[0];
    const decision = makeOcrOnlyDecision(bestCandidate);

    return {
      evidenceSummary,
      searchCandidates: verbose ? searchCandidates : undefined,
      decision,
      resolutionState: {
        evidenceTier: evidenceSummary.sessionTier,
        searchCandidates: verbose ? searchCandidates : undefined,
        decision,
        resolvedAt: new Date().toISOString(),
      },
      queuedForOffline,
    };
  }

  // Provider is enabled - search for matches
  const allMatches: ResolvedBook[] = [];
  const bestCandidate = searchCandidates[0];

  try {
    // Search by ISBN first if available
    if (bestCandidate.isbn) {
      const isbnMatches = await provider.searchByIsbn(bestCandidate.isbn);
      allMatches.push(...isbnMatches);
    }

    // Then search by text
    if (bestCandidate.query) {
      const textMatches = await provider.searchByText(bestCandidate.query);
      // Dedupe by title+author
      for (const match of textMatches) {
        const isDupe = allMatches.some(
          m => m.title === match.title && m.authors?.join(',') === match.authors?.join(',')
        );
        if (!isDupe) {
          allMatches.push(match);
        }
      }
    }
  } catch (e) {
    console.warn('[MetadataOrchestrator] Provider search failed:', e);
    // Fall through to handle empty matches
  }

  if (verbose) {
    console.log(`[MetadataOrchestrator] Found ${allMatches.length} matches from provider`);
  }

  // If no matches found, return OCR-only
  if (allMatches.length === 0) {
    const decision = makeOcrOnlyDecision(bestCandidate);
    return {
      evidenceSummary,
      searchCandidates: verbose ? searchCandidates : undefined,
      decision,
      resolutionState: {
        evidenceTier: evidenceSummary.sessionTier,
        searchCandidates: verbose ? searchCandidates : undefined,
        decision,
        resolvedAt: new Date().toISOString(),
      },
      queuedForOffline: false,
    };
  }

  // Score and rank matches
  const scoredMatches = scoreAndRankMatches(bestCandidate, allMatches);

  if (verbose) {
    console.log(`[MetadataOrchestrator] Scored ${scoredMatches.length} matches`);
    if (scoredMatches.length > 0) {
      console.log(`[MetadataOrchestrator] Top match: "${scoredMatches[0].book.title}" score=${scoredMatches[0].composite.toFixed(3)}`);
    }
  }

  // =========================================================================
  // STAGE 4 & 5: VERIFY & DECIDE - Verify matches and make decision
  // =========================================================================

  const decision = makeDecision({
    scoredMatches,
    candidate: bestCandidate,
    fullTextBlock,
    evidenceTier: evidenceSummary.sessionTier,
  });

  if (verbose) {
    console.log(`[MetadataOrchestrator] Decision: ${decision.action}`);
  }

  // Build resolution state
  const resolutionState: MetadataResolutionState = {
    evidenceTier: evidenceSummary.sessionTier,
    searchCandidates: verbose ? searchCandidates : undefined,
    decision,
    resolvedAt: new Date().toISOString(),
  };

  // Add resolved book info if available
  if (decision.action === 'auto-accept') {
    resolutionState.resolvedBook = decision.book;
  } else if (decision.action === 'suggest') {
    resolutionState.resolvedBook = decision.book;
    resolutionState.alternatives = decision.alternatives;
    resolutionState.verificationFlags = decision.warnings;
  } else if (decision.action === 'ambiguous') {
    resolutionState.alternatives = decision.candidates;
    resolutionState.verificationFlags = decision.warnings;
  }

  return {
    evidenceSummary,
    searchCandidates: verbose ? searchCandidates : undefined,
    topMatches: verbose ? scoredMatches.slice(0, 5) : undefined,
    decision,
    resolutionState,
    queuedForOffline: false,
  };
}

/**
 * Re-run metadata resolution for a session (for retry button)
 *
 * This runs only the metadata stages, not the full pipeline.
 * Safe to call even if resolution was already attempted.
 */
export async function retryMetadataResolution(
  input: MetadataResolutionInput
): Promise<MetadataResolutionOutput> {
  if (isMetadataVerboseDebug()) {
    console.log(`[MetadataOrchestrator] Retrying resolution for session ${input.sessionId}`);
  }
  return runMetadataResolution(input);
}
