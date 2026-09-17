import React, { useState, useCallback } from 'react';
import { StyleSheet, View, Text, FlatList, ScrollView } from 'react-native';
import { colors, fonts, spacing, radii } from '../theme';
import { useAggregatedBooks } from '../hooks/useAggregatedBooks';
import type { AggregatedBook } from '../hooks/useAggregatedBooks';
import { BookListItem } from './BookListItem';
import { BookDetailSheet } from './BookDetailSheet';

export function BooksListTab(): React.JSX.Element {
  const { books, diagnostics } = useAggregatedBooks();
  const [selectedBook, setSelectedBook] = useState<AggregatedBook | null>(null);

  const handlePress = useCallback((book: AggregatedBook) => {
    setSelectedBook(book);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: AggregatedBook }) => (
      <BookListItem book={item} onPress={() => handlePress(item)} />
    ),
    [handlePress],
  );

  const keyExtractor = useCallback(
    (item: AggregatedBook) => `${item.sessionId}_${item.candidate.id}`,
    [],
  );

  if (books.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.emptyContainer}>
        <View style={styles.emptyState}>
          <View style={styles.emptyIconBg}>
            <Text style={styles.emptyIcon}>{'\u{1F4D6}'}</Text>
          </View>
          <Text style={styles.emptyTitle}>No books yet</Text>
          <Text style={styles.emptySubtext}>
            Scan a bookshelf to start building your collection
          </Text>
        </View>

        {/* Diagnostics panel — helps debug pipeline data flow */}
        {diagnostics.sessionCount > 0 && (
          <View style={styles.diagPanel}>
            <Text style={styles.diagTitle}>Pipeline Diagnostics</Text>
            <Text style={styles.diagLine}>
              Sessions: {diagnostics.sessionCount} | With meta: {diagnostics.sessionsWithMeta} | With candidates: {diagnostics.sessionsWithCandidates}
            </Text>
            <Text style={styles.diagLine}>
              Total candidates: {diagnostics.totalCandidates}
            </Text>
            {Object.keys(diagnostics.decisionCounts).length > 0 && (
              <Text style={styles.diagLine}>
                Decisions: {Object.entries(diagnostics.decisionCounts).map(([k, v]) => `${k}=${v}`).join(', ')}
              </Text>
            )}
            {diagnostics.details.map((d, i) => (
              <Text key={i} style={styles.diagDetail}>{d}</Text>
            ))}
          </View>
        )}
      </ScrollView>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={books}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
      />
      <BookDetailSheet
        visible={selectedBook !== null}
        book={selectedBook}
        onClose={() => setSelectedBook(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  list: {
    paddingHorizontal: spacing.xxl,
    paddingBottom: spacing.xxxxl,
  },
  emptyContainer: {
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xxxxl,
  },
  emptyState: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.xxl,
    padding: spacing.xxxl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  emptyIconBg: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primaryMuted,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  emptyIcon: {
    fontSize: 24,
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontFamily: fonts.display.semiBold,
    marginBottom: spacing.xs,
  },
  emptySubtext: {
    color: colors.textTertiary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  // Diagnostics panel
  diagPanel: {
    marginTop: spacing.xl,
    backgroundColor: colors.bgNested,
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  diagTitle: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '700',
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  diagLine: {
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 2,
  },
  diagDetail: {
    color: colors.textTertiary,
    fontSize: 10,
    lineHeight: 14,
    fontFamily: 'Menlo',
  },
});
