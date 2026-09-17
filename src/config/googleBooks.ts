// The key lives in secrets.ts (gitignored). It still ships inside the app, so restrict
// it in Google Cloud to the Books API and to the iOS bundle ID below
// (Google checks the X-Ios-Bundle-Identifier header).
import { GOOGLE_BOOKS_API_KEY } from './secrets';

const IOS_BUNDLE_ID = 'com.mustafa.openshelves';

export function withGoogleBooksKey(url: string): string {
  if (!GOOGLE_BOOKS_API_KEY) {
    return url;
  }
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}key=${encodeURIComponent(GOOGLE_BOOKS_API_KEY)}`;
}

export const GOOGLE_BOOKS_HEADERS: Record<string, string> = {
  'X-Ios-Bundle-Identifier': IOS_BUNDLE_ID,
};
