import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { authorizeDocument, documentAbsolutePath } from './store.mjs';

export function sendJson(res, status, value, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(value));
}

export function sendError(res, decision) {
  return sendJson(res, decision.status ?? 400, {
    error: decision.error ?? '请求不合法',
    code: decision.code ?? 'BAD_REQUEST'
  });
}

export async function readJson(req, limit = 25 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('请求体过大');
      error.status = 413;
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch {
    const error = new Error('JSON 格式不符');
    error.status = 400;
    error.code = 'INVALID_JSON';
    throw error;
  }
}

export function parseSingleRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || header.includes(',')) return { invalid: true };
  const [, startText, endText] = match;
  let start;
  let end;
  if (startText === '' && endText !== '') {
    const suffix = Number(endText);
    if (!Number.isInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (startText !== '') {
    start = Number(startText);
    end = endText === '' ? size - 1 : Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return { invalid: true };
    if (start >= size) return { invalid: true, unsatisfiable: true };
    end = Math.min(end, size - 1);
  } else return { invalid: true };
  return { start, end };
}

export function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function serveAuthorizedDocument(req, res, context, input) {
  const decision = authorizeDocument(context.store.state, context.actor, input);
  if (!decision.ok) return sendError(res, decision);
  const { doc } = decision;
  const filePath = documentAbsolutePath(doc, context.config);
  let fileStat;
  try { fileStat = await stat(filePath); }
  catch { return sendJson(res, 410, { error: '合成文件对象不存在', code: 'OBJECT_MISSING' }); }

  let start = decision.startByte;
  let end = decision.endByte;
  let isRange = false;
  const rangeHeader = req.headers.range;
  if (rangeHeader && input.ignoreRangeHeader !== true) {
    const range = parseSingleRange(rangeHeader, fileStat.size);
    if (range?.unsatisfiable) {
      res.writeHead(416, { 'content-range': `bytes */${fileStat.size}` });
      return res.end();
    }
    if (range?.invalid) return sendJson(res, 416, { error: 'Range 格式不支持，仅支持单段 bytes', code: 'INVALID_RANGE' });
    if (range) {
      // 对 Range 与章节/显式分段取交集；授权器已检查最终范围。
      start = Math.max(start, range.start);
      end = Math.min(end, range.end);
      if (start > end) return sendJson(res, 416, { error: '分段与授权章节没有交集', code: 'RANGE_OUTSIDE_SCOPE' });
      const reDecision = authorizeDocument(context.store.state, context.actor, { ...input, startByte: start, endByte: end });
      if (!reDecision.ok) return sendError(res, reDecision);
      isRange = true;
    }
  }

  const length = end - start + 1;
  const headers = {
    'accept-ranges': 'bytes',
    'content-type': 'text/plain; charset=utf-8',
    'content-length': length,
    'x-document-id': doc.id,
    'x-document-version': String(doc.version),
    'x-authorization-decision': 'allow'
  };
  if (isRange) {
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${fileStat.size}` });
  } else {
    res.writeHead(200, headers);
  }

  const chunkBytes = context.config.streamChunkBytes ?? 65536;
  let handle;
  let pos = start;
  let chunkIndex = 0;
  let deliveredEnd = start - 1;
  let outcome = 'fulfilled';
  let denyCode = null;
  try {
    handle = await open(filePath, 'r');
    while (pos <= end) {
      if (context.hooks?.beforeChunk) await context.hooks.beforeChunk({ chunkIndex, pos, endByte: end, documentId: doc.id });
      if (req.destroyed || res.destroyed || res.writableEnded) { outcome = 'client_aborted'; break; }
      // 每个分块写出前都按当前状态重新判定；撤权后不再写后续块。
      const recheck = authorizeDocument(context.store.state, context.actor, {
        ...input,
        startByte: pos,
        endByte: Math.min(end, pos + chunkBytes - 1)
      });
      if (!recheck.ok) {
        outcome = 'denied_midstream';
        denyCode = recheck.code;
        res.destroy();
        break;
      }
      const chunkEnd = Math.min(end, pos + chunkBytes - 1);
      const buffer = Buffer.allocUnsafe(chunkEnd - pos + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, pos);
      if (!bytesRead) break;
      const out = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
      if (!res.write(out)) await new Promise(resolve => res.once('drain', resolve));
      deliveredEnd = pos + bytesRead - 1;
      pos += bytesRead;
      chunkIndex += 1;
    }
    if (outcome === 'fulfilled' && !res.writableEnded) res.end();
  } catch (error) {
    outcome = 'io_error';
    res.destroy();
    context.serverLog?.('文件流出错', error);
  } finally {
    await handle?.close().catch(() => {});
    await context.store.commit(state => {
      const grant = state.grants.find(g => g.id === decision.grant.id);
      state.accessEvents.push({
        id: context.store.nextId('ACC'),
        at: new Date().toISOString(),
        actorId: context.actor.id,
        memberId: context.actor.member,
        engagementId: input.engagementId,
        documentId: doc.id,
        version: doc.version,
        grantId: decision.grant.id,
        purpose: input.purpose,
        section: input.section ?? null,
        startByte: start,
        requestedEndByte: end,
        deliveredStartByte: start,
        deliveredEndByte: deliveredEnd >= start ? deliveredEnd : null,
        status: outcome === 'fulfilled' ? 'fulfilled' : 'interrupted',
        reason: denyCode ?? outcome
      });
      if (grant) grant.lastAccessedAt = new Date().toISOString();
    }).catch(() => {});
  }
  return { outcome, start, end, deliveredEnd };
}

export function segmentList(doc, config, section) {
  const size = doc.sizeBytes;
  const segmentSize = config.segmentSize ?? 65536;
  const scope = section ? doc.sectionRanges?.[section] : { startByte: 0, endByte: size - 1 };
  if (section && !scope) return null;
  const first = Math.floor(scope.startByte / segmentSize);
  const last = Math.floor(scope.endByte / segmentSize);
  const segments = [];
  for (let index = first; index <= last; index += 1) {
    const globalStart = index * segmentSize;
    const globalEnd = Math.min(size - 1, (index + 1) * segmentSize - 1);
    const startByte = Math.max(globalStart, scope.startByte);
    const endByte = Math.min(globalEnd, scope.endByte);
    if (startByte <= endByte) segments.push({ index, startByte, endByte, length: endByte - startByte + 1, section: section ?? null });
  }
  return { segmentSize, scope, segments };
}

export function ensureWritableDir(dir) {
  mkdirSync(join(dir), { recursive: true });
}
