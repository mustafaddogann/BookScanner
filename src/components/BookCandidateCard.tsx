import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import type { BookCandidate } from '../types';
import { BookCandidateDiagnosticsRow } from './BookCandidateDiagnosticsRow';

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

function formatConfidence(value?: number | null): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value >= 0 && value <= 1) {
    return `${Math.round(value * 100)}%`;
  }
  if (value > 1 && value <= 100) {
    return `${Math.round(value)}%`;
  }
  return null;
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
  const mergedLines = evidence?.mergedLines ?? [];
  const mergedText = (evidence?.fullText ?? evidence?.mergedTextBlock ?? '').trim();
  const explicitAvg = evidence?.avgConfidence;

  // Get resolver decision and resolved book
  const resolverDecision = candidate.resolverDecision;
  const resolvedBook = candidate.resolvedBook;

  // Determine what to display based on resolver state
  const isAccepted = resolverDecision === 'accept';
  const isSuggested = resolverDecision === 'suggested';
  const isRejected = resolverDecision === 'reject';
  const hasResolvedBook = !!resolvedBook;

  // Display title and author:
  // - For accept/suggested with resolvedBook: use resolvedBook info
  // - Otherwise: use the provided title/author props
  const displayTitle = hasResolvedBook ? resolvedBook.title : title;
  const displayAuthor = hasResolvedBook
    ? resolvedBook.authors?.join(', ')
    : author;

  const avgConfidence = useMemo(() => {
    if (typeof explicitAvg === 'number') return explicitAvg;
    if (mergedLines.length === 0) return null;
    const total = mergedLines.reduce((sum, line) => sum + line.confidence, 0);
    return total / mergedLines.length;
  }, [explicitAvg, mergedLines]);

  const candidateId = (candidate as { candidateId?: string }).candidateId;
  const label = Number.isFinite(candidate.orderingKey)
    ? `Book ${candidate.orderingKey + 1}`
    : (candidateId || candidate.id);
  const confidenceLabel = formatConfidence(avgConfidence);

  const content = (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={styles.title}>{label}</Text>
          {/* Decision badge: Verified, Suggested, No match */}
          {isAccepted && (
            <View style={styles.verifiedBadge}>
              <Text style={styles.verifiedBadgeText}>Verified</Text>
            </View>
          )}
          {isSuggested && (
            <View style={styles.suggestedBadge}>
              <Text style={styles.suggestedBadgeText}>Suggested</Text>
            </View>
          )}
          {isRejected && (
            <View style={styles.rejectedBadge}>
              <Text style={styles.rejectedBadgeText}>No match</Text>
            </View>
          )}
          {isAutoApplied && (
            <View style={styles.autoBadge}>
              <Text style={styles.autoBadgeText}>Auto</Text>
            </View>
          )}
          {!!isEdited && (
            <View style={styles.editedBadge}>
              <Text style={styles.editedBadgeText}>Edited</Text>
            </View>
          )}
        </View>
        <Text style={styles.meta}>
          {cropCount} crop{cropCount === 1 ? '' : 's'}
        </Text>
      </View>

      {/* Show resolved book info for accept/suggested */}
      {hasResolvedBook && (isAccepted || isSuggested) && (
        <View style={styles.resolvedInfo}>
          <Text style={styles.resolvedTitle} numberOfLines={2}>
            {displayTitle}
          </Text>
          {displayAuthor && (
            <Text style={styles.resolvedAuthor} numberOfLines={1}>
              {displayAuthor}
            </Text>
          )}
          {resolvedBook.isbn13 && (
            <Text style={styles.resolvedIsbn}>ISBN: {resolvedBook.isbn13}</Text>
          )}
        </View>
      )}

      {/* For reject: show fields fallback */}
      {!hasResolvedBook && (displayTitle || displayAuthor) && (
        <View style={styles.fields}>
          {displayTitle && (
            <Text style={styles.fieldTitle} numberOfLines={1}>
              Title: {displayTitle}
            </Text>
          )}
          {displayAuthor && (
            <Text style={styles.fieldAuthor} numberOfLines={1}>
              Author: {displayAuthor}
            </Text>
          )}
        </View>
      )}

      {confidenceLabel && (
        <Text style={styles.confidence}>
          Confidence {confidenceLabel}
        </Text>
      )}

      {/* Evidence text: show for reject or when no resolved book */}
      {(isRejected || !hasResolvedBook) && (
        <Text style={styles.evidence} numberOfLines={3}>
          {mergedText.length > 0 ? mergedText : 'No evidence text'}
        </Text>
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
    <TouchableOpacity onPress={onPress} activeOpacity={0.8}>
      {content}
    </TouchableOpacity>
  );
}

export const BookCandidateCard = memo(BookCandidateCardBase);
BookCandidateCard.displayName = 'BookCandidateCard';

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1c1c1e',
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  editedBadge: {
    backgroundColor: '#2c2c2e',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginLeft: 8,
  },
  editedBadgeText: {
    color: '#FF9F0A',
    fontSize: 10,
    fontWeight: '600',
  },
  autoBadge: {
    backgroundColor: '#2c2c2e',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginLeft: 8,
  },
  autoBadgeText: {
    color: '#30D158',
    fontSize: 10,
    fontWeight: '600',
  },
  // Decision badges
  verifiedBadge: {
    backgroundColor: 'rgba(48, 209, 88, 0.2)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginLeft: 8,
  },
  verifiedBadgeText: {
    color: '#30D158',
    fontSize: 10,
    fontWeight: '600',
  },
  suggestedBadge: {
    backgroundColor: 'rgba(255, 159, 10, 0.2)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginLeft: 8,
  },
  suggestedBadgeText: {
    color: '#FF9F0A',
    fontSize: 10,
    fontWeight: '600',
  },
  rejectedBadge: {
    backgroundColor: 'rgba(255, 69, 58, 0.2)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginLeft: 8,
  },
  rejectedBadgeText: {
    color: '#FF453A',
    fontSize: 10,
    fontWeight: '600',
  },
  // Resolved book info
  resolvedInfo: {
    backgroundColor: '#2c2c2e',
    borderRadius: 8,
    padding: 8,
    marginBottom: 8,
  },
  resolvedTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  resolvedAuthor: {
    color: '#8e8e93',
    fontSize: 12,
    marginTop: 2,
  },
  resolvedIsbn: {
    color: '#636366',
    fontSize: 10,
    marginTop: 4,
  },
  meta: {
    color: '#8e8e93',
    fontSize: 12,
  },
  fields: {
    marginBottom: 6,
  },
  fieldTitle: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  fieldAuthor: {
    color: '#8e8e93',
    fontSize: 12,
    marginTop: 2,
  },
  confidence: {
    color: '#30D158',
    fontSize: 12,
    marginBottom: 6,
  },
  evidence: {
    color: '#a0a0a5',
    fontSize: 12,
    lineHeight: 18,
  },
});
