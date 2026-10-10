// Model list is no longer hardcoded here. It is loaded at runtime from
// `/api/models` (sourced from models.json). See src/hooks/useModels.ts.
export type ModelId = string;

export type StreamPhase = "idle" | "reasoning" | "generating";

export type GenerationErrorType = "validation" | "api";
