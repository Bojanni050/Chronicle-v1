/**
 * Hindsight API Service — connects Chronicle to Hindsight memory backend.
 *
 * Hindsight is an agent memory system with:
 * - Multi-strategy retrieval (semantic, keyword, graph, temporal)
 * - Entity graph tracking
 * - Reflection/reasoning capabilities
 * - Three memory types: world (facts), experience (events), opinion (inferences)
 *
 * API docs: https://hindsight.vectorize.io/api-reference
 * Default endpoint: http://localhost:8888
 */

const DEFAULT_HINDSIGHT_URL = 'http://localhost:8888';
const DEFAULT_BANK_ID = 'chronicle';

export interface HindsightConfig {
  apiUrl: string;
  bankId: string;
  apiKey?: string;
  enabled: boolean;
}

export interface HindsightRecallResult {
  content: string;
  score: number;
  timestamp?: string;
  context?: string;
  metadata?: Record<string, string>;
  tags?: string[];
  document_id?: string;
}

export interface HindsightRecallResponse {
  results: HindsightRecallResult[];
  total_count: number;
}

export interface HindsightRetainOptions {
  content: string;
  timestamp?: string;
  context?: string;
  document_id?: string;
  tags?: string[];
  metadata?: Record<string, string>;
  entities?: { text: string; type: string }[];
}

export interface HindsightReflectResponse {
  answer: string;
  thinking?: string;
  structured_output?: Record<string, unknown>;
}

function getDefaultConfig(): HindsightConfig {
  return {
    apiUrl: localStorage.getItem('hindsight_api_url') || DEFAULT_HINDSIGHT_URL,
    bankId: localStorage.getItem('hindsight_bank_id') || DEFAULT_BANK_ID,
    apiKey: localStorage.getItem('hindsight_api_key') || undefined,
    enabled: localStorage.getItem('hindsight_enabled') === 'true',
  };
}

function saveConfig(config: HindsightConfig): void {
  localStorage.setItem('hindsight_api_url', config.apiUrl);
  localStorage.setItem('hindsight_bank_id', config.bankId);
  if (config.apiKey) {
    localStorage.setItem('hindsight_api_key', config.apiKey);
  } else {
    localStorage.removeItem('hindsight_api_key');
  }
  localStorage.setItem('hindsight_enabled', config.enabled ? 'true' : 'false');
}

function getHeaders(config: HindsightConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }
  return headers;
}

/**
 * Build a base URL from config, stripping trailing slashes.
 */
function baseUrl(config: HindsightConfig): string {
  return config.apiUrl.replace(/\/+$/, '');
}

/**
 * Check if the Hindsight server is reachable.
 */
export async function checkHealth(config?: HindsightConfig): Promise<boolean> {
  const cfg = config || getDefaultConfig();
  if (!cfg.enabled) return false;

  try {
    const resp = await fetch(`${baseUrl(cfg)}/v1/default/banks`, {
      method: 'GET',
      headers: getHeaders(cfg),
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure a memory bank exists. Creates one if it doesn't.
 */
export async function ensureBank(config?: HindsightConfig): Promise<boolean> {
  const cfg = config || getDefaultConfig();
  if (!cfg.enabled) return false;

  try {
    // Try creating the bank (idempotent if it exists)
    const resp = await fetch(`${baseUrl(cfg)}/v1/default/banks/${cfg.bankId}`, {
      method: 'POST',
      headers: getHeaders(cfg),
      body: JSON.stringify({
        bank_id: cfg.bankId,
        name: 'Chronicle Archive',
        mission: 'Personal AI memory archive — stores conversations, notes, and extracted knowledge.',
      }),
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Store a memory entry in Hindsight (retain).
 *
 * Called automatically when a new chat/note is created or updated.
 */
export async function retainMemory(
  options: HindsightRetainOptions,
  config?: HindsightConfig,
): Promise<boolean> {
  const cfg = config || getDefaultConfig();
  if (!cfg.enabled) return false;

  try {
    const body = {
      items: [
        {
          content: options.content,
          timestamp: options.timestamp || new Date().toISOString(),
          context: options.context,
          document_id: options.document_id,
          tags: options.tags,
          metadata: options.metadata,
          entities: options.entities,
        },
      ],
      var_async: false,
    };

    const resp = await fetch(
      `${baseUrl(cfg)}/v1/default/banks/${cfg.bankId}/memories`,
      {
        method: 'POST',
        headers: getHeaders(cfg),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      },
    );

    if (!resp.ok) {
      const errText = await resp.text().catch(() => 'unknown error');
      console.warn('[Hindsight] Retain failed:', resp.status, errText);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[Hindsight] Retain error:', error);
    return false;
  }
}

/**
 * Search memory in Hindsight (recall).
 *
 * Called when the user searches their archive.
 */
export async function recallMemories(
  query: string,
  options?: {
    types?: string[];
    maxTokens?: number;
    budget?: 'low' | 'mid' | 'high';
    tags?: string[];
    config?: HindsightConfig;
  },
): Promise<HindsightRecallResponse> {
  const cfg = options?.config || getDefaultConfig();
  if (!cfg.enabled) {
    return { results: [], total_count: 0 };
  }

  try {
    const body: Record<string, unknown> = {
      query,
      max_tokens: options?.maxTokens || 4096,
      budget: options?.budget || 'mid',
    };

    if (options?.types && options.types.length > 0) {
      body.types = options.types;
    }
    if (options?.tags && options.tags.length > 0) {
      body.tags = options.tags;
    }

    const resp = await fetch(
      `${baseUrl(cfg)}/v1/default/banks/${cfg.bankId}/memories/recall`,
      {
        method: 'POST',
        headers: getHeaders(cfg),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!resp.ok) {
      console.warn('[Hindsight] Recall failed:', resp.status);
      return { results: [], total_count: 0 };
    }

    const data = await resp.json();
    return {
      results: (data.results || []).map((r: Record<string, unknown>) => ({
        content: String(r.content || ''),
        score: Number(r.score || 0),
        timestamp: r.timestamp as string | undefined,
        context: r.context as string | undefined,
        metadata: r.metadata as Record<string, string> | undefined,
        tags: r.tags as string[] | undefined,
        document_id: r.document_id as string | undefined,
      })),
      total_count: data.total_count || 0,
    };
  } catch (error) {
    console.warn('[Hindsight] Recall error:', error);
    return { results: [], total_count: 0 };
  }
}

/**
 * Ask Hindsight to reflect/generate insights based on stored memories.
 */
export async function reflect(
  query: string,
  options?: {
    context?: string;
    budget?: 'low' | 'mid' | 'high';
    responseSchema?: Record<string, unknown>;
    tags?: string[];
    config?: HindsightConfig;
  },
): Promise<HindsightReflectResponse | null> {
  const cfg = options?.config || getDefaultConfig();
  if (!cfg.enabled) return null;

  try {
    const body: Record<string, unknown> = {
      query,
      budget: options?.budget || 'low',
    };

    if (options?.context) body.context = options.context;
    if (options?.responseSchema) body.response_schema = options.responseSchema;
    if (options?.tags && options.tags.length > 0) body.tags = options.tags;

    const resp = await fetch(
      `${baseUrl(cfg)}/v1/default/banks/${cfg.bankId}/reflect`,
      {
        method: 'POST',
        headers: getHeaders(cfg),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      },
    );

    if (!resp.ok) {
      console.warn('[Hindsight] Reflect failed:', resp.status);
      return null;
    }

    return await resp.json();
  } catch (error) {
    console.warn('[Hindsight] Reflect error:', error);
    return null;
  }
}

/**
 * Get entity graph data from Hindsight for the mind-map view.
 */
export async function getEntityGraph(
  config?: HindsightConfig,
): Promise<{ nodes: unknown[]; edges: unknown[] }> {
  const cfg = config || getDefaultConfig();
  if (!cfg.enabled) return { nodes: [], edges: [] };

  try {
    const resp = await fetch(
      `${baseUrl(cfg)}/v1/default/banks/${cfg.bankId}/graph`,
      {
        method: 'GET',
        headers: getHeaders(cfg),
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!resp.ok) return { nodes: [], edges: [] };
    return await resp.json();
  } catch {
    return { nodes: [], edges: [] };
  }
}

/**
 * Get the current Hindsight configuration (from localStorage).
 */
export function getConfig(): HindsightConfig {
  return getDefaultConfig();
}

/**
 * Update and persist the Hindsight configuration.
 */
export function updateConfig(updates: Partial<HindsightConfig>): HindsightConfig {
  const current = getDefaultConfig();
  const merged = { ...current, ...updates };
  saveConfig(merged);
  return merged;
}

/**
 * Store all entries in Hindsight (bulk sync).
 * Useful for initial migration or re-indexing.
 */
export async function bulkRetain(
  entries: { content: string; document_id: string; tags?: string[]; title?: string }[],
  config?: HindsightConfig,
): Promise<{ success: number; failed: number }> {
  const cfg = config || getDefaultConfig();
  if (!cfg.enabled) return { success: 0, failed: 0 };

  let success = 0;
  let failed = 0;

  for (const entry of entries) {
    const ok = await retainMemory(
      {
        content: entry.content,
        document_id: entry.document_id,
        tags: entry.tags,
        context: entry.title,
      },
      cfg,
    );
    if (ok) success++;
    else failed++;
  }

  return { success, failed };
}
