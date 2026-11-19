/**
 * In-memory fakes for the CMC module's unit tests: the bridge account (batch API with per-call
 * errors, `apiOne` throwing like lib-js) and the persons' data grants.
 */

export interface FakeEvent {
  id: string; streamIds: string[]; type: string; content: any; clientData?: any; trashed?: boolean; time: number
}

const SCOPE = ':_cmc:apps:hds-bridge-reader';

function apiError (error: { id: string }): Error {
  return Object.assign(new Error(error.id), { id: error.id, innerObject: error });
}

export class FakeBridge {
  events: FakeEvent[] = [];
  streams = new Set<string>(['main', 'main-users', 'main-users-active', 'main-errors', 'main-cmc', ':_cmc:inbox', ':_cmc:apps', SCOPE]);
  seq = 0;
  calls: Array<{ method: string, params: any }> = [];
  /** How a scope request ends: delivered at once, or failed. */
  scopeRequest: 'delivered' | 'failed' = 'delivered';

  async api (calls: any[]): Promise<any[]> {
    this.calls.push(...calls);
    return calls.map(c => this.one(c.method, c.params));
  }

  async apiOne (method: string, params: any, key?: string): Promise<any> {
    const [r] = await this.api([{ method, params }]);
    if (r?.error != null) throw apiError(r.error);
    return key != null ? r[key] : r;
  }

  private known (s: string): boolean {
    return this.streams.has(s) || s.startsWith(SCOPE + ':');
  }

  private inStream (e: FakeEvent, s: string): boolean {
    return e.streamIds.some(x => x === s || x.startsWith(s + '-') || x.startsWith(s + ':'));
  }

  add (e: Omit<FakeEvent, 'id'> & { id?: string }): FakeEvent {
    const ev: FakeEvent = { ...e, id: e.id ?? 'e' + (++this.seq) } as FakeEvent;
    this.events.push(ev);
    return ev;
  }

  ofType (type: string): FakeEvent[] {
    return this.events.filter(e => e.type === type && e.trashed !== true);
  }

  private one (method: string, p: any): any {
    if (method === 'streams.create') {
      if (this.streams.has(p.id)) return { error: { id: 'item-already-exists' } };
      this.streams.add(p.id);
      return { stream: { id: p.id } };
    }
    if (method === 'streams.get') {
      if (p?.parentId != null && !this.known(p.parentId)) return { error: { id: 'unknown-referenced-resource' } };
      return { streams: [] };
    }
    if (method === 'events.get') {
      if (p.streams.some((s: string) => !this.known(s))) return { error: { id: 'unknown-referenced-resource' } };
      let events = this.events
        .filter(e => p.streams.some((s: string) => this.inStream(e, s)))
        .filter(e => p.types == null || p.types.includes(e.type))
        .filter(e => p.state === 'all' || e.trashed !== true)
        .filter(e => p.fromTime == null || e.time >= p.fromTime)
        .filter(e => p.toTime == null || e.time <= p.toTime);
      events = events.sort((a, b) => p.sortAscending === true ? a.time - b.time : b.time - a.time).slice(0, p.limit ?? 20);
      return { events: structuredClone(events) };
    }
    if (method === 'events.getOne') {
      const e = this.events.find(x => x.id === p.id && x.trashed !== true);
      return e == null ? { error: { id: 'unknown-resource' } } : { event: structuredClone(e) };
    }
    if (method === 'events.create') {
      if (p.streamIds.some((s: string) => !this.known(s))) return { error: { id: 'unknown-referenced-resource' } };
      const e = this.add({ time: p.time ?? 1000 + this.seq, streamIds: p.streamIds, type: p.type, content: structuredClone(p.content) });
      if (p.clientData != null) e.clientData = structuredClone(p.clientData);
      if (p.type === 'consent/request-cmc') e.content.capabilityUrl = `https://cap-${e.id}@bridge.datasafe.test/`;
      if (p.type === 'consent/scope-request-cmc') {
        if (this.scopeRequest === 'failed') e.content.status = 'failed';
        else Object.assign(e.content, { status: 'completed', remoteEventId: 'remote-' + e.id });
      }
      return { event: structuredClone(e) };
    }
    if (method === 'events.update') {
      const e = this.events.find(x => x.id === p.id);
      if (e == null) return { error: { id: 'unknown-resource' } };
      Object.assign(e, structuredClone(p.update));
      return { event: structuredClone(e) };
    }
    if (method === 'events.delete') {
      const e = this.events.find(x => x.id === p.id);
      if (e == null) return { error: { id: 'unknown-resource' } };
      if (e.trashed !== true) { e.trashed = true; return { event: e }; }
      this.events = this.events.filter(x => x !== e);
      return { eventDeletion: { id: e.id } };
    }
    return { error: { id: 'unknown-method' } };
  }
}

export class FakeGrant {
  state: 'live' | 'gone' | 'unknown' = 'live';
  webhooks = new Map<string, { id: string, url: string, scopes: any, state: string }>();
  events: FakeEvent[] = [];
  calls: Array<{ method: string, params: any }> = [];
  seq = 0;
  info: { id: string, user: { username: string }, permissions: any[] };
  constructor (info: { id: string, user: { username: string }, permissions: any[] }) {
    this.info = info;
  }

  async api (calls: any[]): Promise<any[]> {
    this.calls.push(...calls);
    if (this.state === 'unknown') throw new Error('fetch failed');
    if (this.state === 'gone') throw Object.assign(new Error('API call result is not an Array'), { innerObject: { error: { id: 'invalid-access-token' } } });
    return calls.map(c => this.one(c.method, c.params));
  }

  async apiOne (method: string, params: any, key?: string): Promise<any> {
    const [r] = await this.api([{ method, params }]);
    if (r?.error != null) throw apiError(r.error);
    return key != null ? r[key] : r;
  }

  private one (method: string, p: any): any {
    if (method === 'getAccessInfo') return structuredClone(this.info);
    if (method === 'webhooks.create') {
      const id = 'wh' + (++this.seq);
      this.webhooks.set(id, { id, url: p.url, scopes: p.scopes, state: 'active' });
      return { webhook: { ...this.webhooks.get(id) } };
    }
    if (method === 'webhooks.getOne') {
      const w = this.webhooks.get(p.id);
      return w == null ? { error: { id: 'unknown-resource' } } : { webhook: { ...w } };
    }
    if (method === 'webhooks.update') {
      const w = this.webhooks.get(p.id);
      if (w == null) return { error: { id: 'unknown-resource' } };
      Object.assign(w, p.update);
      return { webhook: { ...w } };
    }
    if (method === 'events.get') return { events: this.events.filter(e => p.streams.some((s: string) => e.streamIds.includes(s))) };
    if (method === 'events.create') {
      const e = { id: 'g' + (++this.seq), time: 0, streamIds: p.streamIds, type: p.type, content: p.content };
      this.events.push(e);
      return { event: e };
    }
    if (method === 'events.update') {
      const e = this.events.find(x => x.id === p.id);
      if (e == null) return { error: { id: 'unknown-resource' } };
      Object.assign(e, p.update);
      return { event: e };
    }
    return { error: { id: 'unknown-method' } };
  }
}
