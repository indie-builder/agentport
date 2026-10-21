import { z } from 'zod';
export declare const commonEnvSchema: z.ZodObject<{
    NODE_ENV: z.ZodDefault<z.ZodEnum<{
        development: "development";
        production: "production";
        test: "test";
    }>>;
    LOG_LEVEL: z.ZodDefault<z.ZodEnum<{
        debug: "debug";
        error: "error";
        fatal: "fatal";
        info: "info";
        trace: "trace";
        warn: "warn";
    }>>;
    REDIS_URL: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export declare function parseEnv<S extends z.ZodType>(schema: S, env: Record<string, string | undefined>): z.output<S>;
//# sourceMappingURL=config.d.ts.map