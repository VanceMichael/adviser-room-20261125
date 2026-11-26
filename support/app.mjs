import { createServer } from 'node:http';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { JsonStore, actorFromRequest } from './store.mjs';
import { HttpSigningClient } from './signing.mjs';
import { handleApi } from './api.mjs';
import { readJson, sendJson, hashBuffer } from './http-utils.mjs';

export function ensureLargeSyntheticObject(store, localObjectDir) {
  mkdirSync(localObjectDir, { recursive: true });
  const id = 'DOC-LARGE-SYNTH';
  const storageKey = 'large-synthetic-v1.bin';
  const fullPath = join(localObjectDir, storageKey);
  const sizeBytes = 512 * 1024;
  const half = sizeBytes / 2;
  if (!existsSync(fullPath)) {
    const buffer = Buffer.alloc(sizeBytes);
    for (let i = 0; i < sizeBytes; i += 1) buffer[i] = 32 + (i % 90);
    buffer.write('SYNTHETIC-LARGE-FILE-ONLY-NOT-REAL-DATA\n', 0, 'utf8');
    writeFileSync(fullPath, buffer);
  }
  if (!store.state.documents.some(d => d.id === id)) {
    const buffer = readFileSync(fullPath);
    store.state.documents.push({
      id,
      owner: 'ORG-A',
      familyId: id,
      version: 1,
      title: '大型合成分段资料',
      sections: ['general', 'appendix'],
      sectionRanges: {
        general: { startByte: 0, endByte: half - 1 },
        appendix: { startByte: half, endByte: sizeBytes - 1 }
      },
      storage: 'local',
      storageKey,
      sizeBytes,
      sha256: hashBuffer(buffer),
      createdAt: '2026-11-26T00:00:00.000Z'
    });
    store.save();
  }
}

export function createBusinessServer(options = {}) {
  const stateFile = options.stateFile ?? process.env.APP_STATE ?? resolve('.local/app-state.json');
  const store = options.store ?? new JsonStore({ stateFile });
  const localObjectDir = resolve(options.localObjectDir ?? process.env.OBJECT_STATE_DIR ?? join(process.cwd(), '.local', 'objects'));
  mkdirSync(localObjectDir, { recursive: true });
  if (options.ensureLarge !== false) ensureLargeSyntheticObject(store, localObjectDir);
  const signing = options.signingClient ?? new HttpSigningClient(options.partnerUrl ?? process.env.PARTNER_URL ?? 'http://127.0.0.1:4317');
  const config = {
    localObjectDir,
    fixtureObjectDir: options.fixtureObjectDir ?? new URL('../objects', import.meta.url).pathname,
    segmentSize: Number(options.segmentSize ?? process.env.SEGMENT_SIZE ?? 65536),
    streamChunkBytes: Number(options.streamChunkBytes ?? process.env.STREAM_CHUNK_BYTES ?? 65536)
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'content-type,authorization,x-actor-id,range,envelope-request',
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
        });
        return res.end();
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, service: 'adviser-room-business', syntheticOnly: true, time: new Date().toISOString() });
      }
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') {
        return sendJson(res, 404, { code: 'NOT_FOUND', error: '没有对应路径；接口前缀为 /api' });
      }

      const notificationRoute = /\/notifications$/.test(url.pathname);
      const auth = actorFromRequest(store.state, req);
      if (auth.error && !notificationRoute) return sendJson(res, auth.error.status, auth.error.body);
      const actor = auth.actor ?? null;
      const query = Object.fromEntries(url.searchParams.entries());
      let body = {};
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !['GET', 'HEAD'].includes(req.method)) {
        body = await readJson(req);
      }
      await handleApi({
        req, res, url, pathname: url.pathname, query, body,
        actor, store, config, signing,
        hooks: options.hooks,
        serverLog: (...args) => console.error('[business]', ...args)
      });
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error(error);
      if (!res.headersSent) sendJson(res, status, { code: error.code ?? 'INTERNAL', error: status >= 500 ? '服务内部错误' : error.message });
      else res.destroy();
    }
  });

  return { server, store, config, signing };
}
