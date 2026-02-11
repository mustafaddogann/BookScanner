/**
 * Fixture Debug Output Tests
 *
 * These tests demonstrate the reasoning trace for different failure classes.
 * Run with: npm test -- --testPathPattern='fixtureDebugOutput.test.ts' --verbose
 */

import { classifyLines, getExcludedBadgeIndices } from '../lineClassification';
import { prepareResolverQuery } from '../resolverQueryPrep';
import { extractTitleAndAuthor } from '../titleAuthorExtraction';

describe('Sample Debug Output', () => {
  /**
   * CLASS A: Marketing/Badge Text Contaminating Author/Title
   * Input: Badge split across multiple lines
   */
  describe('CLASS A: Marketing Badge Detection', () => {
    it('demonstrates badge detection reasoning', () => {
      const lines = [
        'DELL',
        '*1',
        'NEW YORK TIMES',
        'BESTSELLER',
        'JOHN GRISHAM',
        'THE GUARDIANS'
      ];

      console.log('\n=== CLASS A: Marketing Badge Detection ===');
      console.log('Input lines:', lines);
      console.log('');

      // Classification
      const classifications = classifyLines(lines);
      console.log('Line Classifications:');
      classifications.forEach(c => {
        console.log(`  [${c.index}] "${c.text}"`);
        console.log(`      excluded: ${c.isExcluded}, reason: ${c.exclusionReason || 'none'}`);
        if (c.scores) {
          console.log(`      scores: person=${c.scores.personLikeness.toFixed(2)}, title=${c.scores.titleLikeness.toFixed(2)}, orgPenalty=${c.scores.orgPenalty.toFixed(2)}`);
        }
        if (c.badgeResult) {
          console.log(`      badge: confidence=${c.badgeResult.confidence.toFixed(2)}, reason=${c.badgeResult.reason}`);
        }
      });
      console.log('');

      // Badge indices
      const badgeIndices = getExcludedBadgeIndices(lines);
      console.log('Badge Excluded Indices:', Array.from(badgeIndices.keys()));

      // Extraction
      const extraction = extractTitleAndAuthor(lines);
      console.log('');
      console.log('Extraction Result:');
      console.log(`  title: "${extraction.title}" (confidence: ${extraction.titleConfidence.toFixed(2)})`);
      console.log(`  author: "${extraction.author}" (confidence: ${extraction.authorConfidence.toFixed(2)})`);
      console.log(`  excludedBadgeLines: ${extraction.debug.excludedBadgeLines?.map(l => l.text).join(', ')}`);

      // Query prep
      const query = prepareResolverQuery(extraction.title, extraction.author);
      console.log('');
      console.log('Query Preparation:');
      console.log(`  queryTitle: "${query.queryTitle}"`);
      console.log(`  queryAuthor: "${query.queryAuthor}"`);
      console.log(`  shouldQuery: ${query.shouldQuery}`);

      // Assertions
      expect(extraction.title).toContain('GUARDIANS');
      expect(extraction.author).toContain('GRISHAM');
      expect(query.shouldQuery).toBe(true);
    });
  });

  /**
   * CLASS B: Imprint/Publisher Noise
   * Input: Standalone imprint line
   */
  describe('CLASS B: Imprint/Publisher Detection', () => {
    it('demonstrates imprint detection reasoning', () => {
      const lines = [
        'ZEBRA',
        '$4.99',
        'THE BURIED',
        'LISA CHILDS'
      ];

      console.log('\n=== CLASS B: Imprint/Publisher Detection ===');
      console.log('Input lines:', lines);
      console.log('');

      const classifications = classifyLines(lines);
      console.log('Line Classifications:');
      classifications.forEach(c => {
        console.log(`  [${c.index}] "${c.text}"`);
        console.log(`      excluded: ${c.isExcluded}, reason: ${c.exclusionReason || 'none'}`);
      });

      const extraction = extractTitleAndAuthor(lines);
      console.log('');
      console.log('Extraction Result:');
      console.log(`  title: "${extraction.title}"`);
      console.log(`  author: "${extraction.author}"`);
      console.log(`  excludedJunkLines: ${extraction.debug.excludedJunkLines?.map(l => `"${l.text}": ${l.reason}`).join(', ')}`);

      // Assertions
      expect(extraction.title).toBe('THE BURIED');
      expect(extraction.author).toContain('LISA');
    });
  });

  /**
   * CLASS C: OCR Fragmentation and Composition
   * Input: Title split across lines + inline collapsed title/author
   */
  describe('CLASS C: OCR Fragmentation', () => {
    it('demonstrates fragmented title reconstruction', () => {
      const lines = [
        'THE',
        'BURIED',
        'LISA CHILDS'
      ];

      console.log('\n=== CLASS C: Title Split (Stopword Bridge) ===');
      console.log('Input lines:', lines);
      console.log('');

      const classifications = classifyLines(lines);
      console.log('Line Classifications:');
      classifications.forEach(c => {
        console.log(`  [${c.index}] "${c.text}" - excluded: ${c.isExcluded}`);
        if (c.scores) {
          console.log(`      person=${c.scores.personLikeness.toFixed(2)}, title=${c.scores.titleLikeness.toFixed(2)}`);
        }
      });

      const extraction = extractTitleAndAuthor(lines);
      console.log('');
      console.log('Extraction Result:');
      console.log(`  title: "${extraction.title}"`);
      console.log(`  author: "${extraction.author}"`);
      console.log('  titleCandidates:', extraction.debug.titleCandidates.slice(0, 3).map(c =>
        `"${c.text}" (score: ${c.score.toFixed(2)}, reasons: ${c.reasons.join(', ')})`
      ));

      expect(extraction.title).toContain('BURIED');
    });

    it('demonstrates inline title/author split', () => {
      const lines = [
        'BANTAM STER',
        'POISON IN THE PEN Patricia Wentworth'
      ];

      console.log('\n=== CLASS C: Inline Title/Author Collapse ===');
      console.log('Input lines:', lines);
      console.log('');

      const extraction = extractTitleAndAuthor(lines);
      console.log('Extraction Result:');
      console.log(`  title: "${extraction.title}"`);
      console.log(`  author: "${extraction.author}"`);
      console.log(`  inlineSplits: ${JSON.stringify(extraction.debug.inlineSplits, null, 2)}`);

      const query = prepareResolverQuery(extraction.title, extraction.author);
      console.log('');
      console.log('Query Preparation:');
      console.log(`  queryTitle: "${query.queryTitle}"`);
      console.log(`  queryAuthor: "${query.queryAuthor}"`);
      console.log(`  didInlineSplitForQuery: ${query.debug.didInlineSplitForQuery}`);
      console.log(`  sanitizationReasons: ${query.debug.sanitizationReasons.join(', ')}`);

      expect(extraction.title).toContain('POISON');
      expect(extraction.author).toContain('Wentworth');
    });
  });

  /**
   * CLASS D: Avoiding Cascading Errors
   * Input: Person name that could be confused with title
   */
  describe('CLASS D: Avoiding Cascading Errors', () => {
    it('demonstrates person-vs-title disambiguation', () => {
      const lines = [
        'THE GUARDIANS',
        'JOHN GRISHAM'
      ];

      console.log('\n=== CLASS D: Person vs Title Disambiguation ===');
      console.log('Input lines:', lines);
      console.log('');

      const classifications = classifyLines(lines);
      console.log('Line Classifications:');
      classifications.forEach(c => {
        console.log(`  [${c.index}] "${c.text}"`);
        if (c.scores) {
          console.log(`      personLikeness: ${c.scores.personLikeness.toFixed(2)}`);
          console.log(`      titleLikeness: ${c.scores.titleLikeness.toFixed(2)}`);
          console.log(`      orgPenalty: ${c.scores.orgPenalty.toFixed(2)}`);
        }
      });

      const extraction = extractTitleAndAuthor(lines);
      console.log('');
      console.log('Extraction Result:');
      console.log(`  title: "${extraction.title}" (NOT person name)`);
      console.log(`  author: "${extraction.author}" (IS person name)`);

      // THE GUARDIANS should be title (starts with THE) - low person, high title
      // JOHN GRISHAM is both person-like and title-like, but extraction prefers it as author
      expect(classifications[0].scores?.titleLikeness).toBeGreaterThan(classifications[0].scores?.personLikeness ?? 0);
      expect(classifications[1].scores?.personLikeness).toBeGreaterThanOrEqual(0.8); // High person-likeness
    });
  });
});
