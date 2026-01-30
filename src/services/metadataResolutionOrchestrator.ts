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
import { isSupabaseConfigured } from '../config/supabase';
import {
  resolveCandidates,
  applyResolverResult,
} from './supabaseResolverClient';
import { enqueueCandidate } from './offlineResolverQueue';
import { upsertResolvedBook } from './booksCatalogService';
import {
  OpenLibraryProvider,
  buildResolverKey,
  type EvidenceSearchResult,
} from './openLibraryProvider';
import { getQuerySet } from './queryHypotheses';
import type { ScoredCandidate, ScoringDecision } from './candidateScoring';
import { shouldAutoPersist } from './candidateScoring';
import { AUTO_BOOST_ENABLED } from '../config/metadataResolutionConfig';

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

  // SUPABASE RESOLVER PATH: If Supabase is configured and we have book candidates,
  // use the Edge Function resolver instead of local provider
  if (isSupabaseConfigured() && bookCandidates && bookCandidates.length > 0) {
    if (verbose) {
      console.log('[MetadataOrchestrator] Using Supabase Edge Function resolver');
    }

    try {
      // Resolve all candidates via Supabase
      const resolverResults = await resolveCandidates(sessionId, bookCandidates);

      // Apply results to candidates
      const resolvedCandidates = bookCandidates.map((candidate) => {
        const result = resolverResults.get(candidate.id);
        if (result) {
          return applyResolverResult(candidate, result);
        }
        return candidate;
      });

      // Determine overall decision based on resolved candidates
      const acceptedCandidates = resolvedCandidates.filter(
        (c) => c.resolverDecision === 'accept'
      );
      const reviewCandidates = resolvedCandidates.filter(
        (c) => c.resolverDecision === 'suggested'
      );

      let overallDecision: AcceptanceDecision;
      if (acceptedCandidates.length > 0) {
        // At least one auto-accepted
        const firstAccepted = acceptedCandidates[0];
        const resolvedBook = firstAccepted.resolvedBook!;

        // Upsert to books_catalog for auto-accepted books (fire-and-forget)
        upsertResolvedBook(resolvedBook)
          .then((result) => {
            if (result.success && result.bookId) {
              // Attach bookId to the resolved book (for future reference)
              resolvedBook.bookId = result.bookId;
              if (verbose) {
                console.log(`[MetadataOrchestrator] Book cataloged: ${result.bookId}`);
              }
            }
          })
          .catch((e) => {
            console.warn('[MetadataOrchestrator] Failed to catalog book:', e);
          });

        // Use accept_high or accept_medium based on confidence
        const action = firstAccepted.resolvedConfidence! >= 0.85 ? 'accept_high' : 'accept_medium';
        overallDecision = {
          action,
          book: resolvedBook,
          confidence: firstAccepted.resolvedConfidence!,
        } as AcceptanceDecision;
      } else if (reviewCandidates.length > 0) {
        // Suggested candidates - show without blocking
        const firstSuggested = reviewCandidates[0];
        if (firstSuggested.resolvedBook) {
          overallDecision = {
            action: 'suggested',
            book: firstSuggested.resolvedBook,
            confidence: firstSuggested.resolvedConfidence ?? 0,
            alternatives: firstSuggested.resolverSuggestions ?? [],
          };
        } else {
          overallDecision = {
            action: 'reject',
            reason: 'No viable match found',
          };
        }
      } else {
        // All rejected or no results
        overallDecision = {
          action: 'reject',
          reason: 'All candidates rejected',
        };
      }

      // ALWAYS-ON: Log decision for Supabase resolver path
      const supabaseBook = 'book' in overallDecision ? overallDecision.book : undefined;
      const supabaseConfidence = 'confidence' in overallDecision ? overallDecision.confidence : undefined;
      const supabaseResolverKey = supabaseBook ? buildResolverKey(supabaseBook) : 'none';
      console.log(`[MetadataResolution] decision candidateId="${bookCandidates[0]?.id ?? 'unknown'}" action=${overallDecision.action} confidence=${supabaseConfidence?.toFixed(3) ?? 'N/A'} resolver_key="${supabaseResolverKey}"`);

      // Check if any were queued for offline
      let queuedForOffline = false;
      for (const [id, result] of resolverResults) {
        if (result.offline) {
          const candidate = bookCandidates.find((c) => c.id === id);
          if (candidate) {
            enqueueCandidate(sessionId, candidate);
            queuedForOffline = true;
          }
        }
      }

      return {
        evidenceSummary,
        searchCandidates: verbose ? searchCandidates : undefined,
        decision: overallDecision,
        resolutionState: {
          evidenceTier: evidenceSummary.sessionTier,
          searchCandidates: verbose ? searchCandidates : undefined,
          decision: overallDecision,
          resolvedAt: new Date().toISOString(),
          resolvedCandidates: resolvedCandidates,
        },
        queuedForOffline,
      };
    } catch (e) {
      console.warn('[MetadataOrchestrator] Supabase resolver failed, falling back to local:', e);
      // Fall through to local provider
    }
  }

  // LOCAL PROVIDER PATH: Use evidence-driven resolution
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

  // =========================================================================
  // EVIDENCE-DRIVEN RESOLUTION PATH
  // If we have book candidates with evidence, use evidence-driven search
  // =========================================================================
  if (bookCandidates && bookCandidates.length > 0) {
    console.log('[MetadataOrchestrator] Using evidence-driven resolution');

    try {
      // Resolve all candidates using evidence
      const resolvedCandidates = await resolveAllCandidatesByEvidence(bookCandidates);

      // Determine overall decision based on resolved candidates
      const acceptedCandidates = resolvedCandidates.filter(
        (c) => c.resolverDecision === 'accept'
      );
      const reviewCandidates = resolvedCandidates.filter(
        (c) => c.resolverDecision === 'suggested'
      );

      let overallDecision: AcceptanceDecision;
      if (acceptedCandidates.length > 0) {
        const firstAccepted = acceptedCandidates[0];
        const resolvedBook = firstAccepted.resolvedBook!;
        // Determine if accept_high or accept_medium from debug info
        const debugDecision = (firstAccepted as any).evidenceSearchDebug?.decision;
        const action = debugDecision === 'accept_high' ? 'accept_high' : 'accept_medium';
        overallDecision = {
          action,
          book: resolvedBook,
          confidence: firstAccepted.resolvedConfidence!,
        } as AcceptanceDecision;
      } else if (reviewCandidates.length > 0) {
        // Suggested candidates - show without blocking
        const firstSuggested = reviewCandidates[0];
        if (firstSuggested.resolvedBook) {
          overallDecision = {
            action: 'suggested',
            book: firstSuggested.resolvedBook,
            confidence: firstSuggested.resolvedConfidence ?? 0,
            alternatives: firstSuggested.resolverSuggestions ?? [],
          };
        } else {
          // Reject if no book found
          overallDecision = {
            action: 'reject',
            reason: 'No viable match found',
          };
        }
      } else {
        // All rejected
        overallDecision = {
          action: 'reject',
          reason: 'All candidates rejected',
        };
      }

      // ALWAYS-ON: Log decision
      const evidenceBook = 'book' in overallDecision ? overallDecision.book : undefined;
      const evidenceConfidence = 'confidence' in overallDecision ? overallDecision.confidence : undefined;
      const evidenceResolverKey = evidenceBook ? buildResolverKey(evidenceBook) : 'none';
      console.log(`[MetadataResolution] evidence-driven decision action=${overallDecision.action} confidence=${evidenceConfidence?.toFixed(3) ?? 'N/A'} resolver_key="${evidenceResolverKey}"`);

      // Build debug info from first candidate
      const firstCandidate = resolvedCandidates[0] as BookCandidate & { evidenceSearchDebug?: any };
      const evidenceSearchDebug = firstCandidate?.evidenceSearchDebug;

      return {
        evidenceSummary,
        searchCandidates: verbose ? searchCandidates : undefined,
        decision: overallDecision,
        resolutionState: {
          evidenceTier: evidenceSummary.sessionTier,
          searchCandidates: verbose ? searchCandidates : undefined,
          decision: overallDecision,
          resolvedAt: new Date().toISOString(),
          resolvedCandidates,
          evidenceSearchDebug,
        },
        queuedForOffline: false,
      };
    } catch (e) {
      console.warn('[MetadataOrchestrator] Evidence-driven resolution failed, falling back to legacy:', e);
      // Fall through to legacy path
    }
  }

  // =========================================================================
  // LEGACY PATH: Search for matches using old method (fallback)
  // =========================================================================
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
    console.log(`[MetadataOrchestrator] Found ${allMatches.length} matches from provider (legacy)`);
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

  // ALWAYS-ON: Log decision with key details
  const decisionBook = 'book' in decision ? decision.book : undefined;
  const decisionConfidence = 'confidence' in decision ? decision.confidence : undefined;
  const resolverKey = decisionBook ? buildResolverKey(decisionBook) : 'none';
  console.log(`[MetadataResolution] decision candidateId="local" action=${decision.action} confidence=${decisionConfidence?.toFixed(3) ?? 'N/A'} resolver_key="${resolverKey}"`);

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

    // Upsert to books_catalog for auto-accepted books (fire-and-forget)
    upsertResolvedBook(decision.book)
      .then((result) => {
        if (result.success && result.bookId) {
          decision.book.bookId = result.bookId;
          if (verbose) {
            console.log(`[MetadataOrchestrator] Book cataloged: ${result.bookId}`);
          }
        }
      })
      .catch((e) => {
        console.warn('[MetadataOrchestrator] Failed to catalog book:', e);
      });
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

// ============================================================================
// Evidence-Driven Resolution
// ============================================================================

/**
 * Resolve a single book candidate using evidence-driven search
 *
 * This is the core evidence-driven resolution function. It:
 * 1. Extracts evidence lines from the candidate
 * 2. Uses OpenLibraryProvider.searchByEvidence
 * 3. Returns the resolved candidate with decision
 */
export async function resolveBookCandidateByEvidence(
  candidate: BookCandidate
): Promise<BookCandidate> {
  const verbose = isMetadataVerboseDebug();

  // Extract evidence lines from candidate
  const evidence = candidate.evidence;
  if (!evidence || !evidence.mergedLines || evidence.mergedLines.length === 0) {
    if (verbose) {
      console.log(`[EvidenceResolver] Candidate ${candidate.id} has no evidence`);
    }
    return {
      ...candidate,
      resolverDecision: 'pending',
    };
  }

  // Get text lines from evidence
  const evidenceLines = evidence.mergedLines.map((line) => line.text);

  // Get OCR title/author as fallback (may be wrong)
  const ocrTitle = candidate.hypothesis?.searchCandidates?.[0]?.titleHint || null;
  const ocrAuthor = candidate.hypothesis?.searchCandidates?.[0]?.authorHint || null;

  console.log(`[EvidenceResolver] Resolving candidate ${candidate.id} with ${evidenceLines.length} evidence lines`);

  try {
    const provider = new OpenLibraryProvider();
    const hypothesisTier = candidate.hypothesis?.evidenceTier;
    const debugContext = { candidateId: candidate.id, evidenceTier: hypothesisTier };

    // PASS 1: Initial search
    const pass1Result = await provider.searchByEvidence(
      evidenceLines,
      ocrTitle,
      ocrAuthor,
      1,
      undefined,
      debugContext
    );
    const pass1Decision = pass1Result.decision;

    let result = pass1Result;
    let boostTriggered = false;

    // AUTO-BOOST: If pass 1 decision is not accept_high/accept_medium, run boost pass
    if (
      AUTO_BOOST_ENABLED &&
      pass1Decision !== 'accept_high' &&
      pass1Decision !== 'accept_medium'
    ) {
      console.log(`[EvidenceResolver] Pass 1 decision=${pass1Decision}, triggering boost pass 2`);
      boostTriggered = true;

      // Get queries already tried in pass 1
      const pass1Queries = getQuerySet(pass1Result.hypotheses.hypotheses);

      // PASS 2: Boost search with expanded hypotheses
      const pass2Result = await provider.searchByEvidence(
        evidenceLines,
        ocrTitle,
        ocrAuthor,
        2,
        pass1Queries,
        debugContext
      );

      // Merge candidates: pass2 candidates + pass1 candidates (deduped)
      const mergedCandidates = [...pass2Result.scoredCandidates];
      const seenOlids = new Set(mergedCandidates.map((sc) => sc.book.sourceId));
      for (const sc of pass1Result.scoredCandidates) {
        if (sc.book.sourceId && !seenOlids.has(sc.book.sourceId)) {
          mergedCandidates.push(sc);
        }
      }

      // Re-sort merged candidates by score
      mergedCandidates.sort((a, b) => b.scoring.score - a.scoring.score);

      // Use pass2 result but with merged candidates
      result = {
        ...pass2Result,
        scoredCandidates: mergedCandidates,
        topCandidate: mergedCandidates[0] || null,
        pass1Decision,
        boostTriggered: true,
        queriesTriedCount: pass1Result.queriesTriedCount + pass2Result.queriesTriedCount,
        hypothesisResults: [
          ...pass1Result.hypothesisResults,
          ...pass2Result.hypothesisResults,
        ],
      };

      console.log(`[EvidenceResolver] Boost pass 2 decision=${result.decision} (pass1=${pass1Decision})`);
    }

    // Map decision to resolver decision
    let resolverDecision: BookCandidate['resolverDecision'];
    let resolvedBook: BookCandidate['resolvedBook'];
    let resolverSuggestions: BookCandidate['resolverSuggestions'];
    let resolvedConfidence: BookCandidate['resolvedConfidence'];

    // Check if this is an auto-persist decision (accept_high or accept_medium)
    const autoPersist = shouldAutoPersist(result.decision);

    switch (result.decision) {
      case 'accept_high':
      case 'accept_medium':
        if (result.topCandidate) {
          resolverDecision = 'accept';
          resolvedBook = result.topCandidate.book;
          resolvedConfidence = result.topCandidate.scoring.score;

          // ONLY persist to Supabase for accept_high or accept_medium
          // This is the key non-negotiable requirement
          upsertResolvedBook(result.topCandidate.book)
            .then((upsertResult) => {
              if (upsertResult.success && upsertResult.bookId) {
                result.topCandidate!.book.bookId = upsertResult.bookId;
                console.log(`[EvidenceResolver] ${result.decision}: cataloged book ${upsertResult.bookId}`);
              }
            })
            .catch((e) => {
              console.warn(`[EvidenceResolver] Failed to catalog ${result.decision} book:`, e);
            });
        } else {
          resolverDecision = 'pending';
        }
        break;

      case 'suggested':
        // DO NOT persist for suggested - show to user but no Supabase write
        resolverDecision = 'suggested';
        if (result.topCandidate) {
          resolvedBook = result.topCandidate.book;
          resolvedConfidence = result.topCandidate.scoring.score;
        }
        // Include alternatives for optional review
        resolverSuggestions = result.reviewCandidates.map((sc) => sc.book);
        console.log(`[EvidenceResolver] suggested: "${resolvedBook?.title}" (NOT persisted, optional review)`);
        break;

      case 'reject':
      default:
        // DO NOT persist for reject - nothing to save
        resolverDecision = 'reject';
        if (result.topCandidate) {
          resolvedConfidence = result.topCandidate.scoring.score;
        }
        break;
    }

    // Store debug info
    const evidenceSearchDebug = {
      decision: result.decision,
      pass1Decision: result.pass1Decision || result.decision,
      passUsed: result.passUsed,
      boostTriggered: result.boostTriggered,
      reason: result.reason,
      scoreGap: result.scoreGap,
      hypothesesCount: result.hypothesisResults.length,
      queriesTriedCount: result.queriesTriedCount,
      queriesTried: result.hypothesisResults.map((hr) => ({
        query: hr.hypothesis.query,
        type: hr.hypothesis.type,
        pass: hr.pass,
        resultCount: hr.resultCount,
      })),
      candidatesFound: result.scoredCandidates.length,
      topScores: result.scoredCandidates.slice(0, 5).map((sc) => ({
        title: sc.book.title,
        score: sc.scoring.score,
        overlapCount: sc.scoring.overlapCount,
        isbnMatched: sc.scoring.isbnMatched,
      })),
      searchTimeMs: result.searchTimeMs,
      autoPersisted: autoPersist && resolverDecision === 'accept',
    };

    console.log(`[EvidenceResolver] Candidate ${candidate.id}: ${result.decision} (confidence=${resolvedConfidence?.toFixed(3) || 'N/A'}, ${result.reason})`);

    return {
      ...candidate,
      resolverDecision,
      resolvedBook,
      resolvedConfidence,
      resolverSuggestions,
      // Store debug info for diagnostics
      evidenceSearchDebug,
    } as BookCandidate & { evidenceSearchDebug?: typeof evidenceSearchDebug };
  } catch (e: any) {
    console.warn(`[EvidenceResolver] Failed to resolve candidate ${candidate.id}:`, e.message);
    return {
      ...candidate,
      resolverDecision: 'error',
    };
  }
}

/**
 * Resolve all book candidates using evidence-driven search
 */
export async function resolveAllCandidatesByEvidence(
  candidates: BookCandidate[]
): Promise<BookCandidate[]> {
  console.log(`[EvidenceResolver] Resolving ${candidates.length} candidates by evidence`);

  const resolvedCandidates: BookCandidate[] = [];

  for (const candidate of candidates) {
    const resolved = await resolveBookCandidateByEvidence(candidate);
    resolvedCandidates.push(resolved);
  }

  // Log summary
  const accepted = resolvedCandidates.filter((c) => c.resolverDecision === 'accept').length;
  const suggested = resolvedCandidates.filter((c) => c.resolverDecision === 'suggested').length;
  const rejected = resolvedCandidates.filter((c) => c.resolverDecision === 'reject').length;
  console.log(`[EvidenceResolver] Summary: accepted=${accepted} suggested=${suggested} rejected=${rejected}`);

  return resolvedCandidates;
}
