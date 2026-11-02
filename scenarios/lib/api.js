import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import concrnt from 'k6/x/concrnt';
import { cfg } from './env.js';

export const metrics = {
    messageLoad: new Trend('message_load_duration', true),
    commit: new Trend('commit_duration', true),
    realtimeEvents: new Counter('realtime_events'),
    realtimeLatency: new Trend('realtime_event_latency', true),
    sessionCold: new Counter('session_cold'),
};

export const API = `${cfg.baseURL}/api/v2`;

export const qs = (params) =>
    Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');

// every request carries tags.name so k6 aggregates per endpoint instead of per URL
export function params(name, user, headers = {}) {
    if (user) headers['Authorization'] = `Bearer ${user.token()}`;
    return { headers, tags: { name } };
}

// descriptor for http.batch
export const desc = (name, url, user) => ['GET', url, null, params(name, user)];

export const batch = (descs) => http.batch(descs);

export const wellKnown = (user) => http.get(`${cfg.baseURL}/.well-known/concrnt`, params('well-known', user));

export function register(identity) {
    const signed = JSON.parse(concrnt.signDocument(identity, JSON.stringify({
        kind: 'entity',
        author: identity.address,
        schema: 'https://schema.concrnt.net/entity.json',
        value: { domain: cfg.fqdn },
        createdAt: new Date(),
    })));
    signed.meta = {};
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.captcha) headers['captcha'] = cfg.captcha;
    return http.post(`${API}/register`, JSON.stringify(signed), { headers, tags: { name: 'register' } });
}

export function commit(user, doc, { master = false } = {}) {
    const body = master
        ? concrnt.signDocument(user.identity, JSON.stringify(doc))
        : concrnt.signDocumentWithSubkey(user.subkey, JSON.stringify(doc));
    const res = http.post(`${API}/commit`, body, params('commit', user, { 'Content-Type': 'application/json' }));
    metrics.commit.add(res.timings.duration, { kind: doc.kind });
    return res;
}

// independent commits of one user in parallel (seed only; world-app commits one at a time)
export function commitBatch(user, docs, { master = false } = {}) {
    if (docs.length === 0) return [];
    const p = params('commit', user, { 'Content-Type': 'application/json' });
    const res = http.batch(docs.map((doc) => {
        const body = master
            ? concrnt.signDocument(user.identity, JSON.stringify(doc))
            : concrnt.signDocumentWithSubkey(user.subkey, JSON.stringify(doc));
        return ['POST', `${API}/commit`, body, p];
    }));
    res.forEach((r, i) => metrics.commit.add(r.timings.duration, { kind: docs[i].kind }));
    return res;
}

export const resolveURL = (u) => `${API}/resolve?${qs({ uri: u })}`;

// may404: existence probes and optional documents (settings, themes) are not failures
export function resolve(u, user, { may404 = false } = {}) {
    const p = params('resolve', user);
    if (may404) p.responseCallback = http.expectedStatuses(200, 404);
    return http.get(resolveURL(u), p);
}

// world-app keeps resolved documents in IndexedDB for 24h; a VU-local map
// stands in for that so only the first session of a VU pays the cold cost
const cache = new Map();
export const clearCache = () => cache.clear();

export function resolveCached(u, user, opts) {
    const hit = cache.get(u);
    if (hit && Date.now() - hit.at < 86400000) return hit.sd;
    const res = resolve(u, user, opts);
    if (res.status !== 200) return null;
    const sd = JSON.parse(res.body);
    cache.set(u, { sd, at: Date.now() });
    return sd;
}

export const queryURL = (p) => `${API}/query?${qs(p)}`;
export const query = (p, user) => http.get(queryURL(p), params('query', user));

export const associationsURL = (p) => `${API}/associations?${qs(p)}`;
export const associations = (p, user) => http.get(associationsURL(p), params('associations', user));

export const associationCountsURL = (p) => `${API}/association-counts?${qs(p)}`;
export const associationCounts = (p, user) => http.get(associationCountsURL(p), params('association-counts', user));

export const acknowledges = (p, user) => http.get(`${API}/acknowledges?${qs(p)}`, params('acknowledges', user));
export const acknowledgeCounts = (p, user) => http.get(`${API}/acknowledge-counts?${qs(p)}`, params('acknowledge-counts', user));

export const timelineRecent = (uris, p, user) =>
    http.get(`${API}/timeline/recent?${qs({ uris: uris.join(','), ...p })}`, params('timeline/recent', user));

export const subscribeCounter = (user, method) =>
    http.request(method, `${API}/subscribe/${user.ccid}/world.concrnt.app/counter`, null, params('subscribe-counter', user));

export const items = (res) => (res.status === 200 ? JSON.parse(res.body).items || [] : []);
