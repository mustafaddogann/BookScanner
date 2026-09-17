/**
 * BookCandidateDetailModal - Full-screen book detail view
 *
 * UX Flow:
 * 1. Opens with book name as hero element
 * 2. Crop images horizontally scrollable at top for visual context
 * 3. Resolved book info prominent with clear accept/edit actions
 * 4. Debug/evidence info collapsed by default (expandable for power users)
 *
 * Key decisions:
 * - Accept button is full-width and visually dominant — this is the primary action
 * - Evidence text is de-emphasized (most users don't need it)
 * - Suggestions are easy to compare with clear "Select" affordance
 */

import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  ScrollView,
  FlatList,
  Image,
} from 'react-native';
import type { BookCandidate } from '../types';
import { DEBUG_ARTIFACTS_ENABLED } from '../config/debug';
import { useAppStore } from '../store/useAppStore';
import { ensureFileUri } from '../utils/fileUri';
import { colors, fonts, spacing, radii, shadows } from '../theme';

interface BookCandidateDetailModalProps {
  visible: boolean;
  candidate: BookCandidate | null;
  onClose: () => void;
  onEdit?: () => void;
  canEdit?: boolean;
  isEdited?: boolean;
  onRevert?: () => void;
  canRevert?: boolean;
  onAccept?: () => void;
  onSelectCandidate?: (candidateIndex: number) => void;
  isAccepting?: boolean;
}

type EvidenceSnapshot = {
  fullText?: string;
  mergedTextBlock?: string;
  lines?: Array<{
    text?: string;
    confidence?: number;
    sourceCropIndex?: number;
    sourceRotation?: number;
  }>;
  mergedLines?: Array<{
    text?: string;
    confidence?: number;
    sourceCropIndex?: number;
    rotation?: number;
  }>;
  contributingCrops?: number[];
};

type ExtractedFieldsSnapshot = {
  chosen?: {
    title?: string | null;
    author?: string | null;
    isbn?: string | null;
    publisher?: string | null;
    edition?: string | null;
  };
  bestTitle?: string;
  bestAuthor?: string;
  bestPublisher?: string;
  bestEdition?: string;
  bestIsbn?: string;
  titleCandidates?: Array<{ value?: string; confidence?: number }>;
  authorCandidates?: Array<{ value?: string; confidence?: number }>;
  publisherCandidates?: Array<{ value?: string; confidence?: number }>;
  editionCandidates?: Array<{ value?: string; confidence?: number }>;
};

function formatConfidence(value?: number | null): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value >= 0 && value <= 1) return `${Math.round(value * 100)}%`;
  if (value > 1 && value <= 100) return `${Math.round(value)}%`;
  return null;
}

export function BookCandidateDetailModal({
  visible,
  candidate,
  onClose,
  onEdit,
  canEdit = true,
  isEdited,
  onRevert,
  canRevert,
  onAccept,
  onSelectCandidate,
  isAccepting,
}: BookCandidateDetailModalProps) {
  const sessionMeta = useAppStore((state) => state.sessionMeta);
  const rectificationResults = useMemo(
    () => sessionMeta?.rectificationResults ?? [],
    [sessionMeta?.rectificationResults]
  );
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);

  const candidateId = (candidate as { candidateId?: string })?.candidateId ?? candidate?.id ?? 'unknown';
  const label = Number.isFinite(candidate?.orderingKey)
    ? `Book ${Number(candidate?.orderingKey) + 1}`
    : 'Book';
  const isAutoApplied = !!(candidate as { appliedCorrection?: unknown } | null)?.appliedCorrection;
  const allowRevert = typeof onRevert === 'function' && (canRevert ?? true);
  const resolverDecision = candidate?.resolverDecision || 'pending';
  const resolverReason = candidate?.resolverDecisionReason ?? candidate?.evidenceSearchDebug?.reason ?? null;

  useEffect(() => {
    if (!visible) {
      setShowAlternatives(false);
      setShowDebug(false);
      setPreviewUri(null);
    }
  }, [visible, candidateId]);

  const evidence = candidate?.evidence as EvidenceSnapshot | undefined;
  const extractedFields = (candidate as { extractedFields?: ExtractedFieldsSnapshot } | null)?.extractedFields;
  const mergedText = (evidence?.fullText ?? evidence?.mergedTextBlock ?? '').trim();
  const cropIndices = useMemo(() => {
    if (candidate?.cropIndices?.length) return candidate.cropIndices;
    if (evidence?.contributingCrops?.length) return evidence.contributingCrops;
    return [];
  }, [candidate?.cropIndices, evidence?.contributingCrops]);

  const evidenceLines = useMemo(() => {
    if (Array.isArray(evidence?.lines)) return evidence.lines;
    if (Array.isArray(evidence?.mergedLines)) {
      return evidence.mergedLines.map((line) => ({
        text: line.text,
        confidence: line.confidence,
        sourceCropIndex: line.sourceCropIndex,
        sourceRotation: line.rotation,
      }));
    }
    return [];
  }, [evidence?.lines, evidence?.mergedLines]);

  const resolveCropUri = useCallback((cropIndex: number): string | null => {
    const info = rectificationResults[cropIndex] as unknown as Record<string, unknown> | undefined;
    if (!info) return null;
    const candidates = [info.cropUri, info.rectifiedPath, info.outputPath, info.cropPath, info.uprightPath, info.imagePath, info.uri];
    for (const entry of candidates) {
      if (typeof entry !== 'string' || entry.length === 0) continue;
      if (entry.startsWith('content://')) return entry;
      if (entry.startsWith('file://') || entry.startsWith('/')) {
        const normalized = ensureFileUri(entry);
        return normalized || null;
      }
      return entry;
    }
    return null;
  }, [rectificationResults]);

  const chosenFields = useMemo(() => {
    if (!extractedFields) return null;
    const chosen = extractedFields.chosen || {};
    return {
      title: chosen.title ?? extractedFields.bestTitle ?? null,
      author: chosen.author ?? extractedFields.bestAuthor ?? null,
      isbn: chosen.isbn ?? extractedFields.bestIsbn ?? null,
      publisher: chosen.publisher ?? extractedFields.bestPublisher ?? null,
      edition: chosen.edition ?? extractedFields.bestEdition ?? null,
    };
  }, [extractedFields]);

  if (!candidate) {
    return (
      <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
        <View style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Book</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No book candidate selected.</Text>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <>
      <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Text style={styles.headerTitle}>{label}</Text>
              <View style={styles.headerBadges}>
                {resolverDecision === 'accept' && (
                  <View style={[styles.headerBadge, { backgroundColor: 'rgba(126, 200, 126, 0.12)' }]}>
                    <Text style={[styles.headerBadgeText, { color: colors.verified }]}>Verified</Text>
                  </View>
                )}
                {resolverDecision === 'suggested' && (
                  <View style={[styles.headerBadge, { backgroundColor: colors.primaryMuted }]}>
                    <Text style={[styles.headerBadgeText, { color: colors.primary }]}>Suggested</Text>
                  </View>
                )}
                {resolverDecision === 'reject' && (
                  <View style={[styles.headerBadge, { backgroundColor: 'rgba(199, 92, 92, 0.12)' }]}>
                    <Text style={[styles.headerBadgeText, { color: colors.rejected }]}>No match</Text>
                  </View>
                )}
                {isAutoApplied && (
                  <View style={[styles.headerBadge, { backgroundColor: colors.bgNested }]}>
                    <Text style={[styles.headerBadgeText, { color: colors.verified }]}>Auto</Text>
                  </View>
                )}
                {isEdited && (
                  <View style={[styles.headerBadge, { backgroundColor: colors.bgNested }]}>
                    <Text style={[styles.headerBadgeText, { color: colors.accent }]}>Edited</Text>
                  </View>
                )}
              </View>
            </View>
            <View style={styles.headerActions}>
              {onEdit && (
                <TouchableOpacity onPress={onEdit} style={styles.headerActionBtn} disabled={!canEdit}>
                  <Text style={[styles.headerActionText, !canEdit && styles.headerActionDisabled]}>Edit</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                <Text style={styles.closeBtnText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            {/* Crops strip */}
            {cropIndices.length > 0 && (
              <View style={styles.cropsSection}>
                <Text style={styles.sectionLabel}>CROPS</Text>
                <FlatList
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  data={cropIndices}
                  contentContainerStyle={styles.cropStrip}
                  keyExtractor={(cropIndex) => `${candidateId}_${cropIndex}`}
                  renderItem={({ item: cropIndex }) => {
                    const uri = resolveCropUri(cropIndex);
                    if (!uri) {
                      return (
                        <View style={styles.cropPlaceholder}>
                          <Text style={styles.cropPlaceholderText}>Crop {cropIndex + 1}</Text>
                        </View>
                      );
                    }
                    return (
                      <Pressable style={styles.cropThumb} onPress={() => setPreviewUri(uri)} hitSlop={8}>
                        <Image source={{ uri }} style={styles.cropImage} resizeMode="cover" />
                      </Pressable>
                    );
                  }}
                />
              </View>
            )}

            {/* Matched Book — hero section */}
            {candidate.resolvedBook && (
              <View style={styles.matchedSection}>
                <Text style={styles.sectionLabel}>MATCHED BOOK</Text>
                <View style={styles.matchedCard}>
                  <Text style={styles.matchedTitle} numberOfLines={3}>
                    {candidate.resolvedBook.title}
                  </Text>
                  {candidate.resolvedBook.authors && candidate.resolvedBook.authors.length > 0 && (
                    <Text style={styles.matchedAuthors} numberOfLines={1}>
                      by {candidate.resolvedBook.authors.join(', ')}
                    </Text>
                  )}
                  <View style={styles.matchedMeta}>
                    {candidate.resolvedBook.isbn13 && (
                      <Text style={styles.matchedMetaText}>ISBN {candidate.resolvedBook.isbn13}</Text>
                    )}
                    {candidate.resolvedBook.source && (
                      <Text style={styles.matchedMetaText}>via {candidate.resolvedBook.source}</Text>
                    )}
                  </View>

                  {/* Status */}
                  <View style={styles.statusRow}>
                    <Text style={[
                      styles.statusText,
                      resolverDecision === 'accept' && { color: colors.verified },
                      resolverDecision === 'suggested' && { color: colors.primary },
                      resolverDecision === 'reject' && { color: colors.rejected },
                    ]}>
                      {resolverDecision}
                    </Text>
                    {resolverReason && (
                      <Text style={styles.reasonText} numberOfLines={2}>{resolverReason}</Text>
                    )}
                  </View>
                </View>

                {/* Accept button — primary action */}
                {onAccept && candidate.resolverDecision !== 'accept' && (
                  <TouchableOpacity
                    style={[styles.acceptButton, isAccepting && styles.acceptButtonDisabled]}
                    onPress={onAccept}
                    disabled={isAccepting}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.acceptButtonText}>
                      {isAccepting ? 'Accepting...' : 'Accept Match'}
                    </Text>
                  </TouchableOpacity>
                )}
                {candidate.resolverDecision === 'accept' && (
                  <View style={styles.acceptedBanner}>
                    <Text style={styles.acceptedBannerIcon}>{'\u2713'}</Text>
                    <Text style={styles.acceptedBannerText}>Accepted & Cataloged</Text>
                  </View>
                )}
              </View>
            )}

            {/* Alternative suggestions */}
            {candidate.resolverDecision === 'suggested' &&
              candidate.resolverSuggestions &&
              candidate.resolverSuggestions.length > 0 && (
              <View style={styles.suggestionsSection}>
                <Text style={styles.sectionLabel}>ALTERNATIVES</Text>
                <Text style={styles.suggestionsHint}>
                  Not the right match? Try one of these:
                </Text>
                {candidate.resolverSuggestions.slice(0, 3).map((suggestion, idx) => (
                  <TouchableOpacity
                    key={`suggestion-${idx}`}
                    style={styles.suggestionCard}
                    onPress={() => onSelectCandidate?.(idx)}
                    disabled={isAccepting}
                    activeOpacity={0.7}
                  >
                    <View style={styles.suggestionInfo}>
                      <Text style={styles.suggestionTitle} numberOfLines={2}>
                        {suggestion.title}
                      </Text>
                      {suggestion.authors && suggestion.authors.length > 0 && (
                        <Text style={styles.suggestionAuthors} numberOfLines={1}>
                          {suggestion.authors.join(', ')}
                        </Text>
                      )}
                      <View style={styles.suggestionMeta}>
                        {suggestion.isbn13 && (
                          <Text style={styles.suggestionMetaText}>ISBN {suggestion.isbn13}</Text>
                        )}
                        {suggestion.publishYear && (
                          <Text style={styles.suggestionMetaText}>{suggestion.publishYear}</Text>
                        )}
                      </View>
                    </View>
                    <View style={styles.selectButton}>
                      <Text style={styles.selectButtonText}>Select</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Extracted fields */}
            {extractedFields && chosenFields && (
              <View style={styles.fieldsSection}>
                <Text style={styles.sectionLabel}>EXTRACTED FIELDS</Text>
                <View style={styles.fieldsCard}>
                  {chosenFields.title && (
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Title</Text>
                      <Text style={styles.fieldValue}>{chosenFields.title}</Text>
                    </View>
                  )}
                  {chosenFields.author && (
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Author</Text>
                      <Text style={styles.fieldValue}>{chosenFields.author}</Text>
                    </View>
                  )}
                  {chosenFields.isbn && (
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>ISBN</Text>
                      <Text style={styles.fieldValue}>{chosenFields.isbn}</Text>
                    </View>
                  )}
                  {chosenFields.publisher && (
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Publisher</Text>
                      <Text style={styles.fieldValue}>{chosenFields.publisher}</Text>
                    </View>
                  )}

                  {extractedFields.titleCandidates && extractedFields.titleCandidates.length > 1 && (
                    <TouchableOpacity
                      onPress={() => setShowAlternatives((prev) => !prev)}
                      style={styles.altToggle}
                    >
                      <Text style={styles.altToggleText}>
                        {showAlternatives ? 'Hide alternatives' : 'Show alternatives'}
                      </Text>
                    </TouchableOpacity>
                  )}

                  {showAlternatives && (
                    <View style={styles.altContainer}>
                      {extractedFields.titleCandidates && extractedFields.titleCandidates.length > 0 && (
                        <View style={styles.altGroup}>
                          <Text style={styles.altGroupLabel}>Title candidates</Text>
                          {extractedFields.titleCandidates.slice(0, 3).map((item, idx) => (
                            <Text key={idx} style={styles.altItem} numberOfLines={1}>
                              {item.value || '\u2014'}{item.confidence ? ` (${formatConfidence(item.confidence)})` : ''}
                            </Text>
                          ))}
                        </View>
                      )}
                      {extractedFields.authorCandidates && extractedFields.authorCandidates.length > 0 && (
                        <View style={styles.altGroup}>
                          <Text style={styles.altGroupLabel}>Author candidates</Text>
                          {extractedFields.authorCandidates.slice(0, 3).map((item, idx) => (
                            <Text key={idx} style={styles.altItem} numberOfLines={1}>
                              {item.value || '\u2014'}{item.confidence ? ` (${formatConfidence(item.confidence)})` : ''}
                            </Text>
                          ))}
                        </View>
                      )}
                    </View>
                  )}
                </View>
              </View>
            )}

            {/* OCR evidence (collapsed by default) */}
            {mergedText.length > 0 && (
              <View style={styles.evidenceSection}>
                <TouchableOpacity
                  onPress={() => setShowDebug((prev) => !prev)}
                  style={styles.evidenceToggle}
                >
                  <Text style={styles.sectionLabel}>OCR EVIDENCE</Text>
                  <Text style={styles.evidenceChevron}>{showDebug ? '\u25B4' : '\u25BE'}</Text>
                </TouchableOpacity>
                {showDebug && (
                  <View style={styles.evidenceCard}>
                    <Text style={styles.evidenceText}>{mergedText}</Text>
                  </View>
                )}
              </View>
            )}

            {/* Debug sections (only in debug builds) */}
            {DEBUG_ARTIFACTS_ENABLED && showDebug && candidate.evidenceSearchDebug && (
              <View style={styles.debugSection}>
                <Text style={styles.sectionLabel}>SEARCH DEBUG</Text>
                <View style={styles.debugCard}>
                  <Text style={styles.debugLabel}>Hypotheses: {candidate.evidenceSearchDebug.hypothesesCount}</Text>
                  <Text style={styles.debugLabel}>Candidates: {candidate.evidenceSearchDebug.candidatesFound}</Text>
                  <Text style={styles.debugLabel}>Search: {candidate.evidenceSearchDebug.searchTimeMs}ms</Text>
                  {candidate.evidenceSearchDebug.topScores && candidate.evidenceSearchDebug.topScores.length > 0 && (
                    <View style={{ marginTop: 6 }}>
                      {candidate.evidenceSearchDebug.topScores.slice(0, 3).map((s, i) => (
                        <Text key={i} style={styles.debugScore}>
                          {Math.round(s.score * 100)}% - {s.title}
                        </Text>
                      ))}
                    </View>
                  )}
                </View>
              </View>
            )}

            {/* Revert */}
            <View style={styles.revertSection}>
              <TouchableOpacity
                style={[styles.revertButton, !allowRevert && styles.revertButtonDisabled]}
                onPress={onRevert}
                disabled={!allowRevert}
              >
                <Text style={[styles.revertButtonText, !allowRevert && styles.revertButtonTextDisabled]}>
                  Revert to auto-detected
                </Text>
              </TouchableOpacity>
            </View>

            {/* Evidence lines debug */}
            {DEBUG_ARTIFACTS_ENABLED && showDebug && evidenceLines.length > 0 && (
              <View style={styles.debugSection}>
                <Text style={styles.sectionLabel}>EVIDENCE LINES</Text>
                {evidenceLines.map((line, idx) => {
                  const confLabel = formatConfidence(line.confidence) ?? '\u2014';
                  return (
                    <View key={idx} style={styles.lineRow}>
                      <Text style={styles.lineText} numberOfLines={2}>{line.text || '\u2014'}</Text>
                      <Text style={styles.lineMeta}>Conf {confLabel}</Text>
                    </View>
                  );
                })}
              </View>
            )}
          </ScrollView>

          {/* Full-screen preview */}
          {previewUri && (
            <View style={styles.previewOverlay} pointerEvents="box-none">
              <Pressable style={styles.previewBackdrop} onPress={() => setPreviewUri(null)} />
              <View style={styles.previewContent} pointerEvents="auto">
                <Image source={{ uri: previewUri }} style={styles.previewImage} resizeMode="contain" />
                <Pressable style={styles.previewClose} onPress={() => setPreviewUri(null)}>
                  <Text style={styles.previewCloseText}>Close</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgDeep,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xxl,
    paddingTop: 60,
    paddingBottom: spacing.lg,
    backgroundColor: colors.bgElevated,
    borderBottomWidth: 1,
    borderBottomColor: colors.separator,
  },
  headerLeft: {
    flex: 1,
  },
  headerTitle: {
    color: colors.textPrimary,
    fontSize: 20,
    fontFamily: fonts.display.semiBold,
  },
  headerBadges: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 6,
  },
  headerBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radii.pill,
  },
  headerBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  headerActionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerActionText: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: '600',
  },
  headerActionDisabled: {
    color: colors.textMuted,
  },
  closeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  closeBtnText: {
    color: colors.textSecondary,
    fontSize: 15,
  },

  // Content
  content: {
    padding: spacing.xxl,
    paddingBottom: spacing.xxxxl,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    color: colors.textTertiary,
    fontSize: 14,
  },

  // Section label
  sectionLabel: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: spacing.sm,
  },

  // Crops
  cropsSection: {
    marginBottom: spacing.xxl,
  },
  cropStrip: {
    paddingBottom: 4,
    gap: 8,
  },
  cropThumb: {
    width: 80,
    height: 80,
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: colors.bgNested,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  cropImage: {
    width: '100%',
    height: '100%',
  },
  cropPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: radii.md,
    backgroundColor: colors.bgNested,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cropPlaceholderText: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '600',
  },

  // Matched book
  matchedSection: {
    marginBottom: spacing.xxl,
  },
  matchedCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.xl,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  matchedTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontFamily: fonts.display.semiBold,
    lineHeight: 24,
  },
  matchedAuthors: {
    color: colors.textSecondary,
    fontSize: 14,
    marginTop: 4,
  },
  matchedMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  matchedMetaText: {
    color: colors.textMuted,
    fontSize: 11,
    letterSpacing: 0.3,
  },
  statusRow: {
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.separator,
  },
  statusText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  reasonText: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 4,
  },

  // Accept
  acceptButton: {
    backgroundColor: colors.primary,
    borderRadius: radii.lg,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: spacing.lg,
    ...shadows.glow,
  },
  acceptButtonDisabled: {
    backgroundColor: colors.bgNested,
    shadowOpacity: 0,
  },
  acceptButtonText: {
    color: colors.bgDeep,
    fontSize: 16,
    fontWeight: '700',
  },
  acceptedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(126, 200, 126, 0.1)',
    borderRadius: radii.lg,
    paddingVertical: 12,
    marginTop: spacing.lg,
    borderWidth: 1,
    borderColor: 'rgba(126, 200, 126, 0.2)',
  },
  acceptedBannerIcon: {
    color: colors.verified,
    fontSize: 16,
    fontWeight: '700',
  },
  acceptedBannerText: {
    color: colors.verified,
    fontSize: 14,
    fontWeight: '600',
  },

  // Suggestions
  suggestionsSection: {
    marginBottom: spacing.xxl,
  },
  suggestionsHint: {
    color: colors.textTertiary,
    fontSize: 12,
    marginBottom: spacing.md,
  },
  suggestionCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.lg,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  suggestionInfo: {
    flex: 1,
  },
  suggestionTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '500',
  },
  suggestionAuthors: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  suggestionMeta: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: 4,
  },
  suggestionMetaText: {
    color: colors.textMuted,
    fontSize: 10,
  },
  selectButton: {
    backgroundColor: colors.primaryMuted,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radii.pill,
    marginLeft: spacing.md,
  },
  selectButtonText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '700',
  },

  // Fields
  fieldsSection: {
    marginBottom: spacing.xxl,
  },
  fieldsCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  fieldRow: {
    marginBottom: spacing.md,
  },
  fieldLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  fieldValue: {
    color: colors.textPrimary,
    fontSize: 14,
  },
  altToggle: {
    marginTop: spacing.sm,
  },
  altToggleText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '600',
  },
  altContainer: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.separator,
  },
  altGroup: {
    marginBottom: spacing.md,
  },
  altGroupLabel: {
    color: colors.textTertiary,
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  altItem: {
    color: colors.textSecondary,
    fontSize: 12,
    marginBottom: 2,
  },

  // Evidence
  evidenceSection: {
    marginBottom: spacing.xxl,
  },
  evidenceToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  evidenceChevron: {
    color: colors.textMuted,
    fontSize: 14,
  },
  evidenceCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  evidenceText: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    fontFamily: 'Menlo',
  },

  // Debug
  debugSection: {
    marginBottom: spacing.xl,
  },
  debugCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.lg,
    padding: spacing.md,
  },
  debugLabel: {
    color: colors.textSecondary,
    fontSize: 11,
    marginBottom: 3,
    fontFamily: 'Menlo',
  },
  debugScore: {
    color: colors.verified,
    fontSize: 10,
    marginLeft: 8,
    fontFamily: 'Menlo',
  },

  // Revert
  revertSection: {
    marginBottom: spacing.xxl,
  },
  revertButton: {
    backgroundColor: colors.bgNested,
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: radii.md,
    alignSelf: 'flex-start',
  },
  revertButtonDisabled: {
    opacity: 0.4,
  },
  revertButtonText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
  revertButtonTextDisabled: {
    color: colors.textMuted,
  },

  // Evidence lines
  lineRow: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  lineText: {
    color: colors.textPrimary,
    fontSize: 12,
    marginBottom: 4,
    fontFamily: 'Menlo',
  },
  lineMeta: {
    color: colors.textMuted,
    fontSize: 10,
    fontFamily: 'Menlo',
  },

  // Preview
  previewOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: 9999,
    elevation: 9999,
  },
  previewBackdrop: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(12, 10, 9, 0.9)',
  },
  previewContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xxl,
  },
  previewImage: {
    width: '100%',
    height: '70%',
  },
  previewClose: {
    marginTop: spacing.xxl,
    backgroundColor: colors.bgElevated,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: radii.md,
  },
  previewCloseText: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
});
