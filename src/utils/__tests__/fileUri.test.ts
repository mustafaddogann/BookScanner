/**
 * Unit tests for fileUri utilities
 */

import {
  ensureFileUri,
  stripFileUri,
  isFileUri,
  isAbsolutePath,
  getFilename,
} from '../fileUri';

describe('fileUri utilities', () => {
  describe('ensureFileUri', () => {
    it('returns empty string for null/undefined/empty input', () => {
      expect(ensureFileUri(null)).toBe('');
      expect(ensureFileUri(undefined)).toBe('');
      expect(ensureFileUri('')).toBe('');
    });

    it('returns file URI unchanged if already has file:// prefix', () => {
      const uri = 'file:///var/mobile/Containers/Data/test.jpg';
      expect(ensureFileUri(uri)).toBe(uri);
    });

    it('adds file:// prefix to absolute paths', () => {
      const path = '/var/mobile/Containers/Data/test.jpg';
      expect(ensureFileUri(path)).toBe('file:///var/mobile/Containers/Data/test.jpg');
    });

    it('handles paths with spaces correctly', () => {
      const path = '/Users/test user/Documents/test file.jpg';
      expect(ensureFileUri(path)).toBe('file:///Users/test user/Documents/test file.jpg');
    });

    it('returns non-absolute paths unchanged with warning', () => {
      // This tests the fallback behavior for unexpected inputs
      const relativePath = 'relative/path/file.jpg';
      // Jest's console.warn can be spied on if needed
      expect(ensureFileUri(relativePath)).toBe(relativePath);
    });
  });

  describe('stripFileUri', () => {
    it('returns empty string for null/undefined/empty input', () => {
      expect(stripFileUri(null)).toBe('');
      expect(stripFileUri(undefined)).toBe('');
      expect(stripFileUri('')).toBe('');
    });

    it('removes file:// prefix from URIs', () => {
      const uri = 'file:///var/mobile/Containers/Data/test.jpg';
      expect(stripFileUri(uri)).toBe('/var/mobile/Containers/Data/test.jpg');
    });

    it('returns absolute paths unchanged (no file:// to strip)', () => {
      const path = '/var/mobile/Containers/Data/test.jpg';
      expect(stripFileUri(path)).toBe(path);
    });

    it('handles paths with spaces correctly', () => {
      const uri = 'file:///Users/test user/Documents/test file.jpg';
      expect(stripFileUri(uri)).toBe('/Users/test user/Documents/test file.jpg');
    });
  });

  describe('isFileUri', () => {
    it('returns false for null/undefined', () => {
      expect(isFileUri(null)).toBe(false);
      expect(isFileUri(undefined)).toBe(false);
    });

    it('returns true for valid file URIs', () => {
      expect(isFileUri('file:///var/mobile/test.jpg')).toBe(true);
      expect(isFileUri('file:///Users/test/Documents/image.png')).toBe(true);
    });

    it('returns false for absolute paths without file://', () => {
      expect(isFileUri('/var/mobile/test.jpg')).toBe(false);
      expect(isFileUri('/Users/test/Documents/image.png')).toBe(false);
    });

    it('returns false for relative paths', () => {
      expect(isFileUri('relative/path/file.jpg')).toBe(false);
      expect(isFileUri('./file.jpg')).toBe(false);
    });
  });

  describe('isAbsolutePath', () => {
    it('returns false for null/undefined', () => {
      expect(isAbsolutePath(null)).toBe(false);
      expect(isAbsolutePath(undefined)).toBe(false);
    });

    it('returns true for absolute paths', () => {
      expect(isAbsolutePath('/var/mobile/test.jpg')).toBe(true);
      expect(isAbsolutePath('/Users/test/Documents/image.png')).toBe(true);
    });

    it('returns false for file URIs (they start with file://, not /)', () => {
      expect(isAbsolutePath('file:///var/mobile/test.jpg')).toBe(false);
    });

    it('returns false for relative paths', () => {
      expect(isAbsolutePath('relative/path/file.jpg')).toBe(false);
      expect(isAbsolutePath('./file.jpg')).toBe(false);
    });
  });

  describe('getFilename', () => {
    it('returns empty string for null/undefined/empty input', () => {
      expect(getFilename(null)).toBe('');
      expect(getFilename(undefined)).toBe('');
      expect(getFilename('')).toBe('');
    });

    it('extracts filename from absolute path', () => {
      expect(getFilename('/var/mobile/Containers/Data/test.jpg')).toBe('test.jpg');
      expect(getFilename('/Users/test/Documents/image.png')).toBe('image.png');
    });

    it('extracts filename from file URI', () => {
      expect(getFilename('file:///var/mobile/Containers/Data/test.jpg')).toBe('test.jpg');
      expect(getFilename('file:///Users/test/Documents/image.png')).toBe('image.png');
    });

    it('extracts filename with spaces', () => {
      expect(getFilename('/Users/test/my file name.jpg')).toBe('my file name.jpg');
      expect(getFilename('file:///Users/test/my file name.jpg')).toBe('my file name.jpg');
    });

    it('handles paths ending with slash', () => {
      expect(getFilename('/var/mobile/')).toBe('');
    });

    it('handles simple filenames (no path)', () => {
      expect(getFilename('test.jpg')).toBe('test.jpg');
    });
  });

  describe('roundtrip: ensureFileUri + stripFileUri', () => {
    it('roundtrips absolute path correctly', () => {
      const path = '/var/mobile/Containers/Data/test.jpg';
      const uri = ensureFileUri(path);
      const stripped = stripFileUri(uri);
      expect(stripped).toBe(path);
    });

    it('roundtrips file URI correctly', () => {
      const uri = 'file:///var/mobile/Containers/Data/test.jpg';
      const stripped = stripFileUri(uri);
      const restored = ensureFileUri(stripped);
      expect(restored).toBe(uri);
    });
  });
});
