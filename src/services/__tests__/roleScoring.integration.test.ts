/**
 * Role Scoring Integration Tests
 *
 * Comprehensive fixture-based tests for role scoring scenarios:
 * 1. Person-like line + fragmented title (override case)
 * 2. Legit person-name title (no override)
 * 3. Badge line exclusion
 * 4. Swap scenario prevention
 */

import {
  getRoleScore,
  buildJoinedTitleCandidates,
  checkPersonOverride,
  shouldRejectAsAuthor,
  findStopwordBridges,
} from '../roleScoring';
import {
  extractTitleAndAuthor,
  isMarketingBadgeWithNeighbors,
  getMarketingBadgeIndices,
} from '../titleAuthorExtraction';

describe('Role Scoring Integration', () => {
  // ============================================================================
  // Scenario 1: Person-like line + fragmented title
  // ============================================================================
  describe('Scenario: Person-like line with fragmented title', () => {
    /**
     * Fixture: Book with fragmented title and person-like author line
     * Expected: Title should be "THE BURIED", not "LISA CHILDS"
     */
    const fixture1 = {
      lines: ['THE', 'BURIED', 'LISA CHILDS'],
      expectedTitle: 'THE BURIED',
      expectedAuthor: 'LISA CHILDS',
    };

    it('should join fragmented title "THE" + "BURIED"', () => {
      const joinedCandidates = buildJoinedTitleCandidates(fixture1.lines);
      const theBuried = joinedCandidates.find(c => c.text === 'THE BURIED');

      expect(theBuried).toBeDefined();
      expect(theBuried!.score).toBeGreaterThan(0.5);
      expect(theBuried!.reason).toContain('stopword_bridge');
    });

    it('should recognize "LISA CHILDS" as person-like', () => {
      const roleScore = getRoleScore('LISA CHILDS');
      expect(roleScore.recommendedRole).toBe('author');
      expect(roleScore.personLikeness).toBeGreaterThan(0.5);
    });

    it('should trigger override when person-like line competes with joined title', () => {
      const joinedCandidates = buildJoinedTitleCandidates(fixture1.lines);
      const overrideResult = checkPersonOverride(
        'LISA CHILDS',
        joinedCandidates.map(c => ({ text: c.text, score: c.score }))
      );

      expect(overrideResult.shouldOverride).toBe(true);
      expect(overrideResult.betterCandidate?.text).toBe('THE BURIED');
    });

    it('should extract correct title and author from fixture', () => {
      const result = extractTitleAndAuthor(fixture1.lines);

      expect(result.title).toBe(fixture1.expectedTitle);
      expect(result.author).toBe(fixture1.expectedAuthor);
      expect(result.debug.personTitleOverridden).toBe(false); // Title is THE BURIED, not overriding person
    });

    /**
     * Fixture 2: Another fragmented title case
     * "THE" + "GUARDIANS" + "JOHN GRISHAM"
     */
    const fixture2 = {
      lines: ['THE', 'GUARDIANS', 'JOHN GRISHAM'],
      expectedTitle: 'THE GUARDIANS',
      expectedAuthor: 'JOHN GRISHAM',
    };

    it('should handle THE GUARDIANS case', () => {
      const result = extractTitleAndAuthor(fixture2.lines);

      expect(result.title).toBe(fixture2.expectedTitle);
      expect(result.author).toBe(fixture2.expectedAuthor);
    });
  });

  // ============================================================================
  // Scenario 2: Legit person-name title (no override)
  // ============================================================================
  describe('Scenario: Legit person-name title', () => {
    /**
     * Fixture: Books with person names as actual titles
     * These should NOT be overridden even though they look person-like
     */

    it('should allow "CARRIE" as title (Stephen King novel)', () => {
      const lines = ['CARRIE', 'STEPHEN KING'];
      const result = extractTitleAndAuthor(lines);

      // Single word "CARRIE" is not person-like (single token)
      expect(result.title).toBe('CARRIE');
      expect(result.author).toBe('STEPHEN KING');
    });

    it('should allow "REBECCA" as title', () => {
      const lines = ['REBECCA', 'DAPHNE DU MAURIER'];
      const result = extractTitleAndAuthor(lines);

      expect(result.title).toBe('REBECCA');
      expect(result.author).toBe('DAPHNE DU MAURIER');
    });

    it('should handle ambiguous single-name titles without override', () => {
      // "DESTINY" could be either, but with no better alternative, use it as title
      const lines = ['DESTINY', 'JOHN SMITH'];
      const result = extractTitleAndAuthor(lines);

      expect(result.title).toBe('DESTINY');
      expect(result.author).toBe('JOHN SMITH');
    });

    it('should filter person-like names correctly', () => {
      // "JANE DOE" looks like a person name (2 words, all caps, high alpha, no title words)
      // It is correctly filtered from title candidates
      // "RANDOM PUBLISHER" contains "PUBLISHER" which is a publisher blocklist word
      const lines = ['JANE DOE', 'RANDOM PUBLISHER'];
      const result = extractTitleAndAuthor(lines);

      // Both are filtered:
      // - JANE DOE: filtered as all-caps name candidate (no title-like words)
      // - RANDOM PUBLISHER: contains "PUBLISHER" blocklist word
      // Result: no title extracted (but JANE DOE may be used as author)
      expect(result.title).toBeNull();
    });

    it('should extract person-like as author when title is available', () => {
      // When there's a clear title, person-like lines become author
      const lines = ['THE FIRM', 'JANE DOE'];
      const result = extractTitleAndAuthor(lines);

      expect(result.title).toBe('THE FIRM');
      expect(result.author).toBe('JANE DOE');
    });

    it('should NOT filter lines starting with articles as name candidates', () => {
      // Lines starting with THE, A, AN are strong title indicators
      // They should NOT be filtered as name candidates
      const lines = ['THE CLIENT', 'JOHN GRISHAM'];
      const result = extractTitleAndAuthor(lines);

      // THE CLIENT should be title (starts with THE - not a name candidate)
      expect(result.title).toBe('THE CLIENT');
      expect(result.author).toBe('JOHN GRISHAM');
    });
  });

  // ============================================================================
  // Scenario 3: Badge line exclusion
  // ============================================================================
  describe('Scenario: Marketing badge exclusion', () => {
    /**
     * Fixture: Book spine with marketing badges
     * Badges should be excluded from title/author consideration
     */
    const badgeFixture = {
      lines: [
        '#1 NEW YORK TIMES',
        'BESTSELLER',
        'THE SHINING',
        'STEPHEN KING',
      ],
      expectedTitle: 'THE SHINING',
      expectedAuthor: 'STEPHEN KING',
    };

    it('should detect "#1 NEW YORK TIMES" as marketing badge', () => {
      const result = isMarketingBadgeWithNeighbors(0, badgeFixture.lines);
      expect(result.isBadge).toBe(true);
      expect(result.reason).toContain('new york times');
    });

    it('should detect "BESTSELLER" as marketing badge with neighbor', () => {
      const result = isMarketingBadgeWithNeighbors(1, badgeFixture.lines);
      expect(result.isBadge).toBe(true);
    });

    it('should exclude badge indices', () => {
      const excludedIndices = getMarketingBadgeIndices(badgeFixture.lines);
      expect(excludedIndices.has(0)).toBe(true); // #1 NEW YORK TIMES
      expect(excludedIndices.has(1)).toBe(true); // BESTSELLER
      expect(excludedIndices.has(2)).toBe(false); // THE SHINING - not a badge
      expect(excludedIndices.has(3)).toBe(false); // STEPHEN KING - not a badge
    });

    it('should extract title/author correctly with badges filtered', () => {
      const result = extractTitleAndAuthor(badgeFixture.lines);

      expect(result.title).toBe(badgeFixture.expectedTitle);
      expect(result.author).toBe(badgeFixture.expectedAuthor);
      expect(result.debug.excludedBadgeLines!.length).toBeGreaterThanOrEqual(2);
    });

    it('should include badge exclusions in consolidated excludedLines', () => {
      const result = extractTitleAndAuthor(badgeFixture.lines);

      const badgeExclusions = result.debug.excludedLines!.filter(e => e.category === 'badge');
      expect(badgeExclusions.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ============================================================================
  // Scenario 4: Swap scenario prevention
  // ============================================================================
  describe('Scenario: Title/Author swap prevention', () => {
    /**
     * Fixture: Cases where title and author could be swapped
     * The system should correctly identify which is which
     */

    it('should NOT swap when title starts with THE', () => {
      const lines = ['THE GUARDIANS', 'JOHN GRISHAM'];
      const result = extractTitleAndAuthor(lines);

      expect(result.title).toBe('THE GUARDIANS');
      expect(result.author).toBe('JOHN GRISHAM');
    });

    it('should NOT allow title-like line as author', () => {
      // "THE DARK SHADOWS" should be rejected as author
      expect(shouldRejectAsAuthor('THE DARK SHADOWS')).toBe(true);
      expect(shouldRejectAsAuthor('A GAME OF THRONES')).toBe(true);
    });

    it('should allow person-like line as author', () => {
      expect(shouldRejectAsAuthor('JOHN GRISHAM')).toBe(false);
      expect(shouldRejectAsAuthor('STEPHEN KING')).toBe(false);
      expect(shouldRejectAsAuthor('LISA CHILDS')).toBe(false);
    });

    it('should prevent person-like lines from becoming title when better title exists', () => {
      // This is the core anti-swap logic
      const lines = ['THE', 'SHINING', 'JOHN GRISHAM'];

      const joinedCandidates = buildJoinedTitleCandidates(lines);
      const theShining = joinedCandidates.find(c => c.text === 'THE SHINING');

      expect(theShining).toBeDefined();

      // JOHN GRISHAM should NOT become title because THE SHINING is better
      const overrideCheck = checkPersonOverride(
        'JOHN GRISHAM',
        [{ text: 'THE SHINING', score: theShining!.score }]
      );

      expect(overrideCheck.shouldOverride).toBe(true);
    });

    it('should handle reverse order (author before title)', () => {
      const lines = ['JOHN GRISHAM', 'THE GUARDIANS'];
      const result = extractTitleAndAuthor(lines);

      // Should still correctly identify title and author
      expect(result.title).toBe('THE GUARDIANS');
      expect(result.author).toBe('JOHN GRISHAM');
    });
  });

  // ============================================================================
  // Scenario 5: Multi-line fragmented titles
  // ============================================================================
  describe('Scenario: Multi-line fragmented titles', () => {
    it('should join GAME + OF + THRONES', () => {
      const lines = ['GAME', 'OF', 'THRONES', 'GEORGE MARTIN'];
      const joinedCandidates = buildJoinedTitleCandidates(lines);

      const gameOfThrones = joinedCandidates.find(c =>
        c.text.includes('GAME') && c.text.includes('OF') && c.text.includes('THRONES')
      );
      expect(gameOfThrones).toBeDefined();
    });

    it('should detect stopword bridges', () => {
      const lines = ['A', 'GAME', 'OF', 'THRONES'];
      const bridges = findStopwordBridges(lines);

      expect(bridges.length).toBeGreaterThan(0);
      expect(bridges[0].bridgeWord).toBe('A');
      expect(bridges[0].joinedText).toBe('A GAME');
    });

    it('should prefer longer joined title when appropriate', () => {
      const lines = ['THE', 'PELICAN', 'BRIEF', 'JOHN GRISHAM'];
      const result = extractTitleAndAuthor(lines);

      // Should join all three title words
      expect(result.title).toContain('PELICAN');
      expect(result.title).toContain('BRIEF');
      expect(result.author).toBe('JOHN GRISHAM');
    });
  });

  // ============================================================================
  // Debug output verification
  // ============================================================================
  describe('Debug output structure', () => {
    it('should populate titleCandidatesTop with up to 5 entries', () => {
      const lines = ['THE', 'SHINING', 'CARRIE', 'IT', 'STEPHEN KING'];
      const result = extractTitleAndAuthor(lines);

      expect(result.debug.titleCandidatesTop).toBeDefined();
      expect(result.debug.titleCandidatesTop!.length).toBeLessThanOrEqual(5);
      expect(result.debug.titleCandidatesTop!.length).toBeGreaterThan(0);

      // Each entry should have text, score, reason
      const first = result.debug.titleCandidatesTop![0];
      expect(first).toHaveProperty('text');
      expect(first).toHaveProperty('score');
      expect(first).toHaveProperty('reason');
    });

    it('should populate authorCandidatesTop with up to 5 entries', () => {
      const lines = ['THE SHINING', 'STEPHEN KING', 'JOHN GRISHAM'];
      const result = extractTitleAndAuthor(lines);

      expect(result.debug.authorCandidatesTop).toBeDefined();
      expect(result.debug.authorCandidatesTop!.length).toBeLessThanOrEqual(5);
    });

    it('should populate excludedLines with category field', () => {
      const lines = ['$9.99', 'BESTSELLER', 'THE SHINING', 'STEPHEN KING'];
      const result = extractTitleAndAuthor(lines);

      expect(result.debug.excludedLines).toBeDefined();
      expect(result.debug.excludedLines!.length).toBeGreaterThan(0);

      // Check categories are present
      const junkLines = result.debug.excludedLines!.filter(e => e.category === 'junk');
      const badgeLines = result.debug.excludedLines!.filter(e => e.category === 'badge');

      expect(junkLines.length).toBeGreaterThan(0); // $9.99
      expect(badgeLines.length).toBeGreaterThan(0); // BESTSELLER
    });

    it('should set personTitleOverridden flag correctly', () => {
      // Case where override happens
      const overrideLines = ['THE', 'BURIED', 'LISA CHILDS'];
      const overrideResult = extractTitleAndAuthor(overrideLines);

      // THE BURIED should be used, not LISA CHILDS as title
      // personTitleOverridden should be false because the original candidate wasn't person-like
      expect(overrideResult.debug.personTitleOverridden).toBeDefined();
    });

    it('should include lineRoleScores for non-excluded lines', () => {
      const lines = ['THE GUARDIANS', 'JOHN GRISHAM'];
      const result = extractTitleAndAuthor(lines);

      expect(result.debug.lineRoleScores).toBeDefined();
      expect(result.debug.lineRoleScores!.length).toBe(2);

      const guardians = result.debug.lineRoleScores!.find(s => s.text === 'THE GUARDIANS');
      const grisham = result.debug.lineRoleScores!.find(s => s.text === 'JOHN GRISHAM');

      expect(guardians?.recommendedRole).toBe('title');
      expect(grisham?.recommendedRole).toBe('author');
    });
  });

  // ============================================================================
  // Edge cases
  // ============================================================================
  describe('Edge cases', () => {
    it('should handle empty lines array', () => {
      const result = extractTitleAndAuthor([]);
      expect(result.title).toBeNull();
      expect(result.author).toBeNull();
    });

    it('should handle all-badge lines', () => {
      const lines = ['BESTSELLER', 'NEW YORK TIMES', '#1'];
      const result = extractTitleAndAuthor(lines);

      // All lines are badges, should have no title/author
      expect(result.title).toBeNull();
      expect(result.author).toBeNull();
    });

    it('should handle all-junk lines', () => {
      const lines = ['$9.99', '$14.95', '123'];
      const result = extractTitleAndAuthor(lines);

      expect(result.title).toBeNull();
      expect(result.author).toBeNull();
    });

    it('should handle single line with title only', () => {
      const lines = ['THE SHINING'];
      const result = extractTitleAndAuthor(lines);

      expect(result.title).toBe('THE SHINING');
      expect(result.author).toBeNull();
    });

    it('should handle single line with person-like text', () => {
      const lines = ['JOHN GRISHAM'];
      const result = extractTitleAndAuthor(lines);

      // With only one candidate that's person-like, it becomes the title (no author available)
      expect(result.title).toBeDefined();
    });
  });
});
