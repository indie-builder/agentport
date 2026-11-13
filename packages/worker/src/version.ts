import { createRequire } from 'node:module';

const { version }: { version: string } = createRequire(import.meta.url)('../../../package.json');

export { version };
