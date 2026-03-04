import { create } from "zustand";
import type { FileItem } from "@/lib/types";

interface ScanStore {
  path: string;
  files: FileItem[];
  isScanning: boolean;
  selected: Set<string>;

  setPath: (path: string) => void;
  setFiles: (files: FileItem[]) => void;
  setIsScanning: (scanning: boolean) => void;
  updateFileStatus: (
    id: string,
    status: FileItem["status"],
    updates?: Partial<FileItem>
  ) => void;
  updateFileName: (id: string, newName: string) => void;
  clearFiles: () => void;

  toggleSelect: (id: string) => void;
  selectAll: () => void;
  deselectAll: () => void;
  selectReady: () => void;
  selectDone: () => void;
  toggleFolderSelect: (folderName: string) => void;
  removeFiles: (ids: string[]) => void;
}

export const useScanStore = create<ScanStore>((set, get) => ({
  path: "",
  files: [],
  isScanning: false,
  selected: new Set<string>(),

  setPath: (path) => set({ path }),
  setFiles: (files) => set({ files, selected: new Set() }),
  setIsScanning: (isScanning) => set({ isScanning }),
  updateFileStatus: (id, status, updates) =>
    set((state) => ({
      files: state.files.map((f) =>
        f.id === id ? { ...f, status, ...updates } : f
      ),
    })),
  updateFileName: (id, newName) =>
    set((state) => ({
      files: state.files.map((f) =>
        f.id === id ? { ...f, newName } : f
      ),
    })),
  clearFiles: () => set({ files: [], isScanning: false, selected: new Set() }),

  toggleSelect: (id) =>
    set((state) => {
      const next = new Set(state.selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selected: next };
    }),
  selectAll: () =>
    set((state) => ({
      selected: new Set(state.files.map((f) => f.id)),
    })),
  deselectAll: () => set({ selected: new Set() }),
  selectReady: () =>
    set((state) => ({
      selected: new Set(
        state.files.filter((f) => f.status === "ready").map((f) => f.id)
      ),
    })),
  selectDone: () =>
    set((state) => ({
      selected: new Set(
        state.files.filter((f) => f.status === "done").map((f) => f.id)
      ),
    })),
  toggleFolderSelect: (folderName) =>
    set((state) => {
      const folderFiles = state.files.filter(
        (f) => (f.folderName || "_root") === folderName && f.status !== "moved" && f.status !== "identifying" && f.status !== "renaming"
      );
      const folderIds = folderFiles.map((f) => f.id);
      const allSelected = folderIds.every((id) => state.selected.has(id));
      const next = new Set(state.selected);
      if (allSelected) {
        folderIds.forEach((id) => next.delete(id));
      } else {
        folderIds.forEach((id) => next.add(id));
      }
      return { selected: next };
    }),
  removeFiles: (ids) =>
    set((state) => {
      const idSet = new Set(ids);
      const next = new Set(state.selected);
      ids.forEach((id) => next.delete(id));
      return {
        files: state.files.filter((f) => !idSet.has(f.id)),
        selected: next,
      };
    }),
}));
