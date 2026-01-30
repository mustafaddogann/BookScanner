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

interface BookCandidateDiagnosticsRowProps {
  candidate: BookCandidate;
  testID?: string;
}

function getTierColor(tier: EvidenceTier | undefined): string {
  switch (tier) {
    case 'strong':
      return '#30D158';
    case 'usable':
      return '#007AFF';
    case 'weak':
      return '#FF9F0A';
    case 'unusable':
      return '#FF453A';
    default:
      return '#8e8e93';
  }
}

function getDecisionColor(decision: string | undefined): string {
  switch (decision) {
    case 'accept':
      return '#30D158';
    case 'suggested':
      return '#FF9F0A';
    case 'reject':
      return '#FF453A';
    default:
      return '#8e8e93';
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
    borderTopColor: '#2c2c2e',
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  badge: {
    backgroundColor: '#2c2c2e',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    color: '#8e8e93',
    fontSize: 10,
    fontFamily: 'Menlo',
  },
  autoAcceptedBadge: {
    backgroundColor: '#30D158',
  },
  autoAcceptedText: {
    color: '#000',
    fontSize: 10,
    fontWeight: '600',
    fontFamily: 'Menlo',
  },
});
