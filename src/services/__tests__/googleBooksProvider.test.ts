/**
 * Tests for Google Books Provider
 */

import { GoogleBooksProvider, buildGoogleBooksResolverKey } from '../googleBooksProvider';

// Mock fetch for tests
const mockFetch = jest.fn();
(globalThis as any).fetch = mockFetch;

// Mock debug store
jest.mock('../../store/useDebugStore', () => ({
  useDebugStore: {
    getState: () => ({ diagnosticsEnabled: false }),
  },
}));

describe('GoogleBooksProvider', () => {
  let provider: GoogleBooksProvider;

  beforeEach(() => {
    provider = new GoogleBooksProvider();
    mockFetch.mockReset();
  });

  describe('provider properties', () => {
    it('has correct name', () => {
      expect(provider.name).toBe('googleBooks');
    });

    it('is enabled by default', () => {
      expect(provider.isEnabled).toBe(true);
    });
  });

  describe('searchByText', () => {
    it('returns empty array for short query', async () => {
      const results = await provider.searchByText('a');
      expect(results).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('parses Google Books API response correctly', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          kind: 'books#volumes',
          totalItems: 1,
          items: [
            {
              id: 'abc123',
              volumeInfo: {
                title: 'The Buried',
                authors: ['Lisa Childs'],
                publisher: 'Zebra Books',
                publishedDate: '2023-05-15',
                industryIdentifiers: [
                  { type: 'ISBN_13', identifier: '9781420155167' },
                  { type: 'ISBN_10', identifier: '1420155164' },
                ],
                imageLinks: {
                  thumbnail: 'http://books.google.com/books/content?id=abc123',
                },
              },
            },
          ],
        }),
      });

      const results = await provider.searchByText('The Buried Lisa Childs');

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        title: 'The Buried',
        authors: ['Lisa Childs'],
        publisher: 'Zebra Books',
        publishYear: '2023',
        isbn13: '9781420155167',
        isbn10: '1420155164',
        source: 'googleBooks',
        sourceId: 'abc123',
      });
      // Cover URL should be https
      expect(results[0].coverUrl).toContain('https://');
    });

    it('handles empty results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          kind: 'books#volumes',
          totalItems: 0,
        }),
      });

      const results = await provider.searchByText('Nonexistent Book Title 12345');
      expect(results).toEqual([]);
    });

    it('handles API errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const results = await provider.searchByText('Test Query');
      expect(results).toEqual([]);
    });
  });

  describe('searchByIsbn', () => {
    it('rejects invalid ISBN format', async () => {
      const results = await provider.searchByIsbn('invalid');
      expect(results).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('searches with valid ISBN-13', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          kind: 'books#volumes',
          totalItems: 1,
          items: [
            {
              id: 'isbn-result',
              volumeInfo: {
                title: 'Test Book',
                authors: ['Test Author'],
              },
            },
          ],
        }),
      });

      const results = await provider.searchByIsbn('9781234567890');
      expect(results).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('isbn:9781234567890'),
        expect.any(Object)
      );
    });
  });

  describe('searchByTitleAuthor', () => {
    it('constructs structured query with title and author', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          kind: 'books#volumes',
          totalItems: 0,
        }),
      });

      await provider.searchByTitleAuthor('The Shining', 'Stephen King');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('intitle%3AThe%20Shining'),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('inauthor%3AStephen%20King'),
        expect.any(Object)
      );
    });
  });
});

describe('buildGoogleBooksResolverKey', () => {
  it('uses ISBN-13 when available', () => {
    const book = {
      title: 'Test',
      authors: [],
      isbn13: '9781234567890',
      source: 'googleBooks' as const,
      sourceId: 'vol123',
    };
    expect(buildGoogleBooksResolverKey(book)).toBe('isbn:9781234567890');
  });

  it('uses ISBN-10 as fallback', () => {
    const book = {
      title: 'Test',
      authors: [],
      isbn10: '1234567890',
      source: 'googleBooks' as const,
      sourceId: 'vol123',
    };
    expect(buildGoogleBooksResolverKey(book)).toBe('isbn:1234567890');
  });

  it('uses sourceId when no ISBN', () => {
    const book = {
      title: 'Test',
      authors: [],
      source: 'googleBooks' as const,
      sourceId: 'vol123',
    };
    expect(buildGoogleBooksResolverKey(book)).toBe('googleBooks:vol123');
  });
});
