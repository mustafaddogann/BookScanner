/**
 * BookCandidateDiagnosticsRow
 *
 * Shows diagnostic info for a BookCandidate when diagnostics are enabled.
 * Only renders when __DEV__ && diagnosticsEnabled.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { BookCandidate, EvidenceTier } from '../types';
import { useDebugStore } from '../store/useDebugStore';
import { colors, radii } from '../theme';

interface BookCandidateDiagnosticsRowProps {
  candidate: BookCandidate;
  testID?: string;
}

function getTierColor(tier: EvidenceTier | undefined): string {
  switch (tier) {
    case 'strong':
      return colors.verified;
    case 'usable':
      return colors.accent;
    case 'weak':
      return colors.suggested;
    case 'unusable':
      return colors.rejected;
    default:
      return colors.textSecondary;
  }
}

function getDecisionColor(decision: string | undefined): string {
  switch (decision) {
    case 'accept':
      return colors.verified;
    case 'suggested':
      return colors.suggested;
    case 'reject':
      return colors.rejected;
    default:
      return colors.textSecondary;
  }
}

export function BookCandidateDiagnosticsRow({
  candidate,
  testID,
}: BookCandidateDiagnosticsRowProps): React.JSX.Element | null {
  const diagnosticsEnabled = useDebugStore((state) => state.diagnosticsEnabled);

  // Only render in __DEV__ when diagnostics are enabled
  if (!__DEV__ || !diagnosticsEnabled) {
    return null;
  }

  const evidenceTier = candidate.hypothesis?.evidenceTier;
  const decision = candidate.resolverDecision;
  const confidence = candidate.resolvedConfidence;
  const source = candidate.resolvedBook?.source;
  const autoAccepted = decision === 'accept';
  const suggestionCount = candidate.resolverSuggestions?.length ?? 0;

  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.row}>
        {/* Evidence Tier */}
        <View style={styles.badge}>
          <Text style={[styles.badgeText, { color: getTierColor(evidenceTier) }]}>
            {evidenceTier ?? 'n/a'}
          </Text>
        </View>

        {/* Decision */}
        <View style={styles.badge}>
          <Text style={[styles.badgeText, { color: getDecisionColor(decision) }]}>
            {decision ?? 'pending'}
          </Text>
        </View>

        {/* Provider */}
        {source && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{source}</Text>
          </View>
        )}

        {/* Confidence */}
        {confidence !== undefined && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>
              {`${Math.round(confidence * 100)}%`}
            </Text>
          </View>
        )}

        {/* Auto-accepted indicator */}
        {autoAccepted && (
          <View style={[styles.badge, styles.autoAcceptedBadge]}>
            <Text style={styles.autoAcceptedText}>AUTO</Text>
          </View>
        )}

        {/* Suggestions count */}
        {suggestionCount > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{`${suggestionCount} alt`}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.separator,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  badge: {
    backgroundColor: colors.bgNested,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.sm,
  },
  badgeText: {
    color: colors.textSecondary,
    fontSize: 10,
    fontFamily: 'Menlo',
  },
  autoAcceptedBadge: {
    backgroundColor: colors.verified,
  },
  autoAcceptedText: {
    color: colors.bgDeep,
    fontSize: 10,
    fontWeight: '600',
    fontFamily: 'Menlo',
  },
});
