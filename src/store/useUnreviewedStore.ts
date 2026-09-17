import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';

const unreviewedStorage = new MMKV({
  id: 'unreviewed-sessions',
});

const STORAGE_KEY = 'unreviewed_session_ids';

function loadPersistedIds(): Set<string> {
  const raw = unreviewedStorage.getString(STORAGE_KEY);
  if (!raw) return new Set();
  try {
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function persistIds(ids: Set<string>) {
  unreviewedStorage.set(STORAGE_KEY, JSON.stringify([...ids]));
}

interface UnreviewedState {
  unreviewedIds: Set<string>;
  addUnreviewed: (id: string) => void;
  markReviewed: (id: string) => void;
  isUnreviewed: (id: string) => boolean;
}

export const useUnreviewedStore = create<UnreviewedState>((set, get) => ({
  unreviewedIds: loadPersistedIds(),

  addUnreviewed: (id) => {
    set((state) => {
      const next = new Set(state.unreviewedIds);
      next.add(id);
      persistIds(next);
      return { unreviewedIds: next };
    });
  },

  markReviewed: (id) => {
    set((state) => {
      if (!state.unreviewedIds.has(id)) return state;
      const next = new Set(state.unreviewedIds);
      next.delete(id);
      persistIds(next);
      return { unreviewedIds: next };
    });
  },

  isUnreviewed: (id) => get().unreviewedIds.has(id),
}));
