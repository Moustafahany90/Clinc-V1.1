import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import { errorMessage } from './api';

/**
 * State for one on-demand quick action. The fetcher receives an AbortSignal so
 * a superseded or unmounted request cannot overwrite newer results, and a
 * manual reload is ignored while a request is already in flight so a double
 * click never sends the same query twice.
 */

export type QuickActionStatus = 'idle' | 'loading' | 'success' | 'error';

export interface QuickActionState<T> {
  status: QuickActionStatus;
  data: T | null;
  error: string | null;
  isLoading: boolean;
  isIdle: boolean;
  isSuccess: boolean;
  isError: boolean;
  reload: () => void;
  reset: () => void;
}

interface InternalState<T> {
  status: QuickActionStatus;
  data: T | null;
  error: string | null;
}

const IDLE: InternalState<never> = { status: 'idle', data: null, error: null };

export interface QuickActionOptions {
  /** Run once on mount and again whenever `deps` change. Defaults to true. */
  auto?: boolean;
  /** Values that identify the current query (filters, dates). */
  deps?: DependencyList;
  /** Skip automatic loading until the query is complete (for example, a doctor is chosen). */
  enabled?: boolean;
}

export function useQuickAction<T>(
  load: (signal: AbortSignal) => Promise<T>,
  options: QuickActionOptions = {},
): QuickActionState<T> {
  const { auto = true, deps = [], enabled = true } = options;

  const [state, setState] = useState<InternalState<T>>(IDLE);

  const loadRef = useRef(load);
  loadRef.current = load;

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const controllerRef = useRef<AbortController | null>(null);

  const start = useCallback(() => {
    // A new query supersedes the old one; aborting also keeps stale responses
    // from a slower earlier request out of the UI.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setState({ status: 'loading', data: null, error: null });

    loadRef.current(controller.signal).then(
      (data) => {
        if (controller.signal.aborted || controllerRef.current !== controller) return;
        // Release the slot so a later manual reload is not treated as a duplicate.
        controllerRef.current = null;
        setState({ status: 'success', data, error: null });
      },
      (error: unknown) => {
        if (controller.signal.aborted || controllerRef.current !== controller) return;
        controllerRef.current = null;
        setState({ status: 'error', data: null, error: errorMessage(error) });
      },
    );
  }, []);

  const reload = useCallback(() => {
    if (!enabledRef.current) return;
    // Ignore a click while the same query is running (in-flight dedupe).
    if (controllerRef.current) return;
    start();
  }, [start]);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState(IDLE);
  }, []);

  useEffect(() => {
    if (!enabled) {
      controllerRef.current?.abort();
      controllerRef.current = null;
      setState(IDLE);
      return;
    }
    if (!auto) return;
    start();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
    // `start` is stable; `deps` intentionally drives re-fetching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, enabled, start, ...deps]);

  // Abort an in-flight request when the caller moves on or unmounts.
  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [],
  );

  return {
    ...state,
    isLoading: state.status === 'loading',
    isIdle: state.status === 'idle',
    isSuccess: state.status === 'success',
    isError: state.status === 'error',
    reload,
    reset,
  };
}
