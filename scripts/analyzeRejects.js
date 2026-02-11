#!/usr/bin/env node
/**
 * Analyze Rejected Books Export
 *
 * Usage: node scripts/analyzeRejects.js <path-to-rejects.json>
 *
 * This script analyzes exported rejected books and suggests fixes.
 */

const fs = require('fs');
const path = require('path');

// Known patterns that indicate specific issues
const ISSUE_PATTERNS = {
  // OCR corruption patterns
  OCR_CORRUPTION: [
    { pattern: /FORVOUR/i, issue: 'OCR merged "FOR YOUR"', suggestion: 'Add word-splitting heuristic' },
    { pattern: /NGRIO|MOHIO|IGHTO/i, issue: 'OCR corruption of "NGAIO"', suggestion: 'Add to fuzzy match exceptions' },
    { pattern: /CRANKIN/i, issue: 'OCR corruption of "RANKIN"', suggestion: 'Fuzzy match should handle this' },
    { pattern: /SHADFORD/i, issue: 'OCR corruption of "SANDFORD"', suggestion: 'Partial OCR capture' },
    { pattern: /ECOUNTRY/i, issue: 'OCR corruption of "COUNTRY"', suggestion: 'Partial OCR capture' },
    { pattern: /ONF\b/i, issue: 'OCR error "ONF" instead of "ONE"', suggestion: 'Add to OCR confusion matrix' },
    { pattern: /MACDO\b/i, issue: 'Truncated "MACDONALD"', suggestion: 'Handle truncated author names' },
  ],

  // Missing text patterns (vertical/horizontal issue)
  MISSING_TEXT: [
    { pattern: /^(CRANKIN|FALLS)$/m, issue: 'Missing author name (vertical text not captured)', suggestion: 'OCR rotation merge needed' },
    { pattern: /^(SHADFORD|ECOUNTRY)$/m, issue: 'Missing title/author parts', suggestion: 'OCR rotation merge needed' },
  ],

  // Noise that should be filtered
  UNFILTERED_NOISE: [
    { pattern: /\bVISICA\b/i, issue: 'VISICA not filtered', suggestion: 'Add to PUBLISHER_NOISE' },
    { pattern: /\bJOVI\b/i, issue: 'JOVI not filtered', suggestion: 'Add to PUBLISHER_NOISE' },
    { pattern: /\bTSELLER\b/i, issue: 'TSELLER not filtered', suggestion: 'Add to PUBLISHER_NOISE' },
    { pattern: /\bVINTASE\b/i, issue: 'VINTASE not filtered', suggestion: 'Add to PUBLISHER_NOISE' },
    { pattern: /\bBERK!\b/i, issue: 'BERK! not filtered', suggestion: 'Add to PUBLISHER_NOISE' },
    { pattern: /\bOYSTERY\b/i, issue: 'OYSTERY not filtered', suggestion: 'Add to SHELF_LABELS' },
  ],

  // Merged title+author
  MERGED_LINE: [
    { pattern: /\b[A-Z]+\s+[A-Z]\.\s*[A-Z]+$/m, issue: 'Merged title+author with middle initial', suggestion: 'Line splitting pattern should handle this' },
  ],
};

function analyzeReject(reject) {
  const issues = [];
  const mergedText = reject.mergedText || '';
  const reason = reject.resolverDecisionReason || '';

  // Check each pattern category
  for (const [category, patterns] of Object.entries(ISSUE_PATTERNS)) {
    for (const { pattern, issue, suggestion } of patterns) {
      if (pattern.test(mergedText)) {
        issues.push({ category, issue, suggestion, matched: mergedText.match(pattern)?.[0] });
      }
    }
  }

  // Check for low hypothesis count
  const hypothesisCount = reject.evidenceSearchDebug?.hypothesesTried || 0;
  if (hypothesisCount === 0) {
    issues.push({
      category: 'NO_HYPOTHESES',
      issue: 'No hypotheses generated',
      suggestion: 'Check evidence extraction and hypothesis generation',
    });
  }

  // Check for low scores
  const topScore = reject.evidenceSearchDebug?.topScore || 0;
  if (topScore > 0 && topScore < 0.5) {
    issues.push({
      category: 'LOW_SCORE',
      issue: `Top score too low: ${topScore.toFixed(2)}`,
      suggestion: 'Check token matching and fuzzy thresholds',
    });
  }

  return issues;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node scripts/analyzeRejects.js <path-to-rejects.json>');
    console.log('');
    console.log('Example: node scripts/analyzeRejects.js ~/Downloads/rejects_session123_1234567890.json');
    process.exit(1);
  }

  const filepath = args[0];

  if (!fs.existsSync(filepath)) {
    console.error(`File not found: ${filepath}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));

  console.log('='.repeat(60));
  console.log('REJECTED BOOKS ANALYSIS');
  console.log('='.repeat(60));
  console.log(`Session: ${data.sessionId}`);
  console.log(`Exported: ${data.exportedAt}`);
  console.log(`Total Books: ${data.totalBooks}`);
  console.log(`Rejected: ${data.rejectCount}`);
  console.log('');

  const issueSummary = {};

  for (const reject of data.rejects) {
    console.log('-'.repeat(60));
    console.log(`Book ${reject.bookNumber}: ${reject.id}`);
    console.log(`Merged Text:\n  ${(reject.mergedText || '').split('\n').join('\n  ')}`);
    console.log(`Reason: ${reject.resolverDecisionReason}`);

    const issues = analyzeReject(reject);

    if (issues.length > 0) {
      console.log('Issues Found:');
      for (const issue of issues) {
        console.log(`  - [${issue.category}] ${issue.issue}`);
        console.log(`    Suggestion: ${issue.suggestion}`);
        if (issue.matched) console.log(`    Matched: "${issue.matched}"`);

        // Track for summary
        const key = `${issue.category}: ${issue.issue}`;
        issueSummary[key] = (issueSummary[key] || 0) + 1;
      }
    } else {
      console.log('  No known patterns detected - needs manual investigation');
    }
    console.log('');
  }

  console.log('='.repeat(60));
  console.log('ISSUE SUMMARY');
  console.log('='.repeat(60));

  const sortedIssues = Object.entries(issueSummary).sort((a, b) => b[1] - a[1]);
  for (const [issue, count] of sortedIssues) {
    console.log(`${count}x - ${issue}`);
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('RECOMMENDED ACTIONS');
  console.log('='.repeat(60));

  if (sortedIssues.some(([issue]) => issue.includes('vertical text') || issue.includes('rotation'))) {
    console.log('1. OCR ROTATION MERGE: The native OCR module needs to merge text from multiple rotations.');
    console.log('   File: ios/TextRecognizer.m (already updated - rebuild the app)');
  }

  if (sortedIssues.some(([issue]) => issue.includes('not filtered'))) {
    console.log('2. NOISE FILTERS: Add missing patterns to evidenceNormalization.ts');
  }

  if (sortedIssues.some(([issue]) => issue.includes('OCR corruption'))) {
    console.log('3. FUZZY MATCHING: Some OCR corruptions may need lower thresholds or special handling');
  }
}

main();
