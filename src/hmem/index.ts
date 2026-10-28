/**
 * H-MEM: an implementation of the Meterless H-MEM engine spec.
 *
 * Verified against the upstream conformance suite:
 *   HMEM_IMPL=<abs path to this file> npx tsx vendor/meterless/engines/hmem/conformance/runner.ts
 *
 * The spec is in vendor/meterless/engines/hmem/ (AGENTS.md and docs/). The
 * load-bearing rules this file implements, with their sources:
 *
 *   - a record without a source is rejected by construction  (memory-record.md)
 *   - feedback deltas: helpful +0.05 and +1 access, not_helpful -0.03,
 *     wrong -0.20 plus a "review" tag, clamped to [0,1]      (AGENTS.md)
 *   - the eight-signal ranking blend, clamped then multiplied
 *     by confidence, with a -0.20 superseded penalty         (retrieval-ranking.md)
 *   - archive only at >=30 days old, accessCount <=2, and
 *     unreferenced; never archive derived records            (sleep-cycle.md)
 *   - auto-resolve conflicts only at decision confidence
 *     >=0.70, mark the loser supersededBy, delete nothing     (conflict-resolution.md)
 *   - dream proposals never materialise before approval       (dreaming.md)
 *   - no mutation happens without a trust ledger entry        (memory-record.md)
 *
 * Passing a `dir` makes memory durable across sessions, which is what the
 * application uses. The conformance suite constructs with `{ clock }` only,
 * and then nothing touches the disk.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { clamp01, cosine, embed, jaccard, tokenize } from './embeddings.ts';
import type {
  Conflict,
  DreamProposal,
  FeedbackKind,
  LedgerAction,
  LedgerEntry,
  Memory,
  MemoryInput,
  QueryOptions,
  RetrievalHit,
  RetrievalResult,
  SleepPreview,
  SleepReport,
} from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Exact deltas from the spec. */
const FEEDBACK: Record<
  FeedbackKind,
  { confidence: number; access: number; tag?: string }
> = {
  helpful: { confidence: +0.05, access: 1 },
  not_helpful: { confidence: -0.03, access: 0 },
  wrong: { confidence: -0.2, access: 0, tag: 'review' },
};

/** Ranking weights (retrieval-ranking.md). */
const WEIGHTS = {
  semantic: 0.35,
  keyword: 0.2,
  tag: 0.1,
  domain: 0.1,
  entity: 0.15,
  layer: 0.05,
  recency: 0.05,
  superseded: -0.2,
} as const;

const LAYER_WEIGHT = { long_term: 1.0, working: 0.8, short_term: 0.6 } as const;

/** Sleep thresholds (sleep-cycle.md). */
const ARCHIVE_MIN_AGE_DAYS = 30;
const ARCHIVE_MAX_ACCESS = 2;
const ARCHIVE_PROTECT_CONFIDENCE = 0.9;
const CONSOLIDATE_IDLE_DAYS = 7;
const SYNTHESIZE_SIMILARITY = 0.82;

/** Conflict gate (conflict-resolution.md). */
const AUTO_RESOLVE_MIN_CONFIDENCE = 0.7;

/** Dreaming defaults (dreaming.md). */
const CLUSTER_MIN_SIZE = 2;
const RELATEDNESS_THRESHOLD = 0.35;
const MAX_PROPOSALS_PER_TYPE = 8;

const ENTITY_CAP = 10;
const RELATED_CAP = 5;

const OPPOSING_PAIRS: [string, string][] = [
  ['always', 'never'],
  ['enable', 'disable'],
  ['before', 'after'],
];

export interface HMEMOptions {
  clock?: () => number;
  /** When set, memory persists here across sessions. */
  dir?: string;
}

export class HMEM {
  private readonly clock: () => number;
  private readonly dir: string | undefined;

  private readonly memories = new Map<string, Memory>();
  private readonly entries: LedgerEntry[] = [];
  private readonly openConflicts = new Map<string, Conflict>();
  private readonly proposals = new Map<string, DreamProposal>();
  private readonly backups = new Map<string, Memory[]>();

  constructor(options: HMEMOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.dir = options.dir;
    if (this.dir) this.load();
  }

  // --- public surface ------------------------------------------------------

  /**
   * Stores a memory. Rejects a record without a source, by construction.
   * Returns the live stored record, so callers that hold it see later updates.
   */
  add(input: MemoryInput): Memory {
    if (!input.source || String(input.source).trim() === '') {
      throw new Error('H-MEM: a memory record requires a source.');
    }
    if (!input.content || String(input.content).trim() === '') {
      throw new Error('H-MEM: a memory record requires content.');
    }

    const now = this.clock();
    const memory: Memory = {
      id: `mem_${randomUUID()}`,
      content: input.content,
      type: input.type ?? 'general',
      // Mined memory starts in `working` unless told otherwise.
      layer: input.layer ?? 'working',
      timestamp: now,
      lastAccessed: now,
      accessCount: 0,
      tags: [...(input.tags ?? [])],
      domain: input.domain,
      namespace: input.namespace,
      embedding: embed(input.content),
      // Extracted memory is initialised below 1.0; 1.0 is reserved for what
      // the system observed itself.
      confidence: input.confidence ?? 0.7,
      source: input.source,
      provenance: input.provenance ?? {
        origin: 'inference',
        learnedAt: now,
        label: `added from ${input.source}`,
      },
      chatId: input.chatId,
      missionId: input.missionId,
      goalRunId: input.goalRunId,
      entities: (input.entities ?? []).slice(0, ENTITY_CAP),
      relatedTo: (input.relatedTo ?? []).slice(0, RELATED_CAP),
      supersedes: input.supersedes,
      derivedFrom: [...(input.derivedFrom ?? [])],
    };

    this.memories.set(memory.id, memory);
    this.writeLedger('create', memory.id, undefined, this.snapshot(memory));
    this.persist();
    return memory;
  }

  /** Hybrid retrieval: the eight-signal blend, then the confidence multiplier. */
  query(queryText: string, options: QueryOptions = {}): RetrievalResult {
    const threshold = options.threshold ?? 0.35;
    const topN = options.topN ?? 5;
    const includeUnscoped = options.includeUnscoped ?? true;

    const queryEmbedding = embed(queryText);
    const queryTokens = tokenize(queryText).slice(0, 8);
    const suppressed: string[] = [];

    const hits: RetrievalHit[] = [];
    for (const memory of this.memories.values()) {
      if (!this.inScope(memory, options, includeUnscoped)) continue;

      const signals = {
        semantic: cosine(queryEmbedding, memory.embedding),
        keyword: jaccard(queryTokens, tokenize(memory.content)),
        tag: jaccard(memory.tags, queryTokens),
        domain:
          options.strategy === undefined &&
          memory.domain !== undefined &&
          memory.domain === this.inferDomain(queryText)
            ? 1
            : 0,
        entity: jaccard(
          memory.entities.map((entity) => entity.name.toLowerCase()),
          queryTokens,
        ),
        layer: LAYER_WEIGHT[memory.layer],
        recency: Math.exp(
          -(this.clock() - memory.lastAccessed) / (14 * DAY_MS),
        ),
        superseded: memory.supersededBy ? 1 : 0,
      };

      if (signals.superseded === 1) suppressed.push(memory.id);

      const raw =
        WEIGHTS.semantic * signals.semantic +
        WEIGHTS.keyword * signals.keyword +
        WEIGHTS.tag * signals.tag +
        WEIGHTS.domain * signals.domain +
        WEIGHTS.entity * signals.entity +
        WEIGHTS.layer * signals.layer +
        WEIGHTS.recency * signals.recency +
        WEIGHTS.superseded * signals.superseded;

      const score = clamp01(raw) * memory.confidence;
      if (score >= threshold) hits.push({ memory, score, signals });
    }

    hits.sort((a, b) => b.score - a.score);
    return {
      memories: hits.slice(0, topN),
      strategy: options.strategy ?? 'comprehensive',
      suppressed,
    };
  }

  /** Applies the spec's exact feedback deltas and writes a ledger entry. */
  feedback(id: string, kind: FeedbackKind): Memory {
    const memory = this.memories.get(id);
    if (!memory) throw new Error(`H-MEM: no memory ${id}`);

    const delta = FEEDBACK[kind];
    if (!delta) throw new Error(`H-MEM: unknown feedback kind ${kind}`);

    const previous = this.snapshot(memory);
    memory.confidence = clamp01(memory.confidence + delta.confidence);
    memory.accessCount += delta.access;
    memory.lastAccessed = this.clock();
    if (delta.tag && !memory.tags.includes(delta.tag)) {
      memory.tags.push(delta.tag);
    }

    this.writeLedger('feedback', id, previous, this.snapshot(memory), kind);
    this.persist();
    return memory;
  }

  // --- store service -------------------------------------------------------

  readonly store = {
    get: (id: string): Memory | undefined => this.memories.get(id),
    all: (): Memory[] => [...this.memories.values()],
    count: (): number => this.memories.size,
  };

  // --- trust ledger service ------------------------------------------------

  readonly ledger = {
    history: (id: string): LedgerEntry[] =>
      this.entries.filter((entry) => entry.memoryId === id),
    all: (): LedgerEntry[] => [...this.entries],
  };

  // --- sleep cycle service -------------------------------------------------

  readonly sleep = {
    /** Pure: computes the plan without touching the store. */
    preview: (): SleepPreview => {
      const now = this.clock();
      const all = this.store.all();
      const referenced = this.referencedIds();

      const toArchive: string[] = [];
      const toConsolidate: string[] = [];

      for (const memory of all) {
        const ageDays = (now - memory.timestamp) / DAY_MS;

        const archivable =
          ageDays >= ARCHIVE_MIN_AGE_DAYS &&
          memory.accessCount <= ARCHIVE_MAX_ACCESS &&
          !referenced.has(memory.id);

        if (archivable && !this.isGuardrailProtected(memory)) {
          toArchive.push(memory.id);
        }
      }

      // Archiving wins over consolidation when a record qualifies for both:
      // there is no point promoting a record we are about to archive.
      const archiving = new Set(toArchive);
      for (const memory of all) {
        if (archiving.has(memory.id)) continue;
        const idleDays = (now - memory.lastAccessed) / DAY_MS;
        if (
          memory.layer !== 'long_term' &&
          idleDays >= CONSOLIDATE_IDLE_DAYS &&
          memory.confidence >= 0.5
        ) {
          toConsolidate.push(memory.id);
        }
      }

      return {
        toConsolidate,
        toArchive,
        toSynthesize: this.synthesisClusters(),
      };
    },

    /** Executes exactly the plan it was given, nothing more. */
    execute: (preview: SleepPreview): SleepReport => {
      const backupId = `backup_${this.clock()}_${randomUUID().slice(0, 8)}`;
      this.backups.set(
        backupId,
        this.store.all().map((memory) => structuredClone(memory)),
      );

      const actionLog: string[] = [];

      for (const id of preview.toConsolidate) {
        const memory = this.memories.get(id);
        if (!memory) continue;
        const previous = this.snapshot(memory);
        memory.layer = 'long_term';
        this.writeLedger('promote', id, previous, this.snapshot(memory));
        actionLog.push(`promoted ${id}`);
      }

      for (const id of preview.toArchive) {
        const memory = this.memories.get(id);
        if (!memory) continue;
        // Re-check the guardrails at execution time: a record protected now
        // must survive even if the preview is stale or hand-edited.
        if (this.isGuardrailProtected(memory)) continue;
        this.writeLedger('archive', id, this.snapshot(memory), undefined);
        this.memories.delete(id);
        actionLog.push(`archived ${id}`);
      }

      let synthesizedCount = 0;
      for (const cluster of preview.toSynthesize) {
        const members = cluster
          .map((id) => this.memories.get(id))
          .filter((memory): memory is Memory => memory !== undefined);
        if (members.length < CLUSTER_MIN_SIZE) continue;
        const merged = this.add({
          content: members.map((memory) => memory.content).join(' | '),
          source: 'hmem:sleep:synthesis',
          type: members[0]!.type,
          layer: 'long_term',
          confidence: Math.max(...members.map((memory) => memory.confidence)),
          derivedFrom: members.map((memory) => memory.id),
          tags: [...new Set(members.flatMap((memory) => memory.tags))],
        });
        this.writeLedger('synthesize', merged.id, undefined, this.snapshot(merged));
        actionLog.push(`synthesized ${merged.id}`);
        synthesizedCount += 1;
      }

      this.persist();
      return {
        backupId,
        consolidatedCount: preview.toConsolidate.length,
        archivedCount: actionLog.filter((line) => line.startsWith('archived')).length,
        synthesizedCount,
        actionLog,
      };
    },

    restore: (backupId: string): number => {
      const snapshot = this.backups.get(backupId);
      if (!snapshot) throw new Error(`H-MEM: no backup ${backupId}`);
      this.memories.clear();
      for (const memory of snapshot) this.memories.set(memory.id, memory);
      this.writeLedger('restore', backupId, undefined, undefined, backupId);
      this.persist();
      return snapshot.length;
    },
  };

  // --- conflict detection service -----------------------------------------

  readonly conflicts = {
    scan: (): Conflict[] => {
      const all = this.store.all();
      const found: Conflict[] = [];

      for (let i = 0; i < all.length; i += 1) {
        for (let j = i + 1; j < all.length; j += 1) {
          const a = all[i]!;
          const b = all[j]!;

          // An explicit replacement is an intended correction, not a conflict.
          if (a.supersededBy === b.id || b.supersededBy === a.id) continue;
          if (a.supersedes === b.id || b.supersedes === a.id) continue;

          const opposition = this.opposingSignal(a.content, b.content);
          if (opposition === null) continue;

          const similarity = cosine(a.embedding, b.embedding);
          if (similarity < RELATEDNESS_THRESHOLD) continue;

          let confidence = 0.5 + 0.4 * similarity;
          if (a.domain && a.domain === b.domain) confidence += 0.05;
          const sharedEntities = jaccard(
            a.entities.map((entity) => entity.name.toLowerCase()),
            b.entities.map((entity) => entity.name.toLowerCase()),
          );
          confidence += 0.05 * sharedEntities;

          found.push({
            id: `conflict_${randomUUID().slice(0, 8)}`,
            memoryA: a.id,
            memoryB: b.id,
            reason: `opposing "${opposition[0]}"/"${opposition[1]}" on similar content`,
            confidence: clamp01(confidence),
            status: 'open',
          });
        }
      }

      for (const conflict of found) this.openConflicts.set(conflict.id, conflict);
      return found;
    },

    /**
     * Resolves only when the decision is confident enough; otherwise queues it
     * for a human. The loser is marked supersededBy and kept for audit.
     */
    autoResolve: (conflict: Conflict): 'resolved' | 'queued' => {
      const a = this.memories.get(conflict.memoryA);
      const b = this.memories.get(conflict.memoryB);
      if (!a || !b) return 'queued';

      const gap = Math.abs(a.confidence - b.confidence);
      const richness =
        Math.abs(a.content.length - b.content.length) /
        Math.max(a.content.length, b.content.length, 1);
      const decisionConfidence = clamp01(
        0.45 + 0.6 * gap + 0.1 * richness + 0.05 * conflict.confidence,
      );

      if (decisionConfidence < AUTO_RESOLVE_MIN_CONFIDENCE) {
        const queued = { ...conflict, status: 'queued' as const };
        this.openConflicts.set(conflict.id, queued);
        return 'queued';
      }

      const winner = a.confidence >= b.confidence ? a : b;
      const loser = winner === a ? b : a;

      const previous = this.snapshot(loser);
      loser.supersededBy = winner.id;
      winner.supersedes = loser.id;
      this.writeLedger(
        'resolve',
        loser.id,
        previous,
        this.snapshot(loser),
        `superseded by ${winner.id} (decision confidence ${decisionConfidence.toFixed(2)})`,
      );

      this.openConflicts.set(conflict.id, { ...conflict, status: 'resolved' });
      this.persist();
      return 'resolved';
    },

    open: (): Conflict[] =>
      [...this.openConflicts.values()].filter(
        (conflict) => conflict.status !== 'resolved',
      ),
  };

  // --- dreaming service ----------------------------------------------------

  readonly dreaming = {
    /**
     * Constructive synthesis. Returns proposals only: nothing becomes durable
     * memory until a human approves it.
     */
    dream: (): DreamProposal[] => {
      const all = this.store.all().filter((memory) => !memory.supersededBy);
      const proposals: DreamProposal[] = [];

      // Invariants from preference and personal signals, clustered by type.
      for (const type of ['preference', 'personal'] as const) {
        const members = all.filter((memory) => memory.type === type);
        if (members.length < CLUSTER_MIN_SIZE) continue;
        proposals.push({
          id: `dream_prop_${randomUUID().slice(0, 8)}`,
          type: 'invariant',
          content: `A stable ${type} pattern across ${members.length} memories: ${members
            .map((memory) => memory.content)
            .join('; ')}`,
          derivedFrom: members.map((memory) => memory.id),
          confidence: 0.72,
          status: 'pending_review',
        });
      }

      // Insights from clusters of similar content.
      for (const cluster of this.similarityClusters(all, RELATEDNESS_THRESHOLD)) {
        if (proposals.filter((p) => p.type === 'insight').length >= MAX_PROPOSALS_PER_TYPE) {
          break;
        }
        const members = cluster.map((id) => this.memories.get(id)!);
        proposals.push({
          id: `dream_prop_${randomUUID().slice(0, 8)}`,
          type: 'insight',
          content: `Across ${members.length} related memories: ${members
            .map((memory) => memory.content)
            .join('; ')}`,
          derivedFrom: cluster,
          confidence: 0.7,
          status: 'pending_review',
        });
      }

      for (const proposal of proposals) this.proposals.set(proposal.id, proposal);
      return proposals;
    },

    /** Approval is the only path from proposal to durable memory. */
    approve: (proposalId: string): Memory | null => {
      const proposal = this.proposals.get(proposalId);
      if (!proposal) throw new Error(`H-MEM: no proposal ${proposalId}`);
      if (proposal.status !== 'pending_review') return null;

      proposal.status = 'approved';

      if (proposal.type === 'domain') {
        // A domain proposal reclassifies its sources rather than creating.
        return null;
      }

      const created = this.add({
        content: proposal.content,
        source: `hmem:dreaming:${proposal.id}`,
        type: proposal.type === 'invariant' ? 'preference' : 'factual',
        layer: 'long_term',
        confidence: proposal.confidence,
        derivedFrom: proposal.derivedFrom,
        provenance: {
          origin: 'curiosity',
          learnedAt: this.clock(),
          label: `approved dream ${proposal.type} ${proposal.id}`,
        },
      });
      return created;
    },

    reject: (proposalId: string): void => {
      const proposal = this.proposals.get(proposalId);
      if (!proposal) throw new Error(`H-MEM: no proposal ${proposalId}`);
      proposal.status = 'rejected';
    },

    pending: (): DreamProposal[] =>
      [...this.proposals.values()].filter(
        (proposal) => proposal.status === 'pending_review',
      ),
  };

  // --- internals -----------------------------------------------------------

  private inScope(
    memory: Memory,
    options: QueryOptions,
    includeUnscoped: boolean,
  ): boolean {
    if (options.goalRunId !== undefined) {
      if (memory.goalRunId === undefined) return includeUnscoped;
      return memory.goalRunId === options.goalRunId;
    }
    if (options.chatId !== undefined) {
      if (memory.chatId === undefined) return includeUnscoped;
      return memory.chatId === options.chatId;
    }
    return true;
  }

  private inferDomain(queryText: string): string | undefined {
    const tokens = new Set(tokenize(queryText));
    for (const memory of this.memories.values()) {
      if (!memory.domain) continue;
      if (tokens.has(memory.domain.toLowerCase())) return memory.domain;
    }
    return undefined;
  }

  /** Ids that something else points at, so archiving cannot orphan a link. */
  private referencedIds(): Set<string> {
    const referenced = new Set<string>();
    for (const memory of this.memories.values()) {
      for (const id of memory.relatedTo) referenced.add(id);
      for (const id of memory.derivedFrom) referenced.add(id);
      if (memory.supersedes) referenced.add(memory.supersedes);
    }
    return referenced;
  }

  private isGuardrailProtected(memory: Memory): boolean {
    // Derived or synthesized memory is never archived.
    if (memory.derivedFrom.length > 0) return true;
    // A record that supersedes another is the current one.
    if (memory.supersedes) return true;
    // Relationship hubs.
    if (memory.relatedTo.length >= RELATED_CAP) return true;
    // Records with unresolved conflicts.
    for (const conflict of this.openConflicts.values()) {
      if (conflict.status === 'resolved') continue;
      if (conflict.memoryA === memory.id || conflict.memoryB === memory.id) {
        return true;
      }
    }
    // Records above the confidence threshold.
    if (memory.confidence >= ARCHIVE_PROTECT_CONFIDENCE) return true;
    return false;
  }

  private similarityClusters(pool: Memory[], threshold: number): string[][] {
    const clusters: string[][] = [];
    const seen = new Set<string>();
    for (let i = 0; i < pool.length; i += 1) {
      const anchor = pool[i]!;
      if (seen.has(anchor.id)) continue;
      const cluster = [anchor.id];
      for (let j = i + 1; j < pool.length; j += 1) {
        const other = pool[j]!;
        if (seen.has(other.id)) continue;
        if (cosine(anchor.embedding, other.embedding) >= threshold) {
          cluster.push(other.id);
          seen.add(other.id);
        }
      }
      if (cluster.length >= CLUSTER_MIN_SIZE) {
        for (const id of cluster) seen.add(id);
        clusters.push(cluster);
      }
    }
    return clusters;
  }

  private synthesisClusters(): string[][] {
    return this.similarityClusters(
      this.store.all().filter((memory) => memory.derivedFrom.length === 0),
      SYNTHESIZE_SIMILARITY,
    );
  }

  private opposingSignal(a: string, b: string): [string, string] | null {
    const tokensA = new Set(tokenize(a));
    const tokensB = new Set(tokenize(b));
    for (const [left, right] of OPPOSING_PAIRS) {
      if (tokensA.has(left) && tokensB.has(right)) return [left, right];
      if (tokensA.has(right) && tokensB.has(left)) return [right, left];
    }
    return null;
  }

  /** The fields the ledger records on each side of a change. */
  private snapshot(memory: Memory): Partial<Memory> {
    return {
      id: memory.id,
      content: memory.content,
      confidence: memory.confidence,
      layer: memory.layer,
      tags: [...memory.tags],
      accessCount: memory.accessCount,
      supersededBy: memory.supersededBy,
    };
  }

  /** No mutation happens without a ledger entry. */
  private writeLedger(
    action: LedgerAction,
    memoryId: string,
    previousState: Partial<Memory> | undefined,
    newState: Partial<Memory> | undefined,
    detail?: string,
  ): void {
    this.entries.push({
      id: `ledger_${randomUUID().slice(0, 8)}`,
      memoryId,
      action,
      at: this.clock(),
      previousState,
      newState,
      detail,
    });
  }

  // --- durability ----------------------------------------------------------

  private get file(): string {
    return join(this.dir!, 'hmem.json');
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as {
        memories?: Memory[];
        entries?: LedgerEntry[];
      };
      for (const memory of raw.memories ?? []) {
        // Re-embed on load so a change of embedder cannot silently rank stale
        // vectors against fresh ones.
        memory.embedding = embed(memory.content);
        this.memories.set(memory.id, memory);
      }
      this.entries.push(...(raw.entries ?? []));
    } catch (error) {
      throw new Error(
        `H-MEM: could not read ${this.file}: ${(error as Error).message}`,
      );
    }
  }

  private persist(): void {
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(
      this.file,
      JSON.stringify(
        {
          memories: this.store.all().map(({ embedding, score, ...rest }) => rest),
          entries: this.entries,
        },
        null,
        2,
      ),
      'utf8',
    );
  }
}

export type {
  Conflict,
  DreamProposal,
  FeedbackKind,
  LedgerEntry,
  Memory,
  MemoryInput,
  RetrievalResult,
  SleepPreview,
  SleepReport,
} from './types.ts';
