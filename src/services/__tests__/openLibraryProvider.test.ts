/**
 * Unit tests for Open Library Provider
 * Gate 9: ISBN fetching and enrichment
 */

import type { ResolvedBook } from '../../types';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// These tests cover the Open Library API path; the Supabase catalog is off unless a test enables it.
let mockSupabaseConfigured = false;
jest.mock('../../config/supabase', () => ({
  ...jest.requireActual('../../config/supabase'),
  isSupabaseConfigured: () => mockSupabaseConfigured,
  getSupabaseBaseUrl: () => 'https://catalog.test',
  getSupabaseAnonKey: () => 'anon-key',
}));

// Mock useDebugStore
jest.mock('../../store/useDebugStore', () => ({
  useDebugStore: {
    getState: () => ({ diagnosticsEnabled: false }),
  },
}));

import {
  OpenLibraryProvider,
  buildResolverKey,
  buildQueryHash,
  testOpenLibraryIsbnResolution,
} from '../openLibraryProvider';

// ============================================================================
// Test Utilities
// ============================================================================

function createMockSearchResponse(docs: any[], numFound: number = docs.length) {
  return {
    ok: true,
    json: () => Promise.resolve({ docs, numFound }),
  };
}

function createMockBooksApiResponse(data: Record<string, any>) {
  return {
    ok: true,
    json: () => Promise.resolve(data),
  };
}

// ============================================================================
// Setup/Teardown
// ============================================================================

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockReset();
  mockSupabaseConfigured = false;
});

// ============================================================================
// OpenLibraryProvider.searchByIsbn Tests
// ============================================================================

describe('OpenLibraryProvider.searchByIsbn', () => {
  const provider = new OpenLibraryProvider();

  it('returns empty array for invalid ISBN', async () => {
    const result = await provider.searchByIsbn('invalid');
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty array for too short ISBN', async () => {
    const result = await provider.searchByIsbn('12345');
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches book data for valid ISBN-13', async () => {
    const isbn = '9780743273565';
    const mockData = {
      [`ISBN:${isbn}`]: {
        title: 'The Great Gatsby',
        authors: [{ name: 'F. Scott Fitzgerald' }],
        publishers: [{ name: 'Scribner' }],
        publish_date: '1925',
        identifiers: {
          isbn_13: ['978-0-7432-7356-5'],
          isbn_10: ['0743273567'],
          openlibrary: ['OL1234M'],
        },
        cover: {
          medium: 'https://covers.openlibrary.org/b/id/123-M.jpg',
        },
      },
    };

    mockFetch.mockResolvedValueOnce(createMockBooksApiResponse(mockData));

    const result = await provider.searchByIsbn(isbn);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`bibkeys=ISBN:${isbn}`),
      expect.any(Object)
    );
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('The Great Gatsby');
    expect(result[0].isbn13).toBe('9780743273565');
    expect(result[0].isbn10).toBe('0743273567');
    expect(result[0].source).toBe('openLibrary');
  });

  it('fetches book data for valid ISBN-10', async () => {
    const isbn = '0743273567';
    const mockData = {
      [`ISBN:${isbn}`]: {
        title: 'The Great Gatsby',
        authors: [{ name: 'F. Scott Fitzgerald' }],
        identifiers: {
          isbn_10: ['0743273567'],
        },
      },
    };

    mockFetch.mockResolvedValueOnce(createMockBooksApiResponse(mockData));

    const result = await provider.searchByIsbn(isbn);

    expect(result).toHaveLength(1);
    expect(result[0].isbn10).toBe('0743273567');
  });

  it('returns empty array when book not found', async () => {
    mockFetch.mockResolvedValueOnce(createMockBooksApiResponse({}));

    const result = await provider.searchByIsbn('9781234567890');

    expect(result).toEqual([]);
  });

  it('handles fetch error gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await provider.searchByIsbn('9780743273565');

    expect(result).toEqual([]);
  });

  it('handles non-OK response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await provider.searchByIsbn('9780743273565');

    expect(result).toEqual([]);
  });
});

// ============================================================================
// OpenLibraryProvider.searchByText Tests
// ============================================================================

describe('OpenLibraryProvider.searchByText', () => {
  const provider = new OpenLibraryProvider();

  it('returns empty array for empty query', async () => {
    const result = await provider.searchByText('');
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns empty array for too short query', async () => {
    const result = await provider.searchByText('a');
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns catalog results without calling Open Library when the catalog has enough matches', async () => {
    mockSupabaseConfigured = true;
    const row = (id: string, title: string) => ({
      id,
      provider: 'openLibrary',
      provider_id: id,
      isbn13: null,
      isbn10: null,
      title,
      authors: ['Stephen King'],
      publisher: null,
      publish_year: null,
      cover_url: null,
      resolver_key: `openlibrary:${id}`,
      similarity_score: 0.9,
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          row('OL1M', 'The Shining'),
          row('OL2M', 'The Shining (Anchor)'),
          row('OL3M', 'Doctor Sleep'),
        ]),
    });

    const result = await provider.searchByText('The Shining Stephen King');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://catalog.test/rest/v1/rpc/search_books_fuzzy');
    expect(result.map((b) => b.title)).toEqual(['The Shining', 'The Shining (Anchor)', 'Doctor Sleep']);
    expect(result[0].sourceId).toBe('openlibrary:OL1M');
  });

  it('searches and enriches results with ISBNs', async () => {
    // Mock search API response
    const searchResponse = createMockSearchResponse([
      {
        key: '/works/OL123W',
        title: 'The Shining',
        author_name: ['Stephen King'],
        first_publish_year: 1977,
        edition_key: ['OL456M'],
        cover_i: 789,
      },
    ]);

    // Mock Books API enrichment response
    const booksApiResponse = createMockBooksApiResponse({
      'OLID:OL456M': {
        title: 'The Shining',
        authors: [{ name: 'Stephen King' }],
        publishers: [{ name: 'Doubleday' }],
        publish_date: '1977',
        identifiers: {
          isbn_13: ['9780385121675'],
          isbn_10: ['0385121679'],
        },
        cover: {
          medium: 'https://covers.openlibrary.org/b/id/789-M.jpg',
        },
      },
    });

    mockFetch
      .mockResolvedValueOnce(searchResponse)
      .mockResolvedValueOnce(booksApiResponse);

    const result = await provider.searchByText('The Shining Stephen King');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // First call: search API
    expect(mockFetch.mock.calls[0][0]).toContain('search.json');
    // Second call: books API for enrichment
    expect(mockFetch.mock.calls[1][0]).toContain('api/books');

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('The Shining');
    expect(result[0].isbn13).toBe('9780385121675');
    expect(result[0].isbn10).toBe('0385121679');
    expect(result[0].source).toBe('openLibrary');
    expect(result[0].sourceId).toBe('OL456M');
  });

  it('handles empty search results', async () => {
    mockFetch.mockResolvedValueOnce(createMockSearchResponse([]));

    const result = await provider.searchByText('nonexistent book xyz123');

    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('uses work key when no edition key available', async () => {
    const searchResponse = createMockSearchResponse([
      {
        key: '/works/OL789W',
        title: 'Some Book',
        author_name: ['Author Name'],
      },
    ]);

    // No enrichment data available
    mockFetch
      .mockResolvedValueOnce(searchResponse)
      .mockResolvedValueOnce(createMockBooksApiResponse({}));

    const result = await provider.searchByText('Some Book');

    expect(result).toHaveLength(1);
    expect(result[0].sourceId).toBe('OL789W');
  });
});

// ============================================================================
// OpenLibraryProvider.searchByQuery Tests
// ============================================================================

describe('OpenLibraryProvider.searchByQuery', () => {
  const provider = new OpenLibraryProvider();

  it('returns candidates with edition keys', async () => {
    const searchResponse = createMockSearchResponse([
      {
        key: '/works/OL1W',
        title: 'Book One',
        author_name: ['Author One'],
        edition_key: ['OL1M', 'OL2M'],
        cover_i: 100,
      },
      {
        key: '/works/OL2W',
        title: 'Book Two',
        author_name: ['Author Two'],
        edition_key: ['OL3M'],
      },
    ]);

    mockFetch.mockResolvedValueOnce(searchResponse);

    const result = await provider.searchByQuery('test query', 2);

    expect(result).toHaveLength(2);
    expect(result[0].olid).toBe('OL1M'); // First edition key
    expect(result[1].olid).toBe('OL3M');
  });

  it('respects limit parameter', async () => {
    const searchResponse = createMockSearchResponse([
      { key: '/works/OL1W', title: 'Book 1', edition_key: ['OL1M'] },
      { key: '/works/OL2W', title: 'Book 2', edition_key: ['OL2M'] },
      { key: '/works/OL3W', title: 'Book 3', edition_key: ['OL3M'] },
      { key: '/works/OL4W', title: 'Book 4', edition_key: ['OL4M'] },
      { key: '/works/OL5W', title: 'Book 5', edition_key: ['OL5M'] },
    ]);

    mockFetch.mockResolvedValueOnce(searchResponse);

    const result = await provider.searchByQuery('test', 3);

    expect(result).toHaveLength(3);
  });
});

// ============================================================================
// OpenLibraryProvider.enrichToISBN Tests
// ============================================================================

describe('OpenLibraryProvider.enrichToISBN', () => {
  const provider = new OpenLibraryProvider();

  it('returns empty array for empty candidates', async () => {
    const result = await provider.enrichToISBN([]);
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('batches multiple candidates in one request', async () => {
    const candidates = [
      { olid: 'OL1M', title: 'Book 1' },
      { olid: 'OL2M', title: 'Book 2' },
      { olid: 'OL3M', title: 'Book 3' },
    ];

    const booksApiResponse = createMockBooksApiResponse({
      'OLID:OL1M': {
        title: 'Book 1',
        identifiers: { isbn_13: ['9781111111111'] },
      },
      'OLID:OL2M': {
        title: 'Book 2',
        identifiers: { isbn_10: ['2222222222'] },
      },
      'OLID:OL3M': {
        title: 'Book 3',
        identifiers: { isbn_13: ['9783333333333'], isbn_10: ['3333333333'] },
      },
    });

    mockFetch.mockResolvedValueOnce(booksApiResponse);

    const result = await provider.enrichToISBN(candidates);

    // Should only make one fetch call
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // URL-encoded OLIDs
    const fetchUrl = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toContain('api/books');
    expect(fetchUrl).toContain('OLID');

    expect(result).toHaveLength(3);
    expect(result[0].isbn13).toBe('9781111111111');
    expect(result[1].isbn10).toBe('2222222222');
    expect(result[2].isbn13).toBe('9783333333333');
    expect(result[2].isbn10).toBe('3333333333');
  });

  it('handles partial enrichment data', async () => {
    const candidates = [
      { olid: 'OL1M', title: 'Has Data', authors: ['Author 1'] },
      { olid: 'OL2M', title: 'No Data', authors: ['Author 2'] },
    ];

    const booksApiResponse = createMockBooksApiResponse({
      'OLID:OL1M': {
        title: 'Has Data Enriched',
        identifiers: { isbn_13: ['9781234567890'] },
      },
      // OL2M not in response
    });

    mockFetch.mockResolvedValueOnce(booksApiResponse);

    const result = await provider.enrichToISBN(candidates);

    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Has Data Enriched');
    expect(result[0].isbn13).toBe('9781234567890');
    expect(result[1].title).toBe('No Data'); // Falls back to candidate title
    expect(result[1].isbn13).toBeUndefined();
  });

  it('falls back to candidates on fetch error', async () => {
    const candidates = [
      { olid: 'OL1M', title: 'Fallback Book', authors: ['Fallback Author'] },
    ];

    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await provider.enrichToISBN(candidates);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Fallback Book');
    expect(result[0].authors).toEqual(['Fallback Author']);
    expect(result[0].isbn13).toBeUndefined();
  });
});

// ============================================================================
// buildResolverKey Tests
// ============================================================================

describe('buildResolverKey', () => {
  it('builds openlibrary key when source is openLibrary', () => {
    const book: ResolvedBook = {
      title: 'Test',
      authors: [],
      source: 'openLibrary',
      sourceId: 'OL123M',
    };

    expect(buildResolverKey(book)).toBe('openlibrary:OL123M');
  });

  it('builds isbn key when no sourceId but has isbn13', () => {
    const book: ResolvedBook = {
      title: 'Test',
      authors: [],
      source: 'openLibrary',
      isbn13: '9780743273565',
    };

    expect(buildResolverKey(book)).toBe('isbn:9780743273565');
  });

  it('builds isbn key from isbn10 when no isbn13', () => {
    const book: ResolvedBook = {
      title: 'Test',
      authors: [],
      source: 'openLibrary',
      isbn10: '0743273567',
    };

    expect(buildResolverKey(book)).toBe('isbn:0743273567');
  });

  it('builds googleBooks key', () => {
    const book: ResolvedBook = {
      title: 'Test',
      authors: [],
      source: 'googleBooks',
      sourceId: 'vol123',
    };

    expect(buildResolverKey(book)).toBe('googleBooks:vol123');
  });

  it('falls back to source:unknown when nothing available', () => {
    const book: ResolvedBook = {
      title: 'Test',
      authors: [],
      source: 'manual',
    };

    expect(buildResolverKey(book)).toBe('manual:unknown');
  });
});

// ============================================================================
// buildQueryHash Tests
// ============================================================================

describe('buildQueryHash', () => {
  it('generates consistent hash for same input', () => {
    const hash1 = buildQueryHash('text', 'The Shining');
    const hash2 = buildQueryHash('text', 'The Shining');
    expect(hash1).toBe(hash2);
  });

  it('generates different hash for different query types', () => {
    const textHash = buildQueryHash('text', '9780743273565');
    const isbnHash = buildQueryHash('isbn', '9780743273565');
    expect(textHash).not.toBe(isbnHash);
  });

  it('generates different hash for different queries', () => {
    const hash1 = buildQueryHash('text', 'Book One');
    const hash2 = buildQueryHash('text', 'Book Two');
    expect(hash1).not.toBe(hash2);
  });

  it('normalizes case and whitespace', () => {
    const hash1 = buildQueryHash('text', 'The Shining');
    const hash2 = buildQueryHash('text', '  the shining  ');
    expect(hash1).toBe(hash2);
  });

  it('returns hex string', () => {
    const hash = buildQueryHash('text', 'test query');
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });
});

// ============================================================================
// checkAvailability Tests
// ============================================================================

describe('OpenLibraryProvider.checkAvailability', () => {
  const provider = new OpenLibraryProvider();

  it('returns true when Open Library is reachable', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await provider.checkAvailability();

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('search.json?q=test&limit=1'),
      expect.any(Object)
    );
  });

  it('returns false when Open Library is not reachable', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

    const result = await provider.checkAvailability();

    expect(result).toBe(false);
  });

  it('returns false on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await provider.checkAvailability();

    expect(result).toBe(false);
  });
});
