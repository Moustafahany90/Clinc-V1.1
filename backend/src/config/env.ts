import 'dotenv/config';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000, 1, 65535),
  APP_NAME: z.string().default('Ultrasound Clinic'),
  APP_TIMEZONE: z.string().default('Africa/Cairo'),
  APP_CURRENCY: z.string().default('EGP'),
  APP_ORIGIN: z.string().default('http://localhost:8080'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: int(30, 1, 365),
  COOKIE_SECURE: bool(false),
  COOKIE_DOMAIN: z.string().optional().default(''),

  TRUST_PROXY: int(1, 0, 10),
  BODY_LIMIT: z.string().default('2mb'),
  UPLOAD_DIR: z.string().default('./storage/uploads'),
  MAX_UPLOAD_MB: int(25, 1, 200),

  EVOLUTION_API_ENABLED: bool(false),
  EVOLUTION_API_URL: z.string().default(''),
  EVOLUTION_API_KEY: z.string().optional().default(''),
  EVOLUTION_INSTANCE_NAME: z.string().default('ultrasound_clinic'),
  EVOLUTION_API_TIMEOUT_MS: int(30_000, 2_000, 120_000),
  EVOLUTION_DEFAULT_COUNTRY_CODE: z
    .string()
    .regex(/^\d{1,4}$/, 'Must be a country calling code without +.')
    .default('20'),
});

const refined = schema.superRefine((raw, ctx) => {
  let origins: string[] = [];
  try {
    origins = raw.APP_ORIGIN.split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => new URL(value).origin);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['APP_ORIGIN'],
      message: 'Must be a comma-separated list of absolute URLs.',
    });
  }

  if (raw.EVOLUTION_API_ENABLED) {
    if (!raw.EVOLUTION_API_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EVOLUTION_API_URL'],
        message: 'Evolution API is enabled but EVOLUTION_API_URL is missing.',
      });
    }
    if (!raw.EVOLUTION_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EVOLUTION_API_KEY'],
        message: 'Evolution API is enabled but EVOLUTION_API_KEY is missing.',
      });
    }
    if (!raw.EVOLUTION_INSTANCE_NAME) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EVOLUTION_INSTANCE_NAME'],
        message: 'Evolution API is enabled but EVOLUTION_INSTANCE_NAME is missing.',
      });
    }
  }

  if (raw.NODE_ENV !== 'production') return;

  if (origins.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['APP_ORIGIN'],
      message: 'At least one public origin is required in production.',
    });
  }
  if (!raw.COOKIE_SECURE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['COOKIE_SECURE'],
      message: 'Must be true in production so refresh cookies are HTTPS-only.',
    });
  }
  if (raw.TRUST_PROXY < 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TRUST_PROXY'],
      message: 'Must be at least 1 in production (TLS terminates at the reverse proxy).',
    });
  }
  for (const origin of origins) {
    if (!origin.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_ORIGIN'],
        message: 'Every production origin must use https://.',
      });
    }
  }
  if (raw.JWT_ACCESS_SECRET === raw.JWT_REFRESH_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_REFRESH_SECRET'],
      message: 'Access and refresh secrets must be different.',
    });
  }
  const placeholder = /(change[-_ ]?me|replace[-_ ]?me|example|development|test-only|insecure)/i;
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
    if (placeholder.test(raw[key])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: 'Replace the placeholder value with a random secret before production.',
      });
    }
  }
  if (raw.EVOLUTION_API_ENABLED && raw.EVOLUTION_API_KEY && placeholder.test(raw.EVOLUTION_API_KEY)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EVOLUTION_API_KEY'],
      message: 'Replace the placeholder Evolution API key before production.',
    });
  }
});

const parsed = refined.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  refreshTokenTtlMs: raw.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  maxUploadBytes: raw.MAX_UPLOAD_MB * 1024 * 1024,
  corsOrigins: raw.APP_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => new URL(o).origin),
};

export type Env = typeof env;
