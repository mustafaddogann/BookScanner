/**
 * Metadata Lookup Provider Interface
 *
 * Defines the contract for metadata lookup services.
 * Implementations can fetch book metadata from various sources
 * (Open Library, Google Books, ISBNdb, etc.)
 *
 * The default provider is disabled (returns empty results) to ensure
 * safe operation without network calls until a real provider is configured.
 */

import type { ResolvedBook } from '../types';

/**
 * Interface for metadata lookup providers
 *
 * Implementations must handle their own error recovery and rate limiting.
 * Methods should never throw - return empty arrays on failure.
 */
export interface MetadataLookupProvider {
  /**
   * Provider name for logging/debugging
   */
  readonly name: string;

  /**
   * Whether the provider is enabled and configured
   */
  readonly isEnabled: boolean;

  /**
   * Search for books by ISBN
   *
   * @param isbn - ISBN-10 or ISBN-13 (will be normalized internally)
   * @returns Array of matching books (empty if not found or error)
   */
  searchByIsbn(isbn: string): Promise<ResolvedBook[]>;

  /**
   * Search for books by text query (title, author, keywords)
   *
   * @param query - Free-text search query
   * @returns Array of matching books (empty if not found or error)
   */
  searchByText(query: string): Promise<ResolvedBook[]>;

  /**
   * Optional: Check if provider is reachable/configured
   * Used for status display and deciding whether to queue for retry
   */
  checkAvailability?(): Promise<boolean>;
}

/**
 * Disabled Metadata Lookup Provider
 *
 * Safe no-op implementation that returns empty results.
 * Used when:
 * - METADATA_RESOLUTION_ENABLED is false
 * - No real provider is configured
 * - Network is unavailable and we want to proceed without blocking
 */
export class DisabledMetadataLookupProvider implements MetadataLookupProvider {
  readonly name = 'disabled';
  readonly isEnabled = false;

  async searchByIsbn(_isbn: string): Promise<ResolvedBook[]> {
    return [];
  }

  async searchByText(_query: string): Promise<ResolvedBook[]> {
    return [];
  }

  async checkAvailability(): Promise<boolean> {
    return false;
  }
}

/**
 * Type guard to check if provider is disabled
 */
export function isDisabledProvider(
  provider: MetadataLookupProvider
): provider is DisabledMetadataLookupProvider {
  return provider.name === 'disabled' || !provider.isEnabled;
}
