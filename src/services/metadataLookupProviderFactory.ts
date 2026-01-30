/**
 * Metadata Lookup Provider Factory
 *
 * Central place to configure and retrieve the active metadata lookup provider.
 * Uses OpenLibraryProvider by default when metadata resolution is enabled.
 *
 * Gate 9: Open Library integration for ISBN fetching
 */

import {
  MetadataLookupProvider,
  DisabledMetadataLookupProvider,
} from './metadataLookupProvider';
import { OpenLibraryProvider } from './openLibraryProvider';
import { isMetadataResolutionEnabled } from '../config/debug';

// Singleton instance of the current provider
let currentProvider: MetadataLookupProvider | null = null;

/**
 * Get the current metadata lookup provider
 *
 * Returns:
 * - OpenLibraryProvider when METADATA_RESOLUTION_ENABLED is true
 * - DisabledMetadataLookupProvider when disabled
 *
 * @returns The active MetadataLookupProvider instance
 */
export function getMetadataLookupProvider(): MetadataLookupProvider {
  // If resolution is disabled, always return disabled provider
  if (!isMetadataResolutionEnabled()) {
    return new DisabledMetadataLookupProvider();
  }

  // Use cached provider if available
  if (currentProvider && currentProvider.isEnabled) {
    return currentProvider;
  }

  // Use OpenLibraryProvider as the default enabled provider
  currentProvider = new OpenLibraryProvider();
  console.log('[MetadataLookup] Initialized OpenLibraryProvider');
  return currentProvider;
}

/**
 * Set a custom metadata lookup provider (for testing or custom implementations)
 *
 * @param provider - Custom provider implementation
 */
export function setMetadataLookupProvider(provider: MetadataLookupProvider): void {
  currentProvider = provider;
  console.log(`[MetadataLookup] Provider set to: ${provider.name} (enabled=${provider.isEnabled})`);
}

/**
 * Reset to default provider (for testing)
 */
export function resetMetadataLookupProvider(): void {
  currentProvider = null;
  console.log('[MetadataLookup] Provider reset to default');
}

/**
 * Check if the current provider is available and enabled
 */
export async function isProviderAvailable(): Promise<boolean> {
  const provider = getMetadataLookupProvider();

  if (!provider.isEnabled) {
    return false;
  }

  if (provider.checkAvailability) {
    return provider.checkAvailability();
  }

  return true;
}
