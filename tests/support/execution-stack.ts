import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function stringField(input: unknown, key: string): string {
  assert(typeof input === 'object' && input !== null, '隔离契约必须是对象');
  const value: unknown = Reflect.get(input, key);
  assert(typeof value === 'string' && value.length > 0, `隔离契约缺少 ${key}`);
  return value;
}

function pidField(input: unknown, key: string): number {
  assert(typeof input === 'object' && input !== null);
  const value: unknown = Reflect.get(input, key);
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
  return value;
}

export function parseExecutionContract(input: unknown) {
  assert.equal(stringField(input, 'kind'), 'e2e-channel-execution');
  const contract = {
    kind: 'e2e-channel-execution',
    appUrl: stringField(input, 'appUrl'),
    databaseUrl: stringField(input, 'databaseUrl'),
    databaseName: stringField(input, 'databaseName'),
    redisUrl: stringField(input, 'redisUrl'),
    redisContainerId: stringField(input, 'redisContainerId'),
    fakeModelUrl: stringField(input, 'fakeModelUrl'),
    sandboxImage: stringField(input, 'sandboxImage'),
    ownerPid: pidField(input, 'ownerPid'),
    workerPid: pidField(input, 'workerPid'),
    token: stringField(input, 'token'),
  };
  assert.match(contract.databaseName, /^e2e_channel_[a-f0-9]{16}$/);
  assert.match(contract.redisContainerId, /^[a-f0-9]{64}$/);
  assert(contract.token.length >= 32);
  return contract;
}

export async function requireExecutionStack() {
  const path = process.env.E2E_EXECUTION_CONTRACT;
  if (!path) {
    throw new Error(
      '拒绝执行：缺少独享数据库、Redis 与受控假模型契约；使用 E2E_CHANNEL_MODE=execution bun scripts/e2e-channel.ts',
    );
  }
  const contract = parseExecutionContract(JSON.parse(readFileSync(path, 'utf8')));
  const expected = {
    E2E_APP_URL: contract.appUrl,
    E2E_DATABASE_URL: contract.databaseUrl,
    E2E_REDIS_URL: contract.redisUrl,
    E2E_FAKE_MODEL_URL: contract.fakeModelUrl,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (process.env[key] !== value) throw new Error(`拒绝执行：${key} 与隔离入口契约不符`);
  }
  if (new URL(contract.databaseUrl).pathname !== `/${contract.databaseName}`) {
    throw new Error('拒绝执行：数据库身份与隔离入口契约不符');
  }
  process.kill(contract.ownerPid, 0);
  process.kill(contract.workerPid, 0);
  const response = await fetch(`${contract.fakeModelUrl}/__e2e_execution`, {
    headers: { authorization: `Bearer ${contract.token}` },
    signal: AbortSignal.timeout(5_000),
  });
  const live = parseExecutionContract(await response.json());
  if (!response.ok || JSON.stringify(live) !== JSON.stringify(contract)) {
    throw new Error('拒绝执行：受控假模型与隔离入口的实时契约不符');
  }
  return contract;
}

export function runtimeBuildTag(baseImageId: string, versionId: string): string {
  const slash = baseImageId.lastIndexOf('/');
  const colon = baseImageId.lastIndexOf(':');
  const repository = colon > slash ? baseImageId.slice(0, colon) : baseImageId;
  return `${repository}:runtime-env-${versionId}`;
}

export function parseRuntimeResource(input: unknown) {
  return {
    environmentId: stringField(input, 'environmentId'),
    versionId: stringField(input, 'versionId'),
    imageTag: stringField(input, 'imageTag'),
  };
}

export function registerRuntimeBuild(resource: ReturnType<typeof parseRuntimeResource>): void {
  const path = process.env.E2E_EXECUTION_CONTRACT;
  if (!path) throw new Error('拒绝登记：隔离入口契约不存在');
  appendFileSync(join(dirname(path), 'runtime-resources.jsonl'), `${JSON.stringify(resource)}\n`);
  console.log(JSON.stringify({ runtimeResource: resource }));
}
