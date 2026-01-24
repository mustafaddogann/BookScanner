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

interface EditCandidateFieldsModalProps {
  visible: boolean;
  title: string;
  author: string;
  onChangeTitle: (value: string) => void;
  onChangeAuthor: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  canSave?: boolean;
}

export function EditCandidateFieldsModal({
  visible,
  title,
  author,
  onChangeTitle,
  onChangeAuthor,
  onSave,
  onCancel,
  canSave = true,
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
        style={styles.modalOverlay}
      >
        <View style={styles.modalContent}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Edit Book Info</Text>
            <TouchableOpacity onPress={onCancel} style={styles.modalCloseButton}>
              <Text style={styles.modalCloseText}>Cancel</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.modalInputContainer}>
            <Text style={styles.modalInputLabel}>Title</Text>
            <TextInput
              style={styles.modalInput}
              value={title}
              onChangeText={onChangeTitle}
              placeholder="Enter book title"
              placeholderTextColor="#636366"
              autoCapitalize="words"
              autoCorrect={false}
            />
          </View>

          <View style={styles.modalInputContainer}>
            <Text style={styles.modalInputLabel}>Author</Text>
            <TextInput
              style={styles.modalInput}
              value={author}
              onChangeText={onChangeAuthor}
              placeholder="Enter author name"
              placeholderTextColor="#636366"
              autoCapitalize="words"
              autoCorrect={false}
            />
          </View>

          <TouchableOpacity
            style={[styles.modalSaveButton, !canSave && styles.modalSaveButtonDisabled]}
            onPress={onSave}
            disabled={!canSave}
          >
            <Text style={styles.modalSaveButtonText}>Save</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  modalContent: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: Platform.OS === 'ios' ? 40 : 20,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  modalTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  modalCloseButton: {
    padding: 8,
  },
  modalCloseText: {
    color: '#007AFF',
    fontSize: 16,
  },
  modalInputContainer: {
    marginBottom: 16,
  },
  modalInputLabel: {
    color: '#8e8e93',
    fontSize: 13,
    marginBottom: 8,
  },
  modalInput: {
    backgroundColor: '#38383a',
    borderRadius: 8,
    padding: 12,
    color: '#fff',
    fontSize: 16,
  },
  modalSaveButton: {
    backgroundColor: '#007AFF',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  modalSaveButtonDisabled: {
    backgroundColor: '#38383a',
  },
  modalSaveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
