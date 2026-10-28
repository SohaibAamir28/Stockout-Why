/**
 * H-MEM record contract, as specified by the Meterless H-MEM engine
 * (vendor/meterless/engines/hmem/docs/memory-record.md).
 *
 * These types are the portable contract across implementations, so they are
 * kept faithful to the spec rather than trimmed to what this app happens to
 * use today.
 */

export type MemoryType = 'personal' | 'factual' | 'preference' | 'general';

export type MemoryLayer = 'short_term' | 'working' | 'long_term';

export type MemoryOrigin =
  | 'chat'
  | 'import'
  | 'web'
  | 'decision'
  | 'curiosity'
  | 'goal_run'
  | 'user_explicit'
  | 'inference'
  | 'plan_run'
  | 'mission'
  | 'swarm_run'
  | 'tool'
  | 'brain';

export interface MemoryProvenance {
  origin: MemoryOrigin;
  learnedAt: number;
  /** Human-readable "how I learned this". */
  label: string;
  refs?: {
    chatId?: string;
    importRunId?: string;
    importSource?: string;
    sourceUrl?: string;
    sourceDomain?: string;
    decisionId?: string;
    goalRunId?: string;
  };
}

export interface MemoryEntity {
  name: string;
  type: string;
}

export interface Memory {
  id: string;
  content: string;
  type: MemoryType;
  layer: MemoryLayer;
  timestamp: number;
  lastAccessed: number;
  accessCount: number;
  tags: string[];
  domain?: string;
  namespace?: string;
  embedding?: number[];
  /** Runtime only, never persisted as truth. */
  score?: number;
  /** Mandatory. */
  confidence: number;
  /** Mandatory; records without one are rejected by construction. */
  source: string;
  provenance?: MemoryProvenance;

  // Recall scoping.
  chatId?: string;
  missionId?: string;
  goalRunId?: string;

  // Graph.
  entities: MemoryEntity[];
  relatedTo: string[];
  supersedes?: string;
  /** Set by conflict resolution; drives the -0.20 retrieval penalty. */
  supersededBy?: string;
  derivedFrom: string[];
}

/** What callers may supply to add(). Everything else is derived. */
export interface MemoryInput {
  content: string;
  source: string;
  type?: MemoryType;
  layer?: MemoryLayer;
  confidence?: number;
  tags?: string[];
  domain?: string;
  namespace?: string;
  entities?: MemoryEntity[];
  relatedTo?: string[];
  supersedes?: string;
  derivedFrom?: string[];
  chatId?: string;
  missionId?: string;
  goalRunId?: string;
  provenance?: MemoryProvenance;
}

export type FeedbackKind = 'helpful' | 'not_helpful' | 'wrong';

export type LedgerAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'feedback'
  | 'promote'
  | 'archive'
  | 'synthesize'
  | 'resolve'
  | 'restore';

export interface LedgerEntry {
  id: string;
  memoryId: string;
  action: LedgerAction;
  at: number;
  previousState?: Partial<Memory>;
  newState?: Partial<Memory>;
  detail?: string;
}

export interface Conflict {
  id: string;
  memoryA: string;
  memoryB: string;
  reason: string;
  confidence: number;
  status: 'open' | 'resolved' | 'queued';
}

export type DreamProposalType = 'insight' | 'invariant' | 'domain';

export interface DreamProposal {
  id: string;
  type: DreamProposalType;
  content: string;
  derivedFrom: string[];
  confidence: number;
  status: 'pending_review' | 'approved' | 'rejected';
}

export interface SleepPreview {
  toConsolidate: string[];
  toArchive: string[];
  toSynthesize: string[][];
}

export interface SleepReport {
  backupId: string;
  consolidatedCount: number;
  archivedCount: number;
  synthesizedCount: number;
  actionLog: string[];
}

export interface RetrievalHit {
  memory: Memory;
  score: number;
  signals: Record<string, number>;
}

export interface RetrievalResult {
  memories: RetrievalHit[];
  strategy: string;
  /** Records suppressed by the superseded penalty, for trace metadata. */
  suppressed: string[];
}

export interface QueryOptions {
  threshold?: number;
  topN?: number;
  chatId?: string;
  goalRunId?: string;
  includeUnscoped?: boolean;
  strategy?: string;
}
