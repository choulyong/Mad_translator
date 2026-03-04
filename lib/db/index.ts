import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema";

// 1. Database Connection
const sqlite = new Database("local.db");
export const db = drizzle(sqlite, { schema });

// 2. Re-exports from real paths
export { scanDirectory, browseDirectory, previewDirectory, createFolder, moveFiles } from "../../app/actions/scan";
export { identifyMovie } from "../../app/actions/identify";
export { processRename } from "../../app/actions/rename";
export {
  getMovies,
  getMovieCount,
  deleteMovie,
  deleteAllMovies,
  updateMovie,
  scanForLibrary,
  importToLibrary,
  enrichLibrary,
  enrichMovie,
  getEnrichTargets,
  scanSubtitles,
  scanSubtitlesSingle,
  deleteSubtitleFile,
  searchOnlineSubtitles,
  downloadOnlineSubtitle,
  searchMoviesForReidentify,
  reidentifyMovie,
  getMovieForTranslation,
  exportSrtToFile,
  readSubtitleFile,
  detectNewFiles,
  enrichAndImportNewFile
} from "../../app/actions/library";
export { listDirectory, copyItems, deleteItems, renameItem, moveItems } from "../../app/actions/file-manager";
