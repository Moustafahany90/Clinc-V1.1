import type { LogLevel } from './logger.js';

export interface ShutdownTimer {
  unref?: () => void;
}

export interface GracefulShutdownDeps {
  closeServer: () => void;
  closeBrowser: () => Promise<unknown>;
  disconnectDatabase: () => Promise<unknown>;
  log: (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;
  schedule: (callback: () => void, delayMs: number) => ShutdownTimer;
  cancel: (timer: ShutdownTimer) => void;
  forceExit: (code: number) => void;
  forceExitDelayMs?: number;
}

export interface ShutdownController {
  shutdown: (signal: string) => Promise<void>;
  isShuttingDown: () => boolean;
}

export const DEFAULT_FORCE_EXIT_DELAY_MS = 5_000;

/**
 * Build an idempotent SIGTERM/SIGINT handler.
 *
 * The forced-exit deadline is armed before any cleanup is awaited, so a hung
 * browser close or database disconnect can never delay the escape hatch. The
 * timer is unref'd, so a successful fast shutdown is not held open by it.
 *
 * Cleanup tasks run concurrently through `Promise.allSettled`: a failure in
 * one never prevents the other from being attempted. The timer is cancelled
 * only when every task succeeded. If any task failed, the (unref'd) deadline
 * remains armed so the process still has a bounded exit path.
 */
export function createShutdownController(deps: GracefulShutdownDeps): ShutdownController {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    deps.log('info', 'api.shutting_down', { message: 'shutting down', signal });
    deps.closeServer();

    const timer = deps.schedule(
      () => {
        deps.log('warn', 'api.shutdown_forced', {
          message: 'forced exit after shutdown deadline',
          signal,
        });
        deps.forceExit(0);
      },
      deps.forceExitDelayMs ?? DEFAULT_FORCE_EXIT_DELAY_MS,
    );
    timer.unref?.();

    const outcomes = await Promise.allSettled([
      Promise.resolve().then(deps.closeBrowser),
      Promise.resolve().then(deps.disconnectDatabase),
    ]);

    let cleanupFailed = false;
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') return;
      cleanupFailed = true;
      deps.log('warn', 'api.shutdown_cleanup_failed', {
        component: index === 0 ? 'browser' : 'database',
        error: (outcome.reason as Error)?.name ?? 'Error',
        signal,
      });
    });

    // Only a fully successful cleanup cancels the deadline. On failure the
    // unref'd timer stays armed as the bounded exit path, and is harmless if
    // the event loop drains on its own first.
    if (!cleanupFailed) deps.cancel(timer);
  };

  return { shutdown, isShuttingDown: () => shuttingDown };
}
