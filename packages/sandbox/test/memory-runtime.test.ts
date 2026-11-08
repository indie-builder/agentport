import { describe, expect, it } from 'bun:test';
import { DEFAULT_MEMORY_POLICY, memoryPolicySchema, sandboxTaskSchema } from '@agentport/shared';
import { memoryRuntimeSettings } from '../src/memory-runtime.js';

const taskBase = {
  prompt: 'hi',
  model: 'test-model',
  maxTurns: 1,
  maxBudgetUsd: 1,
  userMessageUuid: '11111111-2222-4333-8444-555555555555',
};

describe('sandbox task memory policy', () => {
  it('fills the default policy when older callers omit it', () => {
    const task = sandboxTaskSchema.parse(taskBase);
    expect(task.memoryPolicy).toEqual(DEFAULT_MEMORY_POLICY);
  });

  it('keeps an explicit policy and fills its missing fields', () => {
    const task = sandboxTaskSchema.parse({
      ...taskBase,
      memoryPolicy: { writeMode: 'proposal_only' },
    });
    expect(task.memoryPolicy).toEqual({
      ...DEFAULT_MEMORY_POLICY,
      writeMode: 'proposal_only',
    });
    expect(memoryPolicySchema.parse(task.memoryPolicy)).toEqual(task.memoryPolicy);
  });
});

describe('memoryRuntimeSettings', () => {
  it('enables auto-memory and memory writes in native_auto', () => {
    expect(memoryRuntimeSettings(DEFAULT_MEMORY_POLICY)).toEqual({
      autoMemoryEnabled: true,
      installPersonalHook: true,
      allowMemoryWrite: true,
    });
  });

  it('disables auto-memory and memory writes in proposal_only', () => {
    expect(memoryRuntimeSettings({ ...DEFAULT_MEMORY_POLICY, writeMode: 'proposal_only' })).toEqual(
      {
        autoMemoryEnabled: false,
        installPersonalHook: true,
        allowMemoryWrite: false,
      },
    );
  });

  it('turns off expert memory while leaving personal memory independent', () => {
    expect(memoryRuntimeSettings({ ...DEFAULT_MEMORY_POLICY, enabled: false })).toEqual({
      autoMemoryEnabled: false,
      installPersonalHook: true,
      allowMemoryWrite: false,
    });
    expect(
      memoryRuntimeSettings({
        ...DEFAULT_MEMORY_POLICY,
        enabled: false,
        injectPersonalMemory: false,
      }),
    ).toEqual({
      autoMemoryEnabled: false,
      installPersonalHook: false,
      allowMemoryWrite: false,
    });
  });

  it('skips the personal hook without touching expert memory', () => {
    expect(
      memoryRuntimeSettings({ ...DEFAULT_MEMORY_POLICY, injectPersonalMemory: false }),
    ).toEqual({
      autoMemoryEnabled: true,
      installPersonalHook: false,
      allowMemoryWrite: true,
    });
  });
});
