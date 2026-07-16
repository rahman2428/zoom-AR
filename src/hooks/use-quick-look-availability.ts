"use client";

import { useEffect, useState } from "react";

const POSITIVE_CACHE_TTL_MS = 1000 * 60 * 60 * 24;
const NEGATIVE_CACHE_TTL_MS = 1000 * 45;

interface AvailabilityCacheEntry {
  available: boolean;
  checkedAt: number;
}

const availabilityCache = new Map<string, AvailabilityCacheEntry>();

function isAbortError(error: unknown): error is Error {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: string }).name === "AbortError"
  );
}

async function delay(ms: number, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      window.clearTimeout(timeoutId);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal.addEventListener("abort", onAbort);
  });
}

function readCachedAvailability(url: string) {
  const cached = availabilityCache.get(url);

  if (!cached) {
    return null;
  }

  const ageMs = Date.now() - cached.checkedAt;
  const ttlMs = cached.available ? POSITIVE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;

  if (ageMs > ttlMs) {
    availabilityCache.delete(url);
    return null;
  }

  return cached.available;
}

async function checkUsdzAvailability(url: string, signal: AbortSignal) {
  const requestInit: Omit<RequestInit, "method"> = {
    cache: "no-cache",
    credentials: "omit",
    signal
  };
  const retriableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let shouldRetry = false;

    try {
      const headResponse = await fetch(url, {
        ...requestInit,
        method: "HEAD"
      });

      if (headResponse.ok) {
        return true;
      }

      if (headResponse.status === 404 || headResponse.status === 410) {
        return false;
      }

      if (headResponse.status !== 405 && headResponse.status !== 501) {
        shouldRetry = retriableStatuses.has(headResponse.status);
        if (!shouldRetry) {
          return false;
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      shouldRetry = true;
    }

    try {
      const getResponse = await fetch(url, {
        ...requestInit,
        method: "GET",
        headers: {
          Range: "bytes=0-0"
        }
      });

      if (getResponse.ok) {
        return true;
      }

      if (getResponse.status === 404 || getResponse.status === 410) {
        return false;
      }

      shouldRetry = shouldRetry || retriableStatuses.has(getResponse.status);
      if (!shouldRetry) {
        return false;
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      shouldRetry = true;
    }

    if (!shouldRetry || attempt >= maxAttempts) {
      return false;
    }

    await delay(200 * attempt, signal);
  }

  return false;
}

export function useQuickLookAvailability(usdzUrl: string | null, enabled: boolean) {
  const [available, setAvailable] = useState(true);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!enabled || !usdzUrl) {
      setAvailable(false);
      setChecked(false);
      return;
    }

    const cachedAvailability = readCachedAvailability(usdzUrl);
    if (cachedAvailability !== null) {
      setAvailable(cachedAvailability);
      setChecked(true);
      return;
    }

    // Optimistically allow Quick Look while verification runs to avoid false fallback flicker.
    setAvailable(true);
    setChecked(false);

    const abortController = new AbortController();
    let cancelled = false;

    void checkUsdzAvailability(usdzUrl, abortController.signal)
      .then((result) => {
        availabilityCache.set(usdzUrl, {
          available: result,
          checkedAt: Date.now()
        });
        if (!cancelled) {
          setAvailable(result);
          setChecked(true);
        }
      })
      .catch((error) => {
        if (isAbortError(error)) {
          return;
        }

        availabilityCache.set(usdzUrl, {
          available: false,
          checkedAt: Date.now()
        });
        if (!cancelled) {
          setAvailable(false);
          setChecked(true);
        }
      });

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [enabled, usdzUrl]);

  return { available, checked };
}
