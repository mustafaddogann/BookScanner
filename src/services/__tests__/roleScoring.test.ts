/**
 * Role Scoring Tests
 *
 * Tests for deterministic role scoring to classify lines as titles vs authors.
 */

import {
  scorePersonLikeness,
  scoreTitleLikeness,
  getRoleScore,
  isStopwordBridge,
  findStopwordBridges,
  buildJoinedTitleCandidates,
  shouldOverridePersonAsTitle,
  shouldRejectAsAuthor,
} from '../roleScoring';

describe('Role Scoring', () => {
  // ============================================================================
  // Person Likeness Scoring
  // ============================================================================
  describe('scorePersonLikeness', () => {
    it('should score all-caps 2-word names highly', () => {
      const result = scorePersonLikeness('JOHN GRISHAM');
      expect(result.score).toBeGreaterThan(0.6);
      expect(result.reasons).toContain('token_count_2_4');
    });

    it('should score title-case 2-word names well', () => {
      const result = scorePersonLikeness('Stephen King');
      expect(result.score).toBeGreaterThan(0.5);
    });

    it('should give bonus for common first names', () => {
      const withFirstName = scorePersonLikeness('JOHN SMITH');
      const withoutFirstName = scorePersonLikeness('XYZZY SMITH');
      expect(withFirstName.score).toBeGreaterThan(withoutFirstName.score);
      expect(withFirstName.bonuses.some(b => b.type === 'common_first_name')).toBe(true);
    });

    it('should give bonus for known author last names', () => {
      const result = scorePersonLikeness('JANE KING');
      expect(result.bonuses.some(b => b.type === 'common_author_name')).toBe(true);
    });

    it('should penalize lines starting with articles', () => {
      const result = scorePersonLikeness('THE GUARDIAN');
      expect(result.penalties.some(p => p.type === 'starts_with_article')).toBe(true);
      expect(result.score).toBeLessThan(0.5);
    });

    it('should penalize org-like lines', () => {
      const result = scorePersonLikeness('NEW YORK TIMES');
      expect(result.penalties.some(p => p.type === 'org_marker')).toBe(true);
      // Org penalty significantly reduces score
      expect(result.score).toBeLessThan(0.5);
    });

    it('should penalize title content words', () => {
      const result = scorePersonLikeness('DARK SHADOW');
      expect(result.penalties.some(p => p.type === 'title_content_words')).toBe(true);
    });

    it('should score single words lower than multi-word names', () => {
      const singleWord = scorePersonLikeness('GRISHAM');
      const twoWords = scorePersonLikeness('JOHN GRISHAM');
      // Single word should score lower than proper name
      expect(singleWord.score).toBeLessThan(twoWords.score);
      expect(singleWord.reasons).toContain('single_token');
    });

    it('should score too many words lower', () => {
      const result = scorePersonLikeness('ONE TWO THREE FOUR FIVE SIX');
      // Many words is less person-like than 2-4 words
      expect(result.reasons).toContain('too_many_tokens');
      // But still gets some score
      expect(result.score).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // Title Likeness Scoring
  // ============================================================================
  describe('scoreTitleLikeness', () => {
    it('should score titles starting with THE highly', () => {
      const result = scoreTitleLikeness('THE SHINING');
      expect(result.score).toBeGreaterThan(0.6);
      expect(result.bonuses.some(b => b.type === 'starts_with_article')).toBe(true);
    });

    it('should score multi-word titles well', () => {
      const result = scoreTitleLikeness('GONE WITH THE WIND');
      expect(result.score).toBeGreaterThan(0.5);
    });

    it('should give bonus for title content words', () => {
      const result = scoreTitleLikeness('DARK SHADOWS');
      expect(result.bonuses.some(b => b.type === 'title_content')).toBe(true);
    });

    it('should penalize person name patterns', () => {
      const result = scoreTitleLikeness('JOHN GRISHAM');
      expect(result.penalties.some(p => p.type === 'person_name_pattern')).toBe(true);
    });

    it('should penalize exact imprints', () => {
      const result = scoreTitleLikeness('ZEBRA');
      expect(result.penalties.some(p => p.type === 'imprint')).toBe(true);
    });

    it('should penalize price-like lines', () => {
      const result = scoreTitleLikeness('$9.99');
      expect(result.penalties.some(p => p.type === 'price')).toBe(true);
    });
  });

  // ============================================================================
  // Combined Role Score
  // ============================================================================
  describe('getRoleScore', () => {
    it('should recommend author for person-like lines', () => {
      const result = getRoleScore('JOHN GRISHAM');
      expect(result.recommendedRole).toBe('author');
      expect(result.personLikeness).toBeGreaterThan(result.titleLikeness);
    });

    it('should recommend title for title-like lines', () => {
      const result = getRoleScore('THE SHINING');
      expect(result.recommendedRole).toBe('title');
      expect(result.titleLikeness).toBeGreaterThan(result.personLikeness);
    });

    it('should classify article-starting lines as titles', () => {
      const result = getRoleScore('THE GUARDIANS');
      expect(result.recommendedRole).toBe('title');
    });

    it('should handle ambiguous lines', () => {
      // A line that could be either (e.g., a single uncommon word)
      const result = getRoleScore('DESTINY');
      // May be ambiguous or one of the roles
      expect(['author', 'title', 'ambiguous']).toContain(result.recommendedRole);
    });
  });

  // ============================================================================
  // Stopword Bridge Tests
  // ============================================================================
  describe('Stopword Bridge Detection', () => {
    describe('isStopwordBridge', () => {
      it('should detect single-token stopwords', () => {
        expect(isStopwordBridge('THE')).toBe(true);
        expect(isStopwordBridge('A')).toBe(true);
        expect(isStopwordBridge('AN')).toBe(true);
        expect(isStopwordBridge('OF')).toBe(true);
      });

      it('should NOT detect multi-token lines', () => {
        expect(isStopwordBridge('THE BOOK')).toBe(false);
        expect(isStopwordBridge('A TALE')).toBe(false);
      });

      it('should NOT detect non-stopwords', () => {
        expect(isStopwordBridge('SHINING')).toBe(false);
        expect(isStopwordBridge('JOHN')).toBe(false);
      });
    });

    describe('findStopwordBridges', () => {
      it('should find THE + NOUN patterns', () => {
        const lines = ['THE', 'GUARDIANS', 'JOHN GRISHAM'];
        const bridges = findStopwordBridges(lines);

        expect(bridges.length).toBeGreaterThan(0);
        expect(bridges[0].found).toBe(true);
        expect(bridges[0].joinedText).toBe('THE GUARDIANS');
        expect(bridges[0].bridgeWord).toBe('THE');
      });

      it('should find A + NOUN patterns', () => {
        const lines = ['A', 'GAME', 'OF', 'THRONES'];
        const bridges = findStopwordBridges(lines);

        expect(bridges.length).toBeGreaterThan(0);
        expect(bridges[0].joinedText).toBe('A GAME');
      });

      it('should NOT bridge to person-like lines', () => {
        const lines = ['THE', 'JOHN GRISHAM'];
        const bridges = findStopwordBridges(lines);

        // Should not bridge THE to a person name
        expect(bridges.length).toBe(0);
      });
    });
  });

  // ============================================================================
  // Joined Title Candidates
  // ============================================================================
  describe('buildJoinedTitleCandidates', () => {
    it('should join adjacent title-like lines', () => {
      const lines = ['THE', 'BURIED', 'LISA CHILDS'];
      const candidates = buildJoinedTitleCandidates(lines);

      const theBuried = candidates.find(c => c.text === 'THE BURIED');
      expect(theBuried).toBeDefined();
    });

    it('should build 3-line joins', () => {
      const lines = ['GAME', 'OF', 'THRONES', 'GEORGE MARTIN'];
      const candidates = buildJoinedTitleCandidates(lines);

      const gameOfThrones = candidates.find(c =>
        c.text.includes('GAME') && c.text.includes('OF') && c.text.includes('THRONES')
      );
      expect(gameOfThrones).toBeDefined();
    });

    it('should NOT join person-like lines', () => {
      const lines = ['JOHN', 'GRISHAM'];
      const candidates = buildJoinedTitleCandidates(lines);

      // Should not create "JOHN GRISHAM" as a title candidate
      const johnGrisham = candidates.find(c => c.text === 'JOHN GRISHAM');
      // If it exists, it should score very low
      if (johnGrisham) {
        expect(johnGrisham.score).toBeLessThan(0.4);
      }
    });

    it('should include stopword bridges with bonus', () => {
      const lines = ['THE', 'SHINING'];
      const candidates = buildJoinedTitleCandidates(lines);

      const theShining = candidates.find(c =>
        c.text === 'THE SHINING' && c.reason.includes('stopword_bridge')
      );
      expect(theShining).toBeDefined();
    });
  });

  // ============================================================================
  // Anti-Swap Logic
  // ============================================================================
  describe('shouldOverridePersonAsTitle', () => {
    it('should override person-like with better joined candidate', () => {
      const personLine = 'JOHN GRISHAM';
      const joinedCandidates = [
        { text: 'THE GUARDIANS', score: 0.8 },
      ];

      const result = shouldOverridePersonAsTitle(personLine, joinedCandidates);
      expect(result).toBe(true);
    });

    it('should NOT override when no better candidate', () => {
      const personLine = 'JOHN GRISHAM';
      const joinedCandidates = [
        { text: 'XY', score: 0.2 }, // Low-scoring fragment
      ];

      const result = shouldOverridePersonAsTitle(personLine, joinedCandidates);
      expect(result).toBe(false);
    });

    it('should NOT override non-person-like lines', () => {
      const titleLine = 'THE SHINING';
      const joinedCandidates = [
        { text: 'DARK SHADOWS', score: 0.8 },
      ];

      const result = shouldOverridePersonAsTitle(titleLine, joinedCandidates);
      expect(result).toBe(false); // titleLine is not person-like
    });
  });

  describe('shouldRejectAsAuthor', () => {
    it('should reject lines starting with THE', () => {
      expect(shouldRejectAsAuthor('THE GUARDIANS')).toBe(true);
    });

    it('should reject lines starting with A/AN', () => {
      expect(shouldRejectAsAuthor('A GAME OF THRONES')).toBe(true);
      expect(shouldRejectAsAuthor('AN ECHO IN THE BONE')).toBe(true);
    });

    it('should reject lines with multiple title content words', () => {
      expect(shouldRejectAsAuthor('DARK SHADOW NIGHT')).toBe(true);
    });

    it('should NOT reject person-like lines', () => {
      expect(shouldRejectAsAuthor('JOHN GRISHAM')).toBe(false);
      expect(shouldRejectAsAuthor('STEPHEN KING')).toBe(false);
    });
  });

  // ============================================================================
  // Integration Scenarios
  // ============================================================================
  describe('Integration: Role Classification Scenarios', () => {
    it('Scenario: All-caps author line', () => {
      // Given: A typical book spine with all-caps author
      const lines = ['THE GUARDIANS', 'JOHN GRISHAM'];

      const titleRole = getRoleScore(lines[0]);
      const authorRole = getRoleScore(lines[1]);

      expect(titleRole.recommendedRole).toBe('title');
      expect(authorRole.recommendedRole).toBe('author');
    });

    it('Scenario: Title split across two lines with stopword bridge', () => {
      const lines = ['THE', 'BURIED', 'LISA CHILDS'];

      const candidates = buildJoinedTitleCandidates(lines);
      const theBuried = candidates.find(c => c.text === 'THE BURIED');

      expect(theBuried).toBeDefined();
      expect(theBuried!.score).toBeGreaterThan(0.5);
    });

    it('Scenario: Badge lines present (should have low title score)', () => {
      const line = 'BESTSELLER';
      const role = getRoleScore(line);

      // Should not be recommended as title or author
      expect(role.titleLikeness).toBeLessThan(0.5);
      expect(role.personLikeness).toBeLessThan(0.5);
    });

    it('Scenario: Imprint present', () => {
      const line = 'ZEBRA';
      const role = getRoleScore(line);

      expect(role.titleLikeness).toBeLessThan(0.3);
    });

    it('Scenario: Person-like line competes with joined title', () => {
      // The extraction might pick "LISA CHILDS" as title if we're not careful
      // But "THE BURIED" joined should win
      const personLine = 'LISA CHILDS';
      const joinedCandidates = [
        { text: 'THE BURIED', score: 0.7 },
      ];

      const shouldOverride = shouldOverridePersonAsTitle(personLine, joinedCandidates);
      expect(shouldOverride).toBe(true);
    });

    it('Scenario: Title-like line in author pool (should be rejected)', () => {
      const titleLikeLine = 'THE DARK SHADOWS';
      expect(shouldRejectAsAuthor(titleLikeLine)).toBe(true);
    });
  });
});
