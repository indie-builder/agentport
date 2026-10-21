import { z } from 'zod';
export const commonEnvSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
});
export function parseEnv(schema, env) {
    const parsed = schema.safeParse(env);
    if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
        throw new Error(`Invalid environment:\n${detail}`);
    }
    return parsed.data;
}
//# sourceMappingURL=config.js.map