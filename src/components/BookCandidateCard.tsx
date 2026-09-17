import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { BookCandidate } from '../types';
import { BookCandidateDiagnosticsRow } from './BookCandidateDiagnosticsRow';
import { AnimatedPressable } from './AnimatedPressable';
import { colors, fonts, spacing, radii } from '../theme';

interface BookCandidateCardProps {
  candidate: BookCandidate;
  onPress?: () => void;
  title?: string | null;
  author?: string | null;
  isEdited?: boolean;
}

type EvidenceSnapshot = {
  fullText?: string;
  mergedTextBlock?: string;
  mergedLines?: Array<{ confidence: number }>;
  avgConfidence?: number;
};

function formatConfidence(value?: number | null, clampMax?: number): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;

  let normalized = value;
  if (value > 1 && value <= 100) {
    normalized = value / 100;
  }
  if (normalized < 0 || normalized > 1) return null;

  if (typeof clampMax === 'number' && normalized > clampMax) {
    normalized = clampMax;
  }

  return `${Math.round(normalized * 100)}%`;
}

function getStatusColor(decision?: string): string {
  switch (decision) {
    case 'accept': return colors.verified;
    case 'suggested': return colors.primary;
    case 'reject': return colors.rejected;
    default: return colors.textMuted;
  }
}

function getStatusBg(decision?: string): string {
  switch (decision) {
    case 'accept': return 'rgba(126, 200, 126, 0.08)';
    case 'suggested': return colors.primaryMuted;
    case 'reject': return 'rgba(199, 92, 92, 0.08)';
    default: return colors.bgElevated;
  }
}

function BookCandidateCardBase({
  candidate,
  onPress,
  title,
  author,
  isEdited,
}: BookCandidateCardProps) {
  const isAutoApplied = !!(candidate as { appliedCorrection?: unknown }).appliedCorrection;
  const evidence = candidate.evidence as EvidenceSnapshot | undefined;
  const cropCount = candidate.cropIndices?.length ?? 0;
  const mergedLines = useMemo(() => evidence?.mergedLines ?? [], [evidence?.mergedLines]);
  const mergedText = (evidence?.fullText ?? evidence?.mergedTextBlock ?? '').trim();
  const explicitAvg = evidence?.avgConfidence;

  const resolverDecision = candidate.resolverDecision;
  const resolvedBook = candidate.resolvedBook;

  const isAccepted = resolverDecision === 'accept';
  const isSuggested = resolverDecision === 'suggested';
  const isRejected = resolverDecision === 'reject';
  const hasResolvedBook = !!resolvedBook;

  const displayTitle = hasResolvedBook ? resolvedBook.title : title;
  const displayAuthor = hasResolvedBook
    ? resolvedBook.authors?.join(', ')
    : author;

  const ocrConfidence = useMemo(() => {
    if (typeof explicitAvg === 'number') return explicitAvg;
    if (mergedLines.length === 0) return null;
    const total = mergedLines.reduce((sum, line) => sum + line.confidence, 0);
    return total / mergedLines.length;
  }, [explicitAvg, mergedLines]);

  const resolverConfidenceValue = candidate.resolvedConfidence;

  const { displayConfidence, confidenceClampMax, isUnverified } = useMemo(() => {
    const baseConfidence = typeof resolverConfidenceValue === 'number'
      ? resolverConfidenceValue
      : ocrConfidence;

    if (isRejected) {
      return { displayConfidence: baseConfidence, confidenceClampMax: 0.49, isUnverified: true };
    }

    if (isAccepted || isSuggested) {
      return { displayConfidence: baseConfidence, confidenceClampMax: undefined, isUnverified: false };
    }

    return { displayConfidence: ocrConfidence, confidenceClampMax: undefined, isUnverified: false };
  }, [ocrConfidence, resolverConfidenceValue, isRejected, isAccepted, isSuggested]);

  const candidateId = (candidate as { candidateId?: string }).candidateId;
  const label = Number.isFinite(candidate.orderingKey)
    ? `Book ${candidate.orderingKey + 1}`
    : (candidateId || candidate.id);
  const confidenceLabel = formatConfidence(displayConfidence, confidenceClampMax);
  const statusColor = getStatusColor(resolverDecision);
  const statusBg = getStatusBg(resolverDecision);

  const confidenceBarValue = useMemo(() => {
    if (typeof displayConfidence !== 'number') return 0;
    let norm = displayConfidence;
    if (norm > 1 && norm <= 100) norm = norm / 100;
    if (typeof confidenceClampMax === 'number' && norm > confidenceClampMax) norm = confidenceClampMax;
    return Math.max(0, Math.min(1, norm));
  }, [displayConfidence, confidenceClampMax]);

  const content = (
    <View style={[styles.card, { borderColor: statusBg }]}>
      {/* Top: label + status + meta */}
      <View style={styles.headerRow}>
        <Text style={styles.label}>{label}</Text>
        <View style={styles.badgesRow}>
          {isAccepted && (
            <View style={[styles.statusBadge, { backgroundColor: 'rgba(126, 200, 126, 0.12)' }]}>
              <View style={[styles.statusBadgeDot, { backgroundColor: colors.verified }]} />
              <Text style={[styles.statusBadgeText, { color: colors.verified }]}>Verified</Text>
            </View>
          )}
          {isSuggested && (
            <View style={[styles.statusBadge, { backgroundColor: colors.primaryMuted }]}>
              <View style={[styles.statusBadgeDot, { backgroundColor: colors.primary }]} />
              <Text style={[styles.statusBadgeText, { color: colors.primary }]}>Suggested</Text>
            </View>
          )}
          {isRejected && (
            <View style={[styles.statusBadge, { backgroundColor: 'rgba(199, 92, 92, 0.12)' }]}>
              <View style={[styles.statusBadgeDot, { backgroundColor: colors.rejected }]} />
              <Text style={[styles.statusBadgeText, { color: colors.rejected }]}>No match</Text>
            </View>
          )}
          {isAutoApplied && (
            <View style={[styles.statusBadge, { backgroundColor: colors.bgNested }]}>
              <Text style={[styles.statusBadgeText, { color: colors.verified }]}>Auto</Text>
            </View>
          )}
          {!!isEdited && (
            <View style={[styles.statusBadge, { backgroundColor: colors.bgNested }]}>
              <Text style={[styles.statusBadgeText, { color: colors.accent }]}>Edited</Text>
            </View>
          )}
        </View>
      </View>

      {/* Resolved book info */}
      {hasResolvedBook && (isAccepted || isSuggested) && (
        <View style={styles.resolvedInfo}>
          <Text style={styles.resolvedTitle} numberOfLines={2}>
            {displayTitle}
          </Text>
          {displayAuthor && (
            <Text style={styles.resolvedAuthor} numberOfLines={1}>
              by {displayAuthor}
            </Text>
          )}
          {resolvedBook.isbn13 && (
            <Text style={styles.resolvedIsbn}>ISBN {resolvedBook.isbn13}</Text>
          )}
        </View>
      )}

      {/* Fallback fields for reject/pending */}
      {!hasResolvedBook && (displayTitle || displayAuthor) && (
        <View style={styles.fieldsBlock}>
          {displayTitle && (
            <Text style={styles.fieldTitle} numberOfLines={1}>
              {displayTitle}
            </Text>
          )}
          {displayAuthor && (
            <Text style={styles.fieldAuthor} numberOfLines={1}>
              {displayAuthor}
            </Text>
          )}
        </View>
      )}

      {/* Confidence + crops meta row */}
      <View style={styles.metaRow}>
        {confidenceLabel && (
          <View style={[styles.metaPill, isUnverified && styles.metaPillWarn]}>
            <Text style={[styles.metaPillText, isUnverified && styles.metaPillTextWarn]}>
              {isUnverified ? 'Unverified' : 'Confidence'} {confidenceLabel}
            </Text>
          </View>
        )}
        <View style={styles.metaPill}>
          <Text style={styles.metaPillText}>
            {cropCount} crop{cropCount === 1 ? '' : 's'}
          </Text>
        </View>
      </View>

      {/* Evidence text for reject or unresolved */}
      {(isRejected || !hasResolvedBook) && mergedText.length > 0 && (
        <Text style={styles.evidenceText} numberOfLines={2}>
          {mergedText}
        </Text>
      )}

      {/* Confidence bar */}
      {confidenceBarValue > 0 && (
        <View style={styles.confidenceBarBg}>
          <View
            style={[
              styles.confidenceBarFill,
              { width: `${Math.round(confidenceBarValue * 100)}%`, backgroundColor: statusColor },
            ]}
          />
        </View>
      )}

      <BookCandidateDiagnosticsRow
        candidate={candidate}
        testID="book-candidate-diagnostics-row"
      />
    </View>
  );

  if (!onPress) {
    return content;
  }

  return (
    <AnimatedPressable onPress={onPress} scaleDown={0.98}>
      {content}
    </AnimatedPressable>
  );
}

export const BookCandidateCard = memo(BookCandidateCardBase);
BookCandidateCard.displayName = 'BookCandidateCard';

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.xl,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  badgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.pill,
    gap: 4,
  },
  statusBadgeDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
  },

  // Resolved book
  resolvedInfo: {
    backgroundColor: colors.bgNested,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  resolvedTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontFamily: fonts.display.semiBold,
    lineHeight: 22,
  },
  resolvedAuthor: {
    color: colors.textSecondary,
    fontSize: 13,
    marginTop: 3,
  },
  resolvedIsbn: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 6,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },

  // Fallback fields
  fieldsBlock: {
    marginBottom: spacing.sm,
  },
  fieldTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  fieldAuthor: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },

  // Meta row
  metaRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: spacing.sm,
  },
  metaPill: {
    backgroundColor: colors.bgNested,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.pill,
  },
  metaPillWarn: {
    backgroundColor: 'rgba(212, 168, 83, 0.08)',
  },
  metaPillText: {
    color: colors.textTertiary,
    fontSize: 10,
    fontWeight: '600',
  },
  metaPillTextWarn: {
    color: colors.primary,
  },

  // Evidence
  evidenceText: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    fontStyle: 'italic',
    marginBottom: spacing.sm,
  },

  // Confidence bar
  confidenceBarBg: {
    height: 3,
    backgroundColor: colors.bgNested,
    borderRadius: 2,
    marginTop: spacing.xs,
    overflow: 'hidden',
  },
  confidenceBarFill: {
    height: 3,
    borderRadius: 2,
  },
});
