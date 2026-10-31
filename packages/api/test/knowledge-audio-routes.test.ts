import { createHash } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  expectProblem,
  type FastifyInstance,
  inject,
  loginCookie,
  startApp,
  unique,
} from './helpers.js';

/** 只证明容器头成立的合成音频；负载是否可解码由转录端决定。 */
const AUDIO_FIXTURES = {
  mp3: {
    filename: 'clip.mp3',
    mimeType: 'audio/mpeg',
    canonical: 'audio/mpeg',
    data: Buffer.from('fffb9064', 'hex'),
  },
  wav: {
    filename: 'clip.wav',
    mimeType: 'audio/wav',
    canonical: 'audio/wav',
    data: Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WAVEfmt '),
      Buffer.alloc(16),
    ]),
  },
  m4a: {
    filename: 'clip.m4a',
    mimeType: 'audio/mp4',
    canonical: 'audio/mp4',
    data: Buffer.from('00000018667479704d344120000000004d3441204d34412000000000', 'hex'),
  },
  flac: {
    filename: 'clip.flac',
    mimeType: 'audio/flac',
    canonical: 'audio/flac',
    data: Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(34)]),
  },
  ogg: {
    filename: 'clip.ogg',
    mimeType: 'audio/ogg',
    canonical: 'audio/ogg',
    data: (() => {
      const data = Buffer.alloc(60);
      data.write('OggS', 0);
      data[28] = 1;
      data.write('vorbis', 29);
      return data;
    })(),
  },
} as const;

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

let app: FastifyInstance;
let cookie = '';
let knowledgeDir = '';
const baseIds: string[] = [];
const serverIds: string[] = [];
const profileIds: string[] = [];

beforeAll(async () => {
  knowledgeDir = await mkdtemp(join(tmpdir(), 'knowledge-audio-routes-'));
  app = await startApp({ KNOWLEDGE_DIR: knowledgeDir });
  cookie = await loginCookie(app);
});

afterEach(async () => {
  if (baseIds.length > 0) {
    await app.pool.query('delete from knowledge_bases where id = any($1::text[])', [baseIds]);
    baseIds.length = 0;
  }
  if (serverIds.length > 0) {
    await app.pool.query('delete from servers where id = any($1::text[])', [serverIds]);
    serverIds.length = 0;
  }
  if (profileIds.length > 0) {
    await app.pool.query('delete from knowledge_model_profiles where id = any($1::text[])', [
      profileIds,
    ]);
    profileIds.length = 0;
  }
});

afterAll(async () => {
  await app.close();
  await rm(knowledgeDir, { recursive: true, force: true });
});

type ProfileKind = 'embedding' | 'rerank' | 'asr';

async function createProfile(kind: ProfileKind, overrides: Record<string, unknown> = {}) {
  const res = await inject(app, {
    method: 'POST',
    url: '/api/knowledge/model-profiles',
    headers: { cookie },
    payload: {
      kind,
      name: unique(kind),
      endpointUrl: 'http://127.0.0.1:1/audio/transcriptions',
      model: 'whisper-1',
      ...overrides,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const profile = res.json<{
    id: string;
    kind: string;
    dimensions: number | null;
    embeddingProtocol: string;
    imageInputEnabled: boolean;
    hasSecret: boolean;
  }>();
  profileIds.push(profile.id);
  return profile;
}

async function createBase(asrProfileId: string | null = null) {
  const embedding = await createProfile('embedding', {
    endpointUrl: 'http://127.0.0.1:1/embeddings',
    model: 'test-embedding',
  });
  const res = await inject(app, {
    method: 'POST',
    url: '/api/knowledge/bases',
    headers: { cookie },
    payload: {
      slug: unique('audio-kb'),
      name: '音频知识库',
      embeddingProfileId: embedding.id,
      asrProfileId,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const base = res.json<{ id: string; serverId: string; asrProfileId: string | null }>();
  baseIds.push(base.id);
  serverIds.push(base.serverId);
  return base;
}

async function upload(baseId: string, media: { filename: string; mimeType: string; data: Buffer }) {
  return inject(app, {
    method: 'PUT',
    url: `/api/knowledge/bases/${baseId}/documents/upload`,
    headers: { cookie },
    payload: {
      filename: media.filename,
      mimeType: media.mimeType,
      dataBase64: media.data.toString('base64'),
    },
  });
}

async function rowCounts(baseId: string) {
  const documents = await app.pool.query<{ count: number }>(
    'select count(*)::int as count from knowledge_documents where base_id = $1',
    [baseId],
  );
  const jobs = await app.pool.query<{ count: number }>(
    'select count(*)::int as count from knowledge_jobs where base_id = $1',
    [baseId],
  );
  return { documents: documents.rows[0]!.count, jobs: jobs.rows[0]!.count };
}

async function blobExists(sha: string): Promise<boolean> {
  return access(join(knowledgeDir, 'blobs', sha.slice(0, 2), sha)).then(
    () => true,
    () => false,
  );
}

describe('ASR model profiles', () => {
  it('kind=asr 固定 openai/无维度/无图片，密钥不回显且可清除', async () => {
    const created = await inject(app, {
      method: 'POST',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
      payload: {
        kind: 'asr',
        name: unique('asr'),
        endpointUrl: 'http://127.0.0.1:1/audio/transcriptions',
        model: 'whisper-1',
        apiKey: 'sk-test',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json<Record<string, unknown>>();
    profileIds.push(String(body.id));
    expect(body).toMatchObject({
      kind: 'asr',
      dimensions: null,
      embeddingProtocol: 'openai',
      imageInputEnabled: false,
      hasSecret: true,
      enabled: true,
    });
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('secretsEncrypted');

    const listed = await inject(app, {
      method: 'GET',
      url: '/api/knowledge/model-profiles',
      headers: { cookie },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const row = listed
      .json<Array<Record<string, unknown>>>()
      .find((profile) => profile.id === body.id);
    expect(row).toMatchObject({ kind: 'asr', hasSecret: true });
    expect(row).not.toHaveProperty('apiKey');

    const cleared = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/model-profiles/${body.id}`,
      headers: { cookie },
      payload: { apiKey: null, model: 'whisper-1', name: unique('asr-renamed') },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<{ hasSecret: boolean }>().hasSecret).toBe(false);
  });

  it('创建与更新拒绝 ASR 的 cohere_v2 / 图片能力', async () => {
    for (const overrides of [{ embeddingProtocol: 'cohere_v2' }, { imageInputEnabled: true }]) {
      const res = await inject(app, {
        method: 'POST',
        url: '/api/knowledge/model-profiles',
        headers: { cookie },
        payload: {
          kind: 'asr',
          name: unique('asr-invalid'),
          endpointUrl: 'http://127.0.0.1:1/audio/transcriptions',
          model: 'whisper-1',
          ...overrides,
        },
      });
      expect(res.statusCode, res.body).toBe(400);
      expectProblem(res, 'INVALID_INPUT');
    }

    const profile = await createProfile('asr');
    for (const overrides of [{ embeddingProtocol: 'cohere_v2' }, { imageInputEnabled: true }]) {
      const res = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/model-profiles/${profile.id}`,
        headers: { cookie },
        payload: overrides,
      });
      expect(res.statusCode, res.body).toBe(400);
      expectProblem(res, 'INVALID_INPUT');
    }
  });

  it('ASR 测试入口在出站前返回 409，且不调用 fetch', async () => {
    const profile = await createProfile('asr');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const res = await inject(app, {
        method: 'POST',
        url: `/api/knowledge/model-profiles/${profile.id}/test`,
        headers: { cookie },
      });
      expect(res.statusCode, res.body).toBe(409);
      expectProblem(res, 'CONFLICT');
      expect(res.json<{ message: string }>().message).toContain('显式音频上传');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('knowledge base ASR binding', () => {
  it('create/patch/response 携带 asrProfileId，关闭用 null', async () => {
    const asr = await createProfile('asr');
    const base = await createBase(asr.id);
    expect(base.asrProfileId).toBe(asr.id);

    const got = await inject(app, {
      method: 'GET',
      url: `/api/knowledge/bases/${base.id}`,
      headers: { cookie },
    });
    expect(got.statusCode, got.body).toBe(200);
    expect(got.json<{ asrProfileId: string | null }>().asrProfileId).toBe(asr.id);

    const cleared = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/bases/${base.id}`,
      headers: { cookie },
      payload: { asrProfileId: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<{ asrProfileId: string | null }>().asrProfileId).toBeNull();

    const rebound = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/bases/${base.id}`,
      headers: { cookie },
      payload: { asrProfileId: asr.id },
    });
    expect(rebound.statusCode, rebound.body).toBe(200);
    expect(rebound.json<{ asrProfileId: string | null }>().asrProfileId).toBe(asr.id);

    // 未传时保持原绑定，不会被默认值重置。
    const renamed = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/bases/${base.id}`,
      headers: { cookie },
      payload: { name: '音频知识库改名' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json<{ asrProfileId: string | null }>().asrProfileId).toBe(asr.id);
  });

  it('换绑拒绝不存在、错误类型与停用的 profile', async () => {
    const embedding = await createProfile('embedding', {
      endpointUrl: 'http://127.0.0.1:1/embeddings',
      model: 'test-embedding',
    });
    const base = await createBase();
    const disabled = await createProfile('asr');
    const disable = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/model-profiles/${disabled.id}`,
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(disable.statusCode, disable.body).toBe(200);

    for (const asrProfileId of [embedding.id, disabled.id, 'kmp_missing']) {
      const res = await inject(app, {
        method: 'PATCH',
        url: `/api/knowledge/bases/${base.id}`,
        headers: { cookie },
        payload: { asrProfileId },
      });
      expect(res.statusCode, res.body).toBe(400);
      expectProblem(res, 'INVALID_INPUT');
    }
  });

  it('被知识库引用的 ASR 不能删除，也不能原地换模型；可改 endpoint/key', async () => {
    const asr = await createProfile('asr');
    const base = await createBase(asr.id);

    const removed = await inject(app, {
      method: 'DELETE',
      url: `/api/knowledge/model-profiles/${asr.id}`,
      headers: { cookie },
    });
    expect(removed.statusCode, removed.body).toBe(409);
    expectProblem(removed, 'CONFLICT');

    const modelChange = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/model-profiles/${asr.id}`,
      headers: { cookie },
      payload: { model: 'another-model' },
    });
    expect(modelChange.statusCode, modelChange.body).toBe(409);
    expectProblem(modelChange, 'CONFLICT');

    const endpointChange = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/model-profiles/${asr.id}`,
      headers: { cookie },
      payload: { endpointUrl: 'http://127.0.0.1:2/audio/transcriptions', apiKey: 'sk-new' },
    });
    expect(endpointChange.statusCode, endpointChange.body).toBe(200);
    expect(endpointChange.json<{ hasSecret: boolean }>().hasSecret).toBe(true);

    const unlink = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/bases/${base.id}`,
      headers: { cookie },
      payload: { asrProfileId: null },
    });
    expect(unlink.statusCode, unlink.body).toBe(200);
    const deleted = await inject(app, {
      method: 'DELETE',
      url: `/api/knowledge/model-profiles/${asr.id}`,
      headers: { cookie },
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    profileIds.splice(profileIds.indexOf(asr.id), 1);
  });
});

describe('audio upload entry', () => {
  it('五种格式均以 canonical MIME 入库并保留原文件名', async () => {
    const asr = await createProfile('asr');
    const base = await createBase(asr.id);
    for (const media of Object.values(AUDIO_FIXTURES)) {
      const res = await upload(base.id, media);
      expect(res.statusCode, `${media.filename}: ${res.body}`).toBe(202);
      const { documentId, jobId } = res.json<{ documentId: string; jobId: string }>();
      const row = await app.pool.query<{
        mimeType: string;
        title: string;
        metadata: Record<string, unknown>;
      }>('select mime_type as "mimeType", title, metadata from knowledge_documents where id = $1', [
        documentId,
      ]);
      expect(row.rows[0]!.mimeType).toBe(media.canonical);
      expect(row.rows[0]!.metadata.originalFilename).toBe(media.filename);
      const job = await app.pool.query('select 1 from knowledge_jobs where id = $1', [jobId]);
      expect(job.rowCount).toBe(1);
    }
  });

  it('未绑定或停用 ASR、停用知识库时拒绝音频，且不写 blob/行/任务', async () => {
    const detachedAudio = Buffer.concat([
      Buffer.from('fffb9064', 'hex'),
      Buffer.from(`detached-${unique('blob')}`),
    ]);
    const detached = await createBase();
    const detachedUpload = await upload(detached.id, {
      ...AUDIO_FIXTURES.mp3,
      data: detachedAudio,
    });
    expect(detachedUpload.statusCode, detachedUpload.body).toBe(409);
    expectProblem(detachedUpload, 'CONFLICT');
    expect(await rowCounts(detached.id)).toEqual({ documents: 0, jobs: 0 });
    expect(await blobExists(sha256(detachedAudio))).toBe(false);

    const asr = await createProfile('asr');
    const bound = await createBase(asr.id);
    const disabledBase = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/bases/${bound.id}`,
      headers: { cookie },
      payload: { status: 'disabled' },
    });
    expect(disabledBase.statusCode, disabledBase.body).toBe(200);
    const disabledUpload = await upload(bound.id, AUDIO_FIXTURES.mp3);
    expect(disabledUpload.statusCode, disabledUpload.body).toBe(409);
    expect(await rowCounts(bound.id)).toEqual({ documents: 0, jobs: 0 });

    await app.pool.query("update knowledge_bases set status = 'active' where id = $1", [bound.id]);
    const disableProfile = await inject(app, {
      method: 'PATCH',
      url: `/api/knowledge/model-profiles/${asr.id}`,
      headers: { cookie },
      payload: { enabled: false },
    });
    expect(disableProfile.statusCode, disableProfile.body).toBe(200);
    const profileDisabled = await upload(bound.id, AUDIO_FIXTURES.mp3);
    expect(profileDisabled.statusCode, profileDisabled.body).toBe(409);
    expect(await rowCounts(bound.id)).toEqual({ documents: 0, jobs: 0 });
  });

  it('格式伪装、声明矛盾与超限在 blob/job 之前拒绝', async () => {
    const asr = await createProfile('asr');
    const base = await createBase(asr.id);
    // 同目录下其他用例已写入基准音频；这里用独立字节证明失败路径没有落 blob。
    const uniqueAudio = Buffer.concat([
      Buffer.from('fffb9064', 'hex'),
      Buffer.from(`failure-${unique('blob')}`),
    ]);

    const fake = await upload(base.id, {
      filename: 'fake.mp3',
      mimeType: 'audio/mpeg',
      data: Buffer.from('not audio at all', 'utf8'),
    });
    expect(fake.statusCode, fake.body).toBe(415);
    expectProblem(fake, 'UNSUPPORTED_MEDIA_TYPE');

    // 合法但不支持的 AIFF 仍按不支持的音频拒绝。
    const aiff = await upload(base.id, {
      filename: 'clip.aiff',
      mimeType: 'audio/aiff',
      data: Buffer.concat([
        Buffer.from('FORM'),
        Buffer.from([0, 0, 0, 4]),
        Buffer.from('AIFF'),
        Buffer.alloc(8),
      ]),
    });
    expect(aiff.statusCode, aiff.body).toBe(415);
    expectProblem(aiff, 'UNSUPPORTED_MEDIA_TYPE');

    const mismatch = await upload(base.id, {
      filename: 'clip.mp3',
      mimeType: 'audio/wav',
      data: uniqueAudio,
    });
    expect(mismatch.statusCode, mismatch.body).toBe(400);
    expectProblem(mismatch, 'INVALID_INPUT');

    // 实际音频伪装成文本：仍按真实字节识别并拒绝后缀矛盾。
    const disguised = await upload(base.id, {
      filename: 'notes.txt',
      mimeType: 'text/plain',
      data: uniqueAudio,
    });
    expect(disguised.statusCode, disguised.body).toBe(400);
    expectProblem(disguised, 'INVALID_INPUT');

    const wavAsText = await upload(base.id, {
      filename: 'notes.txt',
      mimeType: 'text/plain',
      data: AUDIO_FIXTURES.wav.data,
    });
    expect(wavAsText.statusCode, wavAsText.body).toBe(400);
    expectProblem(wavAsText, 'INVALID_INPUT');

    const oversized = Buffer.alloc(25_000_001);
    uniqueAudio.copy(oversized);
    const over = await upload(base.id, {
      filename: 'big.mp3',
      mimeType: 'audio/mpeg',
      data: oversized,
    });
    expect(over.statusCode, over.body).toBe(413);
    expectProblem(over, 'PAYLOAD_TOO_LARGE');

    expect(await rowCounts(base.id)).toEqual({ documents: 0, jobs: 0 });
    expect(await blobExists(sha256(uniqueAudio))).toBe(false);
    expect(await blobExists(sha256(oversized))).toBe(false);
  });

  it('零字节上传在音频识别前被 dataBase64 校验拦住，且不新增行/blob', async () => {
    const asr = await createProfile('asr');
    const base = await createBase(asr.id);
    const empty = Buffer.alloc(0);

    for (const media of [
      { filename: 'empty.wav', mimeType: 'audio/wav', data: empty },
      { filename: 'empty.txt', mimeType: 'text/plain', data: empty },
    ]) {
      const res = await upload(base.id, media);
      expect(res.statusCode, `${media.filename}: ${res.body}`).toBe(400);
      expectProblem(res, 'INVALID_INPUT');
    }
    expect(await rowCounts(base.id)).toEqual({ documents: 0, jobs: 0 });
    expect(await blobExists(sha256(empty))).toBe(false);
  });

  it('FORM 开头的普通 Markdown 按普通文件入库，不被误判为音频', async () => {
    const base = await createBase();
    const data = Buffer.from('FORM is important\n');
    const res = await upload(base.id, {
      filename: 'notes.md',
      mimeType: 'text/markdown',
      data,
    });
    expect(res.statusCode, res.body).toBe(202);
    const row = await app.pool.query<{ sizeBytes: string; mimeType: string }>(
      'select size_bytes as "sizeBytes", mime_type as "mimeType" from knowledge_documents where id = $1',
      [res.json<{ documentId: string }>().documentId],
    );
    expect(row.rows[0]!.mimeType).toBe('text/markdown');
    expect(Number(row.rows[0]!.sizeBytes)).toBe(data.length);
  });

  it('普通文件仍保留 32MiB 上传上限，不因音频入口被误判', async () => {
    const asr = await createProfile('asr');
    const base = await createBase(asr.id);
    const data = Buffer.alloc(26 * 1024 * 1024, 0x61);
    const res = await upload(base.id, {
      filename: 'large.md',
      mimeType: 'text/markdown',
      data,
    });
    expect(res.statusCode, res.body).toBe(202);
    const row = await app.pool.query<{ sizeBytes: string; mimeType: string }>(
      'select size_bytes as "sizeBytes", mime_type as "mimeType" from knowledge_documents where id = $1',
      [res.json<{ documentId: string }>().documentId],
    );
    expect(row.rows[0]!.mimeType).toBe('text/markdown');
    expect(Number(row.rows[0]!.sizeBytes)).toBe(data.length);
  });
});
