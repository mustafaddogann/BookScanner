/**
 * Resolver Debug Output Tests
 *
 * These tests demonstrate the reasoning trace for different correction scenarios.
 * Run with: npm test -- --testPathPattern='resolverDebugOutput.test.ts' --verbose
 */

import {
  extractIsbnFromOcrLines,
} from '../isbnExtraction';

import {
  findBestAuthorMatch,
} from '../ocrConfusionMatching';

import {
  detectBadgeTypoContext,
  getEnhancedBadgeExclusions,
} from '../badgeTypoDetection';

// ============================================================================
// Debug Output Tests
// ============================================================================

describe('Resolver Debug Output Demonstrations', () => {
  /**
   * SCENARIO 1: Swap Correction
   * OCR suggests title/author swapped; API has clear match.
   */
  describe('Swap-Corrected Case', () => {
    it('demonstrates swap detection reasoning', () => {
      console.log('\n=== SCENARIO 1: Swap Detection ===');
      console.log('OCR extraction (WRONG):');
      console.log('  extractedTitle: "JOHN GRISHAM"   <- This is actually the author');
      console.log('  extractedAuthor: "THE GUARDIANS" <- This is actually the title');
      console.log('');

      // Simulate the two hypotheses
      const h1 = {
        id: 'H1',
        title: 'JOHN GRISHAM',
        author: 'THE GUARDIANS',
        searchQuery: 'JOHN GRISHAM THE GUARDIANS',
        // H1 would get low scores because "JOHN GRISHAM" isn't a real title
        bestScore: 0.35,
      };

      const h2 = {
        id: 'H2',
        title: 'THE GUARDIANS',  // Swapped - now correct
        author: 'JOHN GRISHAM',  // Swapped - now correct
        searchQuery: 'THE GUARDIANS JOHN GRISHAM',
        // H2 would match the real book
        bestScore: 0.92,
      };

      console.log('Hypothesis H1 (original assignment):');
      console.log(`  title="${h1.title}", author="${h1.author}"`);
      console.log(`  searchQuery: "${h1.searchQuery}"`);
      console.log(`  bestScore: ${h1.bestScore.toFixed(3)}`);
      console.log('');

      console.log('Hypothesis H2 (swapped assignment):');
      console.log(`  title="${h2.title}", author="${h2.author}"`);
      console.log(`  searchQuery: "${h2.searchQuery}"`);
      console.log(`  bestScore: ${h2.bestScore.toFixed(3)}`);
      console.log('');

      const margin = h2.bestScore - h1.bestScore;
      const swapThreshold = 0.10;

      console.log('Decision:');
      console.log(`  scoreMargin: ${margin.toFixed(3)} (H2 - H1)`);
      console.log(`  swapThreshold: ${swapThreshold}`);
      console.log(`  swapApplied: ${margin > swapThreshold ? 'YES' : 'NO'}`);
      console.log('');

      console.log('Corrected Output:');
      console.log(`  title: "THE GUARDIANS" (from API)`);
      console.log(`  author: "John Grisham" (from API)`);
      console.log(`  confidence: ${h2.bestScore.toFixed(3)}`);
      console.log(`  decisionTier: ACCEPT`);

      // Assertions
      expect(margin).toBeGreaterThan(swapThreshold);
      expect(h2.bestScore).toBeGreaterThan(h1.bestScore);
    });
  });

  /**
   * SCENARIO 2: ISBN-First Resolution
   * OCR contains valid ISBN that enables exact lookup.
   */
  describe('ISBN-Corrected Case', () => {
    it('demonstrates ISBN-first resolution reasoning', () => {
      console.log('\n=== SCENARIO 2: ISBN-First Resolution ===');

      const lines = [
        'STEPHEN KING',
        'THE SHINING',
        '$7.99',
        'ISBN: 978-0-307',
        '74311-0',
      ];

      console.log('OCR Lines:');
      lines.forEach((line, i) => {
        console.log(`  [${i}] "${line}"`);
      });
      console.log('');

      // Extract ISBN
      const isbnResult = extractIsbnFromOcrLines(lines);

      console.log('ISBN Extraction:');
      console.log(`  rawIsbnLines: ${JSON.stringify(isbnResult.rawIsbnLines)}`);
      console.log(`  joinedCandidates: ${JSON.stringify(isbnResult.joinedCandidates)}`);
      console.log(`  candidates processed: ${isbnResult.candidates.length}`);
      console.log('');

      console.log('ISBN Candidates:');
      isbnResult.candidates.forEach((c, i) => {
        console.log(`  [${i}] raw="${c.raw.substring(0, 30)}" normalized="${c.normalized}" type=${c.type} valid=${c.checksumValid}`);
      });
      console.log('');

      console.log('ISBN Resolution Result:');
      console.log(`  validIsbn: ${isbnResult.validIsbn || 'null'}`);
      console.log(`  validIsbnType: ${isbnResult.validIsbnType || 'null'}`);
      console.log(`  isbnUsed: ${isbnResult.validIsbn ? 'true' : 'false'}`);

      if (isbnResult.validIsbn) {
        console.log('');
        console.log('API Lookup Result (simulated):');
        console.log('  title: "The Shining" (from API)');
        console.log('  author: "Stephen King" (from API)');
        console.log('  decisionTier: ACCEPT');
        console.log('  reason: isbn_exact_match');
      }

      // At least found ISBN-ish lines
      expect(isbnResult.rawIsbnLines.length).toBeGreaterThan(0);
    });
  });

  /**
   * SCENARIO 3: Missing Leading Character
   * OCR author missing first letter but API match found.
   */
  describe('Missing Leading Character Case', () => {
    it('demonstrates author OCR error correction', () => {
      console.log('\n=== SCENARIO 3: Missing Leading Character ===');

      const ocrAuthor = 'TONIO MARSH';
      const apiAuthors = ['Ngaio Marsh', 'Antonio Marsh', 'Stephen King'];

      console.log('OCR Author (with error):');
      console.log(`  "${ocrAuthor}"`);
      console.log('');

      console.log('API Author Candidates:');
      apiAuthors.forEach((a, i) => {
        console.log(`  [${i}] "${a}"`);
      });
      console.log('');

      // Find best match
      const result = findBestAuthorMatch(ocrAuthor, apiAuthors);

      console.log('Author Matching:');
      console.log(`  normalizedOcr: "${result.similarity.normalizedOcr}"`);
      console.log(`  normalizedApi: "${result.similarity.normalizedApi}"`);
      console.log(`  editDistance: ${result.similarity.editDistance}`);
      console.log(`  missingLeadingChar: ${result.similarity.missingLeadingChar}`);
      console.log(`  similarity: ${result.similarity.similarity.toFixed(3)}`);
      console.log(`  isMatch: ${result.similarity.isMatch}`);
      console.log(`  reason: ${result.similarity.reason}`);
      console.log('');

      console.log('Correction Result:');
      console.log(`  bestMatch: "${result.author}"`);
      console.log('  -> Normalized to API author value');

      // Assertions
      expect(result.similarity.isMatch).toBe(true);
      expect(result.similarity.missingLeadingChar).toBe(true);
      expect(result.author).toBe('Antonio Marsh');
    });
  });

  /**
   * SCENARIO 4: Badge Typo Exclusion
   * OCR contains "NEW FORK TIMES BESTSELLER" (typo in YORK).
   */
  describe('Badge-Typo Excluded Case', () => {
    it('demonstrates badge typo context detection', () => {
      console.log('\n=== SCENARIO 4: Badge Typo Exclusion ===');

      const lines = [
        'DELL',
        '*1',
        'NEW FORK',      // YORK -> FORK (1 edit typo)
        'TIMES',
        'BESTSELLER',
        'JOHN GRISHAM',
        'THE GUARDIANS',
      ];

      console.log('OCR Lines:');
      lines.forEach((line, i) => {
        console.log(`  [${i}] "${line}"`);
      });
      console.log('');

      // Check badge detection for the typo line
      const badgeResult = detectBadgeTypoContext(2, lines);

      console.log('Badge Detection for line 2 ("NEW FORK"):');
      console.log(`  isBadge: ${badgeResult.isBadge}`);
      console.log(`  confidence: ${badgeResult.confidence.toFixed(2)}`);
      console.log(`  reason: ${badgeResult.reason}`);
      console.log(`  badgeLineIndices: ${JSON.stringify(badgeResult.badgeLineIndices)}`);
      console.log('');

      console.log('Badge Components Found:');
      console.log(`  newYorkLine: ${JSON.stringify(badgeResult.components.newYorkLine)}`);
      console.log(`  timesLine: ${JSON.stringify(badgeResult.components.timesLine)}`);
      console.log(`  bestsellerLine: ${JSON.stringify(badgeResult.components.bestsellerLine)}`);
      console.log('');

      // Get all exclusions
      const { excludedIndices } = getEnhancedBadgeExclusions(lines);

      console.log('All Excluded Indices:');
      console.log(`  ${JSON.stringify(Array.from(excludedIndices))}`);
      console.log('');

      // Filter lines
      const filteredLines = lines.filter((_, i) => !excludedIndices.has(i));

      console.log('Filtered Lines (for extraction):');
      filteredLines.forEach((line, i) => {
        console.log(`  [${i}] "${line}"`);
      });
      console.log('');

      console.log('Result:');
      console.log('  Title candidates from: ["DELL", "*1", "JOHN GRISHAM", "THE GUARDIANS"]');
      console.log('  Author candidates from: ["DELL", "*1", "JOHN GRISHAM", "THE GUARDIANS"]');
      console.log('  Badge lines EXCLUDED from candidate pools');
      console.log('  -> Prevents "NEW FORK" from being misidentified as title/author');

      // Assertions
      expect(badgeResult.isBadge).toBe(true);
      expect(badgeResult.reason).toBe('nyt_badge_pattern_with_typo_tolerance');
      expect(excludedIndices.has(2)).toBe(true);  // NEW FORK
      expect(excludedIndices.has(3)).toBe(true);  // TIMES
      expect(excludedIndices.has(4)).toBe(true);  // BESTSELLER
      expect(excludedIndices.has(5)).toBe(false); // JOHN GRISHAM - NOT excluded
      expect(excludedIndices.has(6)).toBe(false); // THE GUARDIANS - NOT excluded
    });
  });

  /**
   * SCENARIO 5: Safety - No False Positive
   * Lines that LOOK badge-like but aren't.
   */
  describe('Safety - No False Positive Case', () => {
    it('demonstrates safety checks prevent false badge detection', () => {
      console.log('\n=== SCENARIO 5: Safety Check (No False Positive) ===');

      const lines = [
        'NEW FORK',      // Typo, BUT no BESTSELLER
        'TIMES',
        'JOHN GRISHAM',  // This is author, NOT bestseller
        'THE GUARDIANS',
      ];

      console.log('OCR Lines (no BESTSELLER):');
      lines.forEach((line, i) => {
        console.log(`  [${i}] "${line}"`);
      });
      console.log('');

      // Check if badge detected
      const badgeResult = detectBadgeTypoContext(0, lines);

      console.log('Badge Detection for line 0 ("NEW FORK"):');
      console.log(`  isBadge: ${badgeResult.isBadge}`);
      console.log(`  reason: ${badgeResult.reason}`);
      console.log('');

      console.log('Components Found:');
      console.log(`  newYorkLine: ${badgeResult.components.newYorkLine ? 'FOUND' : 'null'}`);
      console.log(`  timesLine: ${badgeResult.components.timesLine ? 'FOUND' : 'null'}`);
      console.log(`  bestsellerLine: ${badgeResult.components.bestsellerLine ? 'FOUND' : 'null'}`);
      console.log('');

      console.log('Safety Check Result:');
      console.log('  BESTSELLER component missing -> Badge NOT triggered');
      console.log('  "NEW FORK" will be processed normally (not excluded)');
      console.log('  -> Prevents false exclusion when OCR has "FORK" as real content');

      // Assertions
      expect(badgeResult.isBadge).toBe(false);
      expect(badgeResult.reason).toBe('missing_bestseller_component');
    });
  });
});
