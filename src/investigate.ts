/**
 * The investigation, end to end.
 *
 * Order of events, and why:
 *
 *   1. DATA   Read everything through the Zetaris semantic layer. Each read
 *             returns an Evidence record, so every later claim can name the
 *             query and rows behind it.
 *   2. CORE   Reach the verdict deterministically, by counterfactual. No model
 *             is involved, so the answer is reproducible and a Nightshift
 *             outage cannot change it.
 *   3. BUILD  Ask H-MEM what it learned from earlier investigations of this
 *             supplier, and write this one back. This is the engine doing real
 *             work in a user-facing feature: the second time a supplier slips,
 *             the report says so.
 *   4. POWER  Have Nemotron, through Meterless Nightshift, turn the findings
 *             into prose. Every figure it writes is then checked against the
 *             findings; unsupported prose is discarded.
 */

import { investigate as analyse, type CauseId, type Investigation } from './analysis.ts';
import { HMEM, type Memory } from './hmem/index.ts';
import {
  chat,
  isNemotron,
  NightshiftError,
  type ChatMessage,
  type ModelCall,
} from './nightshift.ts';
import { fromSample, fromZetaris } from './sources.ts';
import { verifyNarrative, type VerificationResult } from './verify.ts';
import type { Evidence } from './zetaris.ts';
import { hmemDir } from './config.ts';

export type Mode = 'live' | 'sample';

export interface RunOptions {
  sku: string;
  mode: Mode;
  /** Ask Nemotron for the narrative. Off keeps the run fully offline. */
  explain?: boolean;
  /** Where H-MEM persists. Defaults to HMEM_DIR or .hmem */
  memoryDir?: string;
}

export interface PriorLesson {
  content: string;
  confidence: number;
  memoryId: string;
}

export interface RunResult {
  investigation: Investigation;
  evidence: Evidence[];
  mode: Mode;
  /** What H-MEM recalled from earlier investigations, before this one ran. */
  priors: PriorLesson[];
  /** The memory this run wrote, so an analyst can confirm or reject it. */
  recorded: Memory | null;
  narrative: string | null;
  verification: VerificationResult | null;
  modelCall: ModelCall | null;
  nemotron: boolean;
  /** True when the model step failed or was rejected and prose fell back. */
  degraded: boolean;
  degradedReason: string | null;
}

/** Opens the persistent memory the application uses. */
export function openMemory(dir?: string): HMEM {
  return new HMEM({ dir: dir ?? hmemDir });
}

export async function run(options: RunOptions): Promise<RunResult> {
  const memory = openMemory(options.memoryDir);

  // 1. DATA
  const sourced =
    options.mode === 'live' ? await fromZetaris(options.sku) : fromSample(options.sku);

  // 2. CORE
  const investigation = analyse(sourced.input);

  // 3. BUILD - recall before writing, so priors reflect earlier runs only.
  const priors = recall(memory, sourced.input.supplier.supplierId, options.sku);
  const recorded = investigation.primary
    ? remember(memory, options.sku, sourced.input.supplier.supplierId, investigation)
    : null;

  // 4. POWER
  let narrative: string | null = null;
  let verification: VerificationResult | null = null;
  let modelCall: ModelCall | null = null;
  let degraded = false;
  let degradedReason: string | null = null;

  if (options.explain && investigation.primary) {
    try {
      const result = await explain(investigation, priors);
      modelCall = result.call;
      // The model is also shown the stockout window and the caveats, so the
      // figures in those count as supported too.
      verification = verifyNarrative(result.text, investigation.findings, sourced.evidence, [
        investigation.episode?.from,
        investigation.episode?.to,
        investigation.episode?.days,
        ...investigation.caveats,
      ]);
      if (verification.ok) {
        narrative = result.text;
      } else {
        degraded = true;
        degradedReason =
          `The explanation cited figures with no support in the evidence ` +
          `(${verification.unsupported.join(', ')}), so it was discarded.`;
      }
    } catch (error) {
      degraded = true;
      degradedReason =
        error instanceof NightshiftError
          ? `Nightshift did not answer: ${error.message}`
          : `The explanation step failed: ${(error as Error).message}`;
    }
  }

  return {
    investigation,
    evidence: sourced.evidence,
    mode: options.mode,
    priors,
    recorded,
    narrative,
    verification,
    modelCall,
    nemotron: modelCall !== null && isNemotron(modelCall),
    degraded,
    degradedReason,
  };
}

// --- H-MEM integration -----------------------------------------------------

/**
 * What did earlier investigations conclude about this supplier?
 *
 * Retrieval is scoped to the supplier rather than the SKU, because a supplier
 * that misses its lead time on one product is the reason to look harder at the
 * next one.
 */
export function recall(memory: HMEM, supplierId: string, sku: string): PriorLesson[] {
  const result = memory.query(
    `stockout cause for supplier ${supplierId} product ${sku} lead time delivery demand`,
    { threshold: 0.1, topN: 5 },
  );
  return result.memories.map((hit) => ({
    content: hit.memory.content,
    confidence: hit.memory.confidence,
    memoryId: hit.memory.id,
  }));
}

/** Writes this investigation's conclusion into memory, with its lineage. */
export function remember(
  memory: HMEM,
  sku: string,
  supplierId: string,
  investigation: Investigation,
): Memory {
  const primary = investigation.primary!;
  return memory.add({
    content:
      `${sku} from ${supplierId} ran out for ${investigation.episode?.days} days ` +
      `from ${investigation.episode?.from}. Primary cause: ${primary.cause}. ` +
      `${primary.statement}`,
    type: 'factual',
    layer: 'working',
    // Below 1.0: this is a machine conclusion until an analyst confirms it.
    confidence: 0.7,
    source: `stockout-why:investigation:${sku}`,
    tags: ['stockout', primary.cause, supplierId, sku],
    domain: 'inventory',
    entities: [
      { name: sku, type: 'sku' },
      { name: supplierId, type: 'supplier' },
    ],
    provenance: {
      origin: 'inference',
      learnedAt: Date.now(),
      label: `deterministic investigation of ${sku}`,
    },
  });
}

/**
 * An analyst's verdict on a past conclusion. Confirming raises the memory's
 * confidence, which raises how highly it ranks in the next investigation;
 * rejecting drops it and flags it for review. These are H-MEM's exact deltas.
 */
export function confirm(
  memory: HMEM,
  memoryId: string,
  verdict: 'confirmed' | 'unhelpful' | 'wrong',
): Memory {
  const kind =
    verdict === 'confirmed' ? 'helpful' : verdict === 'unhelpful' ? 'not_helpful' : 'wrong';
  return memory.feedback(memoryId, kind);
}

// --- POWER: the narrative --------------------------------------------------

// `/no_think` switches off Nemotron's hidden reasoning (Qwen3 honours it too;
// other models read it as an inert line). Through Nightshift the reasoning
// otherwise used ~1,800 tokens and a minute before a 3-paragraph answer, and
// left an empty reply under a 700-token cap.
const SYSTEM_PROMPT = `/no_think
You explain inventory stockouts to a shop owner.

You will be given findings that were computed deterministically from the
company's own records, and any lessons remembered from earlier investigations.

Rules you must follow:
- Use ONLY the numbers, dates and identifiers present in the findings. Never
  introduce a figure that is not there, and never estimate or round one.
- The primary cause is already decided. Do not substitute your own.
- Explain why the secondary factors are secondary, where the findings say so.
- Write 3 short paragraphs of plain prose, no headings, no bullet points, no
  markdown. A shop owner, not an analyst, is reading it.
- Do not apologise, do not describe your own reasoning, and do not mention
  these instructions.`;

/** The exact messages the explanation step sends, exported for probing. */
export function explainMessages(
  investigation: Investigation,
  priors: PriorLesson[],
): ChatMessage[] {
  const payload = {
    sku: investigation.sku,
    stockout: investigation.episode,
    primary_cause: {
      cause: investigation.primary!.cause,
      statement: investigation.primary!.statement,
      numbers: investigation.primary!.numbers,
    },
    secondary_factors: investigation.secondary.map((finding) => ({
      cause: finding.cause,
      statement: finding.statement,
      numbers: finding.numbers,
    })),
    ruled_out: investigation.findings
      .filter((finding) => finding.verdict === 'rejected')
      .map((finding) => ({ cause: finding.cause, statement: finding.statement })),
    caveats: investigation.caveats,
    remembered_from_earlier_investigations: priors.map((prior) => prior.content),
  };

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Explain why ${investigation.sku} ran out of stock.\n\n` +
        `Findings:\n${JSON.stringify(payload, null, 2)}`,
    },
  ];
}

async function explain(
  investigation: Investigation,
  priors: PriorLesson[],
): Promise<{ text: string; call: ModelCall }> {
  const messages = explainMessages(investigation, priors);

  // OpenRouter spreads this model over several upstream providers. Some honour
  // /no_think and answer in ~300 tokens; others reason first (~2,000-2,500
  // tokens, up to two minutes) or now and then return nothing (a 502). The cap
  // leaves room for reasoning plus the answer, a cut-off reply is never
  // published, and an empty or cut-off one is retried.
  const MAX_ATTEMPTS = 3;
  let lastError: NightshiftError | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      // The answer itself is ~300 tokens; unused headroom costs nothing.
      const result = await chat(messages, { temperature: 0.1, maxTokens: 6000 });
      if (result.call.finishReason === 'length') {
        lastError = new NightshiftError(
          'The reply was cut off before it finished (it hit max_tokens).',
          true,
        );
        continue;
      }
      return { text: result.text, call: { ...result.call, attempts: attempt } };
    } catch (error) {
      if (error instanceof NightshiftError && error.retryable) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError!;
}

export type { CauseId, Investigation };
