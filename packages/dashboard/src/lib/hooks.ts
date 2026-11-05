import { useEffect, useRef, useState } from 'react';

/**
 * Bounded, coalesced polling: fetches immediately, then every `intervalMs`,
 * and pauses while the tab is hidden. A new `fetcher` (via deps) resets the
 * loop. Errors are captured without tearing down the loop (so a transient
 * backend outage recovers once it is back).
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: unknown[],
): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      try {
        const result = await fetcherRef.current();
        if (!cancelled) {
          setData(result);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setLoading(false);
        }
      }
    };

    const schedule = () => {
      timer = setTimeout(() => {
        if (document.visibilityState !== 'hidden') {
          run().finally(schedule);
        } else {
          schedule();
        }
      }, intervalMs);
    };

    run().finally(schedule);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading };
}

/** A wall-clock ticker (ms) used for countdowns; updates every second. */
export function useClock(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
