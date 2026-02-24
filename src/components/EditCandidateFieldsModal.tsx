/**
 * EditCandidateFieldsModal - Bottom sheet for editing book info
 *
 * UX: Slide-up sheet with focused input fields.
 * The sheet stays compact — no unnecessary padding or chrome.
 * Save button disables when nothing changed.
 * Revert is destructive and styled accordingly.
 */

import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import { colors, fonts, spacing, radii, shadows } from '../theme';

interface EditCandidateFieldsModalProps {
  visible: boolean;
  title: string;
  author: string;
  onChangeTitle: (value: string) => void;
  onChangeAuthor: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onRevert?: () => void;
  canSave?: boolean;
  canRevert?: boolean;
}

export function EditCandidateFieldsModal({
  visible,
  title,
  author,
  onChangeTitle,
  onChangeAuthor,
  onSave,
  onCancel,
  onRevert,
  canSave = true,
  canRevert = false,
}: EditCandidateFieldsModalProps) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      onRequestClose={onCancel}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.overlay}
      >
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={onCancel}
        />
        <View style={styles.sheet}>
          {/* Handle */}
          <View style={styles.handleRow}>
            <View style={styles.handle} />
          </View>

          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Edit Book Info</Text>
            <TouchableOpacity onPress={onCancel} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>

          {/* Fields */}
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Title</Text>
            <TextInput
              style={styles.input}
              value={title}
              onChangeText={onChangeTitle}
              placeholder="Enter book title"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="next"
            />
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Author</Text>
            <TextInput
              style={styles.input}
              value={author}
              onChangeText={onChangeAuthor}
              placeholder="Enter author name"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={canSave ? onSave : undefined}
            />
          </View>

          {/* Actions */}
          <TouchableOpacity
            style={[styles.saveButton, !canSave && styles.saveButtonDisabled]}
            onPress={onSave}
            disabled={!canSave}
            activeOpacity={0.8}
          >
            <Text style={[styles.saveButtonText, !canSave && styles.saveButtonTextDisabled]}>
              Save Changes
            </Text>
          </TouchableOpacity>

          {canRevert && onRevert && (
            <TouchableOpacity style={styles.revertButton} onPress={onRevert} activeOpacity={0.7}>
              <Text style={styles.revertButtonText}>Revert to Auto-Detected</Text>
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(12, 10, 9, 0.5)',
  },
  sheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radii.xxl,
    borderTopRightRadius: radii.xxl,
    paddingHorizontal: spacing.xxl,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
  },
  handleRow: {
    alignItems: 'center',
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.bgOverlay,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xxl,
  },
  headerTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontFamily: fonts.display.semiBold,
  },
  cancelText: {
    color: colors.textSecondary,
    fontSize: 15,
  },
  fieldGroup: {
    marginBottom: spacing.xl,
  },
  fieldLabel: {
    color: colors.textTertiary,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  input: {
    backgroundColor: colors.bgNested,
    borderRadius: radii.md,
    padding: spacing.lg,
    color: colors.textPrimary,
    fontSize: 16,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  saveButton: {
    backgroundColor: colors.primary,
    borderRadius: radii.lg,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: spacing.sm,
    ...shadows.glowSubtle,
  },
  saveButtonDisabled: {
    backgroundColor: colors.bgNested,
    shadowOpacity: 0,
  },
  saveButtonText: {
    color: colors.bgDeep,
    fontSize: 16,
    fontWeight: '700',
  },
  saveButtonTextDisabled: {
    color: colors.textMuted,
  },
  revertButton: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: 'rgba(199, 92, 92, 0.4)',
    borderRadius: radii.lg,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  revertButtonText: {
    color: colors.rejected,
    fontSize: 15,
    fontWeight: '600',
  },
});
