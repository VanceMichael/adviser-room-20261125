import { partnerConfig } from './store.mjs';

export class HttpSigningClient {
  constructor(baseUrl, fetchImpl = fetch) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, '') : null;
    this.fetchImpl = fetchImpl;
  }

  async createEnvelope(requestKey, items) {
    if (!this.baseUrl) return { skipped: true, status: 0, body: null };
    const response = await this.fetchImpl(this.baseUrl + partnerConfig.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [partnerConfig.key]: requestKey },
      body: JSON.stringify({ [partnerConfig.group]: items })
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  async lookup(reference) {
    if (!this.baseUrl) return { skipped: true, status: 0, body: null };
    const response = await this.fetchImpl(`${this.baseUrl}${partnerConfig.lookup}${encodeURIComponent(reference)}`);
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }
}

export function summarizeSignerStatus(operations) {
  const statuses = operations.map(op => op?.status ?? 'unknown');
  if (statuses.some(s => s === 'rejected' || s === 'returned')) return 'failed';
  if (statuses.length && statuses.every(s => s === 'confirmed')) return 'effective';
  if (statuses.some(s => s === 'pending')) return 'pending';
  return 'provider_accepted';
}
