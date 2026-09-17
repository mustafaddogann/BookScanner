import React from 'react';
import {
  StyleSheet,
  View,
  Text,
  Image,
  Modal,
  TouchableOpacity,
  TouchableWithoutFeedback,
  ScrollView,
} from 'react-native';
import { colors, fonts, spacing, radii } from '../theme';
import type { AggregatedBook } from '../hooks/useAggregatedBooks';

interface BookDetailSheetProps {
  visible: boolean;
  book: AggregatedBook | null;
  onClose: () => void;
}

export function BookDetailSheet({ visible, book, onClose }: BookDetailSheetProps) {
  const resolved = book?.candidate.resolvedBook;
  const title = resolved?.title ?? 'Unknown Title';
  const author = resolved?.authors?.join(', ') ?? 'Unknown Author';

  const pills: string[] = [];
  if (resolved?.isbn13) pills.push(`ISBN ${resolved.isbn13}`);
  else if (resolved?.isbn10) pills.push(`ISBN ${resolved.isbn10}`);
  if (resolved?.publisher) pills.push(resolved.publisher);
  if (resolved?.publishYear) pills.push(resolved.publishYear);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay} />
      </TouchableWithoutFeedback>
      <View style={styles.sheet}>
        {/* Handle */}
        <View style={styles.handleRow}>
          <View style={styles.handle} />
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {/* Cover */}
          <View style={styles.coverWrapper}>
            {book?.coverUri ? (
              <Image
                source={{ uri: book.coverUri }}
                style={styles.cover}
                resizeMode="cover"
              />
            ) : (
              <View style={[styles.cover, styles.coverPlaceholder]}>
                <Text style={styles.coverPlaceholderIcon}>{'\u{1F4D6}'}</Text>
              </View>
            )}
          </View>

          {/* Title & Author */}
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.author}>by {author}</Text>

          {/* Metadata Pills */}
          {pills.length > 0 && (
            <View style={styles.pillsRow}>
              {pills.map((pill) => (
                <View key={pill} style={styles.pill}>
                  <Text style={styles.pillText}>{pill}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Done Button */}
          <TouchableOpacity style={styles.doneButton} onPress={onClose}>
            <Text style={styles.doneButtonText}>Done</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radii.xxl,
    borderTopRightRadius: radii.xxl,
    maxHeight: '60%',
  },
  handleRow: {
    alignItems: 'center',
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  content: {
    alignItems: 'center',
    paddingHorizontal: spacing.xxl,
    paddingBottom: spacing.xxxxl,
  },
  coverWrapper: {
    marginTop: spacing.lg,
    marginBottom: spacing.xl,
  },
  cover: {
    width: 120,
    height: 176,
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: colors.bgNested,
  },
  coverPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  coverPlaceholderIcon: {
    fontSize: 36,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 20,
    fontFamily: fonts.display.semiBold,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  author: {
    color: colors.textSecondary,
    fontSize: 15,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  pillsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xxl,
  },
  pill: {
    backgroundColor: colors.bgNested,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  pillText: {
    color: colors.textTertiary,
    fontSize: 11,
    fontWeight: '600',
  },
  doneButton: {
    backgroundColor: colors.primaryMuted,
    borderRadius: radii.xl,
    paddingHorizontal: spacing.xxxl,
    paddingVertical: spacing.md,
  },
  doneButtonText: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: '700',
  },
});
