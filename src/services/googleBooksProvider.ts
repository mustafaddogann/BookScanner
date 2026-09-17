/**
 * Google Books Provider
 *
 * Implements MetadataLookupProvider using Google Books API:
 * - Search API: https://www.googleapis.com/books/v1/volumes
 *
 * No API key required for basic searches (uses public tier).
 * This provider is used as a fallback when Open Library returns no results.
 */

import type { ResolvedBook } from '../types';
import type { MetadataLookupProvider } from './metadataLookupProvider';
import { useDebugStore } from '../store/useDebugStore';
import { GOOGLE_BOOKS_HEADERS, withGoogleBooksKey } from '../config/googleBooks';

// API endpoint
const GOOGLE_BOOKS_SEARCH = 'https://www.googleapis.com/books/v1/volumes';

// Request timeout in milliseconds
const FETCH_TIMEOUT = 10000;

// Maximum results per query
const MAX_RESULTS = 10;

/**
 * Check if verbose diagnostics logging should be enabled.
 */
function shouldLogVerbose(): boolean {
  const diagnosticsEnabled = useDebugStore.getState().diagnosticsEnabled;
  return __DEV__ && diagnosticsEnabled;
}

/**
 * Fetch with timeout wrapper
 */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(withGoogleBooksKey(url), {
      signal: controller.signal,
      headers: GOOGLE_BOOKS_HEADERS,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Extract year from various date formats
 */
function extractYear(dateStr: string | undefined): string | undefined {
  if (!dateStr) return undefined;
  const match = dateStr.match(/\b(1[0-9]{3}|20[0-2][0-9])\b/);
  return match ? match[1] : undefined;
}

/**
 * Normalize ISBN by removing hyphens and spaces
 */
function normalizeIsbn(isbn: string): string {
  return isbn.replace(/[-\s]/g, '');
}

/**
 * Check if a string is a valid ISBN-13
 */
function isIsbn13(isbn: string): boolean {
  const normalized = normalizeIsbn(isbn);
  return /^97[89]\d{10}$/.test(normalized);
}

/**
 * Check if a string is a valid ISBN-10
 */
function isIsbn10(isbn: string): boolean {
  const normalized = normalizeIsbn(isbn);
  return /^\d{9}[\dXx]$/.test(normalized);
}

/**
 * Volume info from Google Books API response
 */
interface GoogleBooksVolumeInfo {
  title?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  industryIdentifiers?: Array<{
    type: string;
    identifier: string;
  }>;
  imageLinks?: {
    thumbnail?: string;
    smallThumbnail?: string;
  };
  pageCount?: number;
  categories?: string[];
}

/**
 * Volume item from Google Books API response
 */
interface GoogleBooksVolume {
  id: string;
  volumeInfo: GoogleBooksVolumeInfo;
}

/**
 * Search response from Google Books API
 */
interface GoogleBooksSearchResponse {
  kind: string;
  totalItems: number;
  items?: GoogleBooksVolume[];
}

/**
 * Google Books Provider Implementation
 */
export class GoogleBooksProvider implements MetadataLookupProvider {
  readonly name = 'googleBooks';
  readonly isEnabled = true;

  /**
   * Search by ISBN using Google Books API
   */
  async searchByIsbn(isbn: string): Promise<ResolvedBook[]> {
    const normalized = normalizeIsbn(isbn);
    if (!isIsbn10(normalized) && !isIsbn13(normalized)) {
      console.warn(`[GoogleBooks] Invalid ISBN format: ${isbn}`);
      return [];
    }

    const verbose = shouldLogVerbose();
    if (verbose) {
      console.log(`[GoogleBooks] searchByIsbn: ${normalized}`);
    }

    try {
      // Search using isbn: prefix for better accuracy
      const url = `${GOOGLE_BOOKS_SEARCH}?q=isbn:${normalized}&maxResults=1&printType=books`;

      if (verbose) {
        console.log(`[GoogleBooks] ISBN search URL: ${url}`);
      }

      const response = await fetchWithTimeout(url, FETCH_TIMEOUT);
      if (!response.ok) {
        console.warn(`[GoogleBooks] API error: ${response.status}`);
        return [];
      }

      const data: GoogleBooksSearchResponse = await response.json();

      if (!data.items || data.items.length === 0) {
        if (verbose) {
          console.log(`[GoogleBooks] No result for ISBN: ${normalized}`);
        }
        return [];
      }

      return data.items.map(item => this.volumeToResolvedBook(item));
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.warn('[GoogleBooks] ISBN request timed out');
      } else {
        console.warn(`[GoogleBooks] ISBN search error: ${error.message}`);
      }
      return [];
    }
  }

  /**
   * Search by text query using Google Books API
   */
  async searchByText(query: string): Promise<ResolvedBook[]> {
    if (!query || query.trim().length < 2) {
      return [];
    }

    console.log(`[GoogleBooksProvider] searchByText START query="${query}"`);
    const startTime = Date.now();
    const verbose = shouldLogVerbose();

    try {
      const results = await this.searchByQuery(query, MAX_RESULTS);

      console.log(`[GoogleBooksProvider] searchByText END query="${query}" count=${results.length} ms=${Date.now() - startTime}`);
      return results;
    } catch (error: any) {
      console.warn(`[GoogleBooksProvider] searchByText ERROR query="${query}" error="${error.message}" ms=${Date.now() - startTime}`);
      return [];
    }
  }

  /**
   * Search Google Books by query string
   */
  async searchByQuery(queryString: string, limit: number = MAX_RESULTS): Promise<ResolvedBook[]> {
    const verbose = shouldLogVerbose();

    // Encode the query
    const encodedQuery = encodeURIComponent(queryString);
    const url = `${GOOGLE_BOOKS_SEARCH}?q=${encodedQuery}&maxResults=${limit}&printType=books`;

    if (verbose) {
      console.log(`[GoogleBooks] Search URL: ${url}`);
    }

    const response = await fetchWithTimeout(url, FETCH_TIMEOUT);
    if (!response.ok) {
      console.warn(`[GoogleBooks] Search API error: ${response.status}`);
      return [];
    }

    const data: GoogleBooksSearchResponse = await response.json();

    if (!data.items || data.items.length === 0) {
      if (verbose) {
        console.log(`[GoogleBooks] No results for query: ${queryString}`);
      }
      return [];
    }

    if (verbose) {
      console.log(`[GoogleBooks] Search returned ${data.items.length} items (totalItems: ${data.totalItems})`);
    }

    return data.items.slice(0, limit).map(item => this.volumeToResolvedBook(item));
  }

  /**
   * Search by title and optional author with structured query
   */
  async searchByTitleAuthor(title: string, author?: string | null): Promise<ResolvedBook[]> {
    const queryParts: string[] = [];

    if (title) {
      queryParts.push(`intitle:${title}`);
    }
    if (author) {
      queryParts.push(`inauthor:${author}`);
    }

    if (queryParts.length === 0) {
      return [];
    }

    const query = queryParts.join(' ');
    console.log(`[GoogleBooks] Structured search: title="${title}" author="${author ?? 'none'}"`);

    return this.searchByQuery(query, MAX_RESULTS);
  }

  /**
   * Check if Google Books API is reachable
   */
  async checkAvailability(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(
        `${GOOGLE_BOOKS_SEARCH}?q=test&maxResults=1`,
        5000
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Convert a Google Books volume to ResolvedBook
   */
  private volumeToResolvedBook(volume: GoogleBooksVolume): ResolvedBook {
    const info = volume.volumeInfo;

    // Extract ISBNs from industry identifiers
    let isbn13: string | undefined;
    let isbn10: string | undefined;

    if (info.industryIdentifiers) {
      for (const id of info.industryIdentifiers) {
        if (id.type === 'ISBN_13') {
          isbn13 = normalizeIsbn(id.identifier);
        } else if (id.type === 'ISBN_10') {
          isbn10 = normalizeIsbn(id.identifier);
        }
      }
    }

    // Get cover URL (prefer thumbnail, upgrade to https)
    let coverUrl: string | undefined;
    if (info.imageLinks?.thumbnail) {
      coverUrl = info.imageLinks.thumbnail.replace('http://', 'https://');
    } else if (info.imageLinks?.smallThumbnail) {
      coverUrl = info.imageLinks.smallThumbnail.replace('http://', 'https://');
    }

    return {
      title: info.title || '',
      authors: info.authors || [],
      isbn13,
      isbn10,
      publisher: info.publisher,
      publishYear: extractYear(info.publishedDate),
      coverUrl,
      source: 'googleBooks',
      sourceId: volume.id,
    };
  }
}

/**
 * Build resolver_key for a Google Books result
 * Format: "googleBooks:<volumeId>" or "isbn:<isbn13>"
 */
export function buildGoogleBooksResolverKey(book: ResolvedBook): string {
  if (book.isbn13) {
    return `isbn:${book.isbn13}`;
  }
  if (book.isbn10) {
    return `isbn:${book.isbn10}`;
  }
  return `googleBooks:${book.sourceId || 'unknown'}`;
}
