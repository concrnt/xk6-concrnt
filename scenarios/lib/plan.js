// Everything the load scenario decides, as pure functions of (SEED, profile,
// scenario, iteration). No k6 import, so plan.js, the node test and load.js
// share the same code and a run can be replayed without a server.
import { cfg } from './env.js';
import { POST_SAMPLES } from './world.js';

export function hash32(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function mulberry32(a) {
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// the generator behind the follow graph and the seed likes: do not change, the
// seeded population depends on it
export const rng = (seed) => mulberry32(hash32(seed));

// murmur3 finaliser: the keys of consecutive iterations differ in their last
// characters only, this spreads them over the whole state before the first draw
function fmix32(h) {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
}

// One independent stream per (scenario, iteration). VUs run concurrently and an
// arrival-rate executor hands iteration n to whichever VU is free, so a shared
// or per-VU generator would depend on scheduling; the iteration number does not.
// WORKLOAD_SEED (default SEED) gives another workload on the same seeded
// population; DETERMINISTIC=0 brings back Math.random().
export const stream = (scenario, iteration) =>
    cfg.deterministic ? mulberry32(fmix32(hash32(`${cfg.workloadSeed}/load/${scenario}/${iteration}`))) : Math.random;

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

export const popularCount = Math.floor(Math.min(cfg.follows, cfg.users - 1) / 2);
export const isPopular = (i) => Number.isInteger(i) && i >= 0 && i < popularCount;
export const authorClass = (i) => (isPopular(i) ? 'popular' : 'other');

// The online population is LURKERS session slots, slot s played by user
// s % USERS. A session takes the slot of its iteration number: sessions all
// last SESSION_SECONDS, so the ones running at any moment are a window of
// LURKERS consecutive iterations, i.e. every slot once, whichever VU runs them.
export const lurkerUser = (iteration) => (iteration % cfg.lurkers) % cfg.users;

// how many online sessions listen to the home timeline of user i (their own
// session, if they are a lurker, plus the lurkers following them): the number
// of realtime events one post or one association on a post of i must produce
let subscribers = null;
export function subscribersOf(i) {
    if (!subscribers) {
        subscribers = new Map();
        const add = (u) => subscribers.set(u, (subscribers.get(u) || 0) + 1);
        for (let slot = 0; slot < cfg.lurkers; slot++) {
            const u = slot % cfg.users;
            add(u);
            for (const j of followsOf(u)) add(j);
        }
    }
    return subscribers.get(i) || 0;
}

const user = (r) => Math.floor(r() * cfg.users);
const body = (r) => Math.floor(r() * POST_SAMPLES.length);

// Every decision draws all its values in a fixed order, whether or not the
// branch taken uses them, so a change to one branch does not shift the others.
export const decide = {
    lurkers(iteration) {
        const r = stream('lurkers', iteration);
        return { me: lurkerUser(iteration), cold: r() < cfg.coldRatio, scrollMs: Math.round((20 + r() * 20) * 1000) };
    },
    posters(iteration) {
        const r = stream('posters', iteration);
        return { me: user(r), body: body(r) };
    },
    // pick is the position in [0,1) among the posts of the acting user's home
    // timeline as the server returns it: the rule is fixed, the post behind it is
    // whatever the server under test put there
    engagers(iteration) {
        const r = stream('engagers', iteration);
        const me = user(r);
        const pick = r();
        const dice = r();
        const action = dice < 0.6 ? 'like' : dice < 0.75 ? 'reaction' : dice < 0.9 ? 'reply' : 'reroute';
        return { me, action, pick, body: body(r) };
    },
    browsers(iteration) {
        const r = stream('browsers', iteration);
        const me = user(r);
        const dice = r();
        const view = dice < 0.5 ? 'profile' : dice < 0.8 ? 'post' : 'notifications';
        return { me, view, target: user(r), pick: r() };
    },
    newcomers(iteration) {
        const r = stream('newcomers', iteration);
        const bodies = [];
        for (let i = 0; i < cfg.postsPerUser; i++) bodies.push(body(r));
        return { bodies };
    },
};

export const pickAt = (list, roll) => (list.length ? list[Math.min(list.length - 1, Math.floor(roll * list.length))] : null);

// one line per decision, without quotes so it survives k6's logfmt console
// output unescaped; plan.js prints the same lines without a server
// (fractions with six digits: the shortest float notation differs between JS engines)
const show = (v) => (Array.isArray(v) ? v.join(',') : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(6) : v);
export const decisionLine = (scenario, iteration, d) =>
    `decision ${scenario} ${iteration} ${Object.entries(d).map(([k, v]) => `${k}=${show(v)}`).join(' ')}`;

// constant-arrival-rate needs an integer rate, so sub-1/s rates are expressed per minute
export const ratePerMinute = (perSecond) => (perSecond <= 0 ? 0 : Math.max(1, Math.round(perSecond * 60)));

export function seconds(duration) {
    let total = 0;
    for (const [, n, unit] of String(duration).matchAll(/([\d.]+)(ms|h|m|s)/g)) {
        total += Number(n) * { h: 3600, m: 60, s: 1, ms: 0.001 }[unit];
    }
    return total;
}

// iterations each scenario starts when no iteration is dropped (an arrival
// scenario starts one at 0 and one at the very end of DURATION; the number of
// lurker sessions depends on how long the sessions really take)
export const plannedIterations = () => {
    const minutes = seconds(cfg.duration) / 60;
    const arrivals = (perSecond) => (perSecond <= 0 ? 0 : Math.floor(ratePerMinute(perSecond) * minutes) + 1);
    const sessions = Math.ceil((seconds(cfg.rampUp) + seconds(cfg.duration) + seconds(cfg.rampDown)) / cfg.sessionSeconds);
    return {
        lurkers: cfg.lurkers * sessions,
        posters: arrivals(cfg.postRate),
        engagers: arrivals(cfg.engageRate),
        browsers: arrivals(cfg.browseRate),
        newcomers: arrivals(cfg.registerRate),
    };
};
