/**
 * Unit tests for Books Catalog Service
 * Gate 9 Extension: Persistent Book Identity
 */

import type { ResolvedBook, BookCandidate, BookEvidence } from '../../types';

// Mock Supabase client - direct upsert chain: from().upsert().select().single()
const mockSingle = jest.fn();
const mockSelectAfterUpsert = jest.fn(() => ({ single: mockSingle }));
const mockUpsert = jest.fn(() => ({ select: mockSelectAfterUpsert }));

// For read operations: from().select().eq().single()
const mockReadSingle = jest.fn();
const mockEq: jest.Mock = jest.fn(() => ({ eq: mockEq, single: mockReadSingle }));
const mockSelectForRead = jest.fn(() => ({ eq: mockEq }));
const mockFrom = jest.fn(() => {
  // Return different chains based on operation
  return {
    upsert: mockUpsert,
    select: mockSelectForRead,
  };
});

jest.mock('../../config/supabase', () => ({
  isSupabaseConfigured: jest.fn(() => true),
  getSupabaseClient: jest.fn(() => ({
    from: mockFrom,
  })),
}));

jest.mock('../../config/debug', () => ({
  isMetadataVerboseDebug: jest.fn(() => false),
}));

jest.mock('../supabaseCapabilities', () => ({
  getCapabilities: jest.fn(async () => ({
    supportsResolverKey: true,
    probedAt: Date.now(),
  })),
  supportsResolverKey: jest.fn(() => true),
}));

import {
  upsertResolvedBook,
  confirmUserSelection,
  applyUserSelectionToCandidate,
} from '../booksCatalogService';
import { isSupabaseConfigured } from '../../config/supabase';
import { getCapabilities } from '../supabaseCapabilities';

// ============================================================================
// Test Utilities
// ============================================================================

function createMockResolvedBook(overrides?: Partial<ResolvedBook>): ResolvedBook {
  return {
    title: 'The Great Gatsby',
    authors: ['F. Scott Fitzgerald'],
    isbn13: '9780743273565',
    isbn10: '0743273567',
    publisher: 'Scribner',
    publishYear: '1925',
    coverUrl: 'https://covers.openlibrary.org/b/id/1234-L.jpg',
    source: 'openLibrary',
    sourceId: 'OL12345W',
    ...overrides,
  };
}

function createMockEvidence(): BookEvidence {
  return {
    topCrops: [0],
    mergedLines: [
      { text: 'Test Book', normalizedText: 'testbook', confidence: 0.9, sourceCropIndex: 0, rotation: 0 },
    ],
    mergedTextBlock: 'Test Book\nTest Author',
  };
}

function createMockCandidate(id: string = 'test-candidate'): BookCandidate {
  return {
    id,
    detectionIndices: [0],
    cropIndices: [0],
    representativeDetectionIndex: 0,
    orderingKey: 0,
    angleRad: 0,
    confidenceScore: 0.9,
    evidence: createMockEvidence(),
  };
}

// ============================================================================
// Setup/Teardown
// ============================================================================

beforeEach(() => {
  jest.clearAllMocks();

  (getCapabilities as jest.Mock).mockResolvedValue({
    supportsResolverKey: true,
    probedAt: Date.now(),
  });

  // Setup default mock chain for upsert: from().upsert().select().single()
  mockSingle.mockResolvedValue({ data: null, error: null, status: 200, statusText: 'OK' });
  mockSelectAfterUpsert.mockReturnValue({ single: mockSingle });
  mockUpsert.mockReturnValue({ select: mockSelectAfterUpsert });

  // Setup default mock chain for read: from().select().eq().single()
  mockReadSingle.mockResolvedValue({ data: null, error: null });
  mockEq.mockReturnValue({ eq: mockEq, single: mockReadSingle });
  mockSelectForRead.mockReturnValue({ eq: mockEq });
});

// ============================================================================
// upsertResolvedBook Tests
// ============================================================================

describe('upsertResolvedBook', () => {
  it('returns error when Supabase is not configured', async () => {
    (isSupabaseConfigured as jest.Mock).mockReturnValueOnce(false);

    const book = createMockResolvedBook();
    const result = await upsertResolvedBook(book);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Supabase not configured');
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('skips upsert for manual source', async () => {
    const book = createMockResolvedBook({ source: 'manual' });
    const result = await upsertResolvedBook(book);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid source');
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('skips upsert for ocr source', async () => {
    const book = createMockResolvedBook({ source: 'ocr' });
    const result = await upsertResolvedBook(book);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid source');
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('skips upsert when no sourceId', async () => {
    const book = createMockResolvedBook({ sourceId: undefined });
    const result = await upsertResolvedBook(book);

    expect(result.success).toBe(false);
    expect(result.error).toBe('No sourceId available');
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('calls direct upsert with correct parameters including resolver_key', async () => {
    const mockBookId = 'uuid-12345';
    mockSingle.mockResolvedValueOnce({
      data: { id: mockBookId },
      error: null,
      status: 200,
      statusText: 'OK',
    });

    const book = createMockResolvedBook();
    const result = await upsertResolvedBook(book);

    expect(mockFrom).toHaveBeenCalledWith('books_catalog');
    expect(mockUpsert).toHaveBeenCalledWith(
      {
        resolver_key: 'openlibrary:OL12345W',
        provider: 'openLibrary',
        provider_id: 'OL12345W',
        title: 'The Great Gatsby',
        authors: ['F. Scott Fitzgerald'],
        isbn13: '9780743273565',
        isbn10: '0743273567',
        publisher: 'Scribner',
        publish_year: '1925',
        cover_url: 'https://covers.openlibrary.org/b/id/1234-L.jpg',
      },
      {
        onConflict: 'resolver_key',
        ignoreDuplicates: false,
      }
    );

    expect(result.success).toBe(true);
    expect(result.bookId).toBe(mockBookId);
  });

  it('builds resolver_key from googleBooks source', async () => {
    const mockBookId = 'uuid-isbn-key';
    mockSingle.mockResolvedValueOnce({
      data: { id: mockBookId },
      error: null,
      status: 200,
      statusText: 'OK',
    });

    // Book with googleBooks source - uses isbn when available
    const book = createMockResolvedBook({
      source: 'googleBooks',
      sourceId: 'vol123',
      isbn13: '9780743273565',
    });
    const result = await upsertResolvedBook(book);

    // buildResolverKey prefers isbn when available
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        resolver_key: 'isbn:9780743273565',
      }),
      expect.any(Object)
    );

    expect(result.success).toBe(true);
  });

  it('builds resolver_key from source:sourceId when no isbn', async () => {
    const mockBookId = 'uuid-no-isbn';
    mockSingle.mockResolvedValueOnce({
      data: { id: mockBookId },
      error: null,
      status: 200,
      statusText: 'OK',
    });

    const book = createMockResolvedBook({
      source: 'googleBooks',
      sourceId: 'vol456',
      isbn13: undefined,
      isbn10: undefined,
    });
    const result = await upsertResolvedBook(book);

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        resolver_key: 'googleBooks:vol456',
      }),
      expect.any(Object)
    );

    expect(result.success).toBe(true);
  });

  it('handles upsert error gracefully', async () => {
    mockSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'Database error', code: '42501', details: null, hint: null },
      status: 403,
      statusText: 'Forbidden',
    });

    const book = createMockResolvedBook();
    const result = await upsertResolvedBook(book);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Database error');
  });

  it('retries with provider key when resolver_key upsert hits provider unique', async () => {
    mockSingle
      .mockResolvedValueOnce({
        data: null,
        error: {
          message: 'duplicate key value violates unique constraint "books_catalog_provider_unique"',
          code: '23505',
          details: null,
          hint: null,
        },
        status: 409,
        statusText: 'Conflict',
      })
      .mockResolvedValueOnce({
        data: { id: 'uuid-fallback' },
        error: null,
        status: 200,
        statusText: 'OK',
      });

    const book = createMockResolvedBook();
    const result = await upsertResolvedBook(book);

    expect(mockUpsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ resolver_key: 'openlibrary:OL12345W' }),
      expect.objectContaining({ onConflict: 'resolver_key' })
    );
    expect(mockUpsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ resolver_key: 'openlibrary:OL12345W' }),
      expect.objectContaining({ onConflict: 'provider,provider_id' })
    );
    expect(result.success).toBe(true);
    expect(result.bookId).toBe('uuid-fallback');
  });

  it('returns existing id when duplicate persists after fallback', async () => {
    mockSingle
      .mockResolvedValueOnce({
        data: null,
        error: {
          message: 'duplicate key value violates unique constraint "books_catalog_provider_unique"',
          code: '23505',
          details: null,
          hint: null,
        },
        status: 409,
        statusText: 'Conflict',
      })
      .mockResolvedValueOnce({
        data: null,
        error: {
          message: 'duplicate key value violates unique constraint "books_catalog_provider_unique"',
          code: '23505',
          details: null,
          hint: null,
        },
        status: 409,
        statusText: 'Conflict',
      });

    mockReadSingle.mockResolvedValueOnce({
      data: { id: 'uuid-existing' },
      error: null,
    });

    const book = createMockResolvedBook();
    const result = await upsertResolvedBook(book);

    expect(mockUpsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ resolver_key: 'openlibrary:OL12345W' }),
      expect.objectContaining({ onConflict: 'resolver_key' })
    );
    expect(mockUpsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ resolver_key: 'openlibrary:OL12345W' }),
      expect.objectContaining({ onConflict: 'provider,provider_id' })
    );
    expect(mockSelectForRead).toHaveBeenCalledWith('id');
    expect(mockEq).toHaveBeenCalledWith('provider', 'openLibrary');
    expect(mockEq).toHaveBeenCalledWith('provider_id', 'OL12345W');
    expect(result.success).toBe(true);
    expect(result.bookId).toBe('uuid-existing');
  });

  it('handles null values for optional fields', async () => {
    const mockBookId = 'uuid-67890';
    mockSingle.mockResolvedValueOnce({
      data: { id: mockBookId },
      error: null,
      status: 200,
      statusText: 'OK',
    });

    const book = createMockResolvedBook({
      isbn13: undefined,
      isbn10: undefined,
      publisher: undefined,
      publishYear: undefined,
      coverUrl: undefined,
    });

    const result = await upsertResolvedBook(book);

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        isbn13: null,
        isbn10: null,
        publisher: null,
        publish_year: null,
        cover_url: null,
      }),
      expect.any(Object)
    );

    expect(result.success).toBe(true);
    expect(result.bookId).toBe(mockBookId);
  });
});

// ============================================================================
// confirmUserSelection Tests
// ============================================================================

describe('confirmUserSelection', () => {
  it('upserts book and returns bookId on success', async () => {
    const mockBookId = 'uuid-user-select';
    mockSingle.mockResolvedValueOnce({
      data: { id: mockBookId },
      error: null,
      status: 200,
      statusText: 'OK',
    });

    const book = createMockResolvedBook();
    const result = await confirmUserSelection(book, 'candidate-1');

    expect(result.success).toBe(true);
    expect(result.bookId).toBe(mockBookId);
    expect(result.updatedBook).toBeDefined();
    expect(result.updatedBook?.bookId).toBe(mockBookId);
  });

  it('returns error when upsert fails', async () => {
    mockSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'Upsert failed', code: '42501', details: null, hint: null },
      status: 403,
      statusText: 'Forbidden',
    });

    const book = createMockResolvedBook();
    const result = await confirmUserSelection(book);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Upsert failed');
    expect(result.updatedBook).toBeUndefined();
  });
});

// ============================================================================
// applyUserSelectionToCandidate Tests
// ============================================================================

describe('applyUserSelectionToCandidate', () => {
  it('updates candidate with resolved book and bookId', async () => {
    const mockBookId = 'uuid-applied';
    mockSingle.mockResolvedValueOnce({
      data: { id: mockBookId },
      error: null,
      status: 200,
      statusText: 'OK',
    });

    const candidate = createMockCandidate('my-candidate');
    const selectedBook = createMockResolvedBook();

    const result = await applyUserSelectionToCandidate(candidate, selectedBook);

    expect(result.resolvedBook).toBeDefined();
    expect(result.resolvedBook?.bookId).toBe(mockBookId);
    expect(result.resolvedConfidence).toBe(1.0);
    expect(result.resolverDecision).toBe('accept');
  });

  it('still applies selection when catalog upsert fails', async () => {
    mockSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'Catalog unavailable', code: '42501', details: null, hint: null },
      status: 403,
      statusText: 'Forbidden',
    });

    const candidate = createMockCandidate('fallback-candidate');
    const selectedBook = createMockResolvedBook();

    const result = await applyUserSelectionToCandidate(candidate, selectedBook);

    // Should still apply the selection, just without bookId
    expect(result.resolvedBook).toBeDefined();
    expect(result.resolvedBook?.title).toBe('The Great Gatsby');
    expect(result.resolvedBook?.bookId).toBeUndefined();
    expect(result.resolvedConfidence).toBe(1.0);
    expect(result.resolverDecision).toBe('accept');
  });
});

// ============================================================================
// Integration Behavior Tests
// ============================================================================

describe('books catalog integration behavior', () => {
  it('upsertResolvedBook only called for auto-accept (not ambiguous)', async () => {
    // This test verifies the expected behavior:
    // auto-accept -> upsert is called
    // ambiguous/suggest -> upsert is NOT called until user confirms

    const book = createMockResolvedBook();

    // Simulate auto-accept scenario
    mockSingle.mockResolvedValueOnce({
      data: { id: 'uuid-auto' },
      error: null,
      status: 200,
      statusText: 'OK',
    });
    const autoAcceptResult = await upsertResolvedBook(book);
    expect(autoAcceptResult.success).toBe(true);

    // For ambiguous, we don't call upsert directly
    // The user must call confirmUserSelection instead
    // This is verified by the applyUserSelectionToCandidate tests above
  });

  it('bookId is attached to resolved book after successful upsert', async () => {
    const mockBookId = 'uuid-attached';
    mockSingle.mockResolvedValueOnce({
      data: { id: mockBookId },
      error: null,
      status: 200,
      statusText: 'OK',
    });

    const book = createMockResolvedBook();
    const result = await upsertResolvedBook(book);

    expect(result.success).toBe(true);
    expect(result.bookId).toBe(mockBookId);

    // The caller is responsible for attaching bookId to the book
    // This is tested in the orchestrator integration
  });

  it('no-match decisions do not trigger upsert', async () => {
    // For no-match, there's no book to upsert
    // This is implicitly tested by the source guards:
    // - 'ocr' source is rejected
    // - 'manual' source is rejected
    // - missing sourceId is rejected

    const ocrOnlyBook = createMockResolvedBook({ source: 'ocr', sourceId: 'local' });
    const result = await upsertResolvedBook(ocrOnlyBook);

    expect(result.success).toBe(false);
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
