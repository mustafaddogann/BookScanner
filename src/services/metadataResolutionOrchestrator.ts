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
import {
  isMetadataVerboseDebug,
  isOfflineQueueEnabled,
  isSupabaseResolverEnabled,
} from '../config/debug';
import { queueForOfflineResolution } from './offlineResolutionQueue';
import { isSupabaseConfigured } from '../config/supabase';
import {
  resolveCandidates,
  applyResolverResult,
} from './supabaseResolverClient';
import { enqueueCandidate } from './offlineResolverQueue';
import { upsertResolvedBook } from './booksCatalogService';
import { autoExportRejects } from './autoExportService';
import {
  OpenLibraryProvider,
  buildResolverKey,
  type EvidenceSearchResult,
} from './openLibraryProvider';
import { executeTitleMatchFallback, executeTitleMatchFallbackWithGoogleBooks } from './titleMatchFallback';
import { getQuerySet } from './queryHypotheses';
import type { ScoredCandidate, ScoringDecision } from './candidateScoring';
import { shouldAutoPersist, makeDecisionFromScores } from './candidateScoring';
import { AUTO_BOOST_ENABLED } from '../config/metadataResolutionConfig';
import { persistResolverAttempts } from './resolverAttemptsService';

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

function logResolverSummary(
  sessionId: string,
  candidates: BookCandidate[],
  missingCount: number = 0
): void {
  const counts = {
    processed: candidates.length,
    accepted: 0,
    suggested: 0,
    rejected: 0,
    manualReview: 0,
    pending: 0,
  };

  for (const candidate of candidates) {
    const manualReview =
      candidate.evidenceSearchDebug?.manualReview === true ||
      candidate.resolverDecisionReason === 'manual_review';

    switch (candidate.resolverDecision) {
      case 'accept':
        counts.accepted += 1;
        break;
      case 'suggested':
        if (manualReview) {
          counts.manualReview += 1;
        } else {
          counts.suggested += 1;
        }
        break;
      case 'reject':
        counts.rejected += 1;
        break;
      case 'pending':
      case 'offline':
      case 'disabled':
        counts.pending += 1;
        break;
      case 'error':
        if (candidate.resolverDecisionReason !== 'missing_from_resolver_response') {
          counts.pending += 1;
        }
        break;
      default:
        counts.pending += 1;
        break;
    }
  }

  console.log(
    `[MetadataResolution] summary sessionId=${sessionId} ` +
      `processed=${counts.processed} ` +
      `accepted=${counts.accepted} ` +
      `suggested=${counts.suggested} ` +
      `rejected=${counts.rejected} ` +
      `manual_review=${counts.manualReview}`
  );

  if (missingCount > 0) {
    console.warn(
      `[MetadataResolution] missing_responses sessionId=${sessionId} missing=${missingCount}`
    );
  }
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

  // SUPABASE RESOLVER PATH: If Supabase is configured and enabled,
  // use the Edge Function resolver instead of local provider
  const supabaseConfigured = isSupabaseConfigured();
  const supabaseResolverEnabled = isSupabaseResolverEnabled();
  const hasBookCandidates = !!bookCandidates && bookCandidates.length > 0;

  console.log(
    `[MetadataOrchestrator] Resolver path: supabaseConfigured=${supabaseConfigured} ` +
      `supabaseResolverEnabled=${supabaseResolverEnabled} ` +
      `bookCandidates=${bookCandidates?.length ?? 0}`
  );

  if (supabaseConfigured && !supabaseResolverEnabled && verbose) {
    console.log('[MetadataOrchestrator] Supabase resolver disabled; using local evidence-driven resolver');
  }
  if (
    supabaseConfigured &&
    supabaseResolverEnabled &&
    hasBookCandidates
  ) {
    if (verbose) {
      console.log('[MetadataOrchestrator] Using Supabase Edge Function resolver');
    }

    try {
      // Resolve all candidates via Supabase
      const resolverResults = await resolveCandidates(sessionId, bookCandidates);

      // Apply results to candidates, detect missing responses
      const expectedIds = new Set(bookCandidates.map((c) => c.id));
      const returnedIds = new Set(resolverResults.keys());
      const missingCount = Math.max(0, expectedIds.size - returnedIds.size);

      const resolvedCandidates = bookCandidates.map((candidate) => {
        const result = resolverResults.get(candidate.id);
        if (result) {
          return applyResolverResult(candidate, result);
        }

        if (isOfflineQueueEnabled()) {
          enqueueCandidate(sessionId, candidate);
        }

        return {
          ...candidate,
          resolverDecision: 'error' as const,
          resolverDecisionReason: 'missing_from_resolver_response',
          resolverFlags: [
            ...(candidate.resolverFlags ?? []),
            {
              flag: 'missing_from_resolver_response',
              severity: 'error' as const,
              message: 'Resolver returned no response for candidate',
              penalty: 0,
            },
          ],
        };
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

      if (missingCount > 0) {
        queuedForOffline = queuedForOffline || isOfflineQueueEnabled();
        console.warn(
          `[MetadataOrchestrator] Missing resolver responses: ${missingCount} ` +
            `(returned=${returnedIds.size} expected=${expectedIds.size})`
        );
      }

      // Persist per-candidate attempts (non-blocking)
      void persistResolverAttempts(sessionId, resolvedCandidates, resolverResults);

      // Summary log
      logResolverSummary(sessionId, resolvedCandidates, missingCount);

      // Extract resolvedBook and alternatives from decision for UI state
      const resolvedBookFromDecision = 'book' in overallDecision ? overallDecision.book : undefined;
      const alternativesFromDecision = 'alternatives' in overallDecision ? overallDecision.alternatives : undefined;

      return {
        evidenceSummary,
        searchCandidates: verbose ? searchCandidates : undefined,
        decision: overallDecision,
        resolutionState: {
          evidenceTier: evidenceSummary.sessionTier,
          searchCandidates: verbose ? searchCandidates : undefined,
          decision: overallDecision,
          // CRITICAL: Set resolvedBook for UI display (even for suggested)
          resolvedBook: resolvedBookFromDecision,
          alternatives: alternativesFromDecision,
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

      // Persist per-candidate attempts (non-blocking)
      void persistResolverAttempts(sessionId, resolvedCandidates);

      // Summary log
      logResolverSummary(sessionId, resolvedCandidates, 0);

      // Auto-export rejects for debugging (non-blocking)
      void autoExportRejects(sessionId, resolvedCandidates);

      // Extract resolvedBook and alternatives from decision for UI state
      const resolvedBook = 'book' in overallDecision ? overallDecision.book : undefined;
      const alternatives = 'alternatives' in overallDecision ? overallDecision.alternatives : undefined;

      return {
        evidenceSummary,
        searchCandidates: verbose ? searchCandidates : undefined,
        decision: overallDecision,
        resolutionState: {
          evidenceTier: evidenceSummary.sessionTier,
          searchCandidates: verbose ? searchCandidates : undefined,
          decision: overallDecision,
          // CRITICAL: Set resolvedBook for UI display (even for suggested)
          resolvedBook,
          alternatives,
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

  let decision = makeDecision({
    scoredMatches,
    candidate: bestCandidate,
    fullTextBlock,
    evidenceTier: evidenceSummary.sessionTier,
  });

  // =========================================================================
  // TITLE-MATCH FALLBACK: If no-match, try to find author via title lookup
  // Uses Open Library first, then Google Books as fallback
  // =========================================================================
  if (decision.action === 'no-match' && bestCandidate.titleHint) {
    console.log(`[MetadataOrchestrator] No match - attempting title-match fallback for "${bestCandidate.titleHint}"`);

    try {
      // Use the combined fallback that tries Open Library then Google Books
      const fallbackResult = await executeTitleMatchFallbackWithGoogleBooks(
        bestCandidate.titleHint,
        bestCandidate.authorHint || null
      );

      if (fallbackResult.triggered && fallbackResult.decision === 'suggest') {
        // Determine source from reason (google_books_ prefix means it came from Google Books)
        const isGoogleBooks = fallbackResult.reason.startsWith('google_books_');
        const source = isGoogleBooks ? 'googleBooks' : 'openLibrary';

        console.log(`[MetadataOrchestrator] Title-match fallback SUCCESS (${source}): ` +
          `title="${fallbackResult.suggestedTitle}", author="${fallbackResult.suggestedAuthor}", ` +
          `confidence=${fallbackResult.confidence.toFixed(2)}`);

        // Create a suggested book from fallback result
        const fallbackBook: ResolvedBook = {
          title: fallbackResult.suggestedTitle || bestCandidate.titleHint,
          authors: fallbackResult.suggestedAuthor ? [fallbackResult.suggestedAuthor] : [],
          source,
          sourceId: fallbackResult.debug.chosenCandidate?.title || 'fallback',
        };

        // Update decision to suggest
        // Note: We don't set warnings here as they require specific VerificationFlag values
        // The reason is logged and available via fallbackResult.reason
        decision = {
          action: 'suggest',
          book: fallbackBook,
          alternatives: [],
          confidence: fallbackResult.confidence,
        };
      } else {
        console.log(`[MetadataOrchestrator] Title-match fallback did not trigger: ${fallbackResult.reason}`);
      }
    } catch (e: any) {
      console.warn(`[MetadataOrchestrator] Title-match fallback error:`, e.message);
    }
  }

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
    // COVERAGE FIX: Return reject (not pending) when no evidence
    // This ensures the candidate gets logged and doesn't remain in limbo
    return {
      ...candidate,
      resolverDecision: 'reject',
      resolverDecisionReason: 'no_evidence',
      evidenceSearchDebug: {
        decision: 'reject',
        reason: 'no_evidence',
        hypothesesCount: 0,
        queriesTriedCount: 0,
        queriesTried: [],
        candidatesFound: 0,
        topScores: [],
        searchTimeMs: 0,
      },
    };
  }

  // Get text lines from evidence
  // DEFENSIVE FIX: If mergedLines is empty but mergedTextBlock has content,
  // use mergedTextBlock to build lines (handles edge case where arrays weren't populated)
  let evidenceLines: string[];
  if (evidence.mergedLines.length > 0) {
    evidenceLines = evidence.mergedLines.map((line) => line.text);
  } else if (evidence.mergedTextBlock && evidence.mergedTextBlock.trim().length > 0) {
    // Fallback: split text block by newlines
    console.warn(`[EvidenceResolver] Candidate ${candidate.id}: mergedLines empty but mergedTextBlock has content - using fallback`);
    evidenceLines = evidence.mergedTextBlock.split('\n').filter((line) => line.trim().length > 0);
  } else {
    evidenceLines = [];
  }

  // Get OCR title/author as fallback (may be wrong)
  const ocrTitle = candidate.hypothesis?.searchCandidates?.[0]?.titleHint || null;
  const ocrAuthor = candidate.hypothesis?.searchCandidates?.[0]?.authorHint || null;

  // Use perFieldHints if available (from advanced extraction in spineEvidenceMerger)
  // These have better quality than raw OCR fields
  const perFieldHints = evidence.perFieldHints;
  const hintTitle = perFieldHints?.titleHints?.[0] || null;
  const hintAuthor = perFieldHints?.authorHints?.[0] || null;

  // Use perFieldHints for better query generation if available
  const effectiveTitle = hintTitle || ocrTitle;
  const effectiveAuthor = hintAuthor || ocrAuthor;

  // Log only in verbose mode
  if (verbose) {
    console.log(`[EvidenceResolver] candidateId="${candidate.id}" evidenceLines=${evidenceLines.length}`);
    console.log(`[EvidenceResolver]   effectiveTitle="${effectiveTitle}" effectiveAuthor="${effectiveAuthor}"`);
  }

  // Get sourceKind from evidence for ISBN policy (default to spine_crop)
  // This determines whether ISBN is used for scoring:
  // - spine_crop: ISBN is noise, never used for scoring
  // - back_cover/inside_page: Valid ISBN triggers lookup and scoring boost
  const sourceKind = evidence.sourceKind ?? 'spine_crop';

  console.log(`[EvidenceResolver] Resolving candidate ${candidate.id} with ${evidenceLines.length} evidence lines (sourceKind=${sourceKind})`);

  try {
    const provider = new OpenLibraryProvider();
    const hypothesisTier = candidate.hypothesis?.evidenceTier;
    const debugContext = { candidateId: candidate.id, evidenceTier: hypothesisTier };

    // PASS 1: Initial search with source-aware ISBN policy
    // Use effectiveTitle/Author from perFieldHints (better extraction) over raw OCR
    const pass1Result = await provider.searchByEvidence(
      evidenceLines,
      effectiveTitle,
      effectiveAuthor,
      1,
      undefined,
      debugContext,
      sourceKind
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

      // PASS 2: Boost search with expanded hypotheses (same sourceKind)
      // Use effectiveTitle/Author from perFieldHints (better extraction) over raw OCR
      const pass2Result = await provider.searchByEvidence(
        evidenceLines,
        effectiveTitle,
        effectiveAuthor,
        2,
        pass1Queries,
        debugContext,
        sourceKind
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
      mergedCandidates.sort((a, b) => (b.scoring?.score ?? 0) - (a.scoring?.score ?? 0));

      // CRITICAL FIX: Recompute decision on merged candidates
      // Pass2 may have found garbage, but pass1's good match is in mergedCandidates
      // We must re-run decision logic on the merged+sorted list
      const mergedDecisionResult = makeDecisionFromScores(mergedCandidates, true);

      // Use merged decision, not pass2's decision
      result = {
        ...pass2Result,
        // Override with merged decision
        decision: mergedDecisionResult.decision,
        reason: mergedDecisionResult.reason,
        scoreGap: mergedDecisionResult.scoreGap,
        manualReview: mergedDecisionResult.manualReview,
        reviewCandidates: mergedDecisionResult.reviewCandidates,
        scoredCandidates: mergedCandidates,
        topCandidate: mergedDecisionResult.topCandidate ?? mergedCandidates[0] ?? null,
        pass1Decision,
        boostTriggered: true,
        queriesTriedCount: pass1Result.queriesTriedCount + pass2Result.queriesTriedCount,
        hypothesisResults: [
          ...pass1Result.hypothesisResults,
          ...pass2Result.hypothesisResults,
        ],
      };

      console.log(`[EvidenceResolver] Boost pass 2 merged decision=${result.decision} (pass1=${pass1Decision}, pass2Raw=${pass2Result.decision})`);
    }

    // Map decision to resolver decision
    let resolverDecision: BookCandidate['resolverDecision'];
    let resolvedBook: BookCandidate['resolvedBook'];
    let resolverSuggestions: BookCandidate['resolverSuggestions'];
    let resolvedConfidence: BookCandidate['resolvedConfidence'];
    let resolverDecisionReason: string | undefined;

    // Check if this is an auto-persist decision (accept_high or accept_medium)
    const autoPersist = shouldAutoPersist(result.decision);

    switch (result.decision) {
      case 'accept_high':
      case 'accept_medium':
        if (result.topCandidate) {
          resolverDecision = 'accept';
          resolvedBook = result.topCandidate.book;
          resolvedConfidence = result.topCandidate.scoring?.score ?? 0;
          resolverDecisionReason = result.reason;

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
          resolverDecisionReason = 'no_top_candidate';
        }
        break;

      case 'suggested':
        // DO NOT persist for suggested - show to user but no Supabase write
        resolverDecision = 'suggested';
        if (result.topCandidate) {
          resolvedBook = result.topCandidate.book;
          resolvedConfidence = result.topCandidate.scoring?.score ?? 0;
        }
        resolverDecisionReason = result.reason;
        // Include alternatives only when ambiguity warrants manual review
        if (result.manualReview) {
          resolverSuggestions = result.reviewCandidates.map((sc) => sc.book);
        }
        console.log(`[EvidenceResolver] suggested: "${resolvedBook?.title}" (NOT persisted, optional review)`);
        break;

      case 'suggested_weak':
        // NEVER persist for suggested_weak - UI-only best guess
        // Maps to 'suggested' resolver decision but with lower confidence
        resolverDecision = 'suggested';
        if (result.topCandidate) {
          resolvedBook = result.topCandidate.book;
          resolvedConfidence = result.topCandidate.scoring?.score ?? 0;
        }
        resolverDecisionReason = result.reason;
        console.log(`[EvidenceResolver] suggested_weak: "${resolvedBook?.title}" (UI-only, NEVER persisted)`);
        break;

      case 'reject':
      default:
        // Open Library rejected - try Google Books fallback before giving up
        // This helps find books that aren't in Open Library
        if (effectiveTitle) {
          console.log(`[EvidenceResolver] Rejected by Open Library - trying Google Books fallback for "${effectiveTitle}"`);
          try {
            const googleBooksFallbackResult = await executeTitleMatchFallbackWithGoogleBooks(
              effectiveTitle,
              effectiveAuthor
            );

            if (googleBooksFallbackResult.triggered && googleBooksFallbackResult.decision === 'suggest') {
              const isGoogleBooks = googleBooksFallbackResult.reason.startsWith('google_books_');
              const source = isGoogleBooks ? 'googleBooks' : 'openLibrary';

              console.log(`[EvidenceResolver] Google Books fallback SUCCESS (${source}): ` +
                `title="${googleBooksFallbackResult.suggestedTitle}", author="${googleBooksFallbackResult.suggestedAuthor}"`);

              resolverDecision = 'suggested';
              resolvedBook = {
                title: googleBooksFallbackResult.suggestedTitle || effectiveTitle,
                authors: googleBooksFallbackResult.suggestedAuthor ? [googleBooksFallbackResult.suggestedAuthor] : [],
                source,
                sourceId: googleBooksFallbackResult.debug.chosenCandidate?.title || 'fallback',
              };
              resolvedConfidence = googleBooksFallbackResult.confidence;
              resolverDecisionReason = `google_books_fallback: ${googleBooksFallbackResult.reason}`;
              break;
            } else {
              console.log(`[EvidenceResolver] Google Books fallback did not find match: ${googleBooksFallbackResult.reason}`);
            }
          } catch (e: any) {
            console.warn(`[EvidenceResolver] Google Books fallback error: ${e.message}`);
          }
        }

        // Final reject - nothing to save
        resolverDecision = 'reject';
        if (result.topCandidate) {
          resolvedConfidence = result.topCandidate.scoring?.score ?? 0;
        }
        resolverDecisionReason = result.reason;
        break;
    }

    const totalResults = result.hypothesisResults.reduce(
      (sum, hr) => sum + hr.resultCount,
      0
    );

    if (verbose) {
      const hypothesisQueries = result.hypothesisResults.map(
        (hr) => hr.hypothesis.query
      );
      const topScore = result.topCandidate?.scoring.score ?? 0;
      const topOverlap = result.topCandidate?.scoring.overlapCount ?? 0;
      console.log(
        `[EvidenceResolver] candidateId="${candidate.id}" lines=${evidenceLines.length} ` +
          `hypotheses=${result.hypothesisResults.length} ` +
          `queries=${JSON.stringify(hypothesisQueries)} ` +
          `queriesTried=${result.queriesTriedCount} ` +
          `totalResults=${totalResults} ` +
          `topScore=${topScore.toFixed(3)} gap=${result.scoreGap.toFixed(3)} ` +
          `overlap=${topOverlap} decision=${result.decision}`
      );
    }

    // Store debug info - includes both raw_score and final_score for debugging mismatch issues
    const evidenceSearchDebug = {
      decision: result.decision,
      pass1Decision: result.pass1Decision || result.decision,
      passUsed: result.passUsed,
      boostTriggered: result.boostTriggered,
      reason: result.reason,
      scoreGap: result.scoreGap,
      hypothesesCount: result.hypothesisResults.length,
      queriesTriedCount: result.queriesTriedCount,
      queriesTried: result.hypothesisResults.map((hr) => hr.hypothesis.query),
      candidatesFound: result.scoredCandidates.length,
      topScores: result.scoredCandidates.slice(0, 5).map((sc) => ({
        title: sc.book.title,
        score: sc.scoring?.score ?? 0,
        // TASK 4: Include raw_score and final_score for debugging
        rawScore: sc.scoring?.rawScore,
        finalScore: sc.scoring?.finalScore,
        overlapCount: sc.scoring?.overlapCount ?? 0,
        isbnMatched: sc.scoring?.isbnMatched ?? false,
        minSignalCapped: sc.scoring?.minSignalCapped ?? false,
      })),
      searchTimeMs: result.searchTimeMs,
      manualReview: result.manualReview,
      autoPersisted: autoPersist && resolverDecision === 'accept',
    };

    console.log(`[EvidenceResolver] Candidate ${candidate.id}: ${result.decision} (confidence=${resolvedConfidence?.toFixed(3) || 'N/A'}, ${result.reason})`);

    const resolverFlags = result.manualReview
      ? [
          ...(candidate.resolverFlags ?? []),
          {
            flag: 'manual_review',
            severity: 'info',
            message: 'Top two matches are close - manual review suggested',
            penalty: 0,
          },
        ]
      : candidate.resolverFlags;

    return {
      ...candidate,
      resolverDecision,
      resolverDecisionReason,
      resolvedBook,
      resolvedConfidence,
      resolverSuggestions,
      resolverFlags,
      // Store debug info for diagnostics
      evidenceSearchDebug,
    } as BookCandidate & { evidenceSearchDebug?: typeof evidenceSearchDebug };
  } catch (e: any) {
    console.warn(`[EvidenceResolver] Failed to resolve candidate ${candidate.id}:`, e.message);
    return {
      ...candidate,
      resolverDecision: 'error',
      resolverDecisionReason: e?.message || 'resolver_error',
    };
  }
}

/**
 * Resolve all book candidates using evidence-driven search
 *
 * COVERAGE GUARANTEE: This function processes ALL input candidates.
 * - Every candidate gets a decision (accept/suggested/reject)
 * - No candidate is left in "pending" state
 * - Logs assertion at start/end with counts
 */
export async function resolveAllCandidatesByEvidence(
  candidates: BookCandidate[]
): Promise<BookCandidate[]> {
  const inputCount = candidates.length;
  const inputIds = candidates.map((c) => c.id);
  console.log(`[EvidenceResolver] START resolving ${inputCount} candidates by evidence`);
  console.log(`[EvidenceResolver] Input candidate IDs: ${JSON.stringify(inputIds)}`);

  const resolvedCandidates: BookCandidate[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    console.log(`[EvidenceResolver] Processing candidate ${i + 1}/${inputCount}: ${candidate.id}`);
    const resolved = await resolveBookCandidateByEvidence(candidate);
    resolvedCandidates.push(resolved);
  }

  // COVERAGE ASSERTION: Verify output count matches input
  const outputCount = resolvedCandidates.length;
  const outputIds = resolvedCandidates.map((c) => c.id);
  const missingIds = inputIds.filter((id) => !outputIds.includes(id));

  if (missingIds.length > 0) {
    console.error(`[EvidenceResolver] COVERAGE_ERROR: Missing candidates after resolution: ${JSON.stringify(missingIds)}`);
  }

  if (outputCount !== inputCount) {
    console.error(`[EvidenceResolver] COVERAGE_ERROR: Input count ${inputCount} != output count ${outputCount}`);
  }

  // Log summary
  const accepted = resolvedCandidates.filter((c) => c.resolverDecision === 'accept').length;
  const suggested = resolvedCandidates.filter((c) => c.resolverDecision === 'suggested').length;
  const rejected = resolvedCandidates.filter((c) => c.resolverDecision === 'reject').length;
  const pending = resolvedCandidates.filter((c) => c.resolverDecision === 'pending' || !c.resolverDecision).length;
  const manualReview = resolvedCandidates.filter(
    (c) => c.evidenceSearchDebug?.manualReview === true
  ).length;

  console.log(
    `[EvidenceResolver] END Summary: input=${inputCount} output=${outputCount} ` +
    `accepted=${accepted} suggested=${suggested} rejected=${rejected} pending=${pending} ` +
    `manual_review=${manualReview}`
  );

  // COVERAGE ASSERTION: No pending candidates should remain
  if (pending > 0) {
    console.warn(`[EvidenceResolver] WARNING: ${pending} candidates still pending after resolution`);
    // Convert any remaining pending to reject
    for (const candidate of resolvedCandidates) {
      if (candidate.resolverDecision === 'pending' || !candidate.resolverDecision) {
        candidate.resolverDecision = 'reject';
        candidate.resolverDecisionReason = candidate.resolverDecisionReason || 'resolution_incomplete';
      }
    }
  }

  return resolvedCandidates;
}
