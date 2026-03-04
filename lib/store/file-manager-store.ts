import { create } from "zustand";
import type { FMEntry } from "@/app/actions";

interface FileManagerStore {
  currentPath: string;
  parentPath: string | null;
  entries: FMEntry[];
  selected: Set<string>;
  loading: boolean;
  error: string | null;

  // 클립보드 (복사/이동)
  clipboard: { paths: string[]; mode: "copy" | "move" } | null;

  setDirectory: (path: string, parent: string | null, entries: FMEntry[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  toggleSelect: (path: string) => void;
  selectAll: () => void;
  deselectAll: () => void;
  setClipboard: (paths: string[], mode: "copy" | "move") => void;
  clearClipboard: () => void;
}

export const useFileManagerStore = create<FileManagerStore>((set) => ({
  currentPath: "\\\\192.168.0.2\\torrent",
  parentPath: null,
  entries: [],
  selected: new Set<string>(),
  loading: false,
  error: null,
  clipboard: null,

  setDirectory: (currentPath, parentPath, entries) =>
    set({ currentPath, parentPath, entries, selected: new Set(), error: null }),

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  toggleSelect: (path) =>
    set((state) => {
      const next = new Set(state.selected);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { selected: next };
    }),

  selectAll: () =>
    set((state) => ({
      selected: new Set(state.entries.map((e) => e.path)),
    })),

  deselectAll: () => set({ selected: new Set() }),

  setClipboard: (paths, mode) => set({ clipboard: { paths, mode } }),
  clearClipboard: () => set({ clipboard: null }),
}));
