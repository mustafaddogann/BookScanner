/**
 * BookScanner Color Palette - "The Bibliophile's Instrument"
 *
 * Warm, literary-feeling palette inspired by a private rare-books library at night.
 * Rich dark surfaces with warm amber highlights, glass effects, and gradient accents.
 */

export const colors = {
  // Backgrounds (warm-tinted darks, layered depth)
  bgDeep: '#0C0A09',
  bgBase: '#141211',
  bgElevated: '#1E1B18',
  bgNested: '#2A2622',
  bgOverlay: '#332E29',

  // Primary (warm gold)
  primary: '#D4A853',
  primaryLight: '#E8C87A',
  primaryDim: '#8B7340',
  primaryMuted: 'rgba(212, 168, 83, 0.12)',

  // Text
  textPrimary: '#F5F0E8',    // cream
  textSecondary: '#9B9389',
  textTertiary: '#6B6259',
  textMuted: '#4A443E',

  // Status
  verified: '#7EC87E',       // sage green
  suggested: '#D4A853',      // gold (same as primary)
  rejected: '#C75C5C',       // brick red

  // Accent
  accent: '#6B9BD2',         // soft slate blue for links

  // Scanner
  scannerOverlay: 'rgba(212,168,83,0.30)',
  scannerGrid: 'rgba(245,240,232,0.08)',

  // Glass morphism
  glassBg: 'rgba(30, 27, 24, 0.72)',
  glassBorder: 'rgba(245, 240, 232, 0.08)',
  glassHighlight: 'rgba(245, 240, 232, 0.04)',

  // Shimmer
  shimmerBase: '#1E1B18',
  shimmerHighlight: '#2A2622',

  // Gradients (as array pairs for LinearGradient or manual use)
  gradientHero: ['#1E1B18', '#0C0A09'] as const,
  gradientCard: ['rgba(30, 27, 24, 0.9)', 'rgba(20, 18, 17, 0.95)'] as const,
  gradientGold: ['#E8C87A', '#D4A853', '#8B7340'] as const,
  gradientCover: ['#2A2622', '#1E1B18'] as const,

  // Utility
  transparent: 'transparent',
  white: '#FFFFFF',
  black: '#000000',

  // Separator
  separator: 'rgba(245, 240, 232, 0.06)',
  separatorStrong: 'rgba(245, 240, 232, 0.12)',
} as const;
