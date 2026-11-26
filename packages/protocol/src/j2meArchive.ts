export interface ArchiveBuild {
  sha256: string;
  sha1: string;
  crc32: string;
  size: number;
  filename: string;
  collection: string;
  archivePath: string;
  archiveFile: string;
  title: string;
  vendor: string;
  version: string;
  cldc: string;
  midp: string;
}

export interface ArchiveSearchItem extends ArchiveBuild {
  gameId: string | null;
  otherBuildsInLibrary: number;
  direct?: boolean;
}

export type ArchiveMatchState = 'exact' | 'review' | 'unknown' | 'manual';
export interface ArchiveMatch {
  provider: 'j2me-archive';
  indexVersion: string;
  sourceUrl: string;
  matchedSha256: string | null;
  state: ArchiveMatchState;
  confidence: 'verified' | 'candidate' | null;
  build: ArchiveBuild | null;
}

export interface ArchiveReviewItem {
  gameId: string;
  name: string;
  vendor: string;
  version: string;
  sha256: string;
  match: ArchiveMatch;
  candidates: ArchiveBuild[];
}

export interface ArchiveMatchJob {
  state: 'running' | 'paused' | 'preview' | 'applied' | 'failed';
  indexVersion: string;
  total: number;
  processed: number;
  exact: number;
  review: number;
  unknown: number;
  skipped: number;
  errors: number;
  error: string | null;
}

export interface ArchiveTransfer {
  state: 'running' | 'cancelled' | 'done' | 'failed';
  phase: 'fetching' | 'verifying' | 'importing' | 'finished';
  message: string | null;
  processed?: number;
  total?: number;
}

export interface ArchiveStatus {
  availableVersion: string;
  index: { version: string; builtAt: string; builds: number; bytes: number } | null;
  indexJob: ArchiveTransfer | null;
  matchJob: ArchiveMatchJob | null;
  maxIndexBytes: number;
  writableRoots: { id: 'managed' | 'external' | 'java'; label: string; writable: boolean }[];
}

export interface ArchiveDownload extends ArchiveTransfer {
  sha256: string;
  gameId: string | null;
  duplicate: boolean;
  source?: DownloadProvider;
}

export type DownloadProvider = 'J2ME Vault' | 'J2ME Archive';

export interface CuratedTitle {
  title: string;
  suggested: string | null;
  builds: ArchiveSearchItem[];
  installedGameId?: string;
}

export interface CuratedDestination { path: string; writable: boolean }

export interface CuratedImport {
  state: 'running' | 'done' | 'cancelled';
  total: number;
  imported: number;
  duplicates: number;
  failed: { title: string; message: string; sha256?: string }[];
  substituted?: number;
  current: string | null;
  currentBytes?: number;
  destination?: string;
  progress: string | null;
  source?: DownloadProvider;
  followUp?: {
    state: 'queued' | 'scanning' | 'recognizing' | 'done' | 'failed' | 'cancelled';
    scanned?: number;
    recognized?: number;
    error?: string;
  };
}

export interface JavaCatalogInfo {
  title: string;
  sourceUrl: string;
  genres: string[];
  description: string;
  screenshots: number;
  year: number | null;
  partial?: boolean;
}

export interface JavaCatalogJob {
  state: 'running' | 'done' | 'failed' | 'cancelled';
  total: number;
  processed: number;
  matched: number;
  errors: number;
  partial?: number;
  detailsProcessed?: number;
  detailsTotal?: number;
  error?: string;
}
