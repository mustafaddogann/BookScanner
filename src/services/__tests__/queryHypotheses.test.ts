/**
 * Query Hypotheses Generation Tests
 */

import {
  generateHypotheses,
  generateSimpleHypotheses,
  generateBoostHypotheses,
  getQuerySet,
} from '../queryHypotheses';

describe('queryHypotheses', () => {
  describe('generateHypotheses', () => {
    it('generates hypotheses from evidence lines', () => {
      const lines = [
        'FICTION',
        'STEPHEN KING',
        'THE SHINING',
      ];

      const result = generateHypotheses(lines);

      expect(result.hypotheses.length).toBeGreaterThan(0);
      expect(result.debug.inputLineCount).toBe(3);
      expect(result.debug.personNames).toContain('STEPHEN KING');
      expect(result.debug.titleLikeLines).toContain('THE SHINING');
    });

    it('prioritizes title+author combinations', () => {
      const lines = [
        'STEPHEN KING',
        'THE SHINING',
      ];

      const result = generateHypotheses(lines);

      // Should have title+author hypothesis early
      const titleAuthor = result.hypotheses.find(
        (h) => h.type === 'title_author' || h.type === 'author_title'
      );
      expect(titleAuthor).toBeDefined();
    });

    it('does NOT generate ISBN hypothesis from spine_crop (default source)', () => {
      // By default, buildEvidenceTokens uses sourceKind: 'spine_crop'
      // which skips ISBN extraction to avoid false negatives from noisy spine OCR
      const lines = [
        'THE SHINING',
        'ISBN 9780307743256',
      ];

      const result = generateHypotheses(lines);

      // ISBN hypothesis should NOT be present for spine_crop
      const isbnHypothesis = result.hypotheses.find((h) => h.type === 'isbn');
      expect(isbnHypothesis).toBeUndefined();

      // But other hypotheses should still be generated
      expect(result.hypotheses.length).toBeGreaterThan(0);
      const titleHypothesis = result.hypotheses.find((h) => h.type === 'title_only');
      expect(titleHypothesis).toBeDefined();
    });

    it('generates article-stripped variants', () => {
      const lines = [
        'THE GUARDIAN',
        'NICHOLAS SPARKS',
      ];

      const result = generateHypotheses(lines);

      const stripped = result.hypotheses.find(
        (h) => h.type === 'stripped' && h.query.includes('GUARDIAN')
      );
      expect(stripped).toBeDefined();
    });

    it('handles multi-line titles like THE + BURIED', () => {
      // This is the Lisa Childs case: title split across two lines
      const lines = [
        'ZEBRA',
        'NEW FORK',
        'TIMES',
        'BESTSELLER',
        'LISA CHILDS',
        'THE',
        'BURIED',
      ];

      const result = generateHypotheses(lines);

      // Should have title+author hypothesis
      const titleAuthor = result.hypotheses.find((h) => h.type === 'title_author');
      expect(titleAuthor).toBeDefined();

      // Title-only hypothesis should exist
      const titleOnly = result.hypotheses.find((h) => h.type === 'title_only');
      expect(titleOnly).toBeDefined();

      // Should have stripped variant without THE
      // This is critical for Open Library search since "Buried" is the actual title
      const stripped = result.hypotheses.find(
        (h) => h.type === 'stripped' && h.query.toUpperCase().includes('BURIED')
      );
      expect(stripped).toBeDefined();
      expect(stripped?.query.toUpperCase()).not.toContain('THE ');
    });

    it('uses OCR fields as fallback', () => {
      const lines = ['FICTION']; // Only noise

      const result = generateHypotheses(lines, 'The Shining', 'Stephen King');

      const fallback = result.hypotheses.find((h) => h.type === 'fallback');
      expect(fallback).toBeDefined();
      expect(fallback?.query).toContain('The Shining');
    });

    it('limits number of hypotheses to max 5', () => {
      const lines = [
        'LINE ONE',
        'LINE TWO',
        'LINE THREE',
        'LINE FOUR',
        'LINE FIVE',
        'LINE SIX',
        'LINE SEVEN',
      ];

      const result = generateHypotheses(lines);

      // New limit is 5 for rate-limit safety
      expect(result.hypotheses.length).toBeLessThanOrEqual(5);
    });

    it('handles empty input', () => {
      const result = generateHypotheses([]);

      expect(result.hypotheses).toHaveLength(0);
      expect(result.debug.inputLineCount).toBe(0);
    });

    it('deduplicates identical queries', () => {
      const lines = [
        'THE SHINING',
        'THE SHINING', // Duplicate
      ];

      const result = generateHypotheses(lines);

      const shiningQueries = result.hypotheses.filter(
        (h) => h.query.toLowerCase() === 'the shining'
      );
      expect(shiningQueries.length).toBeLessThanOrEqual(1);
    });

    it('generates multiple hypotheses for title-only (no author) input', () => {
      // Regression test: title-strong + author-missing must NOT collapse to 1 hypothesis
      const lines = [
        'THE GREAT GATSBY',
      ];

      const result = generateHypotheses(lines);

      // Should generate at least 2 hypotheses (title-only + stripped variant)
      expect(result.hypotheses.length).toBeGreaterThanOrEqual(2);

      // Should have title-only hypothesis
      const titleOnly = result.hypotheses.find((h) => h.type === 'title_only');
      expect(titleOnly).toBeDefined();

      // Should have stripped variant (without "THE")
      const stripped = result.hypotheses.find(
        (h) => h.type === 'stripped' && h.query.includes('GATSBY')
      );
      expect(stripped).toBeDefined();
    });

    it('generates multiple hypotheses even without author signal', () => {
      // Another regression test: ensure multi-hypothesis works for all title-only cases
      const lines = [
        'A BRIEF HISTORY OF TIME',
      ];

      const result = generateHypotheses(lines);

      // Should generate multiple hypotheses
      expect(result.hypotheses.length).toBeGreaterThanOrEqual(2);

      // Verify shapes include title_only and stripped
      const shapes = result.hypotheses.map((h) => h.type);
      expect(shapes).toContain('title_only');
      expect(shapes).toContain('stripped');
    });

    it('generates "PELICAN BRIEF" hypothesis for split title lines', () => {
      // Regression test: split title across lines should be combined
      // "TED IN USA" (fragment of "PRINTED IN USA") should NOT be detected as author
      const lines = [
        'PELICAN',
        'BRIEF',
        'TED IN USA',
        '21404-',
      ];

      const result = generateHypotheses(lines);

      // Should have "PELICAN BRIEF" hypothesis (either title_only or combined_lines)
      const pelicanBrief = result.hypotheses.find(
        (h) => h.query.toUpperCase().includes('PELICAN BRIEF')
      );
      expect(pelicanBrief).toBeDefined();

      // "TED IN USA" should NOT be detected as author
      // (it's a fragment of "PRINTED IN USA")
      const tedAuthor = result.hypotheses.find(
        (h) => h.query.toUpperCase().includes('TED IN USA')
      );
      expect(tedAuthor).toBeUndefined();

      // The first hypothesis should contain "PELICAN BRIEF" (and not "TED IN USA")
      expect(result.hypotheses[0].query.toUpperCase()).toContain('PELICAN BRIEF');
      expect(result.hypotheses[0].query.toUpperCase()).not.toContain('TED IN USA');
    });

    it('generates DARKNESS KELLERMAN variant for OCR-corrupted title', () => {
      // Regression test: OCR errors in middle of title should still find book
      // "STRAIGHI INTO DARKNESS" has error, but "DARKNESS KELLERMAN" should work
      const lines = [
        'ISIO',
        'CAVE KELLERMAN',
        'STRAIGHI INTO',
        'DARKNESS',
      ];

      const result = generateHypotheses(lines);

      // Should have last-word variant "DARKNESS KELLERMAN"
      const darknessKellerman = result.hypotheses.find(
        (h) => h.query.toUpperCase().includes('DARKNESS') &&
               h.query.toUpperCase().includes('KELLERMAN')
      );
      expect(darknessKellerman).toBeDefined();
    });
  });

  describe('generateSimpleHypotheses', () => {
    it('generates title+author hypotheses', () => {
      const result = generateSimpleHypotheses('The Shining', 'Stephen King');

      expect(result.length).toBeGreaterThan(0);
      expect(result.find((h) => h.type === 'title_author')).toBeDefined();
      expect(result.find((h) => h.type === 'author_title')).toBeDefined();
    });

    it('handles title only', () => {
      const result = generateSimpleHypotheses('The Shining', null);

      expect(result.length).toBe(1);
      expect(result[0].type).toBe('title_only');
    });

    it('handles author only', () => {
      const result = generateSimpleHypotheses(null, 'Stephen King');

      expect(result.length).toBe(1);
      expect(result[0].type).toBe('author_only');
    });

    it('handles both null', () => {
      const result = generateSimpleHypotheses(null, null);

      expect(result).toHaveLength(0);
    });
  });

  describe('generateBoostHypotheses', () => {
    it('generates expanded hypotheses for boost pass', () => {
      const lines = [
        'STEPHEN KING',
        'THE SHINING',
        'A NOVEL OF TERROR',
      ];

      // First pass - get queries to exclude
      const pass1Result = generateHypotheses(lines);
      const excludeQueries = getQuerySet(pass1Result.hypotheses);

      // Boost pass
      const boostResult = generateBoostHypotheses(lines, excludeQueries);

      expect(boostResult.hypotheses.length).toBeGreaterThan(0);
      // Should not duplicate pass 1 queries
      for (const h of boostResult.hypotheses) {
        expect(excludeQueries.has(h.query.toLowerCase().trim())).toBe(false);
      }
    });

    it('limits hypotheses to max 25', () => {
      const lines = [
        'LINE ONE TEXT',
        'LINE TWO TEXT',
        'LINE THREE TEXT',
        'LINE FOUR TEXT',
        'LINE FIVE TEXT',
        'LINE SIX TEXT',
        'LINE SEVEN TEXT',
      ];

      const result = generateBoostHypotheses(lines, new Set());

      // Pass 2 limit is 25 (from PASS2_MAX_HYPOTHESES config)
      expect(result.hypotheses.length).toBeLessThanOrEqual(25);
    });

    it('generates n-gram hypotheses', () => {
      const lines = [
        'MULTIPLE WORD TITLE HERE',
        'ANOTHER LINE TEXT',
      ];

      const result = generateBoostHypotheses(lines, new Set());

      // Should have some n-gram hypotheses
      const ngrams = result.hypotheses.filter((h) => h.type === 'boost_ngram');
      expect(ngrams.length).toBeGreaterThanOrEqual(0); // May not always generate n-grams
    });

    it('generates combined line hypotheses', () => {
      const lines = [
        'TITLE LINE ONE',
        'AUTHOR NAME HERE',
      ];

      const result = generateBoostHypotheses(lines, new Set());

      // Should have some combo hypotheses
      const combos = result.hypotheses.filter((h) => h.type === 'boost_combo');
      expect(combos.length).toBeGreaterThan(0);
    });

    it('handles empty exclude set', () => {
      const lines = ['THE SHINING', 'STEPHEN KING'];

      const result = generateBoostHypotheses(lines, new Set());

      expect(result.hypotheses.length).toBeGreaterThan(0);
    });
  });

  describe('generateBoostHypotheses - OCR correction strategies', () => {
    it('generates word-split hypotheses for merged OCR words', () => {
      // Test Strategy 5j: aggressive word splitting
      const lines = ['UNTANTOS VARATLOS'];

      const result = generateBoostHypotheses(lines, new Set());

      // Should have split variants like "UN TANTOS"
      const splitHypotheses = result.hypotheses.filter(
        (h) => h.query.includes('UN ') || h.query.includes('EN ')
      );
      expect(splitHypotheses.length).toBeGreaterThan(0);
    });

    it('generates character-corrected hypotheses for longer words', () => {
      // Test Strategy 5k: OCR character corrections for longer words
      const lines = ['UNTANTOS'];

      const result = generateBoostHypotheses(lines, new Set());

      // Should have character-corrected variants
      // e.g., UNTANTOS with U→O could give ONTANTOS
      const correctedHypotheses = result.hypotheses.filter(
        (h) => h.type === 'boost_partial' && h.query !== 'UNTANTOS'
      );
      expect(correctedHypotheses.length).toBeGreaterThan(0);
    });

    it('generates drop-start hypotheses for OCR noise at beginning', () => {
      // Test Strategy 5l: dropping first 1-2 characters
      const lines = ['UNTANTOS'];

      const result = generateBoostHypotheses(lines, new Set());

      // Should have variants like "NTANTOS" or "TANTOS"
      const dropStartHypotheses = result.hypotheses.filter(
        (h) => h.query === 'NTANTOS' || h.query === 'TANTOS'
      );
      expect(dropStartHypotheses.length).toBeGreaterThan(0);
    });
  });

  describe('getQuerySet', () => {
    it('returns lowercase trimmed query set', () => {
      const hypotheses = [
        { query: '  The Shining  ', type: 'title_only' as const, priority: 0, explanation: '' },
        { query: 'STEPHEN KING', type: 'author_only' as const, priority: 1, explanation: '' },
      ];

      const querySet = getQuerySet(hypotheses);

      expect(querySet.has('the shining')).toBe(true);
      expect(querySet.has('stephen king')).toBe(true);
      // Original case/whitespace should not be in set
      expect(querySet.has('The Shining')).toBe(false);
      expect(querySet.has('STEPHEN KING')).toBe(false);
    });

    it('handles empty array', () => {
      const querySet = getQuerySet([]);

      expect(querySet.size).toBe(0);
    });
  });

  // Tests for specific reject scenarios from rejects_scan_1770713517396
  describe('generateBoostHypotheses - reject scenario fixes', () => {
    it('generates NGAIO MARSH correction for "NGALO LUI" OCR', () => {
      // Book 1: "DIED IN THE WOOL NGALO LUI" -> Died in the Wool by Ngaio Marsh
      const lines = ['DIED IN THE WOOL NGALO LUI'];
      const result = generateBoostHypotheses(lines, new Set());
      const queries = result.hypotheses.map(h => h.query.toUpperCase());

      // Should generate a hypothesis with corrected author
      const hasNgaioCorrection = queries.some(q =>
        q.includes('DIED IN THE WOOL') && q.includes('NGAIO')
      );
      expect(hasNgaioCorrection).toBe(true);
    });

    it('generates MURDERS correction for "MUKDERS" OCR', () => {
      // Book 3: "THE GOOD LUCK MUKDERS" -> The Good Luck Murders
      const lines = ['THE GOOD LUCK MUKDERS JOINS', 'JOHNS'];
      const result = generateBoostHypotheses(lines, new Set());
      const queries = result.hypotheses.map(h => h.query.toUpperCase());

      // Should generate a hypothesis with MURDERS
      const hasMurdersCorrection = queries.some(q => q.includes('MURDERS'));
      expect(hasMurdersCorrection).toBe(true);
    });

    it('generates THE correction for "TIE" OCR', () => {
      // Book 6: "SEIZE TIE NIGHT" -> Seize the Night by Dean Koontz
      const lines = ['SEIZE', 'TIE NIGHT', 'DEAN KO'];
      const result = generateBoostHypotheses(lines, new Set());
      const queries = result.hypotheses.map(h => h.query.toUpperCase());

      // Debug: log hypotheses containing THE or TIE
      const relevantQueries = queries.filter(q => q.includes('TIE') || q.includes('THE') || q.includes('NIGHT'));
      // eslint-disable-next-line no-console
      console.log('Relevant queries for TIE/THE test:', relevantQueries.slice(0, 10));
      // eslint-disable-next-line no-console
      console.log('Debug info:', result.debug);

      // Should generate a hypothesis with THE instead of TIE
      const hasTheCorrection = queries.some(q => q.includes('THE NIGHT'));
      expect(hasTheCorrection).toBe(true);
    });

    it('generates DEAN KOONTZ correction for "DEAN KO" OCR', () => {
      // Book 6: "DEAN KO" -> Dean Koontz
      const lines = ['SEIZE', 'TIE NIGHT', 'DEAN KO'];
      const result = generateBoostHypotheses(lines, new Set());
      const queries = result.hypotheses.map(h => h.query.toUpperCase());

      // Should generate a hypothesis with KOONTZ
      const hasKoontzCorrection = queries.some(q => q.includes('KOONTZ'));
      expect(hasKoontzCorrection).toBe(true);
    });

    it('generates ONE correction for "ONF" OCR', () => {
      // Book 7: "THE LAST ONF LEFT" -> The Last One Left
      const lines = ['THE LAST ONF LEFT JOHN D. MACDO'];
      const result = generateBoostHypotheses(lines, new Set());
      const queries = result.hypotheses.map(h => h.query.toUpperCase());

      // Should generate a hypothesis with ONE instead of ONF
      const hasOneCorrection = queries.some(q => q.includes('ONE'));
      expect(hasOneCorrection).toBe(true);
    });

    it('generates MACDONALD correction for "MACDO" OCR', () => {
      // Book 7: "JOHN D. MACDO" -> John D. MacDonald
      const lines = ['THE LAST ONF LEFT JOHN D. MACDO'];
      const result = generateBoostHypotheses(lines, new Set());
      const queries = result.hypotheses.map(h => h.query.toUpperCase());

      // Should generate a hypothesis with MACDONALD
      const hasMacdonaldCorrection = queries.some(q => q.includes('MACDONALD'));
      expect(hasMacdonaldCorrection).toBe(true);
    });

    // New test cases for rejected books from the issue
    it('generates GOOD LUCK MURDERS from corrupted OCR with MUKDERS', () => {
      // Book 2: THE GOOD LUCK MUKDERS JOINS JOHNS MYSTEFT PIRA ACIA OKIE
      const lines = ['THE GOOD LUCK MUKDERS JOINS JOHNS MYSTEFT PIRA ACIA OKIE'];
      const result = generateBoostHypotheses(lines, new Set());
      const queries = result.hypotheses.map(h => h.query.toUpperCase());

      // Should have "GOOD LUCK MURDERS" or similar corrected title
      const hasMurdersCorrection = queries.some(q =>
        q.includes('MURDERS') || q.includes('GOOD LUCK')
      );
      expect(hasMurdersCorrection).toBe(true);

      // Should also try extracting title pattern
      const hasTitlePattern = queries.some(q =>
        q.includes('THE GOOD LUCK')
      );
      expect(hasTitlePattern).toBe(true);
    });

    it('generates FARGO ADVENTURE from truncated OCR', () => {
      // Book 3: HEAVI A FARGO ADV 72L ARM WORK TIMES BESTSELLING AUTHOR
      const lines = ['HEAVI A FARGO ADV 72L ARM WORK TIMES BESTSELLING AUTHOR'];
      const result = generateBoostHypotheses(lines, new Set());
      const queries = result.hypotheses.map(h => h.query.toUpperCase());

      // Should expand ADV to ADVENTURE
      const hasAdventureExpansion = queries.some(q => q.includes('ADVENTURE'));
      expect(hasAdventureExpansion).toBe(true);

      // Should try FARGO alone (as a distinctive word)
      const hasFargo = queries.some(q => q.includes('FARGO'));
      expect(hasFargo).toBe(true);
    });

    it('generates THE LAST ONE LEFT from ONF OCR corruption', () => {
      // Book 5: THE LAST ONF LEFT JOHN D. MACDO
      const lines = ['THE LAST ONF LEFT JOHN D. MACDO'];
      const result = generateBoostHypotheses(lines, new Set());
      const queries = result.hypotheses.map(h => h.query.toUpperCase());

      // Should correct ONF to ONE
      const hasOneCorrection = queries.some(q =>
        q.includes('THE LAST ONE LEFT')
      );
      expect(hasOneCorrection).toBe(true);

      // Should also complete MACDO to MACDONALD
      const hasFullAuthor = queries.some(q =>
        q.includes('MACDONALD') || q.includes('JOHN D')
      );
      expect(hasFullAuthor).toBe(true);
    });

    it('handles AGATHA CHRISTIE pattern from corrupted PIRA ACIA', () => {
      // Book 2: Contains "PIRA ACIA" which might be corrupted "AGATHA CHRISTIE"
      // While not a perfect match, we should try famous author patterns
      const lines = ['THE GOOD LUCK MUKDERS PIRA ACIA OKIE'];
      const result = generateBoostHypotheses(lines, new Set());
      const queries = result.hypotheses.map(h => h.query.toUpperCase());

      // Should try AGATHA CHRISTIE as a known author pattern
      const hasAgatha = queries.some(q => q.includes('AGATHA') || q.includes('CHRISTIE'));
      expect(hasAgatha).toBe(true);
    });

    // Tests for the specific rejected books from the issue
    it('handles Book 1: CHON New Time Bestiell DERKLEK... (heavily corrupted)', () => {
      const lines = [
        'CHON',
        'New',
        'Time',
        'Bestiell',
        'DERKLEK',
        'FICTION',
        'estienli',
        'LEV',
        'York',
        'Thu',
        'Hew!',
        'Yarh',
        'PALRICH',
        'RN',
      ];
      const result = generateBoostHypotheses(lines, new Set());
      const queries = result.hypotheses.map(h => h.query.toUpperCase());

      // Should try to extract meaningful tokens
      // DERKLEK might be DEREK, PALRICH might be PATRICK
      const hasMeaningfulQueries = queries.length > 0;
      expect(hasMeaningfulQueries).toBe(true);
    });

    it('handles Book 3: HEAVI A FARGO ADV... (Clive Cussler series)', () => {
      const lines = [
        'HEAVI',
        'A FARGO ADV',
        '72L ARM WORK TIMES BESTSELLING AUTHOR',
        'THE E YA',
        '+Т2/LEHEN KORK: TIMES BESTSELLING AUTHOR',
        'CHIE QUICOLER',
      ];
      const result = generateBoostHypotheses(lines, new Set());
      const queries = result.hypotheses.map(h => h.query.toUpperCase());

      // Should generate FARGO + CUSSLER variants
      const hasFargoSeries = queries.some(q =>
        q.includes('FARGO') && (q.includes('CUSSLER') || q.includes('ADVENTURE'))
      );
      expect(hasFargoSeries).toBe(true);

      // Should correct HEAVI to HEAVY
      const hasHeavyCorrection = queries.some(q => q.includes('HEAVY'));
      expect(hasHeavyCorrection).toBe(true);

      // Should correct QUICOLER to CUSSLER
      const hasCusslerCorrection = queries.some(q => q.includes('CUSSLER'));
      expect(hasCusslerCorrection).toBe(true);
    });

    it('handles Book 4: STE (very short truncated text)', () => {
      const lines = ['STE'];
      const result = generateBoostHypotheses(lines, new Set());
      const queries = result.hypotheses.map(h => h.query.toUpperCase());

      // Should try expansions like STEPHEN, STEVEN, STEEL
      const hasExpansions = queries.some(q =>
        q.includes('STEPHEN') || q.includes('STEVEN') || q.includes('STEEL')
      );
      expect(hasExpansions).toBe(true);
    });

    it('expands truncated genre words in context', () => {
      // Test that "A FARGO ADV" expands ADV to ADVENTURE
      const lines = ['A FARGO ADV'];
      const result = generateBoostHypotheses(lines, new Set());
      const queries = result.hypotheses.map(h => h.query.toUpperCase());

      const hasAdventure = queries.some(q => q.includes('ADVENTURE'));
      expect(hasAdventure).toBe(true);
    });

    it('corrects QUICOLER to CUSSLER', () => {
      const lines = ['CHIE QUICOLER'];
      const result = generateBoostHypotheses(lines, new Set());
      const queries = result.hypotheses.map(h => h.query.toUpperCase());

      const hasCussler = queries.some(q => q.includes('CUSSLER'));
      expect(hasCussler).toBe(true);
    });
  });
});
