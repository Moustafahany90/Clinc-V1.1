import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createShutdownController,
  type GracefulShutdownDeps,
} from '../src/lib/gracefulShutdown.js';

interface Harness {
  deps: GracefulShutdownDeps;
  events: string[];
  state: {
    timerCallback: (() => void) | null;
    delayMs: number | null;
    unrefCount: number;
    cancelCount: number;
    exitCodes: number[];
  };
}

function harness(overrides: Partial<GracefulShutdownDeps> = {}): Harness {
  const events: string[] = [];
  const state: Harness['state'] = {
    timerCallback: null,
    delayMs: null,
    unrefCount: 0,
    cancelCount: 0,
    exitCodes: [],
  };

  const deps: GracefulShutdownDeps = {
    closeServer: () => {
      events.push('server.close');
    },
    closeBrowser: () => {
      events.push('browser.start');
      return Promise.resolve();
    },
    disconnectDatabase: () => {
      events.push('database.start');
      return Promise.resolve();
    },
    log: (_level, event) => {
      events.push(`log.${event}`);
    },
    schedule: (callback, delayMs) => {
      events.push('timer.arm');
      state.timerCallback = callback;
      state.delayMs = delayMs;
      return {
        unref: () => {
          state.unrefCount += 1;
          events.push('timer.unref');
        },
      };
    },
    cancel: () => {
      state.cancelCount += 1;
      events.push('timer.cancel');
    },
    forceExit: (code) => {
      state.exitCodes.push(code);
      events.push(`exit.${code}`);
    },
  };

  Object.assign(deps, overrides);
  return { deps, events, state };
}

test('arms an unref deadline before cleanup and cancels it after success', async () => {
  const h = harness();
  const controller = createShutdownController(h.deps);

  await controller.shutdown('SIGTERM');

  assert.equal(h.state.delayMs, 5_000);
  assert.equal(h.state.unrefCount, 1);
  assert.equal(h.state.cancelCount, 1);
  assert.deepEqual(h.state.exitCodes, []);
  assert.equal(controller.isShuttingDown(), true);
  assert.deepEqual(h.events.slice(0, 4), [
    'log.api.shutting_down',
    'server.close',
    'timer.arm',
    'timer.unref',
  ]);
  assert.ok(h.events.includes('browser.start'));
  assert.ok(h.events.includes('database.start'));
  assert.ok(h.events.indexOf('timer.arm') < h.events.indexOf('browser.start'));
});

test('browser close failure still attempts database disconnect and keeps the deadline', async () => {
  const h = harness({
    closeBrowser: () => {
      h.events.push('browser.reject');
      return Promise.reject(new Error('synthetic browser failure'));
    },
  });
  const controller = createShutdownController(h.deps);

  await controller.shutdown('SIGTERM');

  assert.ok(h.events.includes('database.start'));
  assert.ok(h.events.includes('log.api.shutdown_cleanup_failed'));
  assert.equal(h.state.cancelCount, 0);
  assert.deepEqual(h.state.exitCodes, []);
});

test('database disconnect failure keeps the deadline and does not throw', async () => {
  const h = harness({
    disconnectDatabase: () => {
      h.events.push('database.reject');
      return Promise.reject(new Error('synthetic prisma failure'));
    },
  });
  const controller = createShutdownController(h.deps);

  await controller.shutdown('SIGINT');

  assert.ok(h.events.includes('browser.start'));
  assert.ok(h.events.includes('log.api.shutdown_cleanup_failed'));
  assert.equal(h.state.cancelCount, 0);
  assert.deepEqual(h.state.exitCodes, []);
});

test('a hanging browser close is bounded by the armed deadline', async () => {
  const h = harness({
    closeBrowser: () => {
      h.events.push('browser.hang');
      return new Promise<void>(() => undefined);
    },
  });
  const controller = createShutdownController(h.deps);

  const pending = controller.shutdown('SIGTERM');
  assert.equal(typeof h.state.timerCallback, 'function');
  h.state.timerCallback!();
  await Promise.resolve();

  assert.deepEqual(h.state.exitCodes, [0]);
  assert.ok(h.events.includes('log.api.shutdown_forced'));
  assert.equal(h.state.cancelCount, 0);
  // Avoid an unhandled pending promise; the real process exits in forceExit.
  await Promise.race([pending, Promise.resolve('not-settled')]);
});

test('SIGTERM and SIGINT arriving together run cleanup only once', async () => {
  const h = harness();
  const controller = createShutdownController(h.deps);

  await Promise.all([controller.shutdown('SIGTERM'), controller.shutdown('SIGINT')]);

  assert.equal(h.events.filter((event) => event === 'timer.arm').length, 1);
  assert.equal(h.events.filter((event) => event === 'browser.start').length, 1);
  assert.equal(h.events.filter((event) => event === 'database.start').length, 1);
  assert.equal(h.state.cancelCount, 1);
});
