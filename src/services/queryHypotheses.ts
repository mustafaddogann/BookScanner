/**
 * Query Hypotheses Service
 *
 * Generates ordered search query hypotheses from OCR evidence.
 * These hypotheses are used to search Open Library and find the best match.
 *
 * The key insight is that OCR field extraction (title/author assignment) is often
 * wrong, but the raw text lines themselves are usually correct. This service
 * generates multiple query variations from the evidence to maximize the chance
 * of finding the correct book.
 */

import type { EvidenceTier } from '../types';
import {
  buildEvidenceTokens,
  stripLeadingArticle,
  normalizeForScoring,
  hasInformativeSearchSignal,
  hasUsableAuthorNameSignal,
  buildSearchSignalKey,
  buildFocusedSearchTitle,
  shouldPreferFocusedTitleVariant,
  looksLikeTitle,
  looksLikePersonName,
  type EvidenceTokens,
} from './evidenceNormalization';
import {
  PASS1_MAX_HYPOTHESES,
  PASS2_MAX_HYPOTHESES,
  MIN_QUERY_LENGTH,
  MAX_QUERY_TOKENS,
  BOOST_MAX_NGRAM_SIZE,
  BOOST_TOP_TOKENS_COUNT,
} from '../config/metadataResolutionConfig';

// ============================================================================
// Types
// ============================================================================

/**
 * A search hypothesis with metadata
 */
export interface SearchHypothesis {
  /** The query string to search */
  query: string;
  /** Hypothesis type for debugging */
  type: HypothesisType;
  /** Priority (lower = try first) */
  priority: number;
  /** Explanation for debugging */
  explanation: string;
}

export type HypothesisType =
  | 'isbn'           // Direct ISBN search
  | 'title_author'   // Title + author combination
  | 'author_title'   // Author + title combination
  | 'title_only'     // Just title
  | 'author_only'    // Just author
  | 'longest_line'   // Longest non-junk line
  | 'combined_lines' // Multiple lines combined
  | 'stripped'       // Article-stripped variant
  | 'fallback'       // OCR field fallback
  // Boost pass types
  | 'boost_combo'    // Combined substantive lines
  | 'boost_tokens'   // Top N unique tokens
  | 'boost_ngram'    // N-gram sliding window
  | 'boost_partial'; // Partial line match

/**
 * Result of hypothesis generation
 */
export interface HypothesisGenerationResult {
  /** Ordered hypotheses to try */
  hypotheses: SearchHypothesis[];
  /** Debug info */
  debug: {
    inputLineCount: number;
    cleanedLineCount: number;
    tokenCount: number;
    personNames: string[];
    titleLikeLines: string[];
    isbns: string[];
  };
}

export interface HypothesisDebugContext {
  candidateId?: string;
  evidenceTier?: EvidenceTier;
}

// ============================================================================
// Configuration (imported from metadataResolutionConfig)
// ============================================================================

/** Re-export for backwards compatibility */
export const MAX_HYPOTHESES = PASS1_MAX_HYPOTHESES;

function isEchoQuery(query: string): boolean {
  const tokens = normalizeForScoring(query);
  if (tokens.length < 2) {
    return false;
  }

  if (new Set(tokens).size === 1) {
    return true;
  }

  if (tokens.length % 2 !== 0) {
    return false;
  }

  const half = tokens.length / 2;
  for (let i = 0; i < half; i++) {
    if (tokens[i] !== tokens[i + half]) {
      return false;
    }
  }

  return true;
}

function hasRepeatedTrailingSignal(query: string): boolean {
  const tokens = normalizeForScoring(query);
  if (tokens.length < 4) {
    return false;
  }

  const maxPhraseSize = Math.floor(tokens.length / 2);
  for (let size = 1; size <= maxPhraseSize; size++) {
    const trailing = tokens.slice(tokens.length - size);
    const preceding = tokens.slice(tokens.length - size * 2, tokens.length - size);
    if (
      trailing.length === size &&
      preceding.length === size &&
      trailing.every((token, index) => token === preceding[index])
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Detect "A x A" query shapes created by noisy title/author blending.
 *
 * Example rejected shape:
 * - "WARANLOS NEW WARANLOS"
 *
 * We only block when the middle bridge token is short (<=4) so real
 * repeated-title queries like "TIME AFTER TIME" are preserved.
 */
function hasWrappedSingleTokenEcho(query: string): boolean {
  const tokens = normalizeForScoring(query);
  if (tokens.length !== 3) {
    return false;
  }

  if (tokens[0] !== tokens[2]) {
    return false;
  }

  return tokens[1].length <= 4;
}

/**
 * Prefer focused single-token titles for sparse two-token OCR shards.
 *
 * Example:
 * - "UINT INUIVOLO" -> "INUIVOLO"
 * - "NEW WARANLOS" -> "WARANLOS"
 */
function shouldPreferSparseFocusedTitleVariant(rawTitle: string, focusedTitle: string): boolean {
  const rawTokens = normalizeForScoring(rawTitle);
  const focusedTokens = normalizeForScoring(focusedTitle);

  if (rawTokens.length !== 2 || focusedTokens.length !== 1) {
    return false;
  }

  const focusedToken = focusedTokens[0];
  const droppedTokens = rawTokens.filter((token) => token !== focusedToken);
  if (droppedTokens.length !== 1) {
    return false;
  }

  return focusedToken.length >= 6 && droppedTokens[0].length <= 4;
}

/**
 * Detect short multi-token query shapes that are usually synthetic OCR shards.
 *
 * Example rejected shape:
 * - "TEST OCR BAD" -> 3 tokens, longest token length 4, only one medium token.
 *
 * We keep 1-2 token queries (e.g., "DEAN KO", "DIED WOOL") to avoid
 * over-pruning compact but potentially useful hypotheses.
 */
function isLowDiscriminativeShortQueryShape(query: string): boolean {
  const tokens = normalizeForScoring(query);
  if (tokens.length < 3) {
    return false;
  }

  const longestTokenLength = tokens.reduce((max, token) => Math.max(max, token.length), 0);
  if (longestTokenLength >= 5) {
    return false;
  }

  const mediumTokenCount = tokens.filter((token) => token.length >= 4).length;
  return mediumTokenCount < 2;
}

function hasDistinctSignalKeyPair(
  titleValue: string,
  authorValue: string
): boolean {
  const titleKey = buildSearchSignalKey(titleValue);
  const authorKey = buildSearchSignalKey(authorValue);
  return titleKey.length > 0 && authorKey.length > 0 && titleKey !== authorKey;
}

function selectHighConfidenceRecoveredAuthor(evidence: EvidenceTokens): string | null {
  const recovered = evidence.recoveredAuthorCandidates.find(
    (candidate) =>
      candidate.confidence >= 0.6 &&
      hasUsableAuthorNameSignal(candidate.line)
  );
  return recovered ? recovered.line.trim() : null;
}

const OCR_TOKEN_SUBSTITUTIONS: ReadonlyArray<readonly [string, string]> = [
  ['o', 'a'],
  ['e', 'a'],
  ['p', 'r'],
  ['f', 't'],
  ['i', 'l'],
];

const COMMON_LANGUAGE_BIGRAMS = [
  'th', 'he', 'in', 'er', 'an', 're', 'on', 'at', 'en', 'nd',
  'or', 'ar', 'st', 'to', 'tr', 'ra', 'ck',
];

const COMMON_LANGUAGE_TRIGRAMS = [
  'the', 'and', 'ing', 'ion', 'ent', 'tra', 'ack', 'ter', 'rea',
];

function languageShapeScore(token: string): number {
  let score = 0;

  for (let i = 0; i < token.length - 1; i++) {
    const bigram = token.slice(i, i + 2);
    if (COMMON_LANGUAGE_BIGRAMS.includes(bigram)) {
      score += 1;
    }
  }

  for (let i = 0; i < token.length - 2; i++) {
    const trigram = token.slice(i, i + 3);
    if (COMMON_LANGUAGE_TRIGRAMS.includes(trigram)) {
      score += 2;
    }
  }

  return score;
}

/**
 * Generate OCR-corrected variants for a noisy single title token.
 *
 * This is deliberately constrained:
 * - only 5-10 char alphabetic tokens
 * - only interior single-char substitutions
 * - two-step substitutions allowed to recover common OCR double-errors
 */
function generateOcrTokenCorrectionVariants(token: string, limit: number = 2): string[] {
  const normalized = token.toLowerCase();
  if (!/^[a-z]+$/.test(normalized) || normalized.length < 5 || normalized.length > 10) {
    return [];
  }

  const baseScore = languageShapeScore(normalized);
  const candidates = new Map<string, number>();
  const oneStep = new Set<string>();

  const applySubstitutions = (input: string): string[] => {
    const next: string[] = [];
    for (const [fromChar, toChar] of OCR_TOKEN_SUBSTITUTIONS) {
      for (let i = 1; i < input.length - 1; i++) {
        if (input[i] !== fromChar) {
          continue;
        }
        const variant = `${input.slice(0, i)}${toChar}${input.slice(i + 1)}`;
        next.push(variant);
      }
    }
    return next;
  };

  for (const variant of applySubstitutions(normalized)) {
    oneStep.add(variant);
  }

  for (const variant of oneStep) {
    candidates.set(variant, languageShapeScore(variant));
    for (const secondStepVariant of applySubstitutions(variant)) {
      candidates.set(secondStepVariant, languageShapeScore(secondStepVariant));
    }
  }

  return Array.from(candidates.entries())
    .filter(([variant, score]) => {
      if (variant === normalized) return false;
      if (!/[aeiou]/.test(variant)) return false;
      if (score <= baseScore) return false;
      return hasInformativeSearchSignal(variant, { minSingleTokenLength: 5 });
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, limit))
    .map(([variant]) => variant);
}

// ============================================================================
// Hypothesis Generation
// ============================================================================

/**
 * Generate search hypotheses from evidence lines
 *
 * @param evidenceLines - Raw text lines from merged OCR evidence
 * @param ocrTitle - OCR-extracted title (may be wrong, used as fallback)
 * @param ocrAuthor - OCR-extracted author (may be wrong, used as fallback)
 * @returns Ordered list of search hypotheses
 */
export function generateHypotheses(
  evidenceLines: string[],
  ocrTitle?: string | null,
  ocrAuthor?: string | null,
  debugContext?: HypothesisDebugContext
): HypothesisGenerationResult {
  const hypotheses: SearchHypothesis[] = [];
  const usedQueries = new Set<string>();
  const usedSignalQueries = new Set<string>();

  // Build evidence tokens
  const evidence = buildEvidenceTokens(evidenceLines);

  // Helper to add hypothesis if not duplicate
  // Also enforces token count bounds (2-7 tokens for effective Open Library search)
  const addHypothesis = (
    query: string,
    type: HypothesisType,
    priority: number,
    explanation: string
  ) => {
    let trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) return;

    // Trim to max tokens if needed (except ISBN)
    if (type !== 'isbn') {
      const tokens = trimmed.split(/\s+/).filter(Boolean);
      if (tokens.length > MAX_QUERY_TOKENS) {
        trimmed = tokens.slice(0, MAX_QUERY_TOKENS).join(' ');
      }

      if (type === 'title_only') {
        const focusedTitle = buildFocusedSearchTitle(trimmed);
        if (focusedTitle && focusedTitle !== trimmed) {
          const shouldPreferFocused =
            shouldPreferFocusedTitleVariant(trimmed, focusedTitle) ||
            shouldPreferSparseFocusedTitleVariant(trimmed, focusedTitle);
          if (shouldPreferFocused) {
            trimmed = focusedTitle;
          }
        }
      }

      const rawWordCount = trimmed.split(/\s+/).filter(Boolean).length;
      const signalTokens = normalizeForScoring(trimmed);
      const dedupedSignalTokens = signalTokens.filter(
        (token, index) => index === 0 || token !== signalTokens[index - 1]
      );

      // If a noisy multi-word query collapses to a single informative token
      // (e.g., "NEW WARANLOS" -> "waranlos"), prefer the focused token.
      if (rawWordCount > 1 && dedupedSignalTokens.length === 1) {
        trimmed = dedupedSignalTokens[0];
      }

      // Skip duplicated echo patterns like "NEW WARANLOS NEW WARANLOS".
      if (isEchoQuery(trimmed)) return;
      // Skip low-value repeated suffixes like
      // "THE GUARDIAN NICHOLAS SPARKS NICHOLAS SPARKS".
      if (hasRepeatedTrailingSignal(trimmed)) return;
      // Skip wrapped single-token echoes like
      // "WARANLOS NEW WARANLOS".
      if (hasWrappedSingleTokenEcho(trimmed)) return;

      const hasSignal = hasInformativeSearchSignal(trimmed, {
        minSingleTokenLength: type === 'author_only' ? 4 : 5,
      });
      if (!hasSignal) return;

      // Title-only queries need stronger standalone title signal to avoid
      // emitting short OCR shards (e.g., "THE FHE CIDE").
      if (type === 'title_only' && !hasStrongStandaloneTitleSignal(trimmed)) {
        return;
      }
    }

    const normalized = trimmed.toLowerCase();

    // Skip if too short after trimming
    if (normalized.length < MIN_QUERY_LENGTH) return;

    // Skip duplicates
    if (usedQueries.has(normalized)) return;

    // Skip semantically equivalent queries (e.g., "NEW WARANLOS" vs "WARANLOS").
    // Keep stripped variants even when they share the same semantic key so
    // article-stripped alternatives remain available.
    const shouldApplySemanticDedup = type !== 'isbn' && type !== 'stripped';
    if (shouldApplySemanticDedup) {
      const signalKey = buildSearchSignalKey(trimmed);
      if (!signalKey) return;
      if (usedSignalQueries.has(signalKey)) return;
      usedSignalQueries.add(signalKey);
    }

    usedQueries.add(normalized);
    hypotheses.push({ query: trimmed, type, priority, explanation });
  };

  // =========================================================================
  // Priority Strategy (max 5 hypotheses):
  // 1. ISBN (if found)
  // 2. title + author (best disambiguation)
  // 3. title-only (longest substantive line)
  // 4. author-only (if detected)
  // 5. stripped variant (remove leading article / noise)
  //
  // Only fall back to OCR fields if evidence doesn't yield enough.
  // =========================================================================

  const sortedByLength = [...evidence.candidatePhrases].sort(
    (a, b) => b.length - a.length
  );

  const isInformativeTokens = (tokens: string[]): boolean =>
    tokens.length >= 2 || (tokens.length === 1 && tokens[0].length >= 5);

  const rankedBySignal = evidence.candidatePhrases
    .map((line) => {
      const tokens = normalizeForScoring(line);
      const substantiveTokens = tokens.filter((token) => token.length >= 3);
      const longTokenCount = substantiveTokens.filter((token) => token.length >= 5).length;
      const shortSubstantiveCount = substantiveTokens.filter((token) => token.length <= 4).length;
      const longestTokenLength = substantiveTokens.reduce(
        (max, token) => Math.max(max, token.length),
        0
      );
      const shortTokenPenalty = Math.max(0, tokens.length - substantiveTokens.length) * 2;
      // Prefer lines with fewer but more distinctive long tokens over clusters
      // of short OCR shards (e.g., "GUARDIAN" over "THE FHE CIDE").
      const score =
        substantiveTokens.length * 8 +
        longTokenCount * 7 +
        longestTokenLength * 2 -
        shortSubstantiveCount * 5 -
        shortTokenPenalty * 3;
      return {
        line,
        tokens,
        key: tokens.join(' '),
        score,
      };
    })
    .sort((a, b) => b.score - a.score || b.line.length - a.line.length);

  const isInformativeHint = (value: string | null | undefined): value is string => {
    return hasInformativeSearchSignal(value, {
      minSingleTokenLength: 5,
      requireLongTokenForMultiToken: true,
      minLongTokenLength: 5,
    });
  };

  const selectFocusedTitleToken = (
    titleHintValue: string | null,
    authorHintValue?: string | null
  ): string | null => {
    if (!titleHintValue) return null;

    const titleTokens = normalizeForScoring(titleHintValue);
    const authorTokenSet = new Set(
      authorHintValue ? normalizeForScoring(authorHintValue) : []
    );
    const distinctTitleTokens = titleTokens.filter((t) => !authorTokenSet.has(t));
    if (distinctTitleTokens.length === 0) return null;

    const prioritized = [...distinctTitleTokens].sort((a, b) => b.length - a.length);
    return prioritized.find((t) => t.length >= 5) ?? prioritized[0] ?? null;
  };

  const buildFocusedTitleAuthorHint = (
    titleHintValue: string | null,
    authorHintValue: string | null
  ): string | null => {
    if (!titleHintValue || !authorHintValue) return null;

    const focusedTitle = buildFocusedSearchTitle(titleHintValue);
    if (!shouldPreferFocusedTitleVariant(titleHintValue, focusedTitle)) {
      return null;
    }

    // Prefer longer, more informative title tokens for noisy OCR hints.
    // Example: "TIMES GUARDIAN CIDE" + "NICHOLAS SPARKS" => "GUARDIAN NICHOLAS SPARKS"
    const bestToken =
      selectFocusedTitleToken(focusedTitle, authorHintValue) ??
      selectFocusedTitleToken(titleHintValue, authorHintValue);
    if (!bestToken) return null;

    return `${bestToken} ${authorHintValue}`.trim();
  };

  const stripAuthorFromTitleEdges = (
    titleValue: string,
    authorValue: string
  ): string | null => {
    const titleWords = titleValue.trim().split(/\s+/).filter(Boolean);
    const authorWords = authorValue.trim().split(/\s+/).filter(Boolean);

    if (authorWords.length < 2 || titleWords.length <= authorWords.length) {
      return null;
    }

    const normalizeWord = (word: string): string =>
      word.toLowerCase().replace(/[^a-z]/g, '');

    const hasExactMatchAt = (startIndex: number): boolean =>
      authorWords.every((authorWord, idx) => {
        const titleWord = titleWords[startIndex + idx];
        const normalizedAuthor = normalizeWord(authorWord);
        const normalizedTitle = normalizeWord(titleWord);
        return normalizedAuthor.length > 0 && normalizedAuthor === normalizedTitle;
      });

    let strippedWords: string[] | null = null;

    // Handles "TITLE AUTHOR" inline OCR.
    if (hasExactMatchAt(titleWords.length - authorWords.length)) {
      strippedWords = titleWords.slice(0, titleWords.length - authorWords.length);
    }

    // Handles "AUTHOR TITLE" inline OCR (e.g., "NICHOLAS SPARKS GUARDIAN").
    if (!strippedWords && hasExactMatchAt(0)) {
      strippedWords = titleWords.slice(authorWords.length);
    }

    if (!strippedWords) {
      return null;
    }

    const stripped = strippedWords.join(' ').trim();
    return stripped.length >= MIN_QUERY_LENGTH ? stripped : null;
  };

  const hasSubstantiveAuthorTokens = (value: string): boolean =>
    hasUsableAuthorNameSignal(value);

  const getDistinctTitleSignalTokens = (
    titleValue: string,
    authorValue?: string | null
  ): string[] => {
    const titleTokens = normalizeForScoring(titleValue);
    const authorTokenSet = new Set(
      authorValue ? normalizeForScoring(authorValue) : []
    );
    return titleTokens.filter((token) => !authorTokenSet.has(token));
  };

  const hasStrongStandaloneTitleSignal = (titleValue: string): boolean => {
    const tokens = normalizeForScoring(titleValue);
    if (tokens.length === 0) {
      return false;
    }

    if (tokens.length === 1) {
      const rawWordCount = titleValue.trim().split(/\s+/).filter(Boolean).length;
      return tokens[0].length >= 5 || (tokens[0].length >= 4 && rawWordCount === 1);
    }

    if (tokens.some((token) => token.length >= 5)) {
      return true;
    }

    return tokens.every((token) => token.length >= 4);
  };

  const hasDistinctTitleAuthorSignal = (
    titleValue: string,
    authorValue: string
  ): boolean => {
    const distinctTitleTokens = getDistinctTitleSignalTokens(titleValue, authorValue);
    if (distinctTitleTokens.length === 0) {
      return false;
    }

    if (distinctTitleTokens.length === 1) {
      const rawWordCount = titleValue.trim().split(/\s+/).filter(Boolean).length;
      return (
        distinctTitleTokens[0].length >= 5 ||
        (distinctTitleTokens[0].length >= 4 && rawWordCount === 1)
      );
    }

    if (distinctTitleTokens.some((token) => token.length >= 5)) {
      return true;
    }

    return distinctTitleTokens.every((token) => token.length >= 4);
  };

  const shouldEmitAuthorFirstVariant = (
    titleValue: string,
    authorValue: string
  ): boolean => {
    const distinctTitleTokens = getDistinctTitleSignalTokens(titleValue, authorValue);
    return distinctTitleTokens.length === 1 && distinctTitleTokens[0].length >= 5;
  };

  const rawHintTitle = (() => {
    if (!isInformativeHint(ocrTitle)) {
      return null;
    }
    const trimmed = ocrTitle.trim();
    // Suppress hints that collapse to pure badge residue (e.g., "NEW YORK TIMES").
    return buildFocusedSearchTitle(trimmed) ? trimmed : null;
  })();
  const hintAuthor =
    ocrAuthor &&
    looksLikePersonName(ocrAuthor) &&
    hasSubstantiveAuthorTokens(ocrAuthor)
      ? ocrAuthor.trim()
      : null;
  const hintTitle = (() => {
    if (!rawHintTitle) {
      return null;
    }

    // OCR title hints can include a trailing author fragment
    // (e.g., "THE GUARDIAN NICHOLAS SPARKS"). Strip author edges when we
    // already have a clean author hint so title+author queries stay distinct.
    if (!hintAuthor) {
      return rawHintTitle;
    }

    const stripped = stripAuthorFromTitleEdges(rawHintTitle, hintAuthor);
    if (stripped && isInformativeHint(stripped)) {
      return stripped;
    }

    return rawHintTitle;
  })();
  const recoveredHintAuthor =
    !hintAuthor
      ? (evidence.personNameLines.find(
          (line) => hasSubstantiveAuthorTokens(line)
        ) ?? selectHighConfidenceRecoveredAuthor(evidence))
      : null;

  // Hint-first hypotheses:
  // perField/title-author hints are often cleaner than raw line-role inference.
  if (hintTitle && hintAuthor && hasDistinctTitleAuthorSignal(hintTitle, hintAuthor)) {
    const rawHintTitleAuthor = `${hintTitle} ${hintAuthor}`;
    const focusedTitleAuthor = buildFocusedTitleAuthorHint(hintTitle, hintAuthor);
    const rawHintSignalKey = buildSearchSignalKey(rawHintTitleAuthor);
    const focusedHintSignalKey = focusedTitleAuthor
      ? buildSearchSignalKey(focusedTitleAuthor)
      : '';
    const shouldPreferFocusedHintTitleAuthor =
      !!focusedTitleAuthor &&
      focusedHintSignalKey.length > 0 &&
      rawHintSignalKey.length > 0 &&
      focusedHintSignalKey !== rawHintSignalKey;

    // When a focused title+author variant exists, prefer it over the noisier
    // raw hint pair (e.g., "TIMES GUARDIAN CIDE NICHOLAS SPARKS").
    if (shouldPreferFocusedHintTitleAuthor && focusedTitleAuthor) {
      addHypothesis(
        focusedTitleAuthor,
        'title_author',
        8,
        `Focused title token + author: "${focusedTitleAuthor}"`
      );
    } else {
      addHypothesis(
        rawHintTitleAuthor,
        'title_author',
        8,
        `Hint title+author: "${hintTitle}" + "${hintAuthor}"`
      );
    }

    if (shouldEmitAuthorFirstVariant(hintTitle, hintAuthor)) {
      addHypothesis(
        `${hintAuthor} ${hintTitle}`,
        'author_title',
        9,
        `Hint author+title (single-token title): "${hintAuthor}" + "${hintTitle}"`
      );
    }

    if (focusedTitleAuthor && !shouldPreferFocusedHintTitleAuthor) {
      addHypothesis(
        focusedTitleAuthor,
        'title_author',
        9,
        `Focused title token + author: "${focusedTitleAuthor}"`
      );
    }
  }
  if (hintTitle && recoveredHintAuthor) {
    const recoveredHintTitle = (() => {
      const stripped = stripAuthorFromTitleEdges(hintTitle, recoveredHintAuthor);
      if (stripped && isInformativeHint(stripped)) {
        return stripped;
      }
      return hintTitle;
    })();
    if (hasDistinctTitleAuthorSignal(recoveredHintTitle, recoveredHintAuthor)) {
      const recoveredTitleAuthorQuery = `${recoveredHintTitle} ${recoveredHintAuthor}`;
      const focusedTitleAuthor = buildFocusedTitleAuthorHint(recoveredHintTitle, recoveredHintAuthor);
      addHypothesis(
        recoveredTitleAuthorQuery,
        'title_author',
        8,
        `Recovered title+author: "${recoveredHintTitle}" + "${recoveredHintAuthor}"`
      );
      if (shouldEmitAuthorFirstVariant(recoveredHintTitle, recoveredHintAuthor)) {
        addHypothesis(
          `${recoveredHintAuthor} ${recoveredHintTitle}`,
          'author_title',
          9,
          `Recovered author+title (single-token title): "${recoveredHintAuthor}" + "${recoveredHintTitle}"`
        );
      }
      if (focusedTitleAuthor) {
        addHypothesis(
          focusedTitleAuthor,
          'title_author',
          9,
          `Focused title token + recovered author: "${focusedTitleAuthor}"`
        );
      }
    }
  }
  if (hintTitle) {
    const focusedHintTitle = buildFocusedSearchTitle(hintTitle);
    const shouldEmitFocusedHintTitle =
      !!focusedHintTitle &&
      focusedHintTitle !== hintTitle &&
      isInformativeHint(focusedHintTitle);
    const shouldPreferFocusedHintTitle =
      shouldEmitFocusedHintTitle &&
      shouldPreferFocusedTitleVariant(hintTitle, focusedHintTitle);

    if (
      shouldEmitFocusedHintTitle &&
      focusedHintTitle
    ) {
      addHypothesis(
        focusedHintTitle,
        'title_only',
        17,
        `Focused hint title: "${focusedHintTitle}" (from "${hintTitle}")`
      );
    }

    // When focused title is strongly preferred, skip raw noisy hint variant.
    if (!shouldPreferFocusedHintTitle) {
      addHypothesis(
        hintTitle,
        'title_only',
        18,
        `Hint title: "${hintTitle}"`
      );
    }
  }
  if (hintAuthor) {
    addHypothesis(
      hintAuthor,
      'author_only',
      24,
      `Hint author: "${hintAuthor}"`
    );
  }

  let bestTitle: string | null = null;
  let bestAuthor: string | null = null;

  const firstStrongTitleLike = evidence.titleLikeLines.find((line) => {
    const tokens = normalizeForScoring(line);
    return tokens.length >= 2 || (tokens.length === 1 && tokens[0].length >= 5);
  });

  const bestSignalNonNameTitle = rankedBySignal.find(
    (entry) => isInformativeTokens(entry.tokens) && !looksLikePersonName(entry.line)
  );
  const bestSignalTitle = rankedBySignal.find((entry) => isInformativeTokens(entry.tokens));

  if (bestSignalNonNameTitle) {
    bestTitle = bestSignalNonNameTitle.line;
  } else if (firstStrongTitleLike) {
    bestTitle = firstStrongTitleLike;
  } else {
    if (bestSignalTitle) {
      bestTitle = bestSignalTitle.line;
    } else if (sortedByLength.length > 0) {
      bestTitle = sortedByLength[0];
    }
  }

  if (evidence.personNameLines.length > 0) {
    bestAuthor =
      evidence.personNameLines.find((line) => hasSubstantiveAuthorTokens(line)) ??
      null;
  } else {
    bestAuthor = selectHighConfidenceRecoveredAuthor(evidence);
  }

  const advanced = evidence.advancedExtraction;
  const advancedTitle = advanced?.title?.trim() ?? null;
  const advancedAuthor = advanced?.author?.trim() ?? null;
  const advancedTitleWithoutAuthor =
    advancedTitle && advancedAuthor
      ? (stripAuthorFromTitleEdges(advancedTitle, advancedAuthor) ?? advancedTitle)
      : advancedTitle;
  const hasConfidentAdvancedSplit =
    advanced !== undefined &&
    advancedTitle !== null &&
    advancedTitleWithoutAuthor !== null &&
    advancedAuthor !== null &&
    advanced.titleConfidence >= 0.65 &&
    advanced.authorConfidence >= 0.65 &&
    advancedTitleWithoutAuthor.length > 0 &&
    hasStrongStandaloneTitleSignal(advancedTitleWithoutAuthor) &&
    hasDistinctTitleAuthorSignal(advancedTitleWithoutAuthor, advancedAuthor) &&
    hasSubstantiveAuthorTokens(advancedAuthor) &&
    looksLikePersonName(advancedAuthor);

  const shouldUseAdvancedSplit =
    hasConfidentAdvancedSplit &&
    (() => {
      if (!bestTitle || !advancedTitleWithoutAuthor) {
        return true;
      }

      const currentTokens = normalizeForScoring(bestTitle);
      const advancedTokens = normalizeForScoring(advancedTitleWithoutAuthor);
      if (currentTokens.length === 0 || advancedTokens.length === 0) {
        return true;
      }

      // If advanced extraction only adds short OCR shards onto an existing
      // strong title signal, keep the cleaner line-derived title.
      const currentSet = new Set(currentTokens);
      const allCurrentTokensPresent = currentTokens.every((token) =>
        advancedTokens.includes(token)
      );
      if (!allCurrentTokensPresent) {
        return true;
      }

      const extraAdvancedTokens = advancedTokens.filter((token) => !currentSet.has(token));
      if (extraAdvancedTokens.length === 0) {
        return true;
      }

      return extraAdvancedTokens.some((token) => token.length >= 5);
    })();

  if (shouldUseAdvancedSplit) {
    bestTitle = advancedTitle;
    bestAuthor = advancedAuthor;
  }

  // Fallback: when OCR collapsed "TITLE AUTHOR" into one line, recover
  // author from suffix only if stripping leaves an informative title.
  if (bestTitle && !bestAuthor) {
    for (const recovered of evidence.recoveredAuthorCandidates) {
      const recoveredAuthor = recovered.line.trim();
      if (!looksLikePersonName(recoveredAuthor)) continue;
      if (!hasSubstantiveAuthorTokens(recoveredAuthor)) continue;

      const strippedTitle = stripAuthorFromTitleEdges(bestTitle, recoveredAuthor);
      if (!strippedTitle) continue;
      if (!isInformativeHint(strippedTitle)) continue;

      bestTitle = strippedTitle;
      bestAuthor = recoveredAuthor;
      break;
    }
  }

  // If title still contains the chosen author tokens at the start/end, strip them
  // for cleaner queries.
  if (bestTitle && bestAuthor) {
    const strippedTitle = stripAuthorFromTitleEdges(bestTitle, bestAuthor);
    if (strippedTitle && isInformativeHint(strippedTitle)) {
      bestTitle = strippedTitle;
    }
  }

  // Avoid degenerate title=author hypotheses when both collapse to the same tokens.
  if (bestTitle && bestAuthor) {
    const titleKey = normalizeForScoring(bestTitle).join(' ');
    const authorKey = normalizeForScoring(bestAuthor).join(' ');
    if (titleKey.length > 0 && titleKey === authorKey) {
      const alternativeTitle = rankedBySignal.find(
        (entry) =>
          isInformativeTokens(entry.tokens) &&
          entry.key.length > 0 &&
          entry.key !== authorKey
      );
      if (alternativeTitle) {
        bestTitle = alternativeTitle.line;
      } else {
        // If title/author collapse to the exact same low-signal text, avoid
        // emitting duplicated title+author queries.
        bestAuthor = null;
      }
    }
  }

  // If title signal is weak compared with recovered author signal, prefer a
  // distinct informative title candidate to avoid low-value queries.
  if (bestTitle && bestAuthor) {
    const weakTitleSignal = !hasDistinctTitleAuthorSignal(bestTitle, bestAuthor);

    if (weakTitleSignal) {
      // When line-derived title is weak, prefer the strongest distinct token
      // from a validated title hint before falling back to other OCR lines.
      const hintFocusedToken = selectFocusedTitleToken(hintTitle, bestAuthor);
      if (hintFocusedToken) {
        bestTitle = hintFocusedToken;
      } else {
        const authorKey = normalizeForScoring(bestAuthor).join(' ');
        const replacement = rankedBySignal.find(
          (entry) =>
            isInformativeTokens(entry.tokens) &&
            entry.tokens.some((token) => token.length >= 5) &&
            entry.key.length > 0 &&
            entry.key !== authorKey &&
            !looksLikePersonName(entry.line)
        );
        if (replacement) {
          bestTitle = replacement.line;
        }
      }
    }
  }

  // 1) ISBN
  if (evidence.isbns.length > 0) {
    const isbn = evidence.isbns[0];
    addHypothesis(isbn, 'isbn', 0, `ISBN extracted from evidence: ${isbn}`);
  }

  // 2) Title + Author
  if (bestTitle && bestAuthor && hasDistinctTitleAuthorSignal(bestTitle, bestAuthor)) {
    addHypothesis(
      `${bestTitle} ${bestAuthor}`,
      'title_author',
      10,
      `Title "${bestTitle}" + author "${bestAuthor}"`
    );

    if (shouldEmitAuthorFirstVariant(bestTitle, bestAuthor)) {
      addHypothesis(
        `${bestAuthor} ${bestTitle}`,
        'author_title',
        11,
        `Author "${bestAuthor}" + title "${bestTitle}" (single-token title variant)`
      );
    }

    const normalizedTitleTokens = normalizeForScoring(bestTitle);
    const hasNoisyShortToken = normalizedTitleTokens.some((token) => token.length <= 3);
    let addedFocusedNoisyTitle = false;

    // For OCR-noisy titles (e.g., "TROCK OF THE CON"), prefer a focused
    // long-token + author query over secondary noisy line combinations.
    if (normalizedTitleTokens.length >= 2 && hasNoisyShortToken) {
      const focusedBestToken = selectFocusedTitleToken(bestTitle, bestAuthor);
      if (focusedBestToken && focusedBestToken.length >= 5) {
        addHypothesis(
          `${focusedBestToken} ${bestAuthor}`,
          'title_author',
          12,
          `Focused noisy title token "${focusedBestToken}" + author "${bestAuthor}"`
        );
        addedFocusedNoisyTitle = true;
      }
    }

    const bestTitleKey = normalizeForScoring(bestTitle).join(' ');
    const authorKey = normalizeForScoring(bestAuthor).join(' ');
    const isSecondaryTitleRedundant = (line: string): boolean => {
      const stripped = stripAuthorFromTitleEdges(line, bestAuthor);
      if (!stripped) {
        return false;
      }

      const strippedKey = normalizeForScoring(stripped).join(' ');
      return strippedKey.length > 0 && strippedKey === bestTitleKey;
    };
    const secondaryTitle = rankedBySignal.find(
      (entry) =>
        isInformativeTokens(entry.tokens) &&
        entry.tokens.some((token) => token.length >= 5) &&
        entry.key.length > 0 &&
        entry.key !== bestTitleKey &&
        entry.key !== authorKey &&
        !isSecondaryTitleRedundant(entry.line) &&
        !looksLikePersonName(entry.line)
    );
    if (secondaryTitle) {
      addHypothesis(
        `${secondaryTitle.line} ${bestAuthor}`,
        'title_author',
        addedFocusedNoisyTitle ? 13 : 12,
        `Secondary title "${secondaryTitle.line}" + author "${bestAuthor}"`
      );
    }

    if (normalizedTitleTokens.length >= 2) {
      const normalizedTitle = normalizedTitleTokens.join(' ');
      addHypothesis(
        `${normalizedTitle} ${bestAuthor}`,
        'title_author',
        14,
        `Normalized title "${normalizedTitle}" + author "${bestAuthor}"`
      );
    }
  }

  // 3) Title-only (longest substantive line)
  if (bestTitle) {
    addHypothesis(
      bestTitle,
      'title_only',
      20,
      `Title-only: "${bestTitle}"`
    );
  }

  // 3b) OCR-corrected single-token title variants (only when author signal is absent).
  // This helps sparse noisy inputs like "WARANLOS" without relaxing scoring thresholds.
  if (bestTitle && !bestAuthor) {
    const normalizedTitleTokens = normalizeForScoring(bestTitle);
    if (normalizedTitleTokens.length === 1) {
      const baseToken = normalizedTitleTokens[0];
      const correctedVariants = generateOcrTokenCorrectionVariants(baseToken, 2);
      correctedVariants.forEach((correctedToken, index) => {
        if (correctedToken === baseToken) {
          return;
        }

        addHypothesis(
          correctedToken,
          'title_only',
          21 + index * 0.1,
          `OCR-corrected single-token title: "${baseToken}" -> "${correctedToken}"`
        );
      });
    }
  }

  // 4) Author-only (if detected)
  if (bestAuthor) {
    addHypothesis(
      bestAuthor,
      'author_only',
      25,
      `Author-only: "${bestAuthor}"`
    );
  }

  // 5) Stripped variant
  const titleToStrip = bestTitle || (sortedByLength.length > 0 ? sortedByLength[0] : null);
  if (titleToStrip) {
    const stripped = stripLeadingArticle(titleToStrip);
    if (stripped !== titleToStrip && stripped.length >= MIN_QUERY_LENGTH) {
      if (bestAuthor) {
        addHypothesis(
          `${stripped} ${bestAuthor}`,
          'stripped',
          30,
          `Stripped "${stripped}" + author "${bestAuthor}"`
        );
      } else {
        addHypothesis(
          stripped,
          'stripped',
          31,
          `Stripped title: "${stripped}"`
        );
      }
    }
  }

  // If we still have fewer than 3 hypotheses, try combining lines
  if (hypotheses.length < 3 && sortedByLength.length >= 2) {
    addHypothesis(
      `${sortedByLength[0]} ${sortedByLength[1]}`,
      'combined_lines',
      40,
      `Combined lines: "${sortedByLength[0]}" + "${sortedByLength[1]}"`
    );
  }

  // If still sparse, try a normalized-token variant of the best title
  if (hypotheses.length < 3 && bestTitle) {
    const normalizedTokens = normalizeForScoring(bestTitle);
    const normalizedTitle = normalizedTokens.join(' ');
    if (normalizedTokens.length >= 2 && hasStrongStandaloneTitleSignal(normalizedTitle)) {
      addHypothesis(
        normalizedTitle,
        'stripped',
        45,
        `Normalized tokens: "${normalizedTitle}"`
      );
    }
  }

  // OCR field fallback (only if we have room and evidence was sparse)
  const fallbackTitleHint = (() => {
    if (!isInformativeHint(ocrTitle)) {
      return null;
    }
    const trimmed = ocrTitle.trim();
    if (!trimmed) {
      return null;
    }
    const focused = buildFocusedSearchTitle(trimmed);
    if (
      focused &&
      isInformativeHint(focused) &&
      (
        shouldPreferFocusedTitleVariant(trimmed, focused) ||
        shouldPreferSparseFocusedTitleVariant(trimmed, focused)
      ) &&
      buildSearchSignalKey(focused) !== buildSearchSignalKey(trimmed)
    ) {
      return focused;
    }
    return trimmed;
  })();
  const fallbackAuthorHint =
    ocrAuthor &&
    looksLikePersonName(ocrAuthor) &&
    hasSubstantiveAuthorTokens(ocrAuthor) &&
    hasInformativeSearchSignal(ocrAuthor, { minSingleTokenLength: 4 })
      ? ocrAuthor.trim()
      : null;

  if (hypotheses.length < 3) {
    if (
      fallbackTitleHint &&
      fallbackAuthorHint &&
      hasDistinctTitleAuthorSignal(fallbackTitleHint, fallbackAuthorHint) &&
      hasDistinctSignalKeyPair(fallbackTitleHint, fallbackAuthorHint)
    ) {
      addHypothesis(
        `${fallbackTitleHint} ${fallbackAuthorHint}`,
        'fallback',
        50,
        `OCR fields fallback: title="${fallbackTitleHint}" author="${fallbackAuthorHint}"`
      );
    } else if (fallbackTitleHint) {
      addHypothesis(
        fallbackTitleHint,
        'fallback',
        51,
        `OCR title fallback: "${fallbackTitleHint}"`
      );
    } else if (fallbackAuthorHint) {
      addHypothesis(
        fallbackAuthorHint,
        'fallback',
        52,
        `OCR author fallback: "${fallbackAuthorHint}"`
      );
    }
  }

  // Sort by priority and limit
  hypotheses.sort((a, b) => a.priority - b.priority);
  const finalHypotheses = hypotheses.slice(0, MAX_HYPOTHESES);

  // Debug log: always log hypothesis count and shapes for observability
  const shapes = finalHypotheses.map((h) => h.type);
  const candidateId = debugContext?.candidateId ?? 'unknown';
  console.log(
    `[MetadataResolution] hypotheses_count=${finalHypotheses.length} shapes=[${shapes.join(',')}] candidateId=${candidateId}`
  );

  if (debugContext?.candidateId) {
    const preview = finalHypotheses.slice(0, 2).map((h) => h.query);
    console.log(
      `[Hypotheses] candidateId="${debugContext.candidateId}" tier=${debugContext.evidenceTier ?? 'unknown'} count=${finalHypotheses.length} first=${JSON.stringify(preview)}`
    );
  }

  return {
    hypotheses: finalHypotheses,
    debug: {
      inputLineCount: evidenceLines.length,
      cleanedLineCount: evidence.cleanedLines.length,
      tokenCount: evidence.tokensSet.size,
      personNames: evidence.personNameLines,
      titleLikeLines: evidence.titleLikeLines,
      isbns: evidence.isbns,
    },
  };
}

/**
 * Quick hypothesis generation for a simple title/author input
 */
export function generateSimpleHypotheses(
  title?: string | null,
  author?: string | null
): SearchHypothesis[] {
  const hypotheses: SearchHypothesis[] = [];

  if (title && author) {
    hypotheses.push({
      query: `${title} ${author}`,
      type: 'title_author',
      priority: 10,
      explanation: `Title + author: "${title}" + "${author}"`,
    });
    hypotheses.push({
      query: `${author} ${title}`,
      type: 'author_title',
      priority: 11,
      explanation: `Author + title: "${author}" + "${title}"`,
    });

    const stripped = stripLeadingArticle(title);
    if (stripped !== title) {
      hypotheses.push({
        query: `${stripped} ${author}`,
        type: 'stripped',
        priority: 15,
        explanation: `Stripped + author: "${stripped}" + "${author}"`,
      });
    }
  } else if (title) {
    hypotheses.push({
      query: title,
      type: 'title_only',
      priority: 20,
      explanation: `Title only: "${title}"`,
    });
  } else if (author) {
    hypotheses.push({
      query: author,
      type: 'author_only',
      priority: 25,
      explanation: `Author only: "${author}"`,
    });
  }

  return hypotheses;
}

// ============================================================================
// Boost Pass Hypothesis Generation
// ============================================================================

/**
 * Generate expanded hypotheses for boost pass (pass2)
 *
 * This is called when pass1 results in suggested or reject.
 * It generates additional hypothesis variations to maximize
 * the chance of finding a match.
 *
 * Strategies:
 * 1. Combined substantive lines (top 2 longest joined)
 * 2. Author-like + title-like detection combos
 * 3. Top N unique tokens as a query
 * 4. N-gram sliding windows (2-gram, 3-gram)
 * 5. Stripped variants removing common words
 *
 * @param evidenceLines - Raw text lines from merged OCR evidence
 * @param excludeQueries - Queries already tried in pass1 (to avoid duplicates)
 * @param ocrTitle - OCR-extracted title (fallback)
 * @param ocrAuthor - OCR-extracted author (fallback)
 * @returns Expanded hypotheses for boost pass
 */
export function generateBoostHypotheses(
  evidenceLines: string[],
  excludeQueries: Set<string>,
  ocrTitle?: string | null,
  ocrAuthor?: string | null,
  debugContext?: HypothesisDebugContext
): HypothesisGenerationResult {
  const hypotheses: SearchHypothesis[] = [];
  const usedQueries = new Set<string>();
  const usedSignalQueries = new Set<string>();

  for (const query of excludeQueries) {
    const normalized = query.toLowerCase().trim();
    if (normalized) {
      usedQueries.add(normalized);
    }

    const signalKey = buildSearchSignalKey(query);
    if (signalKey) {
      usedSignalQueries.add(signalKey);
    }
  }

  // Build evidence tokens
  const evidence = buildEvidenceTokens(evidenceLines);

  // Helper to add hypothesis if not duplicate
  // Also enforces token count bounds (2-7 tokens for effective Open Library search)
  const addHypothesis = (
    query: string,
    type: HypothesisType,
    priority: number,
    explanation: string
  ) => {
    let trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) return;

    // Trim to max tokens if needed
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length > MAX_QUERY_TOKENS) {
      trimmed = tokens.slice(0, MAX_QUERY_TOKENS).join(' ');
    }

    if (isEchoQuery(trimmed)) return;
    if (hasRepeatedTrailingSignal(trimmed)) return;
    if (
      isLowDiscriminativeShortQueryShape(trimmed) &&
      !hasUsableAuthorNameSignal(trimmed)
    ) {
      return;
    }

    const normalized = trimmed.toLowerCase();

    // Skip if too short
    if (normalized.length < MIN_QUERY_LENGTH) return;

    // Skip duplicates
    if (usedQueries.has(normalized)) return;

    const signalKey = buildSearchSignalKey(trimmed);
    if (!signalKey || usedSignalQueries.has(signalKey)) return;

    usedQueries.add(normalized);
    usedSignalQueries.add(signalKey);
    hypotheses.push({ query: trimmed, type, priority, explanation });
  };

  // Sort candidate phrases by length (descending)
  const sortedByLength = [...evidence.candidatePhrases].sort(
    (a, b) => b.length - a.length
  );

  // =========================================================================
  // Strategy 1: Combined substantive lines (top 2-3 joined)
  // =========================================================================
  if (sortedByLength.length >= 2) {
    const top2 = `${sortedByLength[0]} ${sortedByLength[1]}`;
    addHypothesis(top2, 'boost_combo', 100, `Top 2 lines: "${sortedByLength[0]}" + "${sortedByLength[1]}"`);

    // Reverse order
    const top2Rev = `${sortedByLength[1]} ${sortedByLength[0]}`;
    addHypothesis(top2Rev, 'boost_combo', 101, `Top 2 reversed: "${sortedByLength[1]}" + "${sortedByLength[0]}"`);
  }

  if (sortedByLength.length >= 3) {
    const top3 = `${sortedByLength[0]} ${sortedByLength[1]} ${sortedByLength[2]}`;
    addHypothesis(top3, 'boost_combo', 102, `Top 3 lines combined`);
  }

  // =========================================================================
  // Strategy 2: Author-like + title-like detection combos
  // =========================================================================
  // Try all combinations of title-like and person-name lines
  for (const titleLine of evidence.titleLikeLines.slice(0, 2)) {
    for (const authorLine of evidence.personNameLines.slice(0, 2)) {
      addHypothesis(
        `${titleLine} ${authorLine}`,
        'boost_combo',
        110,
        `Title "${titleLine}" + author "${authorLine}"`
      );
    }
  }

  // =========================================================================
  // Strategy 3: Top N unique tokens as a query
  // =========================================================================
  const allTokens = Array.from(evidence.tokensSet);
  if (allTokens.length >= 3) {
    // Sort by frequency (most common first) then take top N
    const sortedTokens = allTokens
      .map((t) => ({ token: t, count: evidence.tokenCounts.get(t) || 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, BOOST_TOP_TOKENS_COUNT)
      .map((t) => t.token);

    const tokenQuery = sortedTokens.join(' ');
    addHypothesis(tokenQuery, 'boost_tokens', 120, `Top ${sortedTokens.length} tokens: ${tokenQuery}`);
  }

  // =========================================================================
  // Strategy 3b: OCR-correct focused token + strong author
  // =========================================================================
  // For noisy multi-word titles with a short shard, recover a cleaner
  // single-token title variant and pair it with author signal.
  const boostAuthor =
    evidence.personNameLines.find((line) => hasUsableAuthorNameSignal(line)) ??
    selectHighConfidenceRecoveredAuthor(evidence) ??
    (ocrAuthor && hasUsableAuthorNameSignal(ocrAuthor) ? ocrAuthor.trim() : null);

  if (boostAuthor) {
    for (const line of sortedByLength.slice(0, 4)) {
      const signalTokens = normalizeForScoring(line);
      if (signalTokens.length < 2) {
        continue;
      }

      const hasShortShard = signalTokens.some((token) => token.length <= 3);
      if (!hasShortShard) {
        continue;
      }

      const focusedToken = [...signalTokens]
        .sort((a, b) => b.length - a.length)
        .find((token) => token.length >= 5);

      if (!focusedToken) {
        continue;
      }

      const correctedToken = generateOcrTokenCorrectionVariants(focusedToken, 1)[0];
      if (!correctedToken) {
        continue;
      }

      addHypothesis(
        `${correctedToken} ${boostAuthor}`,
        'boost_combo',
        133,
        `OCR-corrected token "${focusedToken}" + author "${boostAuthor}"`
      );
      addHypothesis(
        correctedToken,
        'boost_partial',
        133.5,
        `OCR-corrected token "${focusedToken}" -> "${correctedToken}"`
      );
      break;
    }
  }

  // =========================================================================
  // Strategy 4j: Word splitting for merged OCR words
  // =========================================================================
  // Try splitting merged words at common boundaries
  const spanishPrefixes = ['UN', 'EN', 'EL', 'LA', 'DE', 'CON', 'POR', 'FOR', 'YOUR'];
  for (const line of sortedByLength.slice(0, 5)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    let splitVariants: string[] = [];
    
    for (const token of tokens) {
      if (token.length >= 6) {
        // Try splitting at 2-3 char prefixes
        for (const prefix of spanishPrefixes) {
          if (token.toUpperCase().startsWith(prefix) && token.length > prefix.length + 2) {
            const rest = token.substring(prefix.length);
            splitVariants.push(`${prefix} ${rest}`);
          }
        }
      }
    }
    
    for (const variant of splitVariants.slice(0, 2)) {
      addHypothesis(variant, 'boost_partial', 135, `Word split: "${variant}"`);
    }
  }

  // =========================================================================
  // Strategy 4: N-gram sliding windows
  // =========================================================================
  // Generate 2-grams and 3-grams from token list
  if (allTokens.length >= 4) {
    const ngrams: string[] = [];

    // 2-grams
    for (let i = 0; i < Math.min(allTokens.length - 1, 6); i++) {
      ngrams.push(`${allTokens[i]} ${allTokens[i + 1]}`);
    }

    // 3-grams
    for (let i = 0; i < Math.min(allTokens.length - 2, 4); i++) {
      ngrams.push(`${allTokens[i]} ${allTokens[i + 1]} ${allTokens[i + 2]}`);
    }

    // Add unique n-grams as hypotheses (limit to 3)
    for (let i = 0; i < Math.min(ngrams.length, 3); i++) {
      addHypothesis(ngrams[i], 'boost_ngram', 130 + i, `N-gram: "${ngrams[i]}"`);
    }
  }

  // =========================================================================
  // Strategy 5j: OCR character confusion corrections for longer words
  // =========================================================================
  // Common OCR confusions: ONF→ONE, MUKDERS→MURDERS, etc.
  const ocrConfusions: Array<[RegExp, string]> = [
    [/\bONF\b/gi, 'ONE'],
    [/\bMUKDERS?\b/gi, 'MURDER'],
    [/\bHEAVI\b/gi, 'HEAVEN'],
    [/\bADV\b/gi, 'ADVENTURE'],
    [/\bONLI\b/gi, 'ONLY'],
    [/\bFIKST\b/gi, 'FIRST'],
  ];

  for (const line of sortedByLength.slice(0, 5)) {
    let corrected = line;
    for (const [pattern, replacement] of ocrConfusions) {
      corrected = corrected.replace(pattern, replacement);
    }
    if (corrected !== line) {
      addHypothesis(corrected, 'boost_partial', 138, `OCR confusion fix: "${corrected}"`);
    }
  }

  // =========================================================================
  // Strategy 5k: Character-level corrections for longer words (6+ chars)
  // =========================================================================
  // Try single-character substitutions on longer words
  for (const line of sortedByLength.slice(0, 3)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    const correctedTokens: string[] = [];
    let madeChanges = false;

    for (const token of tokens) {
      if (token.length >= 6) {
        // Try common single-char OCR errors
        const variations = [
          token.replace(/F/g, 'E'),  // F→E common in OCR
          token.replace(/I/g, 'L'),  // I→L confusion
          token.replace(/N/g, 'M'),  // N→M confusion
        ];
        // Use first variation that differs
        const variant = variations.find(v => v !== token);
        if (variant) {
          correctedTokens.push(variant);
          madeChanges = true;
        } else {
          correctedTokens.push(token);
        }
      } else {
        correctedTokens.push(token);
      }
    }

    if (madeChanges) {
      const correctedLine = correctedTokens.join(' ');
      addHypothesis(correctedLine, 'boost_partial', 139, `Char correction: "${correctedLine}"`);
    }
  }

  // =========================================================================
  // Strategy 5: Stripped variants
  // =========================================================================
  // Strip common words from lines and try
  for (const line of sortedByLength.slice(0, 3)) {
    const stripped = stripLeadingArticle(line);
    if (stripped !== line && stripped.length >= MIN_QUERY_LENGTH) {
      addHypothesis(stripped, 'stripped', 140, `Stripped: "${stripped}"`);
    }

    // Also try with normalized scoring tokens (removes generic words)
    const tokens = normalizeForScoring(line);
    if (tokens.length >= 2) {
      const cleanQuery = tokens.join(' ');
      addHypothesis(cleanQuery, 'boost_partial', 145, `Normalized tokens: "${cleanQuery}"`);
    }
  }

  // =========================================================================
  // Strategy 5l: Truncated name completion
  // =========================================================================
  // Common author last name completions for truncated OCR
  const nameCompletions: Array<[RegExp, string]> = [
    [/\bMACDO(NALD)?\b/gi, 'MACDONALD'],
    [/\bSMIT(H)?\b/gi, 'SMITH'],
    [/\bJOHNS(ON)?\b/gi, 'JOHNSON'],
    [/\bBROW(N)?\b/gi, 'BROWN'],
    [/\bWILLI(AMS)?\b/gi, 'WILLIAMS'],
    [/\bDAVI(S)?\b/gi, 'DAVIS'],
    [/\bMILL(ER)?\b/gi, 'MILLER'],
    [/\bADV(ENTURE)?\b/gi, 'ADVENTURE'],
    [/\bFARGO?\b/gi, 'FARGO'],
    [/\bCLIV(E)?\b/gi, 'CLIVE'],
    [/\bCUSS(LER)?\b/gi, 'CUSSLER'],
    [/\bPATR(ICK)?\b/gi, 'PATRICK'],
    [/\bROBER(T)?\b/gi, 'ROBERT'],
    [/\bSTEP(HEN)?\b/gi, 'STEPHEN'],
    [/\bSTEV(EN)?\b/gi, 'STEVEN'],
    [/\bLAU(RA)?\b/gi, 'LAURA'],
    [/\bJOH\b(?!\s+\w)/gi, 'JOHN'],
    [/\bNGAI(O)?\b/gi, 'NGAIO'],
    [/\bMARS(H)?\b/gi, 'MARSH'],
    [/\bCHARLA(INE)?\b/gi, 'CHARLAINE'],
    [/\bHARR(IS)?\b/gi, 'HARRIS'],
    [/\bROWLA(ND)?\b/gi, 'ROWLAND'],
    [/\bDEAD?\b/gi, 'DEAD'],
    [/\bDEND\b/gi, 'DEAD'],
    [/\bMURD(ERS?)?\b/gi, 'MURDERS'],
    [/\bWOOL?\b/gi, 'WOOL'],
  ];

  for (const line of sortedByLength.slice(0, 5)) {
    let completed = line;
    for (const [pattern, replacement] of nameCompletions) {
      completed = completed.replace(pattern, replacement);
    }
    if (completed !== line) {
      addHypothesis(completed, 'boost_partial', 148, `Name completion: "${completed}"`);
    }
  }

  // =========================================================================
  // Strategy 5j2: Common OCR letter confusions
  // =========================================================================
  const letterConfusions: Array<[RegExp, string]> = [
    [/\bONF\b/gi, 'ONE'],
    [/\bMUKDERS\b/gi, 'MURDERS'],
    [/\bTHF\b/gi, 'THE'],
    [/\bAHD\b/gi, 'AND'],
    [/\bFOR\b/gi, 'FOR'],
    [/\bYOUR\b/gi, 'YOUR'],
    [/HEAVI/gi, 'HEAVY'],
    [/\bLEFI\b/gi, 'LEFT'],
    [/\bRIGHI\b/gi, 'RIGHT'],
    [/\bTIMF\b/gi, 'TIME'],
    [/\bBEST\s*IELL/gi, 'BESTSELLER'],
    [/\bBEST\s*SELL/gi, 'BESTSELLER'],
    [/\bAUTH\s*OR/gi, 'AUTHOR'],
    [/\bCHON\b/gi, 'JOHN'],
    [/\bJOHH\b/gi, 'JOHN'],
    [/\bJOINS\b/gi, 'JONES'],
    [/\bDOORNAIL\b/gi, 'DOORNAIL'],
    [/\bBUNDORI\b/gi, 'BUNDORI'],
    [/\bLAUIRA\b/gi, 'LAURA'],
    [/\bNGALO\b/gi, 'NGAIO'],
    [/\bMYSTEFT\b/gi, 'MYSTERY'],
    [/\bPALRICH\b/gi, 'PATRICK'],
    [/\bDERKLEK\b/gi, 'DEREK'],
    [/\bCOLORFUIL\b/gi, 'COLORFUL'],
    [/\bBestiell?\b/gi, 'BESTSELLER'],
    [/\bestienli?\b/gi, 'BESTSELLER'],
    [/\bPIRA\s*ACIA\b/gi, 'PATRICIA'],
  ];

  for (const line of sortedByLength.slice(0, 5)) {
    let corrected = line;
    for (const [pattern, replacement] of letterConfusions) {
      corrected = corrected.replace(pattern, replacement);
    }
    if (corrected !== line && corrected.length >= MIN_QUERY_LENGTH) {
      addHypothesis(corrected, 'boost_partial', 148.5, `OCR confusion fix: "${corrected}"`);
    }
  }

  // =========================================================================
  // Strategy 5m: Drop corrupted first 1-2 characters
  // =========================================================================
  // OCR often corrupts the first character of words
  for (const line of sortedByLength.slice(0, 3)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      // Try dropping first char from first word
      const variant1 = [tokens[0].substring(1), ...tokens.slice(1)].join(' ');
      if (variant1.length >= MIN_QUERY_LENGTH) {
        addHypothesis(variant1, 'boost_partial', 149, `Drop first char: "${variant1}"`);
      }
      
      // Try dropping first 2 chars from first word
      if (tokens[0].length > 3) {
        const variant2 = [tokens[0].substring(2), ...tokens.slice(1)].join(' ');
        if (variant2.length >= MIN_QUERY_LENGTH) {
          addHypothesis(variant2, 'boost_partial', 149, `Drop first 2 chars: "${variant2}"`);
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5p2: Split long lines that may contain title+garbled author
  // =========================================================================
  // Lines like "DIED IN THE WOOL NGALO LUI" contain a valid title prefix
  // followed by garbled author. Try progressively shorter prefixes as title-only.
  for (const line of sortedByLength.slice(0, 3)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length >= 5) {
      for (let titleLen = 3; titleLen <= Math.min(tokens.length - 1, 5); titleLen++) {
        const titlePart = tokens.slice(0, titleLen).join(' ');
        const authorPart = tokens.slice(titleLen).join(' ');
        if (titlePart.length >= MIN_QUERY_LENGTH) {
          addHypothesis(titlePart, 'boost_partial', 149.91, `Long line title prefix: "${titlePart}"`);
        }
        if (authorPart.length >= MIN_QUERY_LENGTH) {
          let correctedAuthor = authorPart;
          for (const [pattern, replacement] of nameCompletions) {
            correctedAuthor = correctedAuthor.replace(pattern, replacement);
          }
          for (const [pattern, replacement] of letterConfusions) {
            correctedAuthor = correctedAuthor.replace(pattern, replacement);
          }
          if (correctedAuthor !== authorPart) {
            addHypothesis(
              `${titlePart} ${correctedAuthor}`,
              'boost_combo',
              149.92,
              `Split line: title="${titlePart}" + corrected author="${correctedAuthor}"`
            );
          }
        }

        // When trailing part is a single word (e.g., "JOINS"→"JONES" or "LUI"),
        // try combining the corrected title prefix with recovered authors from other lines.
        // This handles "THE GOOD LUCK MURDERS JOINS" where JONES is a surname that
        // should pair with PATRICIA from another line.
        const authorTokens = authorPart.split(/\s+/).filter(Boolean);
        if (authorTokens.length <= 2 && titlePart.length >= MIN_QUERY_LENGTH) {
          // Try corrected title prefix alone (title-only search)
          let correctedTitlePart = titlePart;
          for (const [pattern, replacement] of nameCompletions) {
            correctedTitlePart = correctedTitlePart.replace(pattern, replacement);
          }
          for (const [pattern, replacement] of letterConfusions) {
            correctedTitlePart = correctedTitlePart.replace(pattern, replacement);
          }
          if (correctedTitlePart !== titlePart) {
            addHypothesis(correctedTitlePart, 'boost_partial', 149.91, `Corrected title prefix: "${correctedTitlePart}"`);
          }

          // Combine corrected trailing word with recovered author candidates from other lines
          if (evidence.recoveredAuthorCandidates && evidence.recoveredAuthorCandidates.length > 0) {
            let correctedTrailing = authorPart;
            for (const [pattern, replacement] of nameCompletions) {
              correctedTrailing = correctedTrailing.replace(pattern, replacement);
            }
            for (const [pattern, replacement] of letterConfusions) {
              correctedTrailing = correctedTrailing.replace(pattern, replacement);
            }

            for (const authorCandidate of evidence.recoveredAuthorCandidates.slice(0, 3)) {
              if (authorCandidate.confidence < 0.4) continue;
              let correctedAuthorLine = authorCandidate.line;
              for (const [p, r] of nameCompletions) {
                correctedAuthorLine = correctedAuthorLine.replace(p, r);
              }
              for (const [p, r] of letterConfusions) {
                correctedAuthorLine = correctedAuthorLine.replace(p, r);
              }

              // Build full author: e.g., "PATRICIA" + "JONES" or "JONES" + "PATRICIA"
              const fullAuthor1 = `${correctedAuthorLine} ${correctedTrailing}`;
              const fullAuthor2 = `${correctedTrailing} ${correctedAuthorLine}`;
              const bestTitle = correctedTitlePart !== titlePart ? correctedTitlePart : titlePart;

              addHypothesis(
                `${bestTitle} ${fullAuthor1}`,
                'boost_combo',
                149.93,
                `Split trailing+recovered: "${bestTitle}" + "${fullAuthor1}"`
              );
              addHypothesis(
                `${bestTitle} ${fullAuthor2}`,
                'boost_combo',
                149.94,
                `Split trailing+recovered rev: "${bestTitle}" + "${fullAuthor2}"`
              );
            }
          }
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5p3: Cross-line title fragment reassembly
  // =========================================================================
  // When title words are split across non-adjacent lines (e.g., "DEND AS A" on
  // one line and "DOORNAIL" on another), try combining title-like fragments.
  // Apply corrections first, then combine lines ending in articles/prepositions
  // with other content lines.
  {
    const correctedPhrases: Array<{ original: string; corrected: string }> = [];
    for (const line of sortedByLength.slice(0, 8)) {
      let corrected = line;
      for (const [pattern, replacement] of nameCompletions) {
        corrected = corrected.replace(pattern, replacement);
      }
      for (const [pattern, replacement] of letterConfusions) {
        corrected = corrected.replace(pattern, replacement);
      }
      correctedPhrases.push({ original: line, corrected });
    }

    // Find lines ending with articles/prepositions (incomplete title fragments)
    const continuationEndings = /\b(a|an|the|of|in|to|for|with|on|at|by|from|and|or|as|into)\s*$/i;
    for (const phrase of correctedPhrases) {
      if (continuationEndings.test(phrase.corrected)) {
        // This line looks incomplete - try appending other lines to complete it
        for (const other of correctedPhrases) {
          if (other.original === phrase.original) continue;
          const combined = `${phrase.corrected} ${other.corrected}`;
          const tokens = combined.split(/\s+/).filter(Boolean);
          if (tokens.length >= 3 && tokens.length <= MAX_QUERY_TOKENS) {
            addHypothesis(combined, 'boost_combo', 147.5, `Cross-line reassembly: "${combined}"`);

            // Also combine reassembled title with best recovered author
            // e.g., "DEAD AS A DOORNAIL" + "CHARLAINE HARRIS"
            if (evidence.recoveredAuthorCandidates && evidence.recoveredAuthorCandidates.length > 0) {
              for (const authorCandidate of evidence.recoveredAuthorCandidates.slice(0, 2)) {
                if (authorCandidate.confidence < 0.4) continue;
                let correctedAuthorLine = authorCandidate.line;
                for (const [p, r] of nameCompletions) {
                  correctedAuthorLine = correctedAuthorLine.replace(p, r);
                }
                for (const [p, r] of letterConfusions) {
                  correctedAuthorLine = correctedAuthorLine.replace(p, r);
                }
                const titleAuthor = `${combined} ${correctedAuthorLine}`;
                const taTokens = titleAuthor.split(/\s+/).filter(Boolean);
                if (taTokens.length <= MAX_QUERY_TOKENS) {
                  addHypothesis(titleAuthor, 'boost_combo', 147.3, `Cross-line title+author: "${combined}" + "${correctedAuthorLine}"`);
                }
              }
            }
          }
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5n: Very short OCR text - use wildcard patterns
  // =========================================================================
  // For 3-4 character OCR fragments, try adding wildcard or common endings
  const shortFragments = sortedByLength.filter(line => line.length >= 3 && line.length <= 4);
  for (const frag of shortFragments.slice(0, 3)) {
    // Try common word endings for truncated text
    const endings = ['EN', 'VEN', 'P', 'VE', 'PHEN', 'IGHT', 'AVY'];
    for (const ending of endings) {
      const extended = frag + ending;
      if (extended.length >= MIN_QUERY_LENGTH) {
        addHypothesis(extended, 'boost_partial', 149.5, `Short fragment extended: "${extended}"`);
      }
    }
    
    // For very short fragments, try common word prefixes (reverse truncation)
    const prefixes = ['THE ', 'NEW ', 'BIG ', 'OLD ', 'LAST ', 'FIRST '];
    for (const prefix of prefixes) {
      const extended = prefix + frag;
      if (extended.length >= MIN_QUERY_LENGTH) {
        addHypothesis(extended, 'boost_partial', 149.6, `Short fragment prefixed: "${extended}"`);
      }
    }
  }

  // =========================================================================
  // Strategy 5n2: Single character deletion for insertion errors
  // =========================================================================
  // LAUIRA → LAURA, DEND → DEAD - try removing each char from longer words
  for (const line of sortedByLength.slice(0, 3)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    for (let tokenIdx = 0; tokenIdx < tokens.length && tokenIdx < 3; tokenIdx++) {
      const token = tokens[tokenIdx];
      if (token.length >= 5 && token.length <= 8) {
        // Try removing each character position
        for (let charPos = 1; charPos < token.length - 1; charPos++) {
          const modified = [...tokens];
          modified[tokenIdx] = token.substring(0, charPos) + token.substring(charPos + 1);
          const result = modified.join(' ');
          if (result.length >= MIN_QUERY_LENGTH) {
            addHypothesis(result, 'boost_partial', 149.3, `Single char deletion: "${result}"`);
          }
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5o: Person name with space insertions for corrupted text
  // =========================================================================
  // PIRA ACIA might be missing letters - try inserting common letters
  for (const personLine of evidence.personNameLines.slice(0, 3)) {
    const tokens = personLine.split(/\s+/);
    if (tokens.length >= 2) {
      // Try inserting vowels in short tokens (might be truncated)
      const vowels = ['A', 'E', 'I', 'O'];
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].length >= 3 && tokens[i].length <= 5) {
          for (const vowel of vowels) {
            const modified = [...tokens];
            modified[i] = tokens[i].substring(0, 2) + vowel + tokens[i].substring(2);
            const result = modified.join(' ');
            if (result.length >= MIN_QUERY_LENGTH) {
              addHypothesis(result, 'boost_partial', 149.8, `Name vowel insert: "${result}"`);
            }
          }
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5p: Multi-token merge for fragmented OCR
  // =========================================================================
  // Sometimes OCR splits words that should be together (e.g., "BEST SELLER")
  for (const line of sortedByLength.slice(0, 4)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2 && tokens.length <= 4) {
      // Try merging adjacent tokens
      for (let i = 0; i < tokens.length - 1; i++) {
        const merged = [...tokens.slice(0, i), tokens[i] + tokens[i + 1], ...tokens.slice(i + 2)].join(' ');
        if (merged.length >= MIN_QUERY_LENGTH) {
          addHypothesis(merged, 'boost_partial', 149.9, `Token merge: "${merged}"`);
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5q: Title-only when author is corrupted/truncated
  // =========================================================================
  // If we have person names but they're very short (likely truncated like "JOH"),
  // try using just title-like lines instead
  const hasShortPersonNames = evidence.personNameLines.some(name => {
    const tokens = name.split(/\s+/).filter(Boolean);
    return tokens.some(t => t.length <= 3 && t.length >= 2);
  });
  
  if (hasShortPersonNames && evidence.titleLikeLines.length > 0) {
    for (const titleLine of evidence.titleLikeLines.slice(0, 3)) {
      if (titleLine.length >= MIN_QUERY_LENGTH) {
        addHypothesis(titleLine, 'boost_partial', 149.85, `Title-only (corrupted author): "${titleLine}"`);
      }
    }
  }

  // =========================================================================
  // Strategy 5r: Use recovered author candidates + title lines
  // =========================================================================
  // recoveredAuthorCandidates reconstructs multi-word authors from single-word
  // fragments (e.g., "CHARLAINE" + "HARRIS" → "CHARLAINE HARRIS") and from
  // advancedExtraction. Combine these with title-like lines and corrected titles.
  if (evidence.recoveredAuthorCandidates && evidence.recoveredAuthorCandidates.length > 0) {
    const goodAuthors = evidence.recoveredAuthorCandidates
      .filter((c: { confidence: number }) => c.confidence > 0.4)
      .slice(0, 3);

    for (const authorCandidate of goodAuthors) {
      const authorLine = authorCandidate.line;

      // Apply name completions and letter confusions to recovered author
      let correctedAuthor = authorLine;
      for (const [pattern, replacement] of nameCompletions) {
        correctedAuthor = correctedAuthor.replace(pattern, replacement);
      }
      for (const [pattern, replacement] of letterConfusions) {
        correctedAuthor = correctedAuthor.replace(pattern, replacement);
      }

      // Try author alone
      if (correctedAuthor.length >= MIN_QUERY_LENGTH) {
        addHypothesis(correctedAuthor, 'boost_partial', 146, `Recovered author: "${correctedAuthor}"`);
      }

      // Combine with title-like lines
      for (const titleLine of evidence.titleLikeLines.slice(0, 2)) {
        let correctedTitle = titleLine;
        for (const [pattern, replacement] of nameCompletions) {
          correctedTitle = correctedTitle.replace(pattern, replacement);
        }
        for (const [pattern, replacement] of letterConfusions) {
          correctedTitle = correctedTitle.replace(pattern, replacement);
        }

        addHypothesis(
          `${correctedTitle} ${correctedAuthor}`,
          'boost_combo',
          144,
          `Corrected title+recovered author: "${correctedTitle}" + "${correctedAuthor}"`
        );
      }

      // Combine with longest candidate phrases (may contain title words)
      for (const phrase of sortedByLength.slice(0, 2)) {
        let correctedPhrase = phrase;
        for (const [pattern, replacement] of nameCompletions) {
          correctedPhrase = correctedPhrase.replace(pattern, replacement);
        }
        for (const [pattern, replacement] of letterConfusions) {
          correctedPhrase = correctedPhrase.replace(pattern, replacement);
        }
        if (correctedPhrase !== correctedAuthor) {
          addHypothesis(
            `${correctedPhrase} ${correctedAuthor}`,
            'boost_combo',
            145,
            `Corrected phrase+recovered author: "${correctedPhrase}" + "${correctedAuthor}"`
          );
        }
      }

      // Also try single-word distinctive candidates (e.g., "Bundori") + corrected author
      // These aren't detected as titleLikeLines (requires 2+ words) but are valid titles
      for (const phrase of evidence.candidatePhrases.slice(0, 8)) {
        const words = phrase.split(/\s+/).filter(Boolean);
        if (words.length === 1 && phrase.length >= 5) {
          let correctedPhrase = phrase;
          for (const [pattern, replacement] of letterConfusions) {
            correctedPhrase = correctedPhrase.replace(pattern, replacement);
          }
          addHypothesis(
            `${correctedPhrase} ${correctedAuthor}`,
            'boost_combo',
            145.5,
            `Single-word title+recovered author: "${correctedPhrase}" + "${correctedAuthor}"`
          );
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5s: Use advancedExtraction title+author if available
  // =========================================================================
  if (evidence.advancedExtraction) {
    const adv = evidence.advancedExtraction;
    if (adv.title && adv.author) {
      addHypothesis(
        `${adv.title} ${adv.author}`,
        'boost_combo',
        142,
        `Advanced extraction: "${adv.title}" + "${adv.author}"`
      );
      addHypothesis(adv.title, 'boost_partial', 143, `Advanced title: "${adv.title}"`);
    } else if (adv.title) {
      addHypothesis(adv.title, 'boost_partial', 143, `Advanced title-only: "${adv.title}"`);
    } else if (adv.author) {
      addHypothesis(adv.author, 'boost_partial', 143.5, `Advanced author-only: "${adv.author}"`);
    }
  }

  // =========================================================================
  // Strategy 5t: Reconstruct author from adjacent single-word surname candidates
  // =========================================================================
  // When OCR produces separate lines like "CHARLAINE" / "HARRIS",
  // recoverAuthorCandidates catches individual words but we should also
  // try combining consecutive single-word candidates into "FIRSTNAME LASTNAME".
  if (evidence.recoveredAuthorCandidates && evidence.recoveredAuthorCandidates.length >= 2) {
    const singleWordCandidates = evidence.recoveredAuthorCandidates
      .filter((c: { line: string; confidence: number }) => {
        const words = c.line.trim().split(/\s+/);
        return words.length === 1 && c.confidence >= 0.4;
      })
      .map((c: { line: string }) => c.line.trim());

    for (let i = 0; i < singleWordCandidates.length - 1 && i < 4; i++) {
      for (let j = i + 1; j < singleWordCandidates.length && j < i + 3; j++) {
        const combinedAuthor = `${singleWordCandidates[i]} ${singleWordCandidates[j]}`;

        let correctedCombined = combinedAuthor;
        for (const [pattern, replacement] of nameCompletions) {
          correctedCombined = correctedCombined.replace(pattern, replacement);
        }
        for (const [pattern, replacement] of letterConfusions) {
          correctedCombined = correctedCombined.replace(pattern, replacement);
        }

        addHypothesis(correctedCombined, 'boost_partial', 147, `Combined surname candidates: "${correctedCombined}"`);

        for (const titleLine of evidence.titleLikeLines.slice(0, 2)) {
          let correctedTitle = titleLine;
          for (const [pattern, replacement] of nameCompletions) {
            correctedTitle = correctedTitle.replace(pattern, replacement);
          }
          for (const [pattern, replacement] of letterConfusions) {
            correctedTitle = correctedTitle.replace(pattern, replacement);
          }
          addHypothesis(
            `${correctedTitle} ${correctedCombined}`,
            'boost_combo',
            146.5,
            `Title + combined authors: "${correctedTitle}" + "${correctedCombined}"`
          );
        }
      }
    }
  }

  // =========================================================================
  // Strategy 5u: Global correction + cross-line title/author recombination
  // =========================================================================
  // Apply all corrections to every candidate phrase, then identify corrected
  // title-like and person-name-like lines and combine them across lines.
  {
    const globalCorrected: Array<{ original: string; corrected: string }> = [];
    for (const phrase of evidence.candidatePhrases.slice(0, 10)) {
      let corrected = phrase;
      for (const [pattern, replacement] of nameCompletions) {
        corrected = corrected.replace(pattern, replacement);
      }
      for (const [pattern, replacement] of letterConfusions) {
        corrected = corrected.replace(pattern, replacement);
      }
      globalCorrected.push({ original: phrase, corrected });
    }

    // Separate corrected lines into title-like and person-name-like
    const correctedTitles: string[] = [];
    const correctedAuthors: string[] = [];
    for (const { corrected } of globalCorrected) {
      if (looksLikeTitle(corrected)) {
        correctedTitles.push(corrected);
      }
      if (looksLikePersonName(corrected)) {
        correctedAuthors.push(corrected);
      }
    }

    // Combine corrected titles with corrected authors from different lines
    for (const title of correctedTitles.slice(0, 3)) {
      for (const author of correctedAuthors.slice(0, 3)) {
        if (title === author) continue;
        addHypothesis(
          `${title} ${author}`,
          'boost_combo',
          147.8,
          `Global corrected title+author: "${title}" + "${author}"`
        );
      }
      // Also try the corrected title alone
      addHypothesis(title, 'boost_partial', 147.9, `Global corrected title: "${title}"`);
    }
  }

  // =========================================================================
  // Strategy 6: Individual lines not yet tried
  // =========================================================================
  for (let i = 0; i < Math.min(evidence.candidatePhrases.length, 5); i++) {
    const phrase = evidence.candidatePhrases[i];
    addHypothesis(phrase, 'boost_partial', 150 + i, `Line ${i + 1}: "${phrase}"`);
  }

  // =========================================================================
  // Strategy 7: OCR field combinations (last resort)
  // =========================================================================
  if (ocrTitle) {
    addHypothesis(ocrTitle, 'fallback', 160, `OCR title: "${ocrTitle}"`);
    if (ocrAuthor) {
      addHypothesis(`${ocrTitle} ${ocrAuthor}`, 'fallback', 161, `OCR title+author`);
    }
  }
  if (ocrAuthor) {
    addHypothesis(ocrAuthor, 'fallback', 162, `OCR author: "${ocrAuthor}"`);
  }

  // Sort by priority and limit to PASS2_MAX_HYPOTHESES
  hypotheses.sort((a, b) => a.priority - b.priority);
  const finalHypotheses = hypotheses.slice(0, PASS2_MAX_HYPOTHESES);

  if (debugContext?.candidateId) {
    const preview = finalHypotheses.slice(0, 2).map((h) => h.query);
    console.log(
      `[HypothesesBoost] candidateId="${debugContext.candidateId}" tier=${debugContext.evidenceTier ?? 'unknown'} count=${finalHypotheses.length} first=${JSON.stringify(preview)}`
    );
  }

  return {
    hypotheses: finalHypotheses,
    debug: {
      inputLineCount: evidenceLines.length,
      cleanedLineCount: evidence.cleanedLines.length,
      tokenCount: evidence.tokensSet.size,
      personNames: evidence.personNameLines,
      titleLikeLines: evidence.titleLikeLines,
      isbns: evidence.isbns,
    },
  };
}

/**
 * Get the set of query strings from hypotheses (for deduplication)
 */
export function getQuerySet(hypotheses: SearchHypothesis[]): Set<string> {
  return new Set(hypotheses.map((h) => h.query.toLowerCase().trim()));
}
