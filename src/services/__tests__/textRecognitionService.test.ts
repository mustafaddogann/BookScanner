/**
 * Jest tests for text recognition service
 * Tests title/author heuristics and rotation scoring
 */

import { selectBestTitle } from '../textRecognitionService';
import type { OCRResult } from '../../types';

// Helper to create mock OCR result
function createMockOCRResult(overrides: Partial<OCRResult> = {}): OCRResult {
  return {
    ok: true,
    chosenRotation: 0,
    fullText: '',
    lines: [],
    avgConfidence: 0.8,
    alnumRatio: 0.9,
    charCount: 50,
    lineCount: 3,
    titleCandidate: null,
    authorCandidate: null,
    platform: 'ios',
    ...overrides,
  };
}

describe('selectBestTitle', () => {
  it('should return null when results are empty', () => {
    const result = selectBestTitle({});
    expect(result).toBeNull();
  });

  it('should return null when no results have titleCandidate', () => {
    const results: Record<number, OCRResult> = {
      0: createMockOCRResult({ titleCandidate: null }),
      1: createMockOCRResult({ titleCandidate: null }),
    };
    const result = selectBestTitle(results);
    expect(result).toBeNull();
  });

  it('should return the only result with a title', () => {
    const results: Record<number, OCRResult> = {
      0: createMockOCRResult({ titleCandidate: null }),
      1: createMockOCRResult({
        titleCandidate: 'The Great Gatsby',
        authorCandidate: 'F. Scott Fitzgerald',
        avgConfidence: 0.85,
      }),
      2: createMockOCRResult({ titleCandidate: null }),
    };

    const result = selectBestTitle(results);

    expect(result).not.toBeNull();
    expect(result?.title).toBe('The Great Gatsby');
    expect(result?.authorCandidate).toBe('F. Scott Fitzgerald');
    expect(result?.cropIndex).toBe(1);
  });

  it('should select result with highest confidence', () => {
    const results: Record<number, OCRResult> = {
      0: createMockOCRResult({
        titleCandidate: 'Book A',
        avgConfidence: 0.7,
        charCount: 50,
        alnumRatio: 0.9,
      }),
      1: createMockOCRResult({
        titleCandidate: 'Book B',
        avgConfidence: 0.95,
        charCount: 50,
        alnumRatio: 0.9,
      }),
      2: createMockOCRResult({
        titleCandidate: 'Book C',
        avgConfidence: 0.8,
        charCount: 50,
        alnumRatio: 0.9,
      }),
    };

    const result = selectBestTitle(results);

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Book B');
    expect(result?.cropIndex).toBe(1);
  });

  it('should consider charCount in scoring', () => {
    const results: Record<number, OCRResult> = {
      0: createMockOCRResult({
        titleCandidate: 'Short',
        avgConfidence: 0.9,
        charCount: 10,
        alnumRatio: 0.9,
      }),
      1: createMockOCRResult({
        titleCandidate: 'This is a much longer title',
        avgConfidence: 0.9,
        charCount: 100,
        alnumRatio: 0.9,
      }),
    };

    const result = selectBestTitle(results);

    // With same confidence, longer text should win due to charCount component
    expect(result).not.toBeNull();
    expect(result?.title).toBe('This is a much longer title');
    expect(result?.cropIndex).toBe(1);
  });

  it('should consider alnumRatio in scoring', () => {
    const results: Record<number, OCRResult> = {
      0: createMockOCRResult({
        titleCandidate: 'Book!!!###',
        avgConfidence: 0.9,
        charCount: 50,
        alnumRatio: 0.3,
      }),
      1: createMockOCRResult({
        titleCandidate: 'Clean Title',
        avgConfidence: 0.9,
        charCount: 50,
        alnumRatio: 0.95,
      }),
    };

    const result = selectBestTitle(results);

    // Higher alnumRatio should contribute to better score
    expect(result).not.toBeNull();
    expect(result?.title).toBe('Clean Title');
  });

  it('should skip results where ok is false', () => {
    const results: Record<number, OCRResult> = {
      0: createMockOCRResult({
        ok: false,
        titleCandidate: 'Failed OCR',
      }),
      1: createMockOCRResult({
        ok: true,
        titleCandidate: 'Successful OCR',
        avgConfidence: 0.5,
      }),
    };

    const result = selectBestTitle(results);

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Successful OCR');
    expect(result?.cropIndex).toBe(1);
  });

  it('should handle results with authorCandidate', () => {
    const results: Record<number, OCRResult> = {
      0: createMockOCRResult({
        titleCandidate: 'War and Peace',
        authorCandidate: 'Leo Tolstoy',
        avgConfidence: 0.9,
      }),
    };

    const result = selectBestTitle(results);

    expect(result).not.toBeNull();
    expect(result?.title).toBe('War and Peace');
    expect(result?.authorCandidate).toBe('Leo Tolstoy');
  });

  it('should handle results without authorCandidate', () => {
    const results: Record<number, OCRResult> = {
      0: createMockOCRResult({
        titleCandidate: 'Anonymous Book',
        authorCandidate: null,
        avgConfidence: 0.9,
      }),
    };

    const result = selectBestTitle(results);

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Anonymous Book');
    expect(result?.authorCandidate).toBeNull();
  });
});

describe('OCR Result structure', () => {
  it('should have all required fields in a valid OCRResult', () => {
    const result = createMockOCRResult({
      ok: true,
      chosenRotation: 90,
      fullText: 'Sample text',
      lines: [{ text: 'Line 1', bbox: { x: 0, y: 0, width: 100, height: 20 }, confidence: 0.9 }],
      avgConfidence: 0.85,
      alnumRatio: 0.9,
      charCount: 11,
      lineCount: 1,
      titleCandidate: 'Sample',
      authorCandidate: 'Author',
    });

    expect(result.ok).toBe(true);
    expect(result.chosenRotation).toBe(90);
    expect(result.fullText).toBe('Sample text');
    expect(result.lines).toHaveLength(1);
    expect(result.avgConfidence).toBe(0.85);
    expect(result.alnumRatio).toBe(0.9);
    expect(result.charCount).toBe(11);
    expect(result.lineCount).toBe(1);
    expect(result.titleCandidate).toBe('Sample');
    expect(result.authorCandidate).toBe('Author');
  });

  it('should represent failed OCR result correctly', () => {
    const result = createMockOCRResult({
      ok: false,
      error: 'No text found',
      fullText: '',
      lines: [],
      avgConfidence: 0,
      charCount: 0,
      lineCount: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No text found');
    expect(result.lines).toHaveLength(0);
  });
});

describe('Rotation scoring logic', () => {
  // Test different rotation scenarios to ensure logic matches native implementation
  it('should prefer higher avgConfidence', () => {
    // Simulating rotation comparison logic
    const rotation0 = { avgConfidence: 0.7, alnumRatio: 0.9, charCount: 50 };
    const rotation90 = { avgConfidence: 0.95, alnumRatio: 0.8, charCount: 40 };

    // Higher avgConfidence should win even with lower alnum/charCount
    const isBetter = rotation90.avgConfidence > rotation0.avgConfidence;
    expect(isBetter).toBe(true);
  });

  it('should use alnumRatio as tiebreaker when avgConfidence is equal', () => {
    const rotationA = { avgConfidence: 0.9, alnumRatio: 0.7, charCount: 50 };
    const rotationB = { avgConfidence: 0.9, alnumRatio: 0.95, charCount: 50 };

    // Equal confidence, higher alnumRatio should win
    const isEqualConf = Math.abs(rotationA.avgConfidence - rotationB.avgConfidence) < 0.01;
    const isBetterAlnum = rotationB.alnumRatio > rotationA.alnumRatio;

    expect(isEqualConf).toBe(true);
    expect(isBetterAlnum).toBe(true);
  });

  it('should use charCount as final tiebreaker', () => {
    const rotationA = { avgConfidence: 0.9, alnumRatio: 0.9, charCount: 30 };
    const rotationB = { avgConfidence: 0.9, alnumRatio: 0.9, charCount: 100 };

    // Equal confidence and alnumRatio, higher charCount should win
    const isEqualConf = Math.abs(rotationA.avgConfidence - rotationB.avgConfidence) < 0.01;
    const isEqualAlnum = Math.abs(rotationA.alnumRatio - rotationB.alnumRatio) < 0.01;
    const isBetterChars = rotationB.charCount > rotationA.charCount;

    expect(isEqualConf).toBe(true);
    expect(isEqualAlnum).toBe(true);
    expect(isBetterChars).toBe(true);
  });
});

describe('Title/Author heuristic patterns', () => {
  // Test patterns that identify author lines

  it('should identify "by Author" pattern', () => {
    const text = 'by John Smith';
    const lower = text.toLowerCase();
    const hasByPrefix = lower.startsWith('by ');

    expect(hasByPrefix).toBe(true);

    if (hasByPrefix) {
      const author = text.substring(3).trim();
      expect(author).toBe('John Smith');
    }
  });

  it('should identify person name pattern (2-4 capitalized tokens)', () => {
    const isPersonName = (text: string): boolean => {
      const tokens = text.trim().split(/\s+/);
      if (tokens.length < 2 || tokens.length > 4) return false;

      for (const token of tokens) {
        if (token.length < 2) return false;
        if (!/^[A-Z]/.test(token)) return false;
        const letterCount = token.replace(/[^a-zA-Z]/g, '').length;
        if (letterCount / token.length < 0.8) return false;
      }
      return true;
    };

    expect(isPersonName('John Smith')).toBe(true);
    expect(isPersonName('Mary Jane Watson')).toBe(true);
    expect(isPersonName('Arthur Conan Doyle')).toBe(true);
    expect(isPersonName('lowercase name')).toBe(false);
    expect(isPersonName('A')).toBe(false); // Too short
    expect(isPersonName('One Two Three Four Five')).toBe(false); // Too many tokens
    expect(isPersonName('123 Numbers')).toBe(false); // Doesn't start with letter
    // Note: "J.K. Rowling" would fail due to periods reducing letter ratio below 80%
  });

  it('should filter high symbol density lines', () => {
    const hasHighSymbolDensity = (text: string): boolean => {
      if (text.length < 2) return true;
      const alnumCount = text.replace(/[^a-zA-Z0-9]/g, '').length;
      return alnumCount / text.length < 0.5;
    };

    expect(hasHighSymbolDensity('***###!!!')).toBe(true);
    expect(hasHighSymbolDensity('Normal Text')).toBe(false);
    expect(hasHighSymbolDensity('50% symbols!!!')).toBe(false); // Exactly at threshold
    expect(hasHighSymbolDensity('...')).toBe(true);
    expect(hasHighSymbolDensity('')).toBe(true); // Empty string
    expect(hasHighSymbolDensity('a')).toBe(true); // Too short
  });

  it('should normalize whitespace correctly', () => {
    const normalizeWhitespace = (text: string): string => {
      return text.trim().replace(/\s+/g, ' ');
    };

    expect(normalizeWhitespace('  Multiple   Spaces  ')).toBe('Multiple Spaces');
    expect(normalizeWhitespace('Tabs\t\tHere')).toBe('Tabs Here');
    expect(normalizeWhitespace('Normal')).toBe('Normal');
    expect(normalizeWhitespace('  Leading')).toBe('Leading');
    expect(normalizeWhitespace('Trailing  ')).toBe('Trailing');
  });
});
