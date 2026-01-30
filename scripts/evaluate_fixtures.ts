#!/usr/bin/env npx ts-node
/**
 * Gate 9 Evaluation Script
 *
 * Runs fixtures through hypothesis generation + resolver and reports metrics:
 * - autoAcceptRate: % of candidates auto-accepted
 * - autoAcceptPrecision: % of auto-accepts that are correct (vs ground truth)
 * - ambiguousRate: % of candidates requiring manual review
 * - noMatchRate: % of candidates with no match
 *
 * Usage:
 *   npx ts-node scripts/evaluate_fixtures.ts [--fixtures path/to/fixtures.json]
 *
 * Fixture format:
 * [
 *   {
 *     "id": "fixture-1",
 *     "ocrText": "The Great Gatsby\nF. Scott Fitzgerald",
 *     "groundTruth": {
 *       "title": "The Great Gatsby",
 *       "authors": ["F. Scott Fitzgerald"],
 *       "isbn13": "9780743273565"
 *     }
 *   }
 * ]
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

interface GroundTruth {
  title: string;
  authors: string[];
  isbn13?: string;
}

interface Fixture {
  id: string;
  ocrText: string;
  groundTruth: GroundTruth;
  expectedDecision?: 'auto-accept' | 'suggest' | 'ambiguous' | 'no-match';
}

interface MockResolvedBook {
  title: string;
  authors: string[];
  isbn13: string | null;
}

interface EvaluationResult {
  fixtureId: string;
  decision: 'auto-accept' | 'suggest' | 'ambiguous' | 'no-match' | 'error';
  resolvedBook: MockResolvedBook | null;
  correct: boolean;
  confidence: number;
  processingTimeMs: number;
  error?: string;
}

interface EvaluationSummary {
  totalFixtures: number;
  autoAcceptCount: number;
  suggestCount: number;
  ambiguousCount: number;
  noMatchCount: number;
  errorCount: number;
  autoAcceptRate: number;
  autoAcceptPrecision: number;
  ambiguousRate: number;
  noMatchRate: number;
  avgProcessingTimeMs: number;
}

// ============================================================================
// Scoring Utilities (mirrored from Edge Function for offline evaluation)
// ============================================================================

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ');
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function stringSimilarity(a: string, b: string): number {
  const aNorm = normalizeText(a);
  const bNorm = normalizeText(b);
  if (aNorm === bNorm) return 1.0;
  if (aNorm.length === 0 || bNorm.length === 0) return 0.0;
  const distance = levenshteinDistance(aNorm, bNorm);
  const maxLen = Math.max(aNorm.length, bNorm.length);
  return 1 - distance / maxLen;
}

function authorMatches(bookAuthors: string[], groundTruthAuthors: string[]): boolean {
  if (groundTruthAuthors.length === 0) return true;
  for (const gtAuthor of groundTruthAuthors) {
    const gtNorm = normalizeText(gtAuthor);
    for (const bookAuthor of bookAuthors) {
      const bookNorm = normalizeText(bookAuthor);
      if (stringSimilarity(gtNorm, bookNorm) > 0.8) {
        return true;
      }
    }
  }
  return false;
}

function isCorrectMatch(resolved: MockResolvedBook | null, groundTruth: GroundTruth): boolean {
  if (!resolved) return false;

  // ISBN match is definitive
  if (groundTruth.isbn13 && resolved.isbn13) {
    return resolved.isbn13 === groundTruth.isbn13;
  }

  // Title similarity must be high
  const titleSim = stringSimilarity(resolved.title, groundTruth.title);
  if (titleSim < 0.75) return false;

  // Author must match
  return authorMatches(resolved.authors, groundTruth.authors);
}

// ============================================================================
// Mock Resolver (for offline evaluation without Edge Function)
// ============================================================================

async function mockResolve(ocrText: string): Promise<{
  decision: 'auto-accept' | 'suggest' | 'ambiguous' | 'no-match';
  resolvedBook: MockResolvedBook | null;
  confidence: number;
}> {
  // Extract title and author from OCR text (simple heuristic)
  const lines = ocrText.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { decision: 'no-match', resolvedBook: null, confidence: 0 };
  }

  const title = lines[0].trim();
  const author = lines.length > 1 ? lines[1].trim() : '';

  // Simulate processing time
  await new Promise((r) => setTimeout(r, 10 + Math.random() * 50));

  // Simple scoring based on text quality
  const hasTitle = title.length > 3;
  const hasAuthor = author.length > 3;
  const confidence = hasTitle && hasAuthor ? 0.85 : hasTitle ? 0.65 : 0.3;

  if (confidence >= 0.85) {
    return {
      decision: 'auto-accept',
      resolvedBook: { title, authors: author ? [author] : [], isbn13: null },
      confidence,
    };
  } else if (confidence >= 0.70) {
    return {
      decision: 'suggest',
      resolvedBook: { title, authors: author ? [author] : [], isbn13: null },
      confidence,
    };
  } else if (confidence >= 0.50) {
    return {
      decision: 'ambiguous',
      resolvedBook: null,
      confidence,
    };
  } else {
    return {
      decision: 'no-match',
      resolvedBook: null,
      confidence,
    };
  }
}

// ============================================================================
// Evaluation
// ============================================================================

async function evaluateFixture(fixture: Fixture): Promise<EvaluationResult> {
  const startTime = Date.now();

  try {
    const result = await mockResolve(fixture.ocrText);
    const correct = isCorrectMatch(result.resolvedBook, fixture.groundTruth);

    return {
      fixtureId: fixture.id,
      decision: result.decision,
      resolvedBook: result.resolvedBook,
      correct,
      confidence: result.confidence,
      processingTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      fixtureId: fixture.id,
      decision: 'error',
      resolvedBook: null,
      correct: false,
      confidence: 0,
      processingTimeMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function computeSummary(results: EvaluationResult[]): EvaluationSummary {
  const total = results.length;
  if (total === 0) {
    return {
      totalFixtures: 0,
      autoAcceptCount: 0,
      suggestCount: 0,
      ambiguousCount: 0,
      noMatchCount: 0,
      errorCount: 0,
      autoAcceptRate: 0,
      autoAcceptPrecision: 0,
      ambiguousRate: 0,
      noMatchRate: 0,
      avgProcessingTimeMs: 0,
    };
  }

  const autoAccepts = results.filter((r) => r.decision === 'auto-accept');
  const suggests = results.filter((r) => r.decision === 'suggest');
  const ambiguous = results.filter((r) => r.decision === 'ambiguous');
  const noMatch = results.filter((r) => r.decision === 'no-match');
  const errors = results.filter((r) => r.decision === 'error');

  const correctAutoAccepts = autoAccepts.filter((r) => r.correct);
  const totalTime = results.reduce((sum, r) => sum + r.processingTimeMs, 0);

  return {
    totalFixtures: total,
    autoAcceptCount: autoAccepts.length,
    suggestCount: suggests.length,
    ambiguousCount: ambiguous.length,
    noMatchCount: noMatch.length,
    errorCount: errors.length,
    autoAcceptRate: (autoAccepts.length / total) * 100,
    autoAcceptPrecision:
      autoAccepts.length > 0 ? (correctAutoAccepts.length / autoAccepts.length) * 100 : 0,
    ambiguousRate: (ambiguous.length / total) * 100,
    noMatchRate: (noMatch.length / total) * 100,
    avgProcessingTimeMs: totalTime / total,
  };
}

// ============================================================================
// Main
// ============================================================================

const DEFAULT_FIXTURES: Fixture[] = [
  {
    id: 'gatsby',
    ocrText: 'The Great Gatsby\nF. Scott Fitzgerald\nScribner',
    groundTruth: {
      title: 'The Great Gatsby',
      authors: ['F. Scott Fitzgerald'],
      isbn13: '9780743273565',
    },
  },
  {
    id: 'mockingbird',
    ocrText: 'To Kill a Mockingbird\nHarper Lee',
    groundTruth: {
      title: 'To Kill a Mockingbird',
      authors: ['Harper Lee'],
      isbn13: '9780060935467',
    },
  },
  {
    id: '1984',
    ocrText: '1984\nGeorge Orwell',
    groundTruth: {
      title: '1984',
      authors: ['George Orwell'],
      isbn13: '9780451524935',
    },
  },
  {
    id: 'prideandprejudice',
    ocrText: 'Pride and Prejudice\nJane Austen',
    groundTruth: {
      title: 'Pride and Prejudice',
      authors: ['Jane Austen'],
    },
  },
  {
    id: 'partial-ocr',
    ocrText: 'The Gr t Gatsb\nF Scot Fitzger',
    groundTruth: {
      title: 'The Great Gatsby',
      authors: ['F. Scott Fitzgerald'],
    },
  },
  {
    id: 'noisy-ocr',
    ocrText: 'ISBN 978-0-7432-7356-5\nThe Great Gatsby\n$14.99',
    groundTruth: {
      title: 'The Great Gatsby',
      authors: ['F. Scott Fitzgerald'],
      isbn13: '9780743273565',
    },
  },
  {
    id: 'empty',
    ocrText: '',
    groundTruth: {
      title: 'Unknown',
      authors: [],
    },
    expectedDecision: 'no-match',
  },
  {
    id: 'single-line',
    ocrText: 'War and Peace',
    groundTruth: {
      title: 'War and Peace',
      authors: ['Leo Tolstoy'],
    },
  },
];

async function main() {
  console.log('='.repeat(60));
  console.log('Gate 9 Resolver Evaluation');
  console.log('='.repeat(60));
  console.log();

  // Parse arguments
  const args = process.argv.slice(2);
  let fixturesPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--fixtures' && args[i + 1]) {
      fixturesPath = args[i + 1];
    }
  }

  // Load fixtures
  let fixtures: Fixture[];
  if (fixturesPath) {
    const absPath = path.resolve(fixturesPath);
    console.log(`Loading fixtures from: ${absPath}`);
    const content = fs.readFileSync(absPath, 'utf-8');
    fixtures = JSON.parse(content);
  } else {
    console.log('Using default fixtures (8 built-in test cases)');
    fixtures = DEFAULT_FIXTURES;
  }
  console.log(`Loaded ${fixtures.length} fixtures`);
  console.log();

  // Run evaluation
  console.log('Running evaluation...');
  console.log('-'.repeat(60));

  const results: EvaluationResult[] = [];
  for (const fixture of fixtures) {
    const result = await evaluateFixture(fixture);
    results.push(result);

    const status = result.correct ? '✓' : '✗';
    const confidence = (result.confidence * 100).toFixed(0).padStart(3);
    console.log(
      `  ${status} ${fixture.id.padEnd(20)} ${result.decision.padEnd(12)} ` +
        `conf=${confidence}% time=${result.processingTimeMs}ms`
    );
  }

  // Compute summary
  console.log();
  console.log('='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));

  const summary = computeSummary(results);

  console.log(`Total fixtures:      ${summary.totalFixtures}`);
  console.log(`Auto-accept:         ${summary.autoAcceptCount} (${summary.autoAcceptRate.toFixed(1)}%)`);
  console.log(`Suggest:             ${summary.suggestCount}`);
  console.log(`Ambiguous:           ${summary.ambiguousCount} (${summary.ambiguousRate.toFixed(1)}%)`);
  console.log(`No-match:            ${summary.noMatchCount} (${summary.noMatchRate.toFixed(1)}%)`);
  console.log(`Errors:              ${summary.errorCount}`);
  console.log();
  console.log(`Auto-accept precision: ${summary.autoAcceptPrecision.toFixed(1)}%`);
  console.log(`Avg processing time:   ${summary.avgProcessingTimeMs.toFixed(1)}ms`);
  console.log();

  // Save results
  const outputPath = path.resolve('evaluation_results.json');
  fs.writeFileSync(
    outputPath,
    JSON.stringify({ summary, results }, null, 2)
  );
  console.log(`Results saved to: ${outputPath}`);
}

main().catch((err) => {
  console.error('Evaluation failed:', err);
  process.exit(1);
});
