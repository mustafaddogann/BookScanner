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

interface BookCandidateDetailModalProps {
  visible: boolean;
  candidate: BookCandidate | null;
  onClose: () => void;
  onEdit?: () => void;
  canEdit?: boolean;
  isEdited?: boolean;
  onRevert?: () => void;
  canRevert?: boolean;
  /** Called when user accepts a suggested book match */
  onAccept?: () => void;
  /** Called when user selects a specific candidate from suggestions */
  onSelectCandidate?: (candidateIndex: number) => void;
  /** Whether accept is currently running */
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
  if (value >= 0 && value <= 1) {
    return `${Math.round(value * 100)}%`;
  }
  if (value > 1 && value <= 100) {
    return `${Math.round(value)}%`;
  }
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
  const rectificationResults = sessionMeta?.rectificationResults ?? [];
  const [showAlternatives, setShowAlternatives] = useState(false);
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
    const candidates = [
      info.cropUri,
      info.rectifiedPath,
      info.outputPath,
      info.cropPath,
      info.uprightPath,
      info.imagePath,
      info.uri,
    ];
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

  const renderFieldRow = (labelText: string, value?: string | null) => {
    if (!value) return null;
    return (
      <View style={styles.fieldRow}>
        <Text style={styles.fieldLabel}>{labelText}</Text>
        <Text style={styles.fieldValue}>{value}</Text>
      </View>
    );
  };

  const renderCandidateList = (
    labelText: string,
    list?: Array<{ value?: string; confidence?: number }>
  ) => {
    if (!list || list.length === 0) return null;
    const top = list.slice(0, 3);
    return (
      <View style={styles.altGroup}>
        <Text style={styles.altLabel}>{labelText}</Text>
        {top.map((item, idx) => {
          const confidence = formatConfidence(item.confidence);
          return (
            <Text key={idx} style={styles.altItem} numberOfLines={1}>
              {item.value || '—'}{confidence ? ` (${confidence})` : ''}
            </Text>
          );
        })}
      </View>
    );
  };

  if (!candidate) {
    return (
      <Modal
        visible={visible}
        animationType="slide"
        transparent={false}
        onRequestClose={onClose}
      >
        <View style={styles.container}>
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>Book</Text>
              <Text style={styles.subtitle}>ID: unknown</Text>
            </View>
            <View style={styles.headerActions}>
              <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                <Text style={styles.closeText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.emptyText}>No book candidate selected.</Text>
          </ScrollView>
        </View>
      </Modal>
    );
  }

  return (
    <>
      <Modal
        visible={visible}
        animationType="slide"
        transparent={false}
        onRequestClose={onClose}
      >
        <View style={styles.container}>
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>{label}</Text>
              <Text style={styles.subtitle}>ID: {candidateId}</Text>
              {(isAutoApplied || isEdited) && (
                <View style={styles.badgesRow}>
                  {isAutoApplied && (
                    <View style={styles.autoBadge}>
                      <Text style={styles.autoBadgeText}>Auto</Text>
                    </View>
                  )}
                  {isEdited && (
                    <View style={styles.editedBadge}>
                      <Text style={styles.editedBadgeText}>Edited</Text>
                    </View>
                  )}
                </View>
              )}
            </View>
            <View style={styles.headerActions}>
              {onEdit && (
                <TouchableOpacity
                  onPress={onEdit}
                  style={styles.editButton}
                  disabled={!canEdit}
                >
                  <Text style={[styles.editText, !canEdit && styles.editTextDisabled]}>
                    Edit
                  </Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                <Text style={styles.closeText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.sectionTitle}>Crops</Text>
            {cropIndices.length > 0 ? (
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
                      <View style={styles.cropThumbPlaceholder}>
                        <Text style={styles.cropThumbLabel}>Crop {cropIndex + 1}</Text>
                        <Text style={styles.cropThumbSubtext}>Unavailable</Text>
                      </View>
                    );
                  }
                  return (
                    <Pressable
                      style={styles.cropThumb}
                      onPress={() => setPreviewUri(uri)}
                      hitSlop={10}
                    >
                      <Image
                        source={{ uri }}
                        style={styles.cropThumbImage}
                        resizeMode="cover"
                      />
                    </Pressable>
                  );
                }}
              />
            ) : (
              <Text style={styles.emptyText}>No contributing crops</Text>
            )}

            <Text style={styles.sectionTitle}>Merged Text</Text>
            <Text style={styles.bodyText}>
              {mergedText.length > 0 ? mergedText : 'No merged text available.'}
            </Text>

            {extractedFields && chosenFields && (
              <View style={styles.fieldsSection}>
                <Text style={styles.sectionTitle}>Fields</Text>
                {renderFieldRow('Title', chosenFields.title)}
                {renderFieldRow('Author', chosenFields.author)}
                {renderFieldRow('ISBN', chosenFields.isbn)}
                {renderFieldRow('Publisher', chosenFields.publisher)}
                {renderFieldRow('Edition', chosenFields.edition)}

                <TouchableOpacity
                  onPress={() => setShowAlternatives((prev) => !prev)}
                  style={styles.altToggle}
                >
                  <Text style={styles.altToggleText}>
                    {showAlternatives ? 'Hide alternatives' : 'Show alternatives'}
                  </Text>
                </TouchableOpacity>

                {showAlternatives && (
                  <View style={styles.altContainer}>
                    {renderCandidateList('Title candidates', extractedFields.titleCandidates)}
                    {renderCandidateList('Author candidates', extractedFields.authorCandidates)}
                    {renderCandidateList('Publisher candidates', extractedFields.publisherCandidates)}
                    {renderCandidateList('Edition candidates', extractedFields.editionCandidates)}
                  </View>
                )}
              </View>
            )}

            {/* Resolver Status - Always show decision + reason */}
            {candidate && (
              <View style={styles.resolvedSection}>
                <Text style={styles.sectionTitle}>Resolver Status</Text>
                <View style={styles.resolvedCard}>
                  <Text style={[
                    styles.resolvedStatusText,
                    resolverDecision === 'accept' && styles.statusAccepted,
                    resolverDecision === 'suggested' && styles.statusReview,
                    resolverDecision === 'reject' && styles.statusRejected,
                  ]}>
                    Status: {resolverDecision}
                  </Text>
                  <Text style={styles.resolvedReasonText}>
                    Reason: {resolverReason || '—'}
                  </Text>
                </View>
              </View>
            )}

            {/* Resolved Book Section - Show match and Accept button */}
            {candidate.resolvedBook && (
              <View style={styles.resolvedSection}>
                <Text style={styles.sectionTitle}>Matched Book</Text>
                <View style={styles.resolvedCard}>
                  <Text style={styles.resolvedTitle} numberOfLines={2}>
                    {candidate.resolvedBook.title}
                  </Text>
                  {candidate.resolvedBook.authors && candidate.resolvedBook.authors.length > 0 && (
                    <Text style={styles.resolvedAuthors} numberOfLines={1}>
                      {candidate.resolvedBook.authors.join(', ')}
                    </Text>
                  )}
                  <View style={styles.resolvedMeta}>
                    {candidate.resolvedBook.isbn13 && (
                      <Text style={styles.resolvedIsbn}>ISBN: {candidate.resolvedBook.isbn13}</Text>
                    )}
                    {candidate.resolvedBook.source && (
                      <Text style={styles.resolvedSource}>Source: {candidate.resolvedBook.source}</Text>
                    )}
                  </View>
                  <View style={styles.resolvedStatus}>
                    <Text style={[
                      styles.resolvedStatusText,
                      candidate.resolverDecision === 'accept' && styles.statusAccepted,
                      candidate.resolverDecision === 'suggested' && styles.statusReview,
                      candidate.resolverDecision === 'reject' && styles.statusRejected,
                    ]}>
                      Status: {candidate.resolverDecision || 'pending'}
                    </Text>
                    <Text style={styles.resolvedReasonText}>
                      Reason: {resolverReason || '—'}
                    </Text>
                  </View>
                </View>
                {/* Accept button - show when not already accepted */}
                {onAccept && candidate.resolverDecision !== 'accept' && (
                  <TouchableOpacity
                    style={[styles.acceptButton, isAccepting && styles.acceptButtonDisabled]}
                    onPress={onAccept}
                    disabled={isAccepting}
                  >
                    <Text style={styles.acceptButtonText}>
                      {isAccepting ? 'Accepting...' : 'Accept Match'}
                    </Text>
                  </TouchableOpacity>
                )}
                {candidate.resolverDecision === 'accept' && (
                  <View style={styles.acceptedBadge}>
                    <Text style={styles.acceptedBadgeText}>✓ Accepted & Cataloged</Text>
                  </View>
                )}
              </View>
            )}

            {/* Manual Review Candidates Section - Show alternative matches */}
            {candidate.resolverDecision === 'suggested' &&
              candidate.resolverSuggestions &&
              candidate.resolverSuggestions.length > 0 && (
              <View style={styles.suggestionsSection}>
                <Text style={styles.sectionTitle}>Alternative Matches</Text>
                <Text style={styles.suggestionsHint}>
                  Select a match below or accept the top match above
                </Text>
                {candidate.resolverSuggestions.slice(0, 3).map((suggestion, idx) => (
                  <TouchableOpacity
                    key={`suggestion-${idx}`}
                    style={styles.suggestionCard}
                    onPress={() => onSelectCandidate?.(idx)}
                    disabled={isAccepting}
                  >
                    <View style={styles.suggestionContent}>
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
                          <Text style={styles.suggestionIsbn}>ISBN: {suggestion.isbn13}</Text>
                        )}
                        {suggestion.publishYear && (
                          <Text style={styles.suggestionYear}>{suggestion.publishYear}</Text>
                        )}
                      </View>
                    </View>
                    <View style={styles.suggestionAction}>
                      <Text style={styles.suggestionActionText}>Select</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* Evidence Search Debug - Show hypotheses and scores */}
            {DEBUG_ARTIFACTS_ENABLED && candidate.evidenceSearchDebug && (
              <View style={styles.debugSection}>
                <Text style={styles.sectionTitle}>Evidence Search Debug</Text>
                <View style={styles.debugCard}>
                  <Text style={styles.debugLabel}>Hypotheses: {candidate.evidenceSearchDebug.hypothesesCount}</Text>
                  <Text style={styles.debugLabel}>Candidates Found: {candidate.evidenceSearchDebug.candidatesFound}</Text>
                  <Text style={styles.debugLabel}>Search Time: {candidate.evidenceSearchDebug.searchTimeMs}ms</Text>
                  {candidate.evidenceSearchDebug.topScores && candidate.evidenceSearchDebug.topScores.length > 0 && (
                    <View style={styles.topScoresSection}>
                      <Text style={styles.debugLabel}>Top Scores:</Text>
                      {candidate.evidenceSearchDebug.topScores.slice(0, 3).map((s, i) => (
                        <Text key={i} style={styles.debugScore}>
                          {Math.round(s.score * 100)}% - {s.title}
                        </Text>
                      ))}
                    </View>
                  )}
                  {candidate.evidenceSearchDebug.queriesTried && (
                    <View style={styles.queriesSection}>
                      <Text style={styles.debugLabel}>Queries Tried:</Text>
                      {candidate.evidenceSearchDebug.queriesTried.slice(0, 5).map((q, i) => (
                        <Text key={i} style={styles.debugQuery} numberOfLines={1}>
                          {i + 1}. {q}
                        </Text>
                      ))}
                    </View>
                  )}
                </View>
              </View>
            )}

            <View style={styles.revertSection}>
              <TouchableOpacity
                style={[styles.revertButton, !allowRevert && styles.revertButtonDisabled]}
                onPress={onRevert}
                disabled={!allowRevert}
              >
                <Text style={styles.revertButtonText}>Revert to auto</Text>
              </TouchableOpacity>
              {!allowRevert && (
                <Text style={styles.revertHelperText}>Not available yet</Text>
              )}
            </View>

            {DEBUG_ARTIFACTS_ENABLED && (
              <View style={styles.debugSection}>
                <Text style={styles.sectionTitle}>Evidence Lines (Debug)</Text>
                {evidenceLines.length === 0 ? (
                  <Text style={styles.emptyText}>No evidence lines available</Text>
                ) : (
                  evidenceLines.map((line, idx) => {
                    const confidenceLabel = formatConfidence(line.confidence) ?? '—';
                    const cropLabel = Number.isFinite(line.sourceCropIndex)
                      ? `Crop ${Number(line.sourceCropIndex) + 1}`
                      : '—';
                    const rotationLabel = Number.isFinite(line.sourceRotation)
                      ? `${line.sourceRotation}°`
                      : '—';

                    return (
                      <View key={idx} style={styles.lineRow}>
                        <Text style={styles.lineText} numberOfLines={2}>
                          {line.text || '—'}
                        </Text>
                        <View style={styles.lineMetaRow}>
                          <Text style={styles.lineMeta}>Conf {confidenceLabel}</Text>
                          <Text style={styles.lineMeta}>{cropLabel}</Text>
                          <Text style={styles.lineMeta}>Rot {rotationLabel}</Text>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>
            )}
          </ScrollView>
          {previewUri && (
            <View style={styles.previewOverlay} pointerEvents="box-none">
              <Pressable
                style={styles.previewBackdrop}
                onPress={() => setPreviewUri(null)}
              />
              <View style={styles.previewContent} pointerEvents="auto">
                <Image
                  source={{ uri: previewUri }}
                  style={styles.previewImage}
                  resizeMode="contain"
                />
                <Pressable
                  style={styles.previewClose}
                  onPress={() => setPreviewUri(null)}
                >
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
    backgroundColor: '#000',
    position: 'relative',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 16,
    backgroundColor: '#1c1c1e',
  },
  title: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  subtitle: {
    color: '#8e8e93',
    fontSize: 12,
    marginTop: 4,
  },
  badgesRow: {
    flexDirection: 'row',
    marginTop: 6,
  },
  autoBadge: {
    backgroundColor: '#2c2c2e',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginRight: 6,
  },
  autoBadgeText: {
    color: '#30D158',
    fontSize: 10,
    fontWeight: '600',
  },
  editedBadge: {
    backgroundColor: '#2c2c2e',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  editedBadgeText: {
    color: '#FF9F0A',
    fontSize: 10,
    fontWeight: '600',
  },
  closeButton: {
    padding: 8,
  },
  closeText: {
    color: '#007AFF',
    fontSize: 16,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  editButton: {
    padding: 8,
    marginRight: 6,
  },
  editText: {
    color: '#007AFF',
    fontSize: 16,
  },
  editTextDisabled: {
    color: '#636366',
  },
  content: {
    padding: 16,
  },
  sectionTitle: {
    color: '#8e8e93',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
    marginTop: 12,
  },
  cropStrip: {
    paddingBottom: 8,
  },
  cropThumb: {
    width: 72,
    height: 72,
    borderRadius: 10,
    overflow: 'hidden',
    marginRight: 8,
    backgroundColor: '#2c2c2e',
  },
  cropThumbImage: {
    width: '100%',
    height: '100%',
  },
  cropThumbPlaceholder: {
    width: 72,
    height: 72,
    borderRadius: 10,
    marginRight: 8,
    backgroundColor: '#2c2c2e',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  cropThumbLabel: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
    textAlign: 'center',
  },
  cropThumbSubtext: {
    color: '#8e8e93',
    fontSize: 9,
    marginTop: 4,
    textAlign: 'center',
  },
  bodyText: {
    color: '#a0a0a5',
    fontSize: 13,
    lineHeight: 18,
  },
  fieldsSection: {
    marginTop: 12,
  },
  fieldRow: {
    marginBottom: 6,
  },
  fieldLabel: {
    color: '#8e8e93',
    fontSize: 11,
    marginBottom: 2,
  },
  fieldValue: {
    color: '#fff',
    fontSize: 13,
  },
  altToggle: {
    marginTop: 8,
    alignSelf: 'flex-start',
  },
  altToggleText: {
    color: '#007AFF',
    fontSize: 12,
    fontWeight: '600',
  },
  altContainer: {
    marginTop: 8,
    backgroundColor: '#1c1c1e',
    borderRadius: 10,
    padding: 10,
  },
  altGroup: {
    marginBottom: 8,
  },
  altLabel: {
    color: '#8e8e93',
    fontSize: 11,
    marginBottom: 4,
  },
  altItem: {
    color: '#fff',
    fontSize: 12,
    marginBottom: 2,
  },
  resolvedSection: {
    marginTop: 16,
  },
  resolvedCard: {
    backgroundColor: '#1c1c1e',
    borderRadius: 10,
    padding: 12,
  },
  resolvedTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  resolvedAuthors: {
    color: '#8e8e93',
    fontSize: 13,
    marginTop: 4,
  },
  resolvedMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
  },
  resolvedIsbn: {
    color: '#636366',
    fontSize: 11,
    marginRight: 12,
  },
  resolvedSource: {
    color: '#636366',
    fontSize: 11,
  },
  resolvedStatus: {
    marginTop: 8,
  },
  resolvedStatusText: {
    fontSize: 12,
    fontWeight: '500',
  },
  resolvedReasonText: {
    color: '#8e8e93',
    fontSize: 11,
    marginTop: 4,
  },
  statusAccepted: {
    color: '#30D158',
  },
  statusReview: {
    color: '#FF9F0A',
  },
  statusRejected: {
    color: '#FF453A',
  },
  acceptButton: {
    backgroundColor: '#30D158',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    marginTop: 12,
    alignItems: 'center',
  },
  acceptButtonDisabled: {
    backgroundColor: '#2c2c2e',
  },
  acceptButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  acceptedBadge: {
    backgroundColor: 'rgba(48, 209, 88, 0.2)',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginTop: 12,
  },
  acceptedBadgeText: {
    color: '#30D158',
    fontSize: 13,
    fontWeight: '500',
  },
  revertSection: {
    marginTop: 12,
  },
  revertButton: {
    backgroundColor: '#38383a',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  revertButtonDisabled: {
    backgroundColor: '#2c2c2e',
  },
  revertButtonText: {
    color: '#007AFF',
    fontSize: 13,
    fontWeight: '600',
  },
  revertHelperText: {
    color: '#636366',
    fontSize: 11,
    marginTop: 6,
  },
  emptyText: {
    color: '#636366',
    fontSize: 12,
    fontStyle: 'italic',
  },
  debugSection: {
    marginTop: 8,
  },
  lineRow: {
    backgroundColor: '#1c1c1e',
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
  },
  lineText: {
    color: '#fff',
    fontSize: 13,
    marginBottom: 6,
  },
  lineMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  lineMeta: {
    color: '#8e8e93',
    fontSize: 11,
    marginRight: 12,
  },
  previewOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
    elevation: 9999,
  },
  previewBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
  },
  previewContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  previewImage: {
    width: '100%',
    height: '70%',
  },
  previewClose: {
    marginTop: 16,
    backgroundColor: '#1c1c1e',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  previewCloseText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  // Manual Review Suggestions
  suggestionsSection: {
    marginTop: 16,
  },
  suggestionsHint: {
    color: '#8e8e93',
    fontSize: 12,
    marginBottom: 8,
  },
  suggestionCard: {
    backgroundColor: '#1c1c1e',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  suggestionContent: {
    flex: 1,
  },
  suggestionTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  suggestionAuthors: {
    color: '#8e8e93',
    fontSize: 12,
    marginTop: 2,
  },
  suggestionMeta: {
    flexDirection: 'row',
    marginTop: 4,
  },
  suggestionIsbn: {
    color: '#636366',
    fontSize: 10,
    marginRight: 8,
  },
  suggestionYear: {
    color: '#636366',
    fontSize: 10,
  },
  suggestionAction: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    marginLeft: 8,
  },
  suggestionActionText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  // Evidence Search Debug
  debugCard: {
    backgroundColor: '#1c1c1e',
    borderRadius: 10,
    padding: 12,
  },
  debugLabel: {
    color: '#8e8e93',
    fontSize: 11,
    marginBottom: 4,
  },
  topScoresSection: {
    marginTop: 8,
  },
  debugScore: {
    color: '#30D158',
    fontSize: 11,
    marginLeft: 8,
    marginBottom: 2,
  },
  queriesSection: {
    marginTop: 8,
  },
  debugQuery: {
    color: '#FF9F0A',
    fontSize: 10,
    marginLeft: 8,
    marginBottom: 2,
  },
});
