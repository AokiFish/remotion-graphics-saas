"use client";

import { useEffect, useState } from "react";

export interface ModelOption {
  id: string;
  name: string;
  provider?: string;
}

interface ModelsPayload {
  default: string;
  models: ModelOption[];
}

interface UseModelsResult extends ModelsPayload {
  loading: boolean;
  error: boolean;
}

/**
 * Fetches the model list from `/api/models` (sourced from models.json).
 * Cached per-session via module scope so multiple components share one fetch.
 */
let cached: ModelsPayload | null = null;

export function useModels(): UseModelsResult {
  const [data, setData] = useState<ModelsPayload>(
    cached ?? { default: "", models: [] },
  );
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (cached) return;
    let active = true;
    fetch("/api/models")
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load models: ${res.status}`);
        return res.json();
      })
      .then((payload: ModelsPayload) => {
        if (!active) return;
        cached = payload;
        setData(payload);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return { ...data, loading, error };
}
