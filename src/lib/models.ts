import { createOpenAI } from "@ai-sdk/openai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModel } from "ai";

export interface ProviderConfig {
  /** Display name shown in the UI. */
  label: string;
  /** Protocol adapter. Currently "openai" covers OpenAI and any OpenAI-compatible endpoint. */
  type: "openai";
  /** Base URL of the provider's chat completions API. */
  baseURL: string;
  /** Name of the environment variable that holds the API key (configured in .env). */
  apiKeyEnv: string;
}

export interface ModelConfig {
  /** Exact model id sent to the provider's API. Must be unique across the list. */
  id: string;
  /** Key into the `providers` map. */
  provider: string;
  /** Human-readable name for the UI. */
  label: string;
  /** Optional reasoning effort levels (OpenAI-style). Each becomes a separate selectable option. */
  reasoningEfforts?: string[];
}

export interface ModelsConfig {
  /** Default selection sent to the UI as `id` or `id:effort`. */
  defaultModel: string;
  /** Model id used for cheap auxiliary calls (validation, skill detection). */
  auxModel?: string;
  providers: Record<string, ProviderConfig>;
  models: ModelConfig[];
}

// Loaded once per server process. Server-only module.
const config: ModelsConfig = JSON.parse(
  readFileSync(join(process.cwd(), "models.json"), "utf-8"),
) as ModelsConfig;

export const defaultModel = config.defaultModel;

export class ModelNotFoundError extends Error {}
export class ApiKeyMissingError extends Error {
  constructor(
    public readonly envVar: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ResolvedModel {
  /** Ready-to-use model instance for the Vercel AI SDK. */
  model: LanguageModel;
  /** The base model id (without `:effort`). */
  baseId: string;
  /** Reasoning effort suffix, if present. */
  reasoningEffort?: string;
  /** Whether this model declares reasoning efforts (OpenAI provider options apply). */
  supportsReasoning: boolean;
}

function resolveConfigEntry(modelIdWithEffort: string): {
  entry: ModelConfig;
  provider: ProviderConfig;
  reasoningEffort?: string;
} {
  const [baseId, reasoningEffort] = modelIdWithEffort.split(":");
  const entry = config.models.find((m) => m.id === baseId);
  if (!entry) {
    throw new ModelNotFoundError(
      `Unknown model "${modelIdWithEffort}". It is not defined in models.json.`,
    );
  }
  const provider = config.providers[entry.provider];
  if (!provider) {
    throw new ModelNotFoundError(
      `Model "${entry.id}" references unknown provider "${entry.provider}".`,
    );
  }
  return { entry, provider, reasoningEffort };
}

function buildClient(provider: ProviderConfig) {
  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    throw new ApiKeyMissingError(
      provider.apiKeyEnv,
      `The environment variable "${provider.apiKeyEnv}" is not set. Add it to your .env file and try again.`,
    );
  }
  return createOpenAI({ baseURL: provider.baseURL, apiKey });
}

/** Resolve a model id (with optional `:effort`) into a usable AI SDK model instance. */
export function resolveModel(modelIdWithEffort: string): ResolvedModel {
  const { entry, provider, reasoningEffort } = resolveConfigEntry(
    modelIdWithEffort,
  );
  const client = buildClient(provider);
  const supportsReasoning = Boolean(
    entry.reasoningEfforts && entry.reasoningEfforts.length > 0,
  );
  return {
    model: client(entry.id),
    baseId: entry.id,
    reasoningEffort,
    supportsReasoning,
  };
}

/** Resolve the auxiliary model used for validation / skill detection. Returns null if unavailable. */
export function resolveAuxModel(): ResolvedModel | null {
  if (!config.auxModel) return null;
  try {
    return resolveModel(config.auxModel);
  } catch {
    return null;
  }
}

export interface ModelOption {
  id: string;
  name: string;
  provider?: string;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Flatten the model config into selectable options (expanding reasoning efforts). */
export function listModelOptions(): ModelOption[] {
  return config.models.flatMap((m) => {
    const providerLabel = config.providers[m.provider]?.label ?? m.provider;
    if (m.reasoningEfforts && m.reasoningEfforts.length > 0) {
      return m.reasoningEfforts.map((effort) => ({
        id: `${m.id}:${effort}`,
        name: `${m.label} (${capitalize(effort)})`,
        provider: providerLabel,
      }));
    }
    return [{ id: m.id, name: m.label, provider: providerLabel }];
  });
}
