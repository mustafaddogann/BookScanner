/**
 * BookScanner Typography - "The Bibliophile's Instrument"
 *
 * Display: Playfair Display (serif) for titles and headings
 * Body: System font (SF Pro on iOS)
 * Mono: Menlo for diagnostics
 */

import { Platform } from 'react-native';

export const fonts = {
  display: {
    regular: 'PlayfairDisplay-Regular',
    semiBold: 'PlayfairDisplay-SemiBold',
    bold: 'PlayfairDisplay-Bold',
  },
  body: {
    regular: Platform.select({ ios: 'System', default: 'System' }),
  },
  mono: Platform.select({ ios: 'Menlo', default: 'monospace' }),
} as const;

export const typeScale = {
  displayLarge: {
    fontFamily: fonts.display.bold,
    fontSize: 32,
    lineHeight: 40,
  },
  displayMedium: {
    fontFamily: fonts.display.semiBold,
    fontSize: 24,
    lineHeight: 32,
  },
  displaySmall: {
    fontFamily: fonts.display.semiBold,
    fontSize: 20,
    lineHeight: 28,
  },
  headingLarge: {
    fontFamily: fonts.display.semiBold,
    fontSize: 18,
    lineHeight: 24,
  },
  headingMedium: {
    fontFamily: fonts.display.regular,
    fontSize: 16,
    lineHeight: 22,
  },
  bodyLarge: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '400' as const,
  },
  bodyMedium: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '400' as const,
  },
  bodySmall: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '400' as const,
  },
  label: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600' as const,
  },
  caption: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: 1,
  },
  mono: {
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: 16,
  },
} as const;
