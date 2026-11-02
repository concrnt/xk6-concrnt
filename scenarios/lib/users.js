import concrnt from 'k6/x/concrnt';
import { cfg } from './env.js';

function hash32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export function rng(seed) {
    let a = hash32(seed);
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const memo = new Map();

export function userAt(i) {
    let u = memo.get(i);
    if (u) return u;
    const identity = concrnt.identityFromSeed(`${cfg.seed}/user/${i}`);
    const subkey = concrnt.subkeyFromSeed(identity, 'subkey');
    let token = null;
    let issued = 0;
    u = {
        index: i,
        identity,
        subkey,
        ccid: identity.address,
        // world-app's list id is Date.now(); a seed-derived 13-digit number keeps re-seeding idempotent
        listId: String(1600000000000 + hash32(`${cfg.seed}/list/${i}`)),
        token() {
            // the extension's JWT lives 5 minutes and a stale one silently turns the request anonymous
            if (!token || Date.now() - issued > 240000) {
                token = concrnt.generateAuthTokenWithSubkey(subkey, cfg.fqdn);
                issued = Date.now();
            }
            return token;
        },
    };
    memo.set(i, u);
    return u;
}

export function randomUser() {
    return userAt(Math.floor(Math.random() * cfg.users));
}

// users 0..FOLLOWS/2-1 are "popular": everyone follows them, so their notify
// timelines and association counts get the skewed load a real SNS has. The set
// does not depend on USERS, so growing the population in stages keeps the graph.
export function followsOf(i) {
    const n = cfg.users;
    const want = Math.min(cfg.follows, n - 1);
    const popular = Math.floor(want / 2);
    const picked = [];
    for (let p = 0; p < popular && picked.length < Math.floor(want / 2); p++) {
        if (p !== i) picked.push(p);
    }
    const r = rng(`${cfg.seed}/follows/${i}`);
    while (picked.length < want) {
        const c = Math.floor(r() * n);
        if (c !== i && !picked.includes(c)) picked.push(c);
    }
    return picked;
}
