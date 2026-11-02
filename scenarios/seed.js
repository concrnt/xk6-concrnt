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
import { commitBatch, resolve, query, acknowledges, items, batch, queryURL, params } from './lib/api.js';
import { registerUser } from './lib/register.js';

export const options = {
    scenarios: {
        seed: {
            executor: 'shared-iterations',
            vus: cfg.seedVUs,
            iterations: cfg.users,
            maxDuration: '2h',
            gracefulStop: '60s',
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
        registerUser(u, u.listId, { parallel: true });
        return;
    }

    if (!cfg.seedForce) {
        const acks = items(acknowledges({ from: u.ccid, schema: SCHEMA.followAck, limit: 100 }, u));
        if (acks.length >= Math.min(cfg.follows, cfg.users - 1)) return;
    }

    // the 2 x FOLLOWS commits of a user are independent: one batch instead of 40 round trips
    const listURI = uri.list(u.ccid, u.listId);
    const follows = followsOf(i);
    const social = [];
    for (const j of follows) {
        const target = userAt(j);
        social.push(docs.followAck(u.ccid, target.ccid));
        const href = uri.timeline(target.ccid, 'home');
        social.push(docs.listItem(u.ccid, listURI, concrnt.newCDIDX(href), href, SCHEMA.userTimeline));
    }
    check(commitBatch(u, social), { 'followed + list items added': (rs) => rs.every((r) => r.status === 200) });
    query({ prefix: `${listURI}/`, limit: 100 }, u);

    const r = rng(`${cfg.seed}/likes/${i}`);
    const picks = [];
    for (let k = 0; k < cfg.likesPerUser; k++) picks.push({ target: userAt(follows[Math.floor(r() * follows.length)]), roll: r() });
    const postLists = batch(picks.map((p) => ['GET', queryURL({ prefix: `${uri.posts(p.target.ccid)}/`, limit: 10 }), null, params('query', u)]));
    const likes = [];
    postLists.forEach((res, k) => {
        const posts = items(res);
        if (posts.length === 0) return;
        const post = JSON.parse(posts[Math.floor(picks[k].roll * posts.length)].document);
        likes.push(docs.like(u.ccid, post.key, post.author));
    });
    check(commitBatch(u, likes), { 'liked': (rs) => rs.every((r) => r.status === 200) });
}
