/**
 * Phase 9 disposable container resource-limit drill.
 *
 * Run from the repository root:
 *   node scripts/p9-container-drill.mjs
 *
 * Creates one disposable container named p9-oom-probe from the already-cached
 * node:22-alpine image, with a 48 MiB memory cap, no network, and a 64-PID cap.
 * It forces an in-container allocation loop, records the OOM kill, runs the
 * existing p7-check-containers.sh scoped to p9* only, then deletes that exact
 * container. No ultrasound-clinic-* resource is created, changed, or removed.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BASH_EXE = process.env.P9_BASH_EXE ?? 'C:/Program Files/Git/bin/bash.exe';
const CONTAINER = 'p9-oom-probe';
const IMAGE = 'node:22-alpine';
const TIMEOUT_MS = 30_000;
const OUT_PATH =
  process.env.P9_OUT ??
  'C:/Users/Moustafa/AppData/Local/Temp/opencode/p9/out/container.json';

const out = {
  tool: 'p9-container-drill',
  seed: 9112026,
  startedAt: new Date().toISOString(),
  container: CONTAINER,
  image: IMAGE,
  staticAudit: {},
  runtimeAudit: {},
  drill: {},
  p7Check: {},
};

let created = false;
let tempDir = '';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  return {
    command,
    args,
    status: result.status,
    error: result.error ? String(result.error) : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function dockerJson(format, name) {
  const result = run('docker', ['inspect', '-f', format, name]);
  return { ...result, value: result.status === 0 ? result.stdout.trim() : null };
}

function composeStaticAudit() {
  const text = readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
  const keys = [
    'deploy:',
    'resources:',
    'limits:',
    'reservations:',
    'mem_limit:',
    'cpus:',
    'nano_cpus:',
    'cpuset:',
    'pids_limit:',
    'ulimits:',
  ];
  const found = keys.filter((key) => text.split('\n').some((line) => line.trim().startsWith(key)));
  return {
    file: 'docker-compose.yml',
    resourceKeysFound: found,
    hasMemoryOrCpuLimits: found.length > 0,
  };
}

function inspectLimits(names) {
  const format =
    '{{.Name}}|memory={{.HostConfig.Memory}}|nanoCpus={{.HostConfig.NanoCpus}}|' +
    'cpuShares={{.HostConfig.CpuShares}}|cpuQuota={{.HostConfig.CpuQuota}}|' +
    'cpuPeriod={{.HostConfig.CpuPeriod}}|oomKilled={{.State.OOMKilled}}|' +
    'restarts={{.RestartCount}}|state={{.State.Status}}';
  return names.map((name) => dockerJson(format, name));
}

async function wait(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function bashPath(path) {
  const forward = path.replace(/\\/g, '/');
  const match = forward.match(/^([A-Za-z]):\/(.*)$/);
  return match ? `/${match[1].toLowerCase()}/${match[2]}` : forward;
}

function dockerExeForBash() {
  return bashPath(
    process.env.P9_DOCKER_EXE ?? 'C:/Program Files/Docker/Docker/resources/bin/docker.exe',
  );
}

async function main() {
  out.staticAudit = composeStaticAudit();
  out.runtimeAudit.production = inspectLimits([
    'ultrasound-clinic-db-1',
    'ultrasound-clinic-backend-1',
    'ultrasound-clinic-web-1',
    'ultrasound-clinic-evolution-1',
  ]);
  out.runtimeAudit.phase9 = inspectLimits(['p9-postgres']);

  const existing = run('docker', [
    'ps',
    '-a',
    '--filter',
    `name=${CONTAINER}`,
    '--format',
    '{{.Names}}',
  ]);
  assert.equal(
    existing.stdout.split(/\r?\n/).filter((name) => name.trim() === CONTAINER).length,
    0,
    `${CONTAINER} already exists; refusing to delete or replace it`,
  );

  const imageCheck = run('docker', ['image', 'inspect', IMAGE, '-f', '{{.Id}}']);
  assert.equal(imageCheck.status, 0, `${IMAGE} is not cached locally; refusing to pull`);
  out.drill.imageId = imageCheck.stdout.trim();

  process.stdout.write(`[p9-container] CREATE TARGET: container ${CONTAINER} (image ${IMAGE})\n`);
  const create = run('docker', [
    'run',
    '-d',
    '--name',
    CONTAINER,
    '--network',
    'none',
    '--memory=48m',
    '--memory-swap=48m',
    '--pids-limit=64',
    '--restart',
    'no',
    '--entrypoint',
    'node',
    IMAGE,
    '-e',
    "const a=[];setInterval(()=>a.push(Buffer.alloc(1048576,0x50)),1)",
  ]);
  assert.equal(create.status, 0, create.stderr || create.stdout);
  created = true;
  out.drill.create = { status: create.status, stdout: create.stdout.trim(), stderr: create.stderr.trim() };

  const limits = dockerJson(
    '{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.NanoCpus}}|' +
      '{{.HostConfig.CpuQuota}}|{{.HostConfig.CpuPeriod}}|{{.HostConfig.PidsLimit}}|' +
      '{{.HostConfig.NetworkMode}}',
    CONTAINER,
  );
  out.drill.limits = limits.value;

  const started = Date.now();
  let finalInspect;
  while (Date.now() - started < TIMEOUT_MS) {
    finalInspect = dockerJson(
      '{{.State.OOMKilled}}|{{.State.ExitCode}}|{{.State.Status}}|{{.RestartCount}}',
      CONTAINER,
    );
    const [oomKilled] = (finalInspect.value ?? '').split('|');
    if (oomKilled === 'true') break;
    await wait(200);
  }
  const elapsedMs = Date.now() - started;
  finalInspect ??= dockerJson(
    '{{.State.OOMKilled}}|{{.State.ExitCode}}|{{.State.Status}}|{{.RestartCount}}',
    CONTAINER,
  );
  const [oomKilled, exitCode, state, restarts] = (finalInspect.value ?? '').split('|');
  out.drill.result = {
    elapsedMs,
    oomKilled: oomKilled === 'true',
    exitCode: Number(exitCode),
    state,
    restarts: Number(restarts),
    raw: finalInspect.value,
  };
  assert.equal(out.drill.result.oomKilled, true, 'Expected the capped container to be OOM-killed');

  tempDir = mkdtempSync(join(tmpdir(), 'p9-container-'));
  const stateDir = join(tempDir, 'state');
  const alertSink = join(tempDir, 'alerts.jsonl');
  mkdirSync(stateDir, { recursive: true });
  // Windows bash launchers can drop vars passed through Node's spawn env, so
  // export them inside the bash command itself. A local wrapper avoids the
  // WSL docker shim and the space in Docker Desktop's install path.
  const binDir = join(tempDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const wrapper = join(binDir, 'docker');
  writeFileSync(wrapper, `#!/bin/sh\nexec '${dockerExeForBash()}' "$@"\n`, { mode: 0o755 });
  chmodSync(wrapper, 0o755);
  const p7Command = [
    `export PATH='${bashPath(binDir)}:/c/Program Files/Git/usr/bin:/c/Program Files/Git/bin:$PATH'`,
    'export P7_COMPOSE_PROJECT=p9',
    `export P7_STATE_DIR='${bashPath(stateDir)}'`,
    `export P7_ALERT_SINK='${bashPath(alertSink)}'`,
    'bash scripts/p7-check-containers.sh',
  ].join('\n');
  const check = run(BASH_EXE, ['-c', p7Command], {
    cwd: REPO_ROOT,
    timeout: 30_000,
  });
  out.p7Check = {
    invocation:
      "P7_COMPOSE_PROJECT=p9 P7_STATE_DIR=<temp>/state P7_ALERT_SINK=<temp>/alerts.jsonl " +
      'bash scripts/p7-check-containers.sh',
    status: check.status,
    stdout: check.stdout,
    stderr: check.stderr,
    alertSink:
      process.env.P9_KEEP_TEMP === '1' ? alertSink : '<removed after evidence capture>',
  };
  process.stdout.write(`[p9-container] p7 check stdout:\n${check.stdout}`);
  assert.equal(
    check.status,
    3,
    `Expected p7 container check to report critical on OOM kill; stdout=${check.stdout} stderr=${check.stderr}`,
  );

  out.finishedAt = new Date().toISOString();
  mkdirSync(resolve(OUT_PATH, '..'), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  process.stdout.write(
    `[p9-container] OOM oomKilled=${out.drill.result.oomKilled} exit=${out.drill.result.exitCode} ` +
      `elapsed=${elapsedMs}ms p7Exit=${check.status}\n`,
  );
  process.stdout.write(`[p9-container] WROTE ${OUT_PATH}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`[p9-container] FAILED: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (created) {
      process.stdout.write(`[p9-container] DELETE TARGET: container ${CONTAINER}\n`);
      const removed = run('docker', ['rm', '-f', CONTAINER]);
      process.stdout.write(
        `[p9-container] deleted container ${CONTAINER}: status=${removed.status}\n`,
      );
    }
    if (tempDir) {
      process.stdout.write(`[p9-container] DELETE TARGET: temp directory ${tempDir}\n`);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
