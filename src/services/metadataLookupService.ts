/**
 * Metadata Lookup Service - Search for book metadata using title/author
 *
 * Uses Open Library Search API (primary, no key required)
 * and Google Books API (optional, no key required for basic searches)
 *
 * Feature-flagged: Only performs network calls when METADATA_LOOKUP_ENABLED is true.
 * Debug artifacts written only when DEBUG_ARTIFACTS_ENABLED is true.
 */

import RNFS from 'react-native-fs';
import type { MetadataMatch } from '../types';
import { isMetadataLookupEnabled } from '../config/debug';
import { isArtifactWritingEnabled, getSessionDir } from './debugArtifacts';

// API endpoints
const OPEN_LIBRARY_SEARCH = 'https://openlibrary.org/search.json';
const GOOGLE_BOOKS_SEARCH = 'https://www.googleapis.com/books/v1/volumes';

// Request timeout in milliseconds
const FETCH_TIMEOUT = 10000;

/**
 * Search parameters
 */
export interface SearchParams {
  title: string;
  author?: string;
}

/**
 * Search result with matches from all sources
 */
export interface SearchResult {
  ok: boolean;
  error?: string;
  matches: MetadataMatch[];
  searchedAt: string;
  sources: ('openLibrary' | 'googleBooks')[];
}

/**
 * Check if metadata lookup is available (feature flag + network)
 */
export function isMetadataLookupAvailable(): boolean {
  return isMetadataLookupEnabled();
}

/**
 * Fetch with timeout wrapper
 */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Search Open Library for books matching title/author
 * Returns top 3 matches
 */
async function searchOpenLibrary(params: SearchParams): Promise<MetadataMatch[]> {
  const queryParts: string[] = [];

  if (params.title) {
    queryParts.push(`title=${encodeURIComponent(params.title)}`);
  }
  if (params.author) {
    queryParts.push(`author=${encodeURIComponent(params.author)}`);
  }

  if (queryParts.length === 0) {
    return [];
  }

  const url = `${OPEN_LIBRARY_SEARCH}?${queryParts.join('&')}&limit=5&fields=key,title,author_name,first_publish_year,publisher,isbn,cover_i`;

  console.log(`[MetadataLookup] Open Library query: ${url}`);

  try {
    const response = await fetchWithTimeout(url, FETCH_TIMEOUT);

    if (!response.ok) {
      console.warn(`[MetadataLookup] Open Library error: ${response.status}`);
      return [];
    }

    const data = await response.json();

    if (!data.docs || !Array.isArray(data.docs)) {
      return [];
    }

    // Convert to MetadataMatch format
    const matches: MetadataMatch[] = data.docs.slice(0, 3).map((doc: any, index: number) => {
      // Calculate relevance score based on match quality
      let score = 1.0 - index * 0.1; // Base score decreases by position

      // Build cover URL if available
      let coverUrl: string | undefined;
      if (doc.cover_i) {
        coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`;
      }

      return {
        score,
        title: doc.title || '',
        authors: Array.isArray(doc.author_name) ? doc.author_name : [],
        isbn: Array.isArray(doc.isbn) ? doc.isbn[0] : undefined,
        publisher: Array.isArray(doc.publisher) ? doc.publisher[0] : undefined,
        publishYear: doc.first_publish_year?.toString(),
        coverUrl,
        source: 'openLibrary' as const,
        sourceId: doc.key,
      };
    });

    console.log(`[MetadataLookup] Open Library: ${matches.length} matches`);
    return matches;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.warn('[MetadataLookup] Open Library request timed out');
    } else {
      console.warn(`[MetadataLookup] Open Library error: ${error.message}`);
    }
    return [];
  }
}

/**
 * Search Google Books for books matching title/author
 * Returns top 3 matches
 */
async function searchGoogleBooks(params: SearchParams): Promise<MetadataMatch[]> {
  const queryParts: string[] = [];

  if (params.title) {
    queryParts.push(`intitle:${params.title}`);
  }
  if (params.author) {
    queryParts.push(`inauthor:${params.author}`);
  }

  if (queryParts.length === 0) {
    return [];
  }

  const query = encodeURIComponent(queryParts.join(' '));
  const url = `${GOOGLE_BOOKS_SEARCH}?q=${query}&maxResults=5&printType=books`;

  console.log(`[MetadataLookup] Google Books query: ${url}`);

  try {
    const response = await fetchWithTimeout(url, FETCH_TIMEOUT);

    if (!response.ok) {
      console.warn(`[MetadataLookup] Google Books error: ${response.status}`);
      return [];
    }

    const data = await response.json();

    if (!data.items || !Array.isArray(data.items)) {
      return [];
    }

    // Convert to MetadataMatch format
    const matches: MetadataMatch[] = data.items.slice(0, 3).map((item: any, index: number) => {
      const volumeInfo = item.volumeInfo || {};

      // Calculate relevance score based on match quality
      let score = 0.9 - index * 0.1; // Base score slightly lower than Open Library

      // Extract ISBN from industry identifiers
      let isbn: string | undefined;
      if (volumeInfo.industryIdentifiers) {
        const isbnObj = volumeInfo.industryIdentifiers.find(
          (id: any) => id.type === 'ISBN_13' || id.type === 'ISBN_10'
        );
        if (isbnObj) {
          isbn = isbnObj.identifier;
        }
      }

      // Get cover image (thumbnail)
      let coverUrl: string | undefined;
      if (volumeInfo.imageLinks?.thumbnail) {
        coverUrl = volumeInfo.imageLinks.thumbnail.replace('http://', 'https://');
      }

      return {
        score,
        title: volumeInfo.title || '',
        authors: Array.isArray(volumeInfo.authors) ? volumeInfo.authors : [],
        isbn,
        publisher: volumeInfo.publisher,
        publishYear: volumeInfo.publishedDate?.slice(0, 4),
        coverUrl,
        source: 'googleBooks' as const,
        sourceId: item.id,
      };
    });

    console.log(`[MetadataLookup] Google Books: ${matches.length} matches`);
    return matches;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.warn('[MetadataLookup] Google Books request timed out');
    } else {
      console.warn(`[MetadataLookup] Google Books error: ${error.message}`);
    }
    return [];
  }
}

/**
 * Search for books matching title/author
 * Uses Open Library as primary source, Google Books as secondary
 *
 * @param params - Search parameters with title and optional author
 * @returns SearchResult with up to 3 matches
 */
export async function searchBooks(params: SearchParams): Promise<SearchResult> {
  // Check feature flag
  if (!isMetadataLookupEnabled()) {
    return {
      ok: false,
      error: 'Metadata lookup is disabled',
      matches: [],
      searchedAt: new Date().toISOString(),
      sources: [],
    };
  }

  // Validate params
  if (!params.title || params.title.trim().length < 2) {
    return {
      ok: false,
      error: 'Title is required (at least 2 characters)',
      matches: [],
      searchedAt: new Date().toISOString(),
      sources: [],
    };
  }

  console.log(`[MetadataLookup] Searching for: "${params.title}" by "${params.author || '(unknown)'}"`);

  const sources: ('openLibrary' | 'googleBooks')[] = [];
  let allMatches: MetadataMatch[] = [];

  // Search Open Library (primary)
  try {
    const olMatches = await searchOpenLibrary(params);
    if (olMatches.length > 0) {
      sources.push('openLibrary');
      allMatches = allMatches.concat(olMatches);
    }
  } catch (error: any) {
    console.warn(`[MetadataLookup] Open Library search failed: ${error.message}`);
  }

  // Search Google Books (secondary) if we need more results
  if (allMatches.length < 3) {
    try {
      const gbMatches = await searchGoogleBooks(params);
      if (gbMatches.length > 0) {
        sources.push('googleBooks');
        allMatches = allMatches.concat(gbMatches);
      }
    } catch (error: any) {
      console.warn(`[MetadataLookup] Google Books search failed: ${error.message}`);
    }
  }

  // Sort by score and take top 3
  allMatches.sort((a, b) => b.score - a.score);
  const topMatches = allMatches.slice(0, 3);

  const result: SearchResult = {
    ok: topMatches.length > 0,
    matches: topMatches,
    searchedAt: new Date().toISOString(),
    sources,
  };

  if (topMatches.length === 0) {
    result.error = 'No matches found';
  }

  console.log(`[MetadataLookup] Final: ${topMatches.length} matches from ${sources.join(', ') || 'none'}`);

  return result;
}

/**
 * Search for a crop and persist results to sessionMeta
 * Also writes debug artifact if enabled
 */
export async function searchAndPersist(
  sessionId: string,
  cropIndex: number,
  params: SearchParams
): Promise<SearchResult> {
  const result = await searchBooks(params);

  // Write debug artifact if enabled
  if (isArtifactWritingEnabled() && result.ok) {
    try {
      const sessionDir = getSessionDir(sessionId);
      const cropsDir = `${sessionDir}/crops`;
      const metadataPath = `${cropsDir}/crop_${cropIndex}.metadata.json`;

      await RNFS.mkdir(cropsDir);
      await RNFS.writeFile(metadataPath, JSON.stringify(result, null, 2), 'utf8');
      console.log(`[MetadataLookup] Wrote artifact: crop_${cropIndex}.metadata.json`);
    } catch (error: any) {
      console.warn(`[MetadataLookup] Failed to write artifact: ${error.message}`);
    }
  }

  return result;
}
