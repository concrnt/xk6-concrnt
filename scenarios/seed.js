// Seeds a deterministic user population so every backend is measured on the
// same data. Run twice: PHASE=register (accounts, timelines, posts) and then
// PHASE=social (follows + likes), because writing into another user's notify
// timeline needs that timeline and its policy to exist first.
import { check } from 'k6';
import exec from 'k6/execution';
import concrnt from 'k6/x/concrnt';
import { cfg } from './lib/env.js';
import { userAt, followsOf, rng } from './lib/users.js';
import { SCHEMA, uri, docs } from './lib/world.js';
import { commit, resolve, query, acknowledges, items } from './lib/api.js';
import { registerUser } from './lib/register.js';

export const options = {
    scenarios: {
        seed: {
            executor: 'shared-iterations',
            vus: cfg.seedVUs,
            iterations: cfg.users,
            maxDuration: '2h',
        },
    },
    thresholds: {
        checks: ['rate>0.99'],
        http_req_failed: ['rate<0.01'],
    },
};

export function setup() {
    if (cfg.phase !== 'social') return;
    for (let i = 0; i < cfg.users; i++) {
        if (resolve(uri.profile(userAt(i).ccid)).status !== 200) {
            exec.test.abort(`user ${i} is not registered; run PHASE=register first`);
        }
    }
}

export default function () {
    const i = exec.scenario.iterationInTest;
    const u = userAt(i);

    if (cfg.phase === 'register') {
        if (!cfg.seedForce && resolve(uri.profile(u.ccid), null, { may404: true }).status === 200) return;
        registerUser(u, u.listId);
        return;
    }

    if (!cfg.seedForce) {
        const acks = items(acknowledges({ from: u.ccid, schema: SCHEMA.followAck, limit: 100 }, u));
        if (acks.length >= Math.min(cfg.follows, cfg.users - 1)) return;
    }

    const listURI = uri.list(u.ccid, u.listId);
    const follows = followsOf(i);
    for (const j of follows) {
        const target = userAt(j);
        check(commit(u, docs.followAck(u.ccid, target.ccid)), { 'followed': (r) => r.status === 200 });
        const href = uri.timeline(target.ccid, 'home');
        check(commit(u, docs.listItem(u.ccid, listURI, concrnt.newCDIDX(href), href, SCHEMA.userTimeline)), {
            'list item added': (r) => r.status === 200,
        });
    }
    query({ prefix: `${listURI}/`, limit: 100 }, u);

    const r = rng(`${cfg.seed}/likes/${i}`);
    for (let k = 0; k < cfg.likesPerUser; k++) {
        const target = userAt(follows[Math.floor(r() * follows.length)]);
        const posts = items(query({ prefix: `${uri.posts(target.ccid)}/`, limit: 10 }, u));
        if (posts.length === 0) continue;
        const post = JSON.parse(posts[Math.floor(r() * posts.length)].document);
        check(commit(u, docs.like(u.ccid, post.key, post.author)), { 'liked': (r) => r.status === 200 });
    }
}
