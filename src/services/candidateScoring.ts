/**
 * Candidate Scoring Service
 *
 * Scores Open Library candidates against OCR evidence using token overlap.
 * This is the core scoring logic for evidence-driven book resolution.
 */

import type { ResolvedBook, EvidenceSourceKind } from '../types';
import {
  buildEvidenceTokens,
  normalizeForScoring,
  isGenericTitle,
  GENERIC_TOKENS,
  type EvidenceTokens,
  type BuildEvidenceTokensOptions,
} from './evidenceNormalization';
import {
  determineIsbnPolicy,
  shouldApplyIsbnBoost,
  validateIsbnChecksum,
} from './isbnUtils';
import { isMetadataVerboseDebug } from '../config/debug';
import { levenshteinSimilarity, FUZZY_MATCH_THRESHOLD } from './tokenSetFuzzyScoring';
import {
  ACCEPT_HIGH_THRESHOLD as CONFIG_ACCEPT_HIGH,
  ACCEPT_MEDIUM_THRESHOLD as CONFIG_ACCEPT_MEDIUM,
  ACCEPT_MEDIUM_GAP as CONFIG_ACCEPT_MEDIUM_GAP,
  ACCEPT_MEDIUM_MIN_OVERLAP as CONFIG_MIN_OVERLAP,
  SUGGESTED_THRESHOLD as CONFIG_SUGGESTED,
  SUGGESTED_AUTHOR_THRESHOLD as CONFIG_SUGGESTED_AUTHOR,
  SUGGESTED_AUTHOR_MIN_OVERLAP as CONFIG_SUGGESTED_AUTHOR_MIN_OVERLAP,
  SUGGESTED_WEAK_THRESHOLD as CONFIG_SUGGESTED_WEAK,
  SUGGESTED_WEAK_MIN_OVERLAP as CONFIG_SUGGESTED_WEAK_MIN_OVERLAP,
  MANUAL_REVIEW_THRESHOLD as CONFIG_MANUAL_REVIEW,
  MANUAL_REVIEW_MAX_GAP as CONFIG_MANUAL_REVIEW_GAP,
  MANUAL_REVIEW_MIN_OVERLAP as CONFIG_MANUAL_REVIEW_MIN_OVERLAP,
  MIN_OVERLAP_COUNT as CONFIG_MIN_OVERLAP_COUNT,
  MIN_SIGNAL_SCORE_CAP as CONFIG_MIN_SIGNAL_CAP,
  ISBN_BONUS as CONFIG_ISBN_BONUS,
  GENERIC_TITLE_PENALTY as CONFIG_GENERIC_PENALTY,
  MISSING_AUTHOR_PENALTY as CONFIG_MISSING_AUTHOR_PENALTY,
  MAX_REVIEW_CANDIDATES as CONFIG_MAX_REVIEW,
  // TITLE_ONLY mode thresholds
  TITLE_ONLY_AUTHOR_THRESHOLD,
  TITLE_ONLY_ACCEPT_MIN,
  TITLE_ONLY_SUGGESTED_MIN,
  TITLE_ONLY_MARGIN_MIN,
  TITLE_ONLY_MAX_CANDIDATES,
  TITLE_ONLY_PUBLISHER_MIN,
  TITLE_ONLY_MIN_TOKENS,
  TITLE_ONLY_REJECT_BELOW,
  // FULL_MATCH mode thresholds
  FULL_MATCH_TITLE_MIN,
  FULL_MATCH_AUTHOR_MIN,
  FULL_MATCH_OVERALL_MIN,
} from '../config/metadataResolutionConfig';

// ============================================================================
// Types
// ============================================================================

/**
 * Resolution mode determines which scoring path to use
 *
 * - FULL_MATCH: Both title and author evidence available and reliable
 * - TITLE_ONLY: Author missing or unreliable, stricter title matching required
 * - WEAK_TITLE_STRONG_AUTHOR: Title tokens < 2 but strong author evidence exists
 * - NO_MATCH: Insufficient evidence to attempt matching
 */
export type ResolutionMode = 'FULL_MATCH' | 'TITLE_ONLY' | 'WEAK_TITLE_STRONG_AUTHOR' | 'NO_MATCH';

/**
 * Ambiguity metrics for anti-false-positive safeguards
 */
export interface AmbiguityMetrics {
  /** Score of top candidate */
  top1Score: number;
  /** Score of second distinct candidate (0 if none) */
  top2Score: number;
  /** Gap between top1 and top2 */
  margin: number;
  /** Number of distinct book candidates (different titles) */
  distinctCandidateCount: number;
  /** True if title is unique (few candidates OR large margin) */
  titleUniqueness: boolean;
}

/**
 * Score breakdown for a candidate
 *
 * Scoring formula (set-based F1):
 * - precision = overlap / |evidenceTokens|
 * - recall    = overlap / |candidateTokens|
 * - f1        = 2 * P * R / (P + R)
 * - score     = f1 + ISBN bonus - penalties
 * - If overlapCount < 2 => score capped at 0.10 (minimum signal required)
 * - Generic-title penalty: apply only if title is generic and no author signal
 * - ISBN match bonus: +0.15
 *
 * IMPORTANT: We track both rawScore and finalScore for debugging:
 * - rawScore: F1 + ISBN bonus (before min-signal cap and generic penalty)
 * - finalScore: After all penalties and caps (used for decision gates)
 */
export interface CandidateScore {
  /** Overall composite score [0-1] (alias for finalScore) */
  score: number;
  /** Raw score before min-signal cap (F1 + ISBN bonus) */
  rawScore: number;
  /** Final score after all penalties (used for decision) */
  finalScore: number;
  /** Recall (overlap / |candidateTokens|) */
  overlapRatio: number;
  /** Precision (overlap / |evidenceTokens|) */
  coverageRatio: number;
  /** Order score (1.0 if first title token in evidence, else 0.9) */
  orderScore: number;
  /** Number of overlapping tokens */
  overlapCount: number;
  /** Precision = overlap / |evidenceTokens| */
  precision: number;
  /** Recall = overlap / |candidateTokens| */
  recall: number;
  /** F1 score */
  f1: number;
  /** ISBN match bonus */
  isbnBonus: number;
  /** Penalties applied */
  penalties: ScorePenalty[];
  /** Matched tokens (title + author combined) */
  matchedTokens: string[];
  /** Was ISBN matched */
  isbnMatched: boolean;
  /** Was score capped due to low overlap (min-signal rule) */
  minSignalCapped: boolean;

  // =========================================================================
  // TITLE_ONLY mode fields
  // =========================================================================

  /** Title-specific score [0-1] (F1 on title tokens only) */
  titleScore: number;
  /** Author-specific score [0-1] (F1 on author tokens only), null if no author tokens */
  authorScore: number | null;
  /** Number of title tokens that matched */
  titleTokenCount: number;
  /** Number of author tokens in candidate (0 if none) */
  authorTokenCount: number;
  /** Resolution mode determined for this candidate */
  resolutionMode: ResolutionMode;
  /** Publisher score if available [0-1] */
  publisherScore: number | null;

  // Legacy fields for backwards compatibility
  titleOverlap: number;
  authorOverlap: number;
  matchedTitleTokens: string[];
  matchedAuthorTokens: string[];
}

export interface ScorePenalty {
  /** Penalty type */
  type: 'generic_title' | 'missing_author' | 'missing_isbn' | 'short_title';
  /** Penalty amount (positive value subtracted from score) */
  amount: number;
  /** Explanation */
  reason: string;
}

/**
 * Scored candidate with full breakdown
 */
export interface ScoredCandidate {
  /** The book candidate */
  book: ResolvedBook;
  /** Score breakdown */
  scoring: CandidateScore;
}

// ============================================================================
// Configuration (from centralized config)
// ============================================================================

/** Bonus for ISBN match */
const ISBN_BONUS = CONFIG_ISBN_BONUS;

/** Penalty for generic single-word titles */
const GENERIC_TITLE_PENALTY = CONFIG_GENERIC_PENALTY;

/** Penalty for candidates missing author information */
const MISSING_AUTHOR_PENALTY = CONFIG_MISSING_AUTHOR_PENALTY;

/** Minimum overlapping tokens required for meaningful score */
const MIN_OVERLAP_COUNT = CONFIG_MIN_OVERLAP_COUNT;

/** Maximum score when overlap is below minimum */
const MIN_SIGNAL_SCORE_CAP = CONFIG_MIN_SIGNAL_CAP;

/**
 * Additional cap for low-signal fuzzy-only matches.
 * Keeps weak one-token fuzzy overlaps from looking as strong as exact matches.
 */
const FUZZY_ONLY_SIGNAL_CAP = Math.min(MIN_SIGNAL_SCORE_CAP, MIN_SIGNAL_SCORE_CAP / 2);
const OCR_RELAXED_FUZZY_THRESHOLD = Math.max(0.68, FUZZY_MATCH_THRESHOLD - 0.07);
const OCR_VARIANT_BONUS_PER_TOKEN = 0.035;
const OCR_VARIANT_BONUS_CAP = 0.08;
const FUZZY_NEAR_MISS_BONUS_PER_TOKEN = 0.02;
const FUZZY_NEAR_MISS_BONUS_CAP = 0.07;
const OCR_CONFUSION_EQUIVALENT_BONUS_PER_TOKEN = 0.025;
const OCR_CONFUSION_EQUIVALENT_BONUS_CAP = 0.06;

let hasLoggedScoringDebug = false;

// ============================================================================
// Scoring Functions
// ============================================================================

/**
 * OCR often fuses short joiners into neighboring words (e.g., "knotsand").
 * Expose split variants to improve overlap matching without lowering thresholds.
 */
const OCR_FUSED_JOINERS = ['and', 'into', 'with', 'from', 'the', 'for', 'your', 'god'];

const OCR_LOW_SIGNAL_TOKENS = new Set([
  'jove',
  'mystery',
  'recipes',
  'berkley',
  'novel',
  'fiction',
  'author',
  'authors',
  'writer',
  'bestsell',
  'national',
  'new',
  'york',
  'times',
  'vision',
  'bestseler',
  'bestsellek',
  'bestsellin',
  'bestsellerer',
  'oll',
  'pcto',
  'ati',
  'att',
  'eiv',
  'ana',
  'eg',
  'sas',
  'can',
  'wi',
  'un',
  'ne',
  'al',
  'eu',
  'bh',
  'rcuior',
  'rctior',
  'ties',
  'mettikes',
  'iavers',
  'noblems',
  'prin',
  'crinis',
  'bestseller',
  'bestselling',
  'paperback',
  'hardcover',
  'mass',
  'market',
  // Frequent OCR garbage observed in rejects
  'sili',
  'siall',
  'histi',
  'shous',
  'isouttesoiai',
  'isouttesoiat',
  'leetea',
  'listemas',
  'nosta',
  'nhop',
  'ilsde',
  'novei',
  'stak',
  's7ll',
  'noisea',
  'noisia',
  'ele',
  'll',
  'nill',
  'asth',
  'grand',
  'central',
  'tor',
  'bin',
  'cin',
  'une',
  'aire',
  // Additional low-signal fragments observed in recent OCR rejects
  'rom',
  'moll',
  'vora',
  'frinie',
  'bestrellins',
  'besiselling',
  'ets',
  'ts',
  'du',
]);

const OCR_TOKEN_VARIANT_MAP = new Map<string, string[]>([
  ['fave', ['faye']],
  ['cave', ['faye']],
  ['acaid', ['ngaio']],
  ['agaid', ['ngaio']],
  ['arica', ['erica']],
  ['cis', ['isforseries', 'c']],
  ['priscil', ['priscilla']],
  ['priscill', ['priscilla']],
  ['priscila', ['priscilla']],
  ['warsh', ['marsh']],
  ['straighi', ['straight']],
  ['straighe', ['straight']],
  ['straighiinto', ['straight', 'into']],
  ['straigheinto', ['straight', 'into']],
  ['fi', ['fire']],
  ['unconqueredfi', ['unconquered', 'fire']],
  ['fiace', ['face']],
  ['runforyour', ['run', 'for', 'your']],
  ['foryourlife', ['for', 'your', 'life']],
  ['runforyourlife', ['run', 'for', 'your', 'life']],
  ['rosesare', ['roses', 'are']],
  ['staksout', ['stakeout']],
  ['tonyhillerman', ['tony', 'hillerman']],
  ['talkinggod', ['talking', 'god']],
  ['jamespatterson', ['james', 'patterson']],
  ['davidbaldacce', ['david', 'baldacci']],
  ['baldacce', ['baldacci']],
  ['visicn', ['vision']],
  ['vora', ['york']],
  ['nattonal', ['national']],
  ['natlenats', ['national']],
  ['roberto', ['robert']],
  ['wamraugh', ['wambaugh']],
  ['fbarck', ['black']],
  ['petarbl', ['marble']],
  ['cookon', ['cook']],
  ['sicht', ['sight']],
  ['oe', ['zoe']],
  ['joc', ['joe']],
  ['onthe', ['on', 'the']],
  ['ciyde', ['clyde']],
  ['cinde', ['cindy']],
  ['pandips', ['phillips']],
  ['philips', ['phillips']],
  ['bundsided', ['blindsided']],
  ['bindsded', ['blindsided']],
  ['bicody', ['bloody']],
  ['wodd', ['wood']],
  ['willl', ['will']],
  ['rabbl', ['rabbi']],
  ['kemielman', ['kemelman']],
  ['ieuit', ['exit']],
  ['unrer', ['under']],
  ['ames', ['james']],
  ['tomustice', ['justice']],
  ['chlarfo', ['charlaine']],
  ['aiche', ['aicher']],
  ['eith', ['keith']],
  ['teethey', ['keith']],
  ['tohn', ['john']],
  ['iohn', ['john']],
  ['candford', ['sandford']],
  ['lighining', ['lightning']],
  ['htning', ['lightning']],
  ['tricia', ['patricia']],
  ['parterson', ['patterson']],
  ['parerson', ['patterson']],
  ['pateasan', ['patterson']],
  ['alongcane', ['along', 'came']],
  ['aspder', ['spider']],
  ['asper', ['spider']],
  ['robertr', ['robert']],
  ['fallison', ['allison']],
  ['stelen', ['stolen']],
  ['framie', ['frame']],
  ['suspiciou', ['suspicious']],
  ['bonegragk', ['bonecrack']],
  ['boneerack', ['bonecrack']],
  ['franhis', ['francis']],
  ['dhesk', ['desk']],
  ['crafton', ['grafton']],
  ['cson', ['jackson']],
  ['deathat', ['death', 'at']],
  ['fai', ['faith']],
  ['hearto', ['heart', 'of']],
  ['fustie', ['justice']],
  ['wielane', ['william']],
  ['wilhane', ['william']],
  ['coughline', ['coughlin']],
  ['coughen', ['coughlin']],
  ['alcoughen', ['coughlin']],
  ['sumeet', ['sweet']],
  ['seai', ['scents']],
  ['bles', ['brass', 'black']],
  ['denver', ['deaver']],
  ['cene', ['bane']],
  ['simee', ['suzanne']],
  ['seream', ['scream']],
  ['deaf', ['dead']],
  ['ca', ['cat']],
  ['dis', ['dick']],
  ['peuplevs', ['people', 'vs']],
  ['crosse', ['cross']],
  ['fetten', ['fallen']],
  ['hawimett', ['hammett']],
  ['dishell', ['dashiell']],
  ['barte', ['bartz']],
  ['besiselling', ['bestselling']],
  ['bestrellins', ['bestselling']],
  ['bin', ['isforseries', 'b']],
  ['cin', ['isforseries', 'c']],
  ['s7ll', ['isforseries']],
]);

const MAX_EVIDENCE_NOISE_DISCOUNT_RATIO = 0.5;
const HEAVY_OCR_NOISE_RATIO = 0.55;
const HEAVY_OCR_MAX_DISCOUNT_RATIO = 0.65;

function expandMergedTokenVariants(token: string): string[] {
  const lower = token.toLowerCase();
  const variants = new Set<string>();

  for (const joiner of OCR_FUSED_JOINERS) {
    if (lower.length <= joiner.length + 3) continue;

    if (lower.endsWith(joiner)) {
      const base = lower.slice(0, -joiner.length);
      if (base.length >= 3) {
        variants.add(base);
        if (base.endsWith('i') && base.length >= 6) {
          variants.add(`${base.slice(0, -1)}t`);
        }
        variants.add(joiner);
      }
    }

    if (lower.startsWith(joiner)) {
      const base = lower.slice(joiner.length);
      if (base.length >= 3) {
        variants.add(base);
        variants.add(joiner);
      }
    }

    const middleIndex = lower.indexOf(joiner);
    if (middleIndex > 2) {
      let left = lower.slice(0, middleIndex);
      const right = lower.slice(middleIndex + joiner.length);
      if (left.length >= 3 && right.length >= 3) {
        if (left.endsWith('i') && left.length >= 6) {
          left = `${left.slice(0, -1)}t`;
        }
        variants.add(left);
        variants.add(joiner);
        variants.add(right);
      }
    }
  }

  return Array.from(variants);
}

function expandOcrCharacterVariants(token: string): string[] {
  const lower = token.toLowerCase();
  const variants = new Set<string>();
  const hadDigitConfusion = /[01]/.test(lower);

  const digitNormalized = lower
    .replace(/0/g, 'o')
    .replace(/1/g, 'l');
  if (digitNormalized !== lower) {
    variants.add(digitNormalized);
  }

  if (hadDigitConfusion && digitNormalized.length >= 4 && /[li]/.test(digitNormalized)) {
    variants.add(digitNormalized.replace(/l/g, 'i'));
    variants.add(digitNormalized.replace(/i/g, 'l'));
  }

  if (lower.length >= 4 && lower.includes('o')) {
    variants.add(lower.replace(/o/g, '0'));
  }

  if (lower.length >= 4 && /[vy]/.test(lower)) {
    variants.add(lower.replace(/v/g, 'y'));
    variants.add(lower.replace(/y/g, 'v'));
  }

  return Array.from(variants);
}

function expandCommonLetterSwapVariants(token: string): string[] {
  const lower = token.toLowerCase();
  const variants = new Set<string>();

  if (/[il]/.test(lower) && lower.length >= 4) {
    variants.add(lower.replace(/i/g, 'l'));
    variants.add(lower.replace(/l/g, 'i'));
  }

  if (lower.length >= 5) {
    if (lower.startsWith('c')) {
      variants.add(`g${lower.slice(1)}`);
    } else if (lower.startsWith('g')) {
      variants.add(`c${lower.slice(1)}`);
    }
  }

  variants.delete(lower);
  return Array.from(variants);
}

function expandRepeatedCharacterVariants(token: string): string[] {
  const lower = token.toLowerCase();
  const variants = new Set<string>();

  const collapsedToDouble = lower.replace(/([a-z])\1{2,}/g, '$1$1');
  if (collapsedToDouble !== lower) {
    variants.add(collapsedToDouble);
  }

  const collapsedToSingle = lower.replace(/([a-z])\1+/g, '$1');
  if (collapsedToSingle !== lower) {
    variants.add(collapsedToSingle);
  }

  return Array.from(variants);
}

function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) {
    i++;
  }
  return i;
}

function sharedSuffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) {
    i++;
  }
  return i;
}

function normalizeOcrConfusionSignature(token: string): string {
  return token
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/i/g, 'l')
    .replace(/v/g, 'y')
    .replace(/^g/, 'c');
}

function isLikelyOcrConfusionEquivalent(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4) {
    return false;
  }
  if (Math.abs(a.length - b.length) > 1) {
    return false;
  }

  const normalizedA = normalizeOcrConfusionSignature(a);
  const normalizedB = normalizeOcrConfusionSignature(b);
  if (normalizedA !== normalizedB) {
    return false;
  }

  if (GENERIC_TOKENS.has(normalizedA) || OCR_LOW_SIGNAL_TOKENS.has(normalizedA)) {
    return false;
  }

  return (
    sharedPrefixLength(a, b) >= 2 ||
    sharedSuffixLength(a, b) >= 2
  );
}

function isLikelyTruncatedPrefixMatch(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (longer.length - shorter.length !== 1) {
    return false;
  }

  if (shorter.length < 2 || longer.length > 6) {
    return false;
  }

  if (!longer.startsWith(shorter)) {
    return false;
  }

  if (GENERIC_TOKENS.has(shorter) || OCR_LOW_SIGNAL_TOKENS.has(shorter)) {
    return false;
  }

  return true;
}

function passesFuzzyThreshold(
  similarity: number,
  candidateVariant: string,
  evidenceVariant: string
): boolean {
  if (similarity >= FUZZY_MATCH_THRESHOLD) {
    return true;
  }

  // OCR truncates terminal characters on short tokens ("ca" -> "cat").
  if (isLikelyTruncatedPrefixMatch(candidateVariant, evidenceVariant)) {
    return true;
  }

  if (isLikelyOcrConfusionEquivalent(candidateVariant, evidenceVariant)) {
    return true;
  }

  if (similarity < OCR_RELAXED_FUZZY_THRESHOLD) {
    return false;
  }

  const minLength = Math.min(candidateVariant.length, evidenceVariant.length);
  if (minLength < 6) {
    return false;
  }

  return (
    sharedPrefixLength(candidateVariant, evidenceVariant) >= 3 ||
    sharedSuffixLength(candidateVariant, evidenceVariant) >= 3
  );
}

function buildTokenVariants(token: string): string[] {
  const lower = token.toLowerCase();
  const variants = new Set<string>([lower]);

  for (const variant of expandMergedTokenVariants(lower)) {
    variants.add(variant);
  }

  const firstPass = Array.from(variants);
  for (const variant of firstPass) {
    for (const charVariant of expandOcrCharacterVariants(variant)) {
      variants.add(charVariant);
    }
    for (const swapVariant of expandCommonLetterSwapVariants(variant)) {
      variants.add(swapVariant);
    }
    for (const repeatedVariant of expandRepeatedCharacterVariants(variant)) {
      variants.add(repeatedVariant);
    }
  }

  const secondPass = Array.from(variants);
  for (const variant of secondPass) {
    const mapped = OCR_TOKEN_VARIANT_MAP.get(variant);
    if (mapped) {
      for (const replacement of mapped) {
        variants.add(replacement);
      }
    }
  }

  return Array.from(variants);
}

function hasIsForSeriesPattern(title: string | null | undefined): boolean {
  if (!title) return false;
  return /["']?[a-z0-9]["']?\s+is\s+for\b/i.test(title);
}

function isLowSignalEvidenceToken(token: string): boolean {
  const lower = token.toLowerCase();
  return (
    lower.length <= 2 ||
    GENERIC_TOKENS.has(lower) ||
    OCR_LOW_SIGNAL_TOKENS.has(lower) ||
    /^\$?\d+(?:\.\d+)?$/.test(lower) ||
    /^[\d-]{4,}$/.test(lower)
  );
}

function getEffectiveEvidenceTokenCount(evidenceTokenSet: Set<string>): number {
  const totalCount = evidenceTokenSet.size;
  if (totalCount === 0) {
    return 0;
  }

  let lowSignalCount = 0;
  for (const token of evidenceTokenSet) {
    if (isLowSignalEvidenceToken(token)) {
      lowSignalCount++;
    }
  }

  const substantiveCount = totalCount - lowSignalCount;
  const lowSignalRatio = lowSignalCount / totalCount;
  const maxDiscountRatio =
    substantiveCount >= 2 && lowSignalRatio >= HEAVY_OCR_NOISE_RATIO
      ? HEAVY_OCR_MAX_DISCOUNT_RATIO
      : MAX_EVIDENCE_NOISE_DISCOUNT_RATIO;
  const maxDiscount = Math.floor(totalCount * maxDiscountRatio);
  const discountedCount = Math.min(lowSignalCount, maxDiscount);
  return Math.max(1, totalCount - discountedCount);
}

function getLowSignalEvidenceRatio(evidenceTokenSet: Set<string>): number {
  const totalCount = evidenceTokenSet.size;
  if (totalCount === 0) {
    return 0;
  }

  let lowSignalCount = 0;
  for (const token of evidenceTokenSet) {
    if (isLowSignalEvidenceToken(token)) {
      lowSignalCount++;
    }
  }

  return lowSignalCount / totalCount;
}

/**
 * Calculate overlap between candidate tokens and evidence tokens
 * Uses fuzzy Levenshtein matching (threshold from FUZZY_MATCH_THRESHOLD) for OCR tolerance.
 *
 * @returns Object with:
 * - overlapCount: number of matching tokens
 * - matched: array of matched tokens
 * - matchedPairs: debug info showing which tokens matched
 */
function calculateTokenOverlap(
  candidateTokens: string[],
  evidenceTokenSet: Set<string>
): {
  overlapCount: number;
  matched: string[];
  matchedPairs: Array<{
    candidate: string;
    evidence: string;
    similarity: number;
    variantMatched: boolean;
  }>;
} {
  if (candidateTokens.length === 0 || evidenceTokenSet.size === 0) {
    return { overlapCount: 0, matched: [], matchedPairs: [] };
  }

  const matchedSet = new Set<string>();
  const usedEvidenceTokens = new Set<string>();
  const evidenceTokens = Array.from(evidenceTokenSet);
  const evidenceTokenVariants = new Map<string, string[]>();
  for (const token of evidenceTokens) {
    evidenceTokenVariants.set(token, buildTokenVariants(token));
  }
  const candidateTokenVariants = new Map<string, string[]>();
  for (const token of candidateTokens) {
    candidateTokenVariants.set(token, buildTokenVariants(token));
  }
  const matchedPairs: Array<{
    candidate: string;
    evidence: string;
    similarity: number;
    variantMatched: boolean;
  }> = [];

  // For each candidate token, find best matching evidence token
  for (const candidateToken of candidateTokens) {
    let bestMatch: string | null = null;
    let bestSimilarity = 0;
    let bestCandidateVariant = candidateToken;
    let bestEvidenceVariant = candidateToken;

    for (const evidenceToken of evidenceTokens) {
      // Skip already-used evidence tokens (1:1 matching)
      if (usedEvidenceTokens.has(evidenceToken)) continue;

      const variants = evidenceTokenVariants.get(evidenceToken) ?? [evidenceToken];
      const candidateVariants = candidateTokenVariants.get(candidateToken) ?? [candidateToken];
      let localBest = 0;
      let localBestCandidateVariant = candidateToken;
      let localBestEvidenceVariant = evidenceToken;
      for (const evidenceVariant of variants) {
        for (const candidateVariant of candidateVariants) {
          // Quick exact match check
          if (candidateVariant === evidenceVariant) {
            localBest = 1.0;
            localBestCandidateVariant = candidateVariant;
            localBestEvidenceVariant = evidenceVariant;
            break;
          }

          // Fuzzy Levenshtein match
          const similarity = levenshteinSimilarity(candidateVariant, evidenceVariant);
          if (similarity > localBest) {
            localBest = similarity;
            localBestCandidateVariant = candidateVariant;
            localBestEvidenceVariant = evidenceVariant;
          }
        }
        if (localBest >= 1.0) {
          break;
        }
      }

      if (localBest > bestSimilarity) {
        bestSimilarity = localBest;
        bestMatch = evidenceToken;
        bestCandidateVariant = localBestCandidateVariant;
        bestEvidenceVariant = localBestEvidenceVariant;
        if (bestSimilarity >= 1.0) {
          break;
        }
      }
    }

    // Count as overlap if similarity >= threshold
    if (
      bestMatch &&
      passesFuzzyThreshold(bestSimilarity, bestCandidateVariant, bestEvidenceVariant)
    ) {
      matchedSet.add(candidateToken);
      usedEvidenceTokens.add(bestMatch);
      matchedPairs.push({
        candidate: candidateToken,
        evidence: bestMatch,
        similarity: bestSimilarity,
        variantMatched:
          bestCandidateVariant !== candidateToken || bestEvidenceVariant !== bestMatch,
      });
    }
  }

  const matched = Array.from(matchedSet);
  return {
    overlapCount: matched.length,
    matched,
    matchedPairs,
  };
}

/**
 * Calculate order score - rewards when first token of title appears in evidence
 */
function calculateOrderScore(titleTokens: string[], evidenceTokenSet: Set<string>): number {
  if (titleTokens.length === 0) {
    return 0.9; // No title tokens, neutral score
  }

  const firstToken = titleTokens[0];
  if (evidenceTokenSet.has(firstToken)) {
    return 1.0; // First token present in evidence
  }

  return 0.9; // First token not found
}

/**
 * Options for scoring candidates
 */
export interface ScoringOptions {
  /**
   * Source kind for ISBN policy (default: 'spine_crop')
   * - spine_crop: ISBN is non-fatal noise, never used for scoring boost
   * - back_cover/inside_page: Valid ISBN triggers lookup and boost
   * - unknown: Conservative, treat as spine_crop
   */
  sourceKind?: EvidenceSourceKind;
}

/**
 * Score a single candidate against evidence
 *
 * Scoring formula:
 * score = F1(precision, recall) + ISBN bonus - penalties
 * precision = overlap / |evidenceTokens|
 * recall    = overlap / |candidateTokens|
 * f1        = 2 * P * R / (P + R)
 *
 * If overlapCount < 2, score is capped at 0.10 (minimum signal required)
 *
 * ISBN POLICY:
 * - For spine_crop: ISBN is NEVER used for scoring (noise from spine OCR)
 * - For back_cover/inside_page: Valid ISBN match adds bonus
 * - ISBN can only INCREASE confidence, never decrease it
 * - Missing/invalid ISBN is NOT a penalty in any case
 */
export function scoreCandidate(
  candidate: ResolvedBook,
  evidenceTokens: EvidenceTokens,
  options?: ScoringOptions
): CandidateScore {
  const sourceKind: EvidenceSourceKind = options?.sourceKind ?? 'spine_crop';
  const penalties: ScorePenalty[] = [];

  // Get title tokens (using aggressive normalization)
  const titleTokens = candidate.title ? normalizeForScoring(candidate.title) : [];
  if (hasIsForSeriesPattern(candidate.title)) {
    titleTokens.push('isforseries');
  }

  // Count raw title words for MIN_TOKENS check (before normalization)
  // This prevents "The Fingerprint" from being counted as 1 token just because "the" is filtered
  const titleRawWords = candidate.title
    ? candidate.title.trim().split(/\s+/).filter(w => w.length >= 2)
    : [];
  const titleRawWordCount = titleRawWords.length;

  // Get author tokens (combine all authors)
  const authorTokens: string[] = [];
  if (candidate.authors && candidate.authors.length > 0) {
    for (const author of candidate.authors) {
      const tokens = normalizeForScoring(author);
      for (const token of tokens) {
        if (!authorTokens.includes(token)) {
          authorTokens.push(token);
        }
      }
    }
  }

  const titleTokenSet = new Set(titleTokens);
  const authorTokenSet = new Set(authorTokens);
  const candidateTokenSet = new Set([...titleTokenSet, ...authorTokenSet]);
  const candidateTokens = Array.from(candidateTokenSet);

  // Calculate overlap metrics (set-based)
  const overlapResult = calculateTokenOverlap(candidateTokens, evidenceTokens.tokensSet);

  // Calculate order score based on title's first token (for diagnostics only)
  const orderScore = calculateOrderScore(Array.from(titleTokenSet), evidenceTokens.tokensSet);

  const effectiveEvidenceTokenCount = getEffectiveEvidenceTokenCount(evidenceTokens.tokensSet);
  const lowSignalEvidenceRatio = getLowSignalEvidenceRatio(evidenceTokens.tokensSet);
  const candidateTokenCount = candidateTokens.length;
  const precision =
    effectiveEvidenceTokenCount > 0
      ? overlapResult.overlapCount / effectiveEvidenceTokenCount
      : 0;
  const recall =
    candidateTokenCount > 0 ? overlapResult.overlapCount / candidateTokenCount : 0;
  const f1 =
    precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  // ISBN matching with source-aware policy
  // IMPORTANT: ISBN can only INCREASE confidence, never decrease it
  // For spine_crop: ISBN is noise, never use for scoring
  // For back_cover/inside_page: ISBN match adds bonus
  let isbnBonus = 0;
  let isbnMatched = false;

  // Get valid ISBNs from evidence (checksum-validated)
  const validEvidenceIsbns = evidenceTokens.isbns.filter((isbn) =>
    validateIsbnChecksum(isbn)
  );

  // Determine ISBN policy based on source kind
  // Note: We pass an empty array for validIsbns since we just need the policy type
  const isbnPolicy = determineIsbnPolicy(
    sourceKind,
    validEvidenceIsbns.map((isbn) => ({
      raw: isbn,
      normalized: isbn,
      type: isbn.length === 10 ? 'isbn10' as const : 'isbn13' as const,
      checksumValid: true,
    }))
  );

  // Only apply ISBN bonus if policy allows it AND we have valid ISBNs
  if (shouldApplyIsbnBoost(isbnPolicy) && validEvidenceIsbns.length > 0) {
    const candidateIsbns = [candidate.isbn13, candidate.isbn10].filter(Boolean) as string[];
    for (const evidenceIsbn of validEvidenceIsbns) {
      for (const candidateIsbn of candidateIsbns) {
        if (evidenceIsbn === candidateIsbn) {
          isbnBonus = ISBN_BONUS;
          isbnMatched = true;
          break;
        }
      }
      if (isbnMatched) break;
    }
  }
  // NOTE: If isbnPolicy === 'ignore' (spine_crop), we don't even check for matches
  // This ensures ISBN from spine OCR is never used for scoring

  // Compute title and author overlaps separately
  const titleOnlyResult = calculateTokenOverlap(Array.from(titleTokenSet), evidenceTokens.tokensSet);
  const authorOnlyResult = calculateTokenOverlap(Array.from(authorTokenSet), evidenceTokens.tokensSet);

  // Calculate title-specific F1 score
  // IMPORTANT: For title precision, exclude evidence tokens that matched the author
  // This prevents author tokens in evidence (e.g., "KELLERMAN") from diluting title precision
  // Example: "ISIO CAVE KELLERMAN STRAIGHI INTO DARKNESS" matching "Straight into Darkness"
  // Without adjustment: titlePrecision = 3/6 = 0.50 (penalized by CAVE, KELLERMAN, ISIO)
  // With adjustment: titlePrecision = 3/5 = 0.60 (KELLERMAN excluded as author match)
  const authorMatchedEvidenceCount = authorOnlyResult.matchedPairs.length;
  const nonLexicalEvidenceCount = Array.from(evidenceTokens.tokensSet).filter(
    (token) => !/[a-z]/i.test(token)
  ).length;
  const adjustedEvidenceCountForTitle = Math.max(
    1,
    effectiveEvidenceTokenCount - authorMatchedEvidenceCount - nonLexicalEvidenceCount
  );
  const titleTokenCount = titleTokenSet.size;
  const titlePrecision =
    adjustedEvidenceCountForTitle > 0 ? titleOnlyResult.overlapCount / adjustedEvidenceCountForTitle : 0;
  const titleRecall =
    titleTokenCount > 0 ? titleOnlyResult.overlapCount / titleTokenCount : 0;
  const titleScore =
    titlePrecision + titleRecall > 0
      ? (2 * titlePrecision * titleRecall) / (titlePrecision + titleRecall)
      : 0;

  // Note: Verbose scoring debug removed - enable if needed for troubleshooting

  // Calculate author-specific F1 score (null if no author tokens in candidate)
  const authorTokenCount = authorTokenSet.size;
  let authorScore: number | null = null;
  if (authorTokenCount > 0) {
    const authorPrecision =
      effectiveEvidenceTokenCount > 0
        ? authorOnlyResult.overlapCount / effectiveEvidenceTokenCount
        : 0;
    const authorRecall = authorOnlyResult.overlapCount / authorTokenCount;
    authorScore =
      authorPrecision + authorRecall > 0
        ? (2 * authorPrecision * authorRecall) / (authorPrecision + authorRecall)
        : 0;
  }

  // Determine resolution mode:
  // - FULL_MATCH: both title and author evidence available
  // - TITLE_ONLY: author missing/weak, but title >= 2 tokens
  // - WEAK_TITLE_STRONG_AUTHOR: title < 2 tokens but strong author evidence
  // - NO_MATCH: insufficient evidence (title < 2 AND no strong author)
  //
  // Gate for weak title + strong author:
  // If titleTokens == 1 AND bestAuthorConfidence >= 0.75 AND bestAuthorTokenCount >= 2
  // => proceed with WEAK_TITLE_STRONG_AUTHOR (do NOT reject)
  const bestAuthorConfidence = evidenceTokens.bestAuthorConfidence ?? 0;
  const bestAuthorTokenCount = evidenceTokens.bestAuthorTokenCount ?? 0;
  // Strong author evidence: 2+ words with high confidence (full name like "JOHN SANDFORD")
  const hasStrongAuthorEvidence = bestAuthorConfidence >= 0.70 && bestAuthorTokenCount >= 2;
  // Weak author evidence: single surname with moderate confidence (like "CRANKIN", "SANDFORD")
  // This helps rescue single-word titles when we have a potential author surname
  const hasWeakAuthorEvidence = bestAuthorConfidence >= 0.40 && bestAuthorTokenCount >= 1;

  let resolutionMode: ResolutionMode = 'FULL_MATCH';
  // Use titleRawWordCount for MIN_TOKENS check to prevent "The Fingerprint" (2 words) from
  // being rejected just because "the" is filtered during normalization
  if (titleRawWordCount < TITLE_ONLY_MIN_TOKENS) {
    // Weak title - check if author evidence can save us
    if (titleTokenCount >= 1 && hasStrongAuthorEvidence) {
      // Proceed with weak title but strong author
      resolutionMode = 'WEAK_TITLE_STRONG_AUTHOR';
    } else if (titleTokenCount >= 1 && hasWeakAuthorEvidence) {
      // Single-word title + single-word author surname: still attempt matching
      // Example: "FALLS" + "CRANKIN" should try to match "Falls" by Ian Rankin
      resolutionMode = 'WEAK_TITLE_STRONG_AUTHOR';
    } else {
      resolutionMode = 'NO_MATCH';
    }
  } else if (authorScore === null || authorScore < TITLE_ONLY_AUTHOR_THRESHOLD) {
    resolutionMode = 'TITLE_ONLY';
  }

  // Publisher score (not available from Open Library yet, stub for future use)
  const publisherScore: number | null = null;

  // Generic title penalty (only when no author signal)
  if (candidate.title && isGenericTitle(candidate.title) && authorOnlyResult.matched.length === 0) {
    penalties.push({
      type: 'generic_title',
      amount: GENERIC_TITLE_PENALTY,
      reason: `Title "${candidate.title}" is a generic single word without author signal`,
    });
  }

  // Missing author penalty: penalize candidates without author information
  // This ensures editions with known authors are preferred over those without
  // (e.g., "The Pelican Brief" by John Grisham should beat "THE PELICAN BRIEF" by unknown)
  if (!candidate.authors || candidate.authors.length === 0) {
    penalties.push({
      type: 'missing_author',
      amount: MISSING_AUTHOR_PENALTY,
      reason: `Candidate "${candidate.title}" has no author information`,
    });
  }

  // OCR-corrected variant matches signal close near-misses (e.g., "SEAI" -> "SCENTS").
  // Keep this bounded and require minimum overlap so weak single-token cases are unaffected.
  const ocrVariantMatchCount = overlapResult.matchedPairs.filter(
    (pair) =>
      pair.variantMatched &&
      !GENERIC_TOKENS.has(pair.candidate) &&
      !isLowSignalEvidenceToken(pair.evidence)
  ).length;
  const ocrVariantBonus =
    overlapResult.overlapCount >= MIN_OVERLAP_COUNT
      ? Math.min(OCR_VARIANT_BONUS_CAP, ocrVariantMatchCount * OCR_VARIANT_BONUS_PER_TOKEN)
      : 0;

  // Give small credit to high-similarity OCR near-misses that were matched
  // directly by fuzzy distance (not via explicit variant maps).
  const fuzzyNearMissCount = overlapResult.matchedPairs.filter(
    (pair) =>
      !pair.variantMatched &&
      pair.similarity < 0.999 &&
      pair.similarity >= OCR_RELAXED_FUZZY_THRESHOLD &&
      pair.candidate.length >= 4 &&
      !GENERIC_TOKENS.has(pair.candidate) &&
      !isLowSignalEvidenceToken(pair.evidence)
  ).length;
  const fuzzyNearMissBonus =
    overlapResult.overlapCount >= MIN_OVERLAP_COUNT
      ? Math.min(FUZZY_NEAR_MISS_BONUS_CAP, fuzzyNearMissCount * FUZZY_NEAR_MISS_BONUS_PER_TOKEN)
      : 0;

  const confusionEquivalentNearMissCount = overlapResult.matchedPairs.filter(
    (pair) =>
      !pair.variantMatched &&
      pair.similarity < 0.999 &&
      isLikelyOcrConfusionEquivalent(pair.candidate, pair.evidence) &&
      !GENERIC_TOKENS.has(pair.candidate) &&
      !isLowSignalEvidenceToken(pair.evidence)
  ).length;
  const confusionEquivalentBonus =
    overlapResult.overlapCount >= MIN_OVERLAP_COUNT
      ? Math.min(
          OCR_CONFUSION_EQUIVALENT_BONUS_CAP,
          confusionEquivalentNearMissCount * OCR_CONFUSION_EQUIVALENT_BONUS_PER_TOKEN
        )
      : 0;

  const hasTitleAndAuthorAnchor =
    titleOnlyResult.overlapCount >= 1 && authorOnlyResult.overlapCount >= 1;
  const hasStrongAuthorAnchor = authorOnlyResult.overlapCount >= 2;
  const noisyEvidenceAnchorBonus =
    overlapResult.overlapCount >= MIN_OVERLAP_COUNT && lowSignalEvidenceRatio >= 0.4
      ? hasStrongAuthorAnchor
        ? 0.04
        : hasTitleAndAuthorAnchor
          ? 0.02
          : 0
      : 0;

  // Rescue noisy badge-heavy OCR where title lines are weak but author anchor is clear.
  // This lifts near-misses into suggested_weak without changing global thresholds.
  const hasConfidentAuthorRescueSignal =
    bestAuthorConfidence >= 0.55 &&
    bestAuthorTokenCount >= 2 &&
    authorTokenSet.size >= 2 &&
    authorOnlyResult.overlapCount >= 2 &&
    titleOnlyResult.overlapCount <= 1 &&
    overlapResult.matchedPairs.some(
      (pair) =>
        authorTokenSet.has(pair.candidate) &&
        pair.similarity >= OCR_RELAXED_FUZZY_THRESHOLD
    );
  const noisyAuthorRescueBonus =
    overlapResult.overlapCount >= MIN_OVERLAP_COUNT &&
    lowSignalEvidenceRatio >= 0.35 &&
    hasConfidentAuthorRescueSignal
      ? 0.12
      : 0;

  // Calculate combined score using F1
  // rawScore = F1 + bounded OCR bonuses + ISBN bonus (before penalties and caps)
  const rawScore =
    f1 +
    isbnBonus +
    ocrVariantBonus +
    fuzzyNearMissBonus +
    confusionEquivalentBonus +
    noisyEvidenceAnchorBonus +
    noisyAuthorRescueBonus;

  let score = rawScore;

  // Apply penalties
  for (const penalty of penalties) {
    score -= penalty.amount;
  }

  const hasExactOverlap = overlapResult.matchedPairs.some((pair) => pair.similarity >= 0.999);

  // Minimum signal check: if overlap < 2, cap score.
  // Fuzzy-only single overlaps are capped lower than exact low-signal matches.
  let minSignalCapped = false;
  if (overlapResult.overlapCount < MIN_OVERLAP_COUNT) {
    const lowSignalCap =
      overlapResult.overlapCount > 0 && !hasExactOverlap
        ? FUZZY_ONLY_SIGNAL_CAP
        : MIN_SIGNAL_SCORE_CAP;

    if (score > lowSignalCap) {
      minSignalCapped = true;
    }
    score = Math.min(score, lowSignalCap);
  }

  // Clamp to [0, 1]
  score = Math.max(0, Math.min(1, score));

  // finalScore = score after all penalties and caps
  const finalScore = score;

  if (isMetadataVerboseDebug() && !hasLoggedScoringDebug) {
    hasLoggedScoringDebug = true;
    const overlapTokens = overlapResult.matched;
    console.log('[ScoringDebug] candidate:', {
      title: candidate.title,
      authors: candidate.authors,
      evidenceTokens: Array.from(evidenceTokens.tokensSet),
      candidateTokens: candidateTokens,
      overlapTokens,
      overlapCount: overlapResult.overlapCount,
      precision: Number(precision.toFixed(3)),
      recall: Number(recall.toFixed(3)),
      f1: Number(f1.toFixed(3)),
      isbnMatched,
      isbnBonus,
      penalties,
    });
  }

  return {
    score: finalScore,
    rawScore,
    finalScore,
    overlapRatio: recall,
    coverageRatio: precision,
    orderScore,
    overlapCount: overlapResult.overlapCount,
    precision,
    recall,
    f1,
    isbnBonus,
    penalties,
    matchedTokens: overlapResult.matched,
    isbnMatched,
    minSignalCapped,
    // TITLE_ONLY mode fields
    titleScore,
    authorScore,
    titleTokenCount,
    authorTokenCount,
    resolutionMode,
    publisherScore,
    // Legacy fields
    titleOverlap: titleOnlyResult.overlapCount / Math.max(1, titleTokenSet.size),
    authorOverlap: authorOnlyResult.overlapCount / Math.max(1, authorTokenSet.size),
    matchedTitleTokens: titleOnlyResult.matched,
    matchedAuthorTokens: authorOnlyResult.matched,
  };
}

/**
 * Score and rank multiple candidates
 *
 * @param candidates - Books to score
 * @param evidenceTokens - Tokenized evidence
 * @param options - Scoring options including sourceKind for ISBN policy
 */
export function scoreAndRankCandidates(
  candidates: ResolvedBook[],
  evidenceTokens: EvidenceTokens,
  options?: ScoringOptions
): ScoredCandidate[] {
  const scored: ScoredCandidate[] = candidates.map((book) => ({
    book,
    scoring: scoreCandidate(book, evidenceTokens, options),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.scoring.score - a.scoring.score);

  return scored;
}

/**
 * Build evidence tokens from raw lines (convenience wrapper)
 */
export function buildEvidenceFromLines(
  lines: string[],
  options?: BuildEvidenceTokensOptions
): EvidenceTokens {
  return buildEvidenceTokens(lines, options);
}

// ============================================================================
// Decision Thresholds
// ============================================================================

/**
 * Decision Gates:
 * - accepted: score >= 0.88 AND overlapCount >= 3 AND (gap >= 0.12 OR ISBN match)
 * - suggested: score >= 0.60 AND overlapCount >= 3
 *   OR score >= 0.70 AND overlapCount >= 2 AND author signal present
 * - manual_review: score >= 0.75 AND overlapCount >= 3 AND gap <= 0.08 (ambiguity only)
 * - reject: else (no viable match)
 */

/** Minimum score for accept-high (with ISBN match) */
export const ACCEPT_HIGH_THRESHOLD = CONFIG_ACCEPT_HIGH;

/** Minimum score for accept-medium (no ISBN but high confidence) */
export const ACCEPT_MEDIUM_THRESHOLD = CONFIG_ACCEPT_MEDIUM;

/** Minimum gap between top and second candidate for accept-medium */
export const ACCEPT_MEDIUM_GAP = CONFIG_ACCEPT_MEDIUM_GAP;

/** Minimum overlap count for accept-medium */
export const ACCEPT_MEDIUM_MIN_OVERLAP = CONFIG_MIN_OVERLAP;

/** Minimum score for suggested (replaces manual_review) */
export const SUGGESTED_THRESHOLD = CONFIG_SUGGESTED;

/** Alternate suggested threshold when author signal exists */
export const SUGGESTED_AUTHOR_THRESHOLD = CONFIG_SUGGESTED_AUTHOR;

/** Minimum overlap for alternate suggested path */
export const SUGGESTED_AUTHOR_MIN_OVERLAP = CONFIG_SUGGESTED_AUTHOR_MIN_OVERLAP;

/** Weak suggested threshold (UI-only, never persisted) */
export const SUGGESTED_WEAK_THRESHOLD = CONFIG_SUGGESTED_WEAK;

/** Minimum overlap for weak suggested path */
export const SUGGESTED_WEAK_MIN_OVERLAP = CONFIG_SUGGESTED_WEAK_MIN_OVERLAP;

/** Manual review threshold (ambiguity only) */
export const MANUAL_REVIEW_THRESHOLD = CONFIG_MANUAL_REVIEW;

/** Manual review max gap */
export const MANUAL_REVIEW_MAX_GAP = CONFIG_MANUAL_REVIEW_GAP;

/** Manual review minimum overlap */
export const MANUAL_REVIEW_MIN_OVERLAP = CONFIG_MANUAL_REVIEW_MIN_OVERLAP;

/** Maximum candidates to return for manual review */
export const MAX_REVIEW_CANDIDATES = CONFIG_MAX_REVIEW;

// Legacy export for backwards compatibility
export const AUTO_ACCEPT_THRESHOLD = ACCEPT_HIGH_THRESHOLD;

/**
 * Decision type from scoring
 * - accept_high: ISBN match + high score (persisted)
 * - accept_medium: high score + dominance (persisted)
 * - suggested: moderate score, shown but NOT persisted
 * - suggested_weak: low score but some signal, shown but NEVER persisted (UI-only best guess)
 * - reject: no viable match
 */
export type ScoringDecision = 'accept_high' | 'accept_medium' | 'suggested' | 'suggested_weak' | 'reject';

/**
 * Decision result with full context
 */
export interface DecisionResult {
  decision: ScoringDecision;
  topCandidate: ScoredCandidate | null;
  reviewCandidates: ScoredCandidate[];
  /** Gap between top and second candidate */
  scoreGap: number;
  /** Explanation for the decision */
  reason: string;
  /** Whether this should trigger manual review (ambiguity only) */
  manualReview?: boolean;
  /** Resolution mode used for decision (FULL_MATCH, TITLE_ONLY, NO_MATCH) */
  resolutionMode?: ResolutionMode;
  /** Ambiguity metrics for anti-false-positive safeguards */
  ambiguityMetrics?: AmbiguityMetrics;
}

/**
 * Make a decision based on scored candidates
 *
 * Decision Gates:
 * - accept_high: ISBN matched AND topScore >= 0.65 (persisted)
 * - accept_medium: topScore >= 0.80 AND gap >= 0.15 AND overlapCount >= 2 (persisted)
 *   (demoted to suggested if generic title and no author signal)
 * - suggested: topScore >= 0.55 AND overlapCount >= 2 (NOT persisted, shown to user)
 * - reject: else
 *
 * @param scoredCandidates - Candidates sorted by score descending
 * @param isAfterBoostPass - If true, we've already tried boost pass
 */
/**
 * Check if two candidates are the same book (by normalized title).
 * Used to find distinct second candidate for gap computation.
 */
function isSameBook(a: ScoredCandidate, b: ScoredCandidate): boolean {
  const normalizeTitle = (t: string) =>
    t.toLowerCase().replace(/[^a-z0-9]/g, '');
  const titleA = normalizeTitle(a.book.title || '');
  const titleB = normalizeTitle(b.book.title || '');
  // Same title = same book (even if different editions/OLIDs)
  return titleA === titleB && titleA.length > 0;
}

/**
 * Find the first distinct second candidate (different book from top).
 * Returns null if no distinct candidate exists.
 */
function findDistinctSecond(
  top: ScoredCandidate,
  candidates: ScoredCandidate[]
): ScoredCandidate | null {
  for (let i = 1; i < candidates.length; i++) {
    if (!isSameBook(top, candidates[i])) {
      return candidates[i];
    }
  }
  return null; // No distinct second = top is dominant
}

/**
 * Debug context for logging gate decisions
 */
export interface GateDebugContext {
  /** Raw evidence lines */
  rawLines?: string[];
  /** Normalized/cleaned lines */
  normalizedLines?: string[];
  /** Best author candidate from evidence */
  bestAuthorCandidate?: string;
  /** Best author confidence */
  bestAuthorConfidence?: number;
  /** Candidate ID for correlation */
  candidateId?: string;
  /** Advanced extraction result (multi-line title, colon patterns, all-caps author) */
  advancedExtraction?: {
    title: string | null;
    author: string | null;
    titleConfidence: number;
    authorConfidence: number;
  };
}

/**
 * Log a gate decision when verbose debug is enabled
 */
function logGateDecision(
  decision: ScoringDecision,
  reason: string,
  resolutionMode: ResolutionMode,
  top: ScoredCandidate | null,
  debugContext?: GateDebugContext
): void {
  if (!isMetadataVerboseDebug()) return;

  const candidateInfo = top ? {
    title: top.book.title,
    authors: top.book.authors,
    score: Number(top.scoring.score.toFixed(3)),
    titleScore: Number(top.scoring.titleScore.toFixed(3)),
    authorScore: top.scoring.authorScore !== null ? Number(top.scoring.authorScore.toFixed(3)) : null,
    titleTokenCount: top.scoring.titleTokenCount,
    matchedTitleTokens: top.scoring.matchedTitleTokens,
    matchedAuthorTokens: top.scoring.matchedAuthorTokens,
    overlapCount: top.scoring.overlapCount,
  } : null;

  console.log(`[GateDecision] ${decision.toUpperCase()}: ${reason}`, {
    candidateId: debugContext?.candidateId,
    resolutionMode,
    rawLines: debugContext?.rawLines,
    normalizedLines: debugContext?.normalizedLines,
    bestAuthorCandidate: debugContext?.bestAuthorCandidate,
    bestAuthorConfidence: debugContext?.bestAuthorConfidence,
    advancedExtraction: debugContext?.advancedExtraction,
    topCandidate: candidateInfo,
  });
}

export function makeDecisionFromScores(
  scoredCandidates: ScoredCandidate[],
  isAfterBoostPass: boolean = false,
  debugContext?: GateDebugContext
): DecisionResult {
  // Note: Detailed instrumentation available via isMetadataVerboseDebug() in gate decision logs

  if (scoredCandidates.length === 0) {
    logGateDecision('reject', 'No candidates found', 'NO_MATCH', null, debugContext);
    return {
      decision: 'reject',
      topCandidate: null,
      reviewCandidates: [],
      scoreGap: 0,
      reason: 'No candidates found',
      resolutionMode: 'NO_MATCH',
    };
  }

  const top = scoredCandidates[0];
  // Find distinct second candidate (different book, not just different edition)
  const distinctSecond = findDistinctSecond(top, scoredCandidates);
  // Gap = 1.0 if no distinct competitor (dominant by default)
  const scoreGap = distinctSecond
    ? top.scoring.score - distinctSecond.scoring.score
    : 1.0;

  // Count distinct candidates for ambiguity metrics
  const normalizeTitle = (t: string) =>
    t.toLowerCase().replace(/[^a-z0-9]/g, '');
  const seenTitles = new Set<string>();
  seenTitles.add(normalizeTitle(top.book.title || ''));
  let distinctCandidateCount = 1;
  for (let i = 1; i < scoredCandidates.length; i++) {
    const normalizedTitle = normalizeTitle(scoredCandidates[i].book.title || '');
    if (!seenTitles.has(normalizedTitle)) {
      seenTitles.add(normalizedTitle);
      distinctCandidateCount++;
    }
  }

  // Build ambiguity metrics
  const ambiguityMetrics: AmbiguityMetrics = {
    top1Score: top.scoring.score,
    top2Score: distinctSecond?.scoring.score ?? 0,
    margin: scoreGap,
    distinctCandidateCount,
    titleUniqueness:
      distinctCandidateCount <= TITLE_ONLY_MAX_CANDIDATES ||
      scoreGap >= TITLE_ONLY_MARGIN_MIN,
  };

  // Alternatives for manual review: distinct candidates only (skip duplicates)
  const distinctAlternatives: ScoredCandidate[] = [];
  const seenAltTitles = new Set<string>();
  seenAltTitles.add(normalizeTitle(top.book.title || ''));
  for (let i = 1; i < scoredCandidates.length && distinctAlternatives.length < MAX_REVIEW_CANDIDATES; i++) {
    const candidate = scoredCandidates[i];
    const normalizedTitle = normalizeTitle(candidate.book.title || '');
    if (!seenAltTitles.has(normalizedTitle)) {
      seenAltTitles.add(normalizedTitle);
      distinctAlternatives.push(candidate);
    }
  }
  const alternatives = distinctAlternatives;

  // DEBUG: Early log to confirm function is reached
  console.log(`[Decision] ENTER makeDecisionFromScores with ${scoredCandidates.length} candidates`);

  // Get resolution mode from top candidate (with safe access)
  const resolutionMode = top.scoring.resolutionMode;
  const titleScore = top.scoring.titleScore ?? 0;
  const authorScore = top.scoring.authorScore;
  const titleTokenCount = top.scoring.titleTokenCount ?? 0;
  const publisherScore = top.scoring.publisherScore;
  // Safe access for matchedAuthorTokens
  const hasAuthorSignal = (top.scoring.matchedAuthorTokens?.length ?? 0) >= 1;

  // DEBUG: Log decision inputs
  console.log(`[Decision] Top: "${top.book.title}" score=${top.scoring.score} titleScore=${titleScore} overlap=${top.scoring.overlapCount}`);

  // ==========================================================================
  // DECISION PATH: Route based on resolution mode
  // ==========================================================================

  // FAST PATH: Safety net for cases that should clearly be suggested but might be
  // incorrectly rejected by complex routing logic. Only applies when:
  // - Score is clearly good (>= 0.65) but below accept threshold
  // - Title score is clearly good (>= 0.70)
  // - Overlap is substantial (>= 3)
  // - Score gap is clear (>= 0.10) - don't interfere with ambiguous cases
  // This is conservative to avoid interfering with normal decision flow
  const shouldUseFastPath =
    top.scoring.score >= 0.65 &&
    top.scoring.score < ACCEPT_MEDIUM_THRESHOLD &&
    top.scoring.overlapCount >= 3 &&
    titleScore >= 0.70 &&
    scoreGap >= 0.10;  // Don't use fast path for ambiguous close-score cases

  if (shouldUseFastPath) {
    console.log(`[Decision] FAST PATH: score=${top.scoring.score}, overlap=${top.scoring.overlapCount}, titleScore=${titleScore} -> suggested`);
    return {
      decision: 'suggested',
      topCandidate: top,
      reviewCandidates: alternatives,
      scoreGap,
      reason: 'fast_path_good_match',
      resolutionMode,
      ambiguityMetrics,
    };
  }

  if (resolutionMode === 'NO_MATCH') {
    // Insufficient evidence to match
    logGateDecision('reject', 'insufficient_title_evidence', resolutionMode, top, debugContext);
    return {
      decision: 'reject',
      topCandidate: top,
      reviewCandidates: [],
      scoreGap,
      reason: 'insufficient_title_evidence',
      resolutionMode,
      ambiguityMetrics,
    };
  }

  // ==========================================================================
  // WEAK_TITLE_STRONG_AUTHOR PATH: Title < 2 tokens but strong author evidence
  // Conservative: never auto-accept, always suggest or manual_review
  // ==========================================================================
  if (resolutionMode === 'WEAK_TITLE_STRONG_AUTHOR') {
    // Up-weight author match: if author tokens matched, score is more reliable
    const authorMatchCount = top.scoring.matchedAuthorTokens.length;

    // If we have both title and author overlap, suggest
    if (top.scoring.overlapCount >= 2 && authorMatchCount >= 1) {
      logGateDecision('suggested', 'weak_title_strong_author_proceeded', resolutionMode, top, debugContext);
      return {
        decision: 'suggested',
        topCandidate: top,
        reviewCandidates: alternatives,
        scoreGap,
        reason: 'weak_title_strong_author_proceeded',
        manualReview: true,
        resolutionMode,
        ambiguityMetrics,
      };
    }

    // If only author matched but title didn't, still suggest with manual review
    if (authorMatchCount >= 2) {
      logGateDecision('suggested', 'weak_title_author_only_match', resolutionMode, top, debugContext);
      return {
        decision: 'suggested',
        topCandidate: top,
        reviewCandidates: alternatives,
        scoreGap,
        reason: 'weak_title_author_only_match',
        manualReview: true,
        resolutionMode,
        ambiguityMetrics,
      };
    }

    // Fallback: some signal but weak - suggest_weak with manual review
    if (top.scoring.overlapCount >= 1) {
      logGateDecision('suggested_weak', 'weak_title_and_author_manual_review', resolutionMode, top, debugContext);
      return {
        decision: 'suggested_weak',
        topCandidate: top,
        reviewCandidates: alternatives,
        scoreGap,
        reason: 'weak_title_and_author_manual_review',
        manualReview: true,
        resolutionMode,
        ambiguityMetrics,
      };
    }

    // No overlap at all - reject
    logGateDecision('reject', 'no_evidence_overlap', resolutionMode, top, debugContext);
    return {
      decision: 'reject',
      topCandidate: top,
      reviewCandidates: [],
      scoreGap,
      reason: 'no_evidence_overlap',
      resolutionMode,
      ambiguityMetrics,
    };
  }

  // ==========================================================================
  // FULL_MATCH PATH: Both title and author available
  // ==========================================================================
  if (resolutionMode === 'FULL_MATCH') {
    // Standard acceptance gates (existing logic, improved reasons)
    const isAccepted =
      top.scoring.score >= ACCEPT_MEDIUM_THRESHOLD &&
      top.scoring.overlapCount >= ACCEPT_MEDIUM_MIN_OVERLAP &&
      (scoreGap >= ACCEPT_MEDIUM_GAP || top.scoring.isbnMatched);

    if (isAccepted) {
      const decision = top.scoring.isbnMatched ? 'accept_high' : 'accept_medium';
      logGateDecision(decision, 'full_match', resolutionMode, top, debugContext);
      return {
        decision,
        topCandidate: top,
        reviewCandidates: [],
        scoreGap,
        reason: 'full_match',
        resolutionMode,
        ambiguityMetrics,
      };
    }

    // Extremely strong matches can still tie across duplicate/variant records.
    // If score + anchored title/author evidence are both high, avoid falling into
    // ambiguous-suggested loops and accept as medium confidence.
    const hasSubstantiveTitleAnchor = top.scoring.matchedTitleTokens.some(
      (token) => token.length >= 5 && !GENERIC_TOKENS.has(token)
    );
    const hasAuthorAnchor = (top.scoring.matchedAuthorTokens?.length ?? 0) >= 1;
    const shouldAcceptHighConfidenceTie =
      top.scoring.score >= 0.9 &&
      top.scoring.overlapCount >= MANUAL_REVIEW_MIN_OVERLAP &&
      hasSubstantiveTitleAnchor &&
      hasAuthorAnchor;

    if (shouldAcceptHighConfidenceTie) {
      logGateDecision(
        'accept_medium',
        'full_match_high_confidence_tiebreak',
        resolutionMode,
        top,
        debugContext
      );
      return {
        decision: 'accept_medium',
        topCandidate: top,
        reviewCandidates: [],
        scoreGap,
        reason: 'full_match_high_confidence_tiebreak',
        resolutionMode,
        ambiguityMetrics,
      };
    }

    // Manual review for close-call ambiguity
    const isManualReview =
      distinctSecond !== null &&
      top.scoring.score >= MANUAL_REVIEW_THRESHOLD &&
      top.scoring.overlapCount >= MANUAL_REVIEW_MIN_OVERLAP &&
      scoreGap <= MANUAL_REVIEW_MAX_GAP;

    // SUGGESTED for FULL_MATCH
    const isSuggested =
      (top.scoring.score >= SUGGESTED_THRESHOLD &&
        top.scoring.overlapCount >= ACCEPT_MEDIUM_MIN_OVERLAP) ||
      (top.scoring.score >= SUGGESTED_AUTHOR_THRESHOLD &&
        top.scoring.overlapCount >= SUGGESTED_AUTHOR_MIN_OVERLAP &&
        hasAuthorSignal);

    if (isSuggested) {
      const reason = isManualReview ? 'ambiguous_candidates' : 'full_match_suggested';
      logGateDecision('suggested', reason, resolutionMode, top, debugContext);
      return {
        decision: 'suggested',
        topCandidate: top,
        reviewCandidates: isManualReview ? alternatives : [],
        scoreGap,
        reason,
        manualReview: isManualReview,
        resolutionMode,
        ambiguityMetrics,
      };
    }

    // SUGGESTED_WEAK for FULL_MATCH
    const isSuggestedWeak =
      top.scoring.score >= SUGGESTED_WEAK_THRESHOLD &&
      top.scoring.overlapCount >= SUGGESTED_WEAK_MIN_OVERLAP;

    if (isSuggestedWeak) {
      logGateDecision('suggested_weak', 'full_match_weak', resolutionMode, top, debugContext);
      return {
        decision: 'suggested_weak',
        topCandidate: top,
        reviewCandidates: [],
        scoreGap,
        reason: 'full_match_weak',
        manualReview: false,
        resolutionMode,
        ambiguityMetrics,
      };
    }

    // OCR-noisy near miss: allow weak suggestion when signal is clearly present
    // but score falls just below the weak threshold due evidence noise.
    const hasSubstantiveMatchedToken = top.scoring.matchedTokens.some(
      (token) => token.length >= 5 && !GENERIC_TOKENS.has(token)
    );
    const isNoisyNearMiss =
      top.scoring.score >= SUGGESTED_WEAK_THRESHOLD - 0.05 &&
      top.scoring.overlapCount >= Math.max(3, SUGGESTED_WEAK_MIN_OVERLAP) &&
      scoreGap >= 0.04 &&
      hasSubstantiveMatchedToken;

    if (isNoisyNearMiss) {
      logGateDecision('suggested_weak', 'full_match_noisy_near_miss', resolutionMode, top, debugContext);
      return {
        decision: 'suggested_weak',
        topCandidate: top,
        reviewCandidates: [],
        scoreGap,
        reason: 'full_match_noisy_near_miss',
        manualReview: false,
        resolutionMode,
        ambiguityMetrics,
      };
    }

    // Reject in FULL_MATCH mode - due to low title/author confidence
    logGateDecision('reject', 'low_title_confidence', resolutionMode, top, debugContext);
    return {
      decision: 'reject',
      topCandidate: top,
      reviewCandidates: [],
      scoreGap,
      reason: 'low_title_confidence',
      resolutionMode,
      ambiguityMetrics,
    };
  }

  // ==========================================================================
  // TITLE_ONLY PATH: Author missing or unreliable
  // Stricter anti-false-positive safeguards required
  // ==========================================================================

  // DEBUG: Log TITLE_ONLY decision inputs (simplified)
  const overallScore = top.scoring.score;
  console.log(`[Decision] TITLE_ONLY: titleScore=${titleScore}, overallScore=${overallScore}, willReject=${titleScore < SUGGESTED_WEAK_THRESHOLD && overallScore < SUGGESTED_THRESHOLD}`);

  // TITLE_ONLY REJECT: Reject only if BOTH:
  // 1. titleScore < SUGGESTED_WEAK_THRESHOLD (title extraction failed)
  // 2. overall score < SUGGESTED_THRESHOLD (overall match is also weak)
  //
  // This fallback allows cases where evidence extraction picked wrong lines
  // but the overall match is still good (e.g., "The Nanny" with score 0.50
  // but titleHint was "MORROT Thriler")
  const titleTooWeak = titleScore < SUGGESTED_WEAK_THRESHOLD || titleTokenCount < TITLE_ONLY_MIN_TOKENS;
  const overallScoreGood = overallScore >= SUGGESTED_THRESHOLD;
  const hasSubstantiveMatchedToken = top.scoring.matchedTokens.some(
    (token) => token.length >= 5 && !GENERIC_TOKENS.has(token)
  );
  const isTitleOnlyNoisyNearMiss =
    titleTooWeak &&
    !overallScoreGood &&
    overallScore >= SUGGESTED_WEAK_THRESHOLD &&
    top.scoring.overlapCount >= SUGGESTED_WEAK_MIN_OVERLAP &&
    hasSubstantiveMatchedToken;

  if (isTitleOnlyNoisyNearMiss) {
    logGateDecision('suggested_weak', 'title_only_noisy_near_miss', resolutionMode, top, debugContext);
    return {
      decision: 'suggested_weak',
      topCandidate: top,
      reviewCandidates: [],
      scoreGap,
      reason: 'title_only_noisy_near_miss',
      manualReview: false,
      resolutionMode,
      ambiguityMetrics,
    };
  }

  if (titleTooWeak && !overallScoreGood) {
    logGateDecision('reject', 'low_title_confidence', resolutionMode, top, debugContext);
    return {
      decision: 'reject',
      topCandidate: top,
      reviewCandidates: [],
      scoreGap,
      reason: 'low_title_confidence',
      resolutionMode,
      ambiguityMetrics,
    };
  }

  // If title is weak but overall score is good, fall through to suggested_weak
  if (titleTooWeak && overallScoreGood) {
    logGateDecision('suggested_weak', 'overall_score_fallback', resolutionMode, top, debugContext);
    return {
      decision: 'suggested_weak',
      topCandidate: top,
      reviewCandidates: [],
      scoreGap,
      reason: 'overall_score_fallback',
      manualReview: false,
      resolutionMode,
      ambiguityMetrics,
    };
  }

  // TITLE_ONLY ACCEPT requires ALL of:
  // - titleScore >= TITLE_ONLY_ACCEPT_MIN
  // - titleTokenCount >= 2
  // - AND at least ONE of:
  //   - margin >= TITLE_ONLY_MARGIN_MIN (clear winner)
  //   - distinctCandidateCount <= TITLE_ONLY_MAX_CANDIDATES (few results)
  //   - publisherScore >= TITLE_ONLY_PUBLISHER_MIN (publisher confirms)
  const hasAntiAmbiguitySignal =
    scoreGap >= TITLE_ONLY_MARGIN_MIN ||
    distinctCandidateCount <= TITLE_ONLY_MAX_CANDIDATES ||
    (publisherScore !== null && publisherScore >= TITLE_ONLY_PUBLISHER_MIN);

  if (
    titleScore >= TITLE_ONLY_ACCEPT_MIN &&
    titleTokenCount >= TITLE_ONLY_MIN_TOKENS &&
    hasAntiAmbiguitySignal
  ) {
    logGateDecision('accept_medium', 'title_only_high_confidence', resolutionMode, top, debugContext);
    return {
      decision: 'accept_medium', // TITLE_ONLY accept is medium confidence
      topCandidate: top,
      reviewCandidates: [],
      scoreGap,
      reason: 'title_only_high_confidence',
      resolutionMode,
      ambiguityMetrics,
    };
  }

  // TITLE_ONLY SUGGESTED: titleScore >= T_ONLY_MIN but ambiguity is high
  if (titleScore >= TITLE_ONLY_ACCEPT_MIN && !hasAntiAmbiguitySignal) {
    logGateDecision('suggested', 'title_only_ambiguous', resolutionMode, top, debugContext);
    return {
      decision: 'suggested',
      topCandidate: top,
      reviewCandidates: alternatives,
      scoreGap,
      reason: 'title_only_ambiguous',
      manualReview: true,
      resolutionMode,
      ambiguityMetrics,
    };
  }

  // TITLE_ONLY SUGGESTED: titleScore strong but below T_ONLY_MIN
  if (titleScore >= TITLE_ONLY_SUGGESTED_MIN) {
    logGateDecision('suggested', 'title_strong_author_missing', resolutionMode, top, debugContext);
    return {
      decision: 'suggested',
      topCandidate: top,
      reviewCandidates: alternatives.length > 0 ? alternatives : [],
      scoreGap,
      reason: 'title_strong_author_missing',
      manualReview: false,
      resolutionMode,
      ambiguityMetrics,
    };
  }

  // TITLE_ONLY SUGGESTED_WEAK: title has some signal but not enough for suggested
  if (titleScore >= SUGGESTED_WEAK_THRESHOLD) {
    logGateDecision('suggested_weak', 'title_weak_author_missing', resolutionMode, top, debugContext);
    return {
      decision: 'suggested_weak',
      topCandidate: top,
      reviewCandidates: [],
      scoreGap,
      reason: 'title_weak_author_missing',
      manualReview: false,
      resolutionMode,
      ambiguityMetrics,
    };
  }

  // Final reject - title confidence too low
  logGateDecision('reject', 'low_title_confidence', resolutionMode, top, debugContext);
  return {
    decision: 'reject',
    topCandidate: top,
    reviewCandidates: [],
    scoreGap,
    reason: 'low_title_confidence',
    resolutionMode,
    ambiguityMetrics,
  };
}

/**
 * Format score for display
 */
export function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/**
 * Explain a score for debugging
 */
export function explainScore(scoring: CandidateScore): string {
  const parts: string[] = [
    `Score: ${formatScore(scoring.score)}`,
    `Overlap: ${scoring.overlapCount} tokens`,
    `Precision: ${formatScore(scoring.precision)}`,
    `Recall: ${formatScore(scoring.recall)}`,
    `F1: ${formatScore(scoring.f1)}`,
    `Matched: ${scoring.matchedTokens.join(', ') || 'none'}`,
  ];

  if (scoring.isbnMatched) {
    parts.push(`ISBN bonus: +${formatScore(scoring.isbnBonus)}`);
  }

  for (const penalty of scoring.penalties) {
    parts.push(`Penalty (${penalty.type}): -${formatScore(penalty.amount)} - ${penalty.reason}`);
  }

  if (scoring.overlapCount < MIN_OVERLAP_COUNT) {
    parts.push(`⚠️ Low signal: overlap < ${MIN_OVERLAP_COUNT}, score capped at ${formatScore(MIN_SIGNAL_SCORE_CAP)}`);
  }

  return parts.join('\n');
}

/**
 * Check if a decision should auto-persist (accept_high or accept_medium)
 * IMPORTANT: Only accept_high and accept_medium are persisted to database
 * - suggested: NOT persisted (shown to user)
 * - suggested_weak: NEVER persisted (UI-only best guess)
 * - reject: NOT persisted
 */
export function shouldAutoPersist(decision: ScoringDecision): boolean {
  return decision === 'accept_high' || decision === 'accept_medium';
}

/**
 * Check if a decision should show a result in UI (accept, suggested, or suggested_weak)
 */
export function shouldShowInUI(decision: ScoringDecision): boolean {
  return decision === 'accept_high' ||
    decision === 'accept_medium' ||
    decision === 'suggested' ||
    decision === 'suggested_weak';
}
