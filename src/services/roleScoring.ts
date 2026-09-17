/**
 * Role Scoring Service
 *
 * Provides deterministic, penalty-based scoring for classifying lines
 * as titles vs authors. Prevents common misassignments.
 *
 * Design principles:
 * - Person-like lines should be authors, not titles
 * - Title-like lines should be titles, not authors
 * - Stopword bridges join fragmented titles
 * - No ML dependency - pure deterministic rules
 */

import {
  tokens,
  alphaRatio,
  isOrgLikeLine,
  isExactImprintLine,
  isPriceLikeLine,
  isFragmentLine,
  isTitleBridgeStopword,
} from './lineClassification';

// ============================================================================
// Constants
// ============================================================================

/**
 * Words that strongly indicate a title (not a person name)
 */
const TITLE_INDICATOR_WORDS = new Set([
  'THE', 'A', 'AN', 'OF', 'IN', 'ON', 'TO', 'FOR', 'AND', 'OR',
  'WITH', 'INTO', 'UNDER', 'OVER', 'THROUGH', 'BETWEEN', 'BEYOND',
  'BENEATH', 'AGAINST', 'ACROSS', 'ALONG', 'AMONG', 'AROUND',
  'BEFORE', 'BEHIND', 'BELOW', 'BESIDE', 'DURING', 'AFTER',
]);

/**
 * Words that are common in titles but rarely in person names
 */
const TITLE_CONTENT_WORDS = new Set([
  'DARK', 'NIGHT', 'DAY', 'DEATH', 'LIFE', 'BLOOD', 'FIRE', 'ICE',
  'STORM', 'SHADOW', 'SECRET', 'LAST', 'FIRST', 'FINAL', 'DEAD',
  'LOST', 'FALLEN', 'BROKEN', 'SILENT', 'HIDDEN', 'BURIED',
  'FORGOTTEN', 'GUARDIAN', 'GUARDIANS', 'FINGERPRINT', 'PELICAN',
  'BRIEF', 'GAME', 'GIRL', 'BOY', 'MAN', 'WOMAN', 'WIFE', 'HUSBAND',
  'GONE', 'POISON', 'PEN', 'SHINING', 'RISING', 'FALLING',
  'HOUSE', 'CASTLE', 'KINGDOM', 'CITY', 'WORLD', 'LAND',
  'BOOK', 'STORY', 'TALE', 'LEGEND', 'MYSTERY', 'THRILLER',
]);

/**
 * Common person name patterns (first names)
 */
const COMMON_FIRST_NAMES = new Set([
  'JOHN', 'JAMES', 'DAVID', 'MICHAEL', 'WILLIAM', 'RICHARD', 'ROBERT',
  'THOMAS', 'CHARLES', 'CHRISTOPHER', 'DANIEL', 'MATTHEW', 'ANTHONY',
  'MARK', 'DONALD', 'STEVEN', 'PAUL', 'ANDREW', 'JOSHUA', 'KENNETH',
  'MARY', 'PATRICIA', 'JENNIFER', 'LINDA', 'ELIZABETH', 'BARBARA',
  'SUSAN', 'JESSICA', 'SARAH', 'KAREN', 'NANCY', 'LISA', 'BETTY',
  'MARGARET', 'SANDRA', 'ASHLEY', 'KIMBERLY', 'EMILY', 'DONNA',
  'STEPHEN', 'GEORGE', 'EDWARD', 'BRIAN', 'RONALD', 'TIMOTHY',
  'PETER', 'NORA', 'AGATHA', 'NGAIO', 'DOROTHY', 'ANNE', 'ANN',
]);

/**
 * Common person name patterns (last names often seen in books)
 */
const COMMON_AUTHOR_LAST_NAMES = new Set([
  'KING', 'GRISHAM', 'PATTERSON', 'ROBERTS', 'STEEL', 'SPARKS',
  'CHILD', 'CHILDS', 'BROWN', 'CLARK', 'CORNWELL', 'CLANCY',
  'KOONTZ', 'CRICHTON', 'FLYNN', 'HAWKINS', 'PICOULT', 'WEIR',
  'MARTIN', 'CHRISTIE', 'WENTWORTH', 'MARSH', 'COBEN', 'GRAFTON',
  'KELLERMAN', 'CONNELLY', 'CRAIS', 'DEAVER', 'GERRITSEN', 'WOODS',
  'EVANOVICH', 'ROBB', 'SANDFORD', 'BALDACCI', 'REICHS', 'SLAUGHTER',
]);

// ============================================================================
// Role Scoring Types
// ============================================================================

/**
 * Role score breakdown for a line
 */
export interface RoleScore {
  /** Person-likeness score [0-1] */
  personLikeness: number;
  /** Title-likeness score [0-1] */
  titleLikeness: number;
  /** Penalties applied */
  penalties: Array<{ type: string; amount: number; reason: string }>;
  /** Bonuses applied */
  bonuses: Array<{ type: string; amount: number; reason: string }>;
  /** Recommended role */
  recommendedRole: 'author' | 'title' | 'ambiguous';
  /** Reasons for the classification */
  reasons: string[];
}

/**
 * Scored candidate with role information
 */
export interface ScoredRoleCandidate {
  /** Original text */
  text: string;
  /** Line index in original array */
  index: number;
  /** Role scoring */
  roleScore: RoleScore;
}

// ============================================================================
// Scoring Functions
// ============================================================================

/**
 * Score a line for person-likeness (author candidate quality)
 *
 * Criteria:
 * - 2-4 tokens (typical for names)
 * - High alpha ratio (>85%)
 * - TitleCase or ALLCAPS pattern
 * - Contains common first name token (+bonus)
 * - Contains common author last name (+bonus)
 * - Penalties: org markers, title content words, starts with article
 */
export function scorePersonLikeness(line: string): {
  score: number;
  reasons: string[];
  penalties: Array<{ type: string; amount: number; reason: string }>;
  bonuses: Array<{ type: string; amount: number; reason: string }>;
} {
  const toks = tokens(line);
  const alpha = alphaRatio(line);
  const trimmed = line.trim();
  const penalties: Array<{ type: string; amount: number; reason: string }> = [];
  const bonuses: Array<{ type: string; amount: number; reason: string }> = [];
  const reasons: string[] = [];

  // Base score
  let score = 0;

  // Token count check (2-4 typical for names)
  if (toks.length >= 2 && toks.length <= 4) {
    score = 0.5;
    reasons.push('token_count_2_4');
  } else if (toks.length === 1) {
    score = 0.1;
    reasons.push('single_token');
  } else if (toks.length > 4) {
    score = 0.2;
    reasons.push('too_many_tokens');
  } else {
    return { score: 0, reasons: ['empty_or_invalid'], penalties, bonuses };
  }

  // Alpha ratio check
  if (alpha >= 0.85) {
    score += 0.2;
    reasons.push('high_alpha_ratio');
  } else if (alpha < 0.7) {
    penalties.push({ type: 'low_alpha', amount: 0.3, reason: `alpha_ratio=${alpha.toFixed(2)}` });
  }

  // Case pattern check
  const words = trimmed.split(/\s+/);
  const isAllCaps = words.every(w => w.length <= 2 || w === w.toUpperCase());
  const isTitleCase = words.every(w =>
    w.length <= 1 || (w[0] === w[0].toUpperCase())
  );

  if (isAllCaps && words.length >= 2) {
    bonuses.push({ type: 'allcaps', amount: 0.2, reason: 'ALLCAPS pattern (typical for author on spine)' });
  } else if (isTitleCase) {
    bonuses.push({ type: 'titlecase', amount: 0.1, reason: 'TitleCase pattern' });
  }

  // Check for common first name
  const firstTok = toks[0];
  if (COMMON_FIRST_NAMES.has(firstTok)) {
    bonuses.push({ type: 'common_first_name', amount: 0.15, reason: `first token "${firstTok}" is common first name` });
  }

  // Check for common author last name
  const lastTok = toks[toks.length - 1];
  if (COMMON_AUTHOR_LAST_NAMES.has(lastTok)) {
    bonuses.push({ type: 'common_author_name', amount: 0.15, reason: `last token "${lastTok}" is known author name` });
  }

  // PENALTIES

  // Org markers
  if (isOrgLikeLine(trimmed)) {
    penalties.push({ type: 'org_marker', amount: 0.5, reason: 'contains organization marker' });
  }

  // Starts with article (THE, A, AN)
  if (TITLE_INDICATOR_WORDS.has(firstTok)) {
    penalties.push({ type: 'starts_with_article', amount: 0.4, reason: `starts with "${firstTok}"` });
  }

  // Contains title content words
  const titleContentCount = toks.filter(t => TITLE_CONTENT_WORDS.has(t)).length;
  if (titleContentCount > 0) {
    const ratio = titleContentCount / toks.length;
    if (ratio >= 0.5) {
      penalties.push({ type: 'title_content_words', amount: 0.35, reason: `${titleContentCount}/${toks.length} tokens are title-like` });
    } else if (titleContentCount >= 1) {
      penalties.push({ type: 'title_content_words', amount: 0.15, reason: `contains title-like word` });
    }
  }

  // Apply bonuses and penalties
  for (const bonus of bonuses) {
    score += bonus.amount;
  }
  for (const penalty of penalties) {
    score -= penalty.amount;
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    reasons,
    penalties,
    bonuses,
  };
}

/**
 * Score a line for title-likeness (title candidate quality)
 *
 * Criteria:
 * - 1-6 tokens (typical for titles)
 * - Starts with article (THE, A, AN) (+bonus)
 * - Contains prepositions/articles (+bonus)
 * - Contains title content words (+bonus)
 * - Penalties: looks like person name, org markers, imprint
 */
export function scoreTitleLikeness(line: string): {
  score: number;
  reasons: string[];
  penalties: Array<{ type: string; amount: number; reason: string }>;
  bonuses: Array<{ type: string; amount: number; reason: string }>;
} {
  const toks = tokens(line);
  const alpha = alphaRatio(line);
  const trimmed = line.trim();
  const penalties: Array<{ type: string; amount: number; reason: string }> = [];
  const bonuses: Array<{ type: string; amount: number; reason: string }> = [];
  const reasons: string[] = [];

  // Base score
  let score = 0;

  if (toks.length === 0) {
    return { score: 0, reasons: ['empty'], penalties, bonuses };
  }

  // Token count check
  if (toks.length >= 2 && toks.length <= 6) {
    score = 0.5;
    reasons.push('token_count_2_6');
  } else if (toks.length === 1 && toks[0].length >= 4) {
    score = 0.3;
    reasons.push('single_token_title');
  } else if (toks.length > 6) {
    score = 0.35;
    reasons.push('long_title');
  } else {
    score = 0.1;
    reasons.push('short_fragment');
  }

  // Alpha ratio check
  if (alpha < 0.6) {
    penalties.push({ type: 'low_alpha', amount: 0.2, reason: `alpha_ratio=${alpha.toFixed(2)}` });
  }

  // BONUSES

  // Starts with article
  const firstTok = toks[0];
  if (['THE', 'A', 'AN'].includes(firstTok)) {
    bonuses.push({ type: 'starts_with_article', amount: 0.25, reason: `starts with "${firstTok}"` });
  }

  // Contains prepositions/articles
  const hasPreposition = toks.some(t => TITLE_INDICATOR_WORDS.has(t));
  if (hasPreposition) {
    bonuses.push({ type: 'has_preposition', amount: 0.1, reason: 'contains preposition/article' });
  }

  // Contains title content words
  const titleContentCount = toks.filter(t => TITLE_CONTENT_WORDS.has(t)).length;
  if (titleContentCount >= 1) {
    bonuses.push({ type: 'title_content', amount: 0.15, reason: `contains ${titleContentCount} title word(s)` });
  }

  // Multiple tokens without common names
  if (toks.length >= 3 && !toks.some(t => COMMON_FIRST_NAMES.has(t) || COMMON_AUTHOR_LAST_NAMES.has(t))) {
    bonuses.push({ type: 'multi_token_no_names', amount: 0.1, reason: 'multi-token without person names' });
  }

  // PENALTIES

  // Looks like person name pattern (all common names)
  const nameTokenCount = toks.filter(t =>
    COMMON_FIRST_NAMES.has(t) || COMMON_AUTHOR_LAST_NAMES.has(t)
  ).length;
  if (nameTokenCount >= 2 && nameTokenCount >= toks.length * 0.6) {
    penalties.push({ type: 'person_name_pattern', amount: 0.4, reason: 'looks like person name' });
  }

  // Is exact imprint
  if (isExactImprintLine(trimmed)) {
    penalties.push({ type: 'imprint', amount: 0.5, reason: 'exact imprint match' });
  }

  // Is price-like
  if (isPriceLikeLine(trimmed)) {
    penalties.push({ type: 'price', amount: 0.5, reason: 'looks like price' });
  }

  // Is fragment
  if (isFragmentLine(trimmed)) {
    penalties.push({ type: 'fragment', amount: 0.3, reason: 'too short/fragmented' });
  }

  // Apply bonuses and penalties
  for (const bonus of bonuses) {
    score += bonus.amount;
  }
  for (const penalty of penalties) {
    score -= penalty.amount;
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    reasons,
    penalties,
    bonuses,
  };
}

/**
 * Get complete role score for a line
 */
export function getRoleScore(line: string): RoleScore {
  const personResult = scorePersonLikeness(line);
  const titleResult = scoreTitleLikeness(line);

  const personLikeness = personResult.score;
  const titleLikeness = titleResult.score;

  // Combine penalties and bonuses
  const penalties = [
    ...personResult.penalties.map(p => ({ ...p, type: `person:${p.type}` })),
    ...titleResult.penalties.map(p => ({ ...p, type: `title:${p.type}` })),
  ];
  const bonuses = [
    ...personResult.bonuses.map(b => ({ ...b, type: `person:${b.type}` })),
    ...titleResult.bonuses.map(b => ({ ...b, type: `title:${b.type}` })),
  ];

  // Determine recommended role
  let recommendedRole: 'author' | 'title' | 'ambiguous';
  const reasons: string[] = [];

  if (personLikeness > titleLikeness + 0.15) {
    recommendedRole = 'author';
    reasons.push(`person_score(${personLikeness.toFixed(2)}) > title_score(${titleLikeness.toFixed(2)}) + 0.15`);
  } else if (titleLikeness > personLikeness + 0.15) {
    recommendedRole = 'title';
    reasons.push(`title_score(${titleLikeness.toFixed(2)}) > person_score(${personLikeness.toFixed(2)}) + 0.15`);
  } else {
    recommendedRole = 'ambiguous';
    reasons.push(`scores too close: person=${personLikeness.toFixed(2)}, title=${titleLikeness.toFixed(2)}`);
  }

  return {
    personLikeness,
    titleLikeness,
    penalties,
    bonuses,
    recommendedRole,
    reasons,
  };
}

// ============================================================================
// Stopword Bridge Join
// ============================================================================

/**
 * Result of stopword bridge detection
 */
export interface StopwordBridgeResult {
  /** Whether a bridge was found */
  found: boolean;
  /** Joined text if found */
  joinedText: string | null;
  /** Indices of lines that were joined */
  joinedIndices: number[];
  /** The stopword that bridged */
  bridgeWord: string | null;
}

/**
 * Check if a line is a stopword that could bridge to next line
 */
export function isStopwordBridge(line: string): boolean {
  const toks = tokens(line);
  if (toks.length !== 1) return false;
  return isTitleBridgeStopword(toks[0]);
}

/**
 * Find stopword bridges in lines and build joined candidates
 *
 * A stopword bridge is when a single-token stopword line (THE, A, AN, OF, etc.)
 * connects to the following line to form a complete title.
 *
 * Example: ["THE", "GUARDIANS"] -> "THE GUARDIANS"
 */
export function findStopwordBridges(lines: string[]): StopwordBridgeResult[] {
  const results: StopwordBridgeResult[] = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    const nextLine = lines[i + 1].trim();

    if (!line || !nextLine) continue;

    // Check if current line is a stopword bridge
    if (isStopwordBridge(line)) {
      const bridgeWord = tokens(line)[0];

      // Check that next line is title-like (not person-like)
      const nextScore = getRoleScore(nextLine);
      if (nextScore.titleLikeness >= 0.3 && nextScore.recommendedRole !== 'author') {
        const joined = `${line} ${nextLine}`;
        results.push({
          found: true,
          joinedText: joined,
          joinedIndices: [i, i + 1],
          bridgeWord,
        });
      }
    }
  }

  return results;
}

/**
 * Build joined title candidates from consecutive title-like lines
 *
 * Joins 2-3 consecutive lines that are all title-like
 */
export function buildJoinedTitleCandidates(lines: string[]): Array<{
  text: string;
  indices: number[];
  score: number;
  reason: string;
}> {
  const results: Array<{
    text: string;
    indices: number[];
    score: number;
    reason: string;
  }> = [];

  // Score all lines first
  const lineScores = lines.map((line, i) => ({
    line: line.trim(),
    index: i,
    roleScore: getRoleScore(line),
  }));

  // Find consecutive title-like lines
  for (let i = 0; i < lineScores.length - 1; i++) {
    const current = lineScores[i];
    const next = lineScores[i + 1];

    if (!current.line || !next.line) continue;

    // Both must be title-like (not person-like)
    if (current.roleScore.recommendedRole === 'author') continue;
    if (next.roleScore.recommendedRole === 'author') continue;

    // At least one should have positive title score
    if (current.roleScore.titleLikeness < 0.3 && next.roleScore.titleLikeness < 0.3) continue;

    // Build 2-line join
    const joined2 = `${current.line} ${next.line}`;
    const joined2Score = scoreTitleLikeness(joined2);
    results.push({
      text: joined2,
      indices: [i, i + 1],
      score: joined2Score.score,
      reason: 'adjacent_title_lines',
    });

    // Try 3-line join
    if (i + 2 < lineScores.length) {
      const third = lineScores[i + 2];
      if (third.line && third.roleScore.recommendedRole !== 'author') {
        const joined3 = `${current.line} ${next.line} ${third.line}`;
        const joined3Score = scoreTitleLikeness(joined3);
        if (joined3Score.score >= joined2Score.score) {
          results.push({
            text: joined3,
            indices: [i, i + 1, i + 2],
            score: joined3Score.score,
            reason: 'three_line_join',
          });
        }
      }
    }
  }

  // Add stopword bridges
  const bridges = findStopwordBridges(lines);
  for (const bridge of bridges) {
    if (bridge.found && bridge.joinedText) {
      const bridgeScore = scoreTitleLikeness(bridge.joinedText);
      results.push({
        text: bridge.joinedText,
        indices: bridge.joinedIndices,
        score: bridgeScore.score + 0.1, // Bonus for stopword bridge pattern
        reason: `stopword_bridge:${bridge.bridgeWord}`,
      });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results;
}

// ============================================================================
// Anti-Swap Logic
// ============================================================================

/**
 * Result of person-title override check
 */
export interface PersonOverrideResult {
  /** Whether the person-like line should be overridden */
  shouldOverride: boolean;
  /** The reason for the decision */
  reason: string;
  /** The better candidate that triggered override (if any) */
  betterCandidate: { text: string; score: number } | null;
  /** Score comparison details */
  scoreComparison: {
    personLikeness: number;
    personTitleScore: number;
    bestAlternativeScore: number;
  };
}

/**
 * Check if a person-like line should be overridden as title
 *
 * This prevents selecting person-like lines as titles when
 * better title candidates exist.
 *
 * Enhanced logic:
 * 1. Must be person-like (recommended as author, personLikeness >= 0.5)
 * 2. Alternative must be clearly title-like (score >= 0.5, no person penalty)
 * 3. Alternative must score meaningfully better (> personTitleScore + 0.1)
 * 4. Alternative must NOT itself be person-like
 *
 * @returns true if the person-like line should NOT be used as title
 */
export function shouldOverridePersonAsTitle(
  personLikeLine: string,
  joinedTitleCandidates: Array<{ text: string; score: number }>
): boolean {
  return checkPersonOverride(personLikeLine, joinedTitleCandidates).shouldOverride;
}

/**
 * Detailed check for person-title override with full explanation
 */
export function checkPersonOverride(
  personLikeLine: string,
  joinedTitleCandidates: Array<{ text: string; score: number }>
): PersonOverrideResult {
  const personScore = getRoleScore(personLikeLine);

  const baseResult: PersonOverrideResult = {
    shouldOverride: false,
    reason: '',
    betterCandidate: null,
    scoreComparison: {
      personLikeness: personScore.personLikeness,
      personTitleScore: personScore.titleLikeness,
      bestAlternativeScore: 0,
    },
  };

  // If not actually person-like, no override needed
  if (personScore.recommendedRole !== 'author') {
    baseResult.reason = 'not_person_like_role';
    return baseResult;
  }
  if (personScore.personLikeness < 0.5) {
    baseResult.reason = 'low_person_likeness';
    return baseResult;
  }

  // Check if any joined candidate is better
  for (const candidate of joinedTitleCandidates) {
    const candidateRoleScore = getRoleScore(candidate.text);
    const candidateTitleScore = scoreTitleLikeness(candidate.text);

    // Track best alternative score
    if (candidateTitleScore.score > baseResult.scoreComparison.bestAlternativeScore) {
      baseResult.scoreComparison.bestAlternativeScore = candidateTitleScore.score;
    }

    // Skip if candidate is also person-like (could be a genuine person-name title, but risky)
    if (candidateRoleScore.recommendedRole === 'author' && candidateRoleScore.personLikeness >= 0.6) {
      continue;
    }

    // If joined candidate has higher title score and is clearly title-like
    if (candidateTitleScore.score > personScore.titleLikeness + 0.1 && candidateTitleScore.score >= 0.5) {
      // Additional check: candidate should have title indicators (article, preposition, title content)
      const hasArticleStart = ['THE', 'A', 'AN'].includes(tokens(candidate.text)[0]);
      const hasTitleContent = candidateTitleScore.bonuses.some(b =>
        b.type === 'title_content' || b.type === 'has_preposition' || b.type === 'starts_with_article'
      );

      if (hasArticleStart || hasTitleContent || candidateTitleScore.score >= 0.65) {
        baseResult.shouldOverride = true;
        baseResult.reason = `better_title_candidate_found`;
        baseResult.betterCandidate = candidate;
        return baseResult;
      }
    }
  }

  baseResult.reason = 'no_better_alternative';
  return baseResult;
}

/**
 * Check if a title-like line should be rejected as author
 *
 * This prevents selecting title-like lines as authors when
 * they have clear title indicators.
 *
 * @returns true if the title-like line should NOT be used as author
 */
export function shouldRejectAsAuthor(line: string): boolean {
  const roleScore = getRoleScore(line);

  // Clear title recommendation
  if (roleScore.recommendedRole === 'title' && roleScore.titleLikeness >= 0.6) {
    return true;
  }

  // Starts with article (THE, A, AN)
  const toks = tokens(line);
  if (toks.length > 0 && ['THE', 'A', 'AN'].includes(toks[0])) {
    return true;
  }

  // Too many title content words
  const titleContentCount = toks.filter(t => TITLE_CONTENT_WORDS.has(t)).length;
  if (titleContentCount >= 2) {
    return true;
  }

  return false;
}
