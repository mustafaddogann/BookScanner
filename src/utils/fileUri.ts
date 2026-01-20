/**
 * File URI utilities for React Native
 *
 * React Native Image component requires file:// URIs for local files.
 * Native modules often return or expect plain absolute paths.
 * These utilities ensure consistent handling.
 */

/**
 * Ensure a path has the file:// URI scheme.
 * - If already has file://, returns as-is
 * - If absolute path (starts with /), returns file:// + path
 * - Handles edge cases: empty string, undefined, etc.
 *
 * @param path - Absolute path or file URI
 * @returns file:// URI suitable for React Native Image
 */
export function ensureFileUri(path: string | null | undefined): string {
  if (!path) {
    return '';
  }

  // Already a file URI
  if (path.startsWith('file://')) {
    return path;
  }

  // Absolute path - add file:// prefix
  // Note: iOS paths start with / (e.g., /var/mobile/...)
  if (path.startsWith('/')) {
    return `file://${path}`;
  }

  // Relative path or other - return as-is (may fail in Image)
  console.warn(`[fileUri] Unexpected path format: ${path.substring(0, 50)}...`);
  return path;
}

/**
 * Strip the file:// URI scheme to get a plain absolute path.
 * Native modules often require plain paths without the scheme.
 *
 * @param uri - file:// URI or absolute path
 * @returns Plain absolute path (without file://)
 */
export function stripFileUri(uri: string | null | undefined): string {
  if (!uri) {
    return '';
  }

  if (uri.startsWith('file://')) {
    return uri.slice(7); // Remove 'file://'
  }

  // Already a plain path
  return uri;
}

/**
 * Check if a string is a valid file URI
 */
export function isFileUri(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('file://');
}

/**
 * Check if a string is an absolute path (not a URI)
 */
export function isAbsolutePath(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('file://');
}

/**
 * Get the filename from a path or URI
 */
export function getFilename(pathOrUri: string | null | undefined): string {
  if (!pathOrUri) {
    return '';
  }

  const path = stripFileUri(pathOrUri);
  const parts = path.split('/');
  return parts[parts.length - 1] || '';
}
