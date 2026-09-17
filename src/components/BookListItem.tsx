import React from 'react';
import { StyleSheet, View, Text, Image } from 'react-native';
import { colors, fonts, spacing, radii } from '../theme';
import { AnimatedPressable } from './AnimatedPressable';
import type { AggregatedBook } from '../hooks/useAggregatedBooks';

interface BookListItemProps {
  book: AggregatedBook;
  onPress: () => void;
}

export const BookListItem = React.memo(function BookListItem({
  book,
  onPress,
}: BookListItemProps) {
  const resolved = book.candidate.resolvedBook;
  const title = resolved?.title ?? 'Unknown Title';
  const author = resolved?.authors?.join(', ') ?? 'Unknown Author';

  return (
    <AnimatedPressable style={styles.card} onPress={onPress}>
      <View style={styles.cover}>
        {book.coverUri ? (
          <Image
            source={{ uri: book.coverUri }}
            style={styles.coverImage}
            resizeMode="cover"
          />
        ) : (
          <View style={styles.coverPlaceholder}>
            <Text style={styles.coverPlaceholderIcon}>{'\u{1F4D6}'}</Text>
          </View>
        )}
      </View>
      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        <Text style={styles.author} numberOfLines={1}>
          by {author}
        </Text>
      </View>
      <Text style={styles.chevron}>{'\u203A'}</Text>
    </AnimatedPressable>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: spacing.lg,
    marginBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 88,
  },
  cover: {
    width: 52,
    height: 76,
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: colors.bgNested,
  },
  coverImage: {
    width: '100%',
    height: '100%',
  },
  coverPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  coverPlaceholderIcon: {
    fontSize: 20,
  },
  info: {
    flex: 1,
    marginLeft: spacing.lg,
    marginRight: spacing.sm,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  author: {
    color: colors.textSecondary,
    fontSize: 13,
    marginTop: 3,
  },
  chevron: {
    color: colors.textMuted,
    fontSize: 16,
  },
});
