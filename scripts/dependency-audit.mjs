#!/usr/bin/env node
/**
 * CI wrapper for the backend npm audit.
 *
 * The repository currently has a documented, owner-approved exception for the
 * Prisma 6.x advisory cluster. This script fails on any audit result that is
 * not exactly that known cluster, and emits a non-blocking warning for it so
 * the exception cannot become invisible.
 */

import { readFileSync } from 'node:fs';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('dependency-audit: expected a path to npm audit JSON');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
} catch (error) {
  console.error(`dependency-audit: cannot read audit report (${error.message})`);
  process.exit(2);
}

const expectedPackages = ['@prisma/config', 'deepmerge-ts', 'effect', 'prisma'];
const vulnerabilities = Object.entries(report.vulnerabilities ?? {});
const counts = report.metadata?.vulnerabilities ?? {};
const total =
  Number(counts.total ?? 0) ||
  Object.entries(counts)
    .filter(([severity]) => severity !== 'total')
    .reduce((sum, [, count]) => sum + Number(count || 0), 0);
const names = vulnerabilities.map(([name]) => name).sort();
const unexpected = names.filter((name) => !expectedPackages.includes(name));
const missing = expectedPackages.filter((name) => !names.includes(name));
const unexpectedSeverity = Object.entries(counts).some(
  ([severity, count]) => Number(count || 0) > 0 && !['high', 'total'].includes(severity),
);

if (total === 0) {
  console.log('dependency-audit: no vulnerabilities reported');
  process.exit(0);
}

const knownException =
  total === expectedPackages.length &&
  counts.high === expectedPackages.length &&
  unexpected.length === 0 &&
  missing.length === 0 &&
  !unexpectedSeverity;

if (knownException) {
  console.log(
    '::warning::Backend npm audit reports the documented Prisma 6.x advisory cluster (4 high). ' +
      'Remediation requires the Prisma 7 major upgrade tracked in docs/PRODUCTION_READINESS_PHASE8_1.md.',
  );
  console.log(
    `dependency-audit: ${total} known advisory assignment(s) accepted temporarily; no unexpected findings`,
  );
  process.exit(0);
}

console.error(
  '::error::Backend npm audit result changed. Review the dependency audit and update the documented exception before merging.',
);
console.error(
  `dependency-audit: total=${total} high=${counts.high ?? 0} unexpected=[${unexpected.join(', ')}] missing=[${missing.join(', ')}]`,
);
process.exit(1);
