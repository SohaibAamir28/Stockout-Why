/**
 * POWER layer. Meterless Nightshift is our primary AI provider; Nightshift
 * holds the NVIDIA credential and serves the request from a Nemotron lane.
 *
 * Every call records which model actually answered, because "meterless/auto"
 * is a routing mode and may land on a non-NVIDIA model when several are
 * eligible. We log what we got rather than claiming what we hoped for.
 */

import { meterless as cfg } from './config.ts';

export interface ModelCall {
  requestedModel: string;
  /** The model Nightshift actually used, from the response body. */
  routedModel: string | null;
  receiptId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  calledAt: string;
  /** Why the model stopped: "stop" is a finished answer, "length" a cut-off one. */
  finishReason?: string | null;
  /** How many requests it took, when a caller retried an empty or cut-off reply. */
  attempts?: number;
}

export interface ChatResult {
  text: string;
  call: ModelCall;
}

export class NightshiftError extends Error {
  /** True for failures a second attempt can fix: an empty reply or a lane hiccup. */
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}

/** Calls are slow: a cold local model load can take minutes. */
const TIMEOUT_MS = 180_000;

function headers(scope: 'user' | 'system' = 'user'): Record<string, string> {
  return {
    Authorization: `Bearer ${cfg.token}`,
    'Content-Type': 'application/json',
    'meterless-app': cfg.app,
    'meterless-scope': scope,
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function chat(
  messages: ChatMessage[],
  options: { model?: string; temperature?: number; maxTokens?: number } = {},
): Promise<ChatResult> {
  const requestedModel = options.model ?? cfg.model;
  const startedAt = Date.now();

  const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers('user'),
    body: JSON.stringify({
      model: requestedModel,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 1200,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new NightshiftError(
      `Nightshift returned ${response.status}. ${explain(response.status)} ${body.slice(0, 200)}`,
      response.status === 502 || response.status === 503,
    );
  }

  const payload = (await response.json()) as {
    model?: string;
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    id?: string;
    meterless?: { receipt_id?: string; routed_model?: string };
  };

  const text = payload.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new NightshiftError('Nightshift replied without any content.', true);
  }

  return {
    text: text.trim(),
    call: {
      requestedModel,
      routedModel: payload.meterless?.routed_model ?? payload.model ?? null,
      receiptId: payload.meterless?.receipt_id ?? payload.id ?? null,
      promptTokens: payload.usage?.prompt_tokens ?? null,
      completionTokens: payload.usage?.completion_tokens ?? null,
      latencyMs: Date.now() - startedAt,
      calledAt: new Date(startedAt).toISOString(),
      finishReason: payload.choices?.[0]?.finish_reason ?? null,
    },
  };
}

function explain(status: number): string {
  if (status === 401)
    return 'The Runtime token was rejected. Copy it again from Nightshift > Console.';
  if (status === 404)
    return 'That model id is not exposed. Check GET /v1/models for available routes.';
  if (status === 502 || status === 503)
    return (
      'The upstream lane failed or replied empty. Check the lane is assigned in ' +
      'Nightshift > NIGHT > LANES; an "empty_response" usually means a thinking ' +
      'model spent max_tokens before answering.'
    );
  return '';
}

/** Model discovery. A /healthz response only proves the process is up. */
export async function listModels(): Promise<string[]> {
  const response = await fetch(`${cfg.baseUrl}/models`, {
    headers: headers('user'),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new NightshiftError(
      `Model discovery failed with ${response.status}. ${explain(response.status)}`,
    );
  }
  const payload = (await response.json()) as { data?: { id?: string }[] };
  return (payload.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string');
}

/** True when the routed model is an NVIDIA Nemotron, for award evidence. */
export function isNemotron(call: ModelCall): boolean {
  const model = call.routedModel?.toLowerCase() ?? '';
  return model.includes('nemotron');
}
