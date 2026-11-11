// Steady-state load shaped like world-app traffic against a population made by
// seed.js (same SEED/USERS). Every rate and size is overridable with -e, see README.
import { check } from 'k6';
import exec from 'k6/execution';
import concrnt from 'k6/x/concrnt';
import { cfg } from './lib/env.js';
import { userAt, followsOf } from './lib/users.js';
import { decide, pickAt, decisionLine, ratePerMinute, subscribersOf, authorClass, popularCount, stream } from './lib/plan.js';
import { SCHEMA, POST_SAMPLES, uri, docs } from './lib/world.js';
import {
    metrics,
    wellKnown,
    commit,
    resolve,
    resolveCached,
    clearCache,
    query,
    associations,
    acknowledges,
    acknowledgeCounts,
    timelineRecent,
    subscribeCounter,
    items,
} from './lib/api.js';
import { loadMessage, reloadAssociations } from './lib/message.js';
import { openRealtime } from './lib/realtime.js';
import { registerUser } from './lib/register.js';

// --summary-export only lists a tagged sub-metric that has a threshold, so the
// workload counters get one that cannot fail: these are readings, not criteria
function workloadCounters() {
    const out = {};
    const show = (name) => (out[name] = ['count>=0']);
    for (const type of ['created', 'associated']) {
        for (const metric of ['realtime_events', 'realtime_events_expected']) {
            show(`${metric}{type:${type}}`);
            for (const author of ['popular', 'other']) show(`${metric}{type:${type},author:${author}}`);
        }
    }
    for (const c of ['popular', 'other']) {
        show(`workload_posts{author:${c}}`);
        show(`workload_associations{target:${c}}`);
    }
    return out;
}

const scenarios = {
    lurkers: {
        executor: 'ramping-vus',
        exec: 'lurker',
        startVUs: 0,
        stages: [
            { duration: cfg.rampUp, target: cfg.lurkers },
            { duration: cfg.duration, target: cfg.lurkers },
            { duration: cfg.rampDown, target: 0 },
        ],
        gracefulRampDown: `${cfg.sessionSeconds}s`,
        gracefulStop: `${cfg.sessionSeconds}s`,
    },
};

// maxVUs caps the concurrency of each persona (check dropped_iterations when raising rates);
// a fifth of it is pre-allocated
const arrival = (name, fn, perSecond, max) => {
    if (perSecond <= 0) return;
    scenarios[name] = {
        executor: 'constant-arrival-rate',
        exec: fn,
        rate: ratePerMinute(perSecond),
        timeUnit: '1m',
        startTime: cfg.rampUp,
        duration: cfg.duration,
        preAllocatedVUs: Math.max(1, Math.ceil(max / 5)),
        maxVUs: max,
    };
};
arrival('posters', 'poster', cfg.postRate, cfg.posterMaxVUs);
arrival('engagers', 'engager', cfg.engageRate, cfg.engagerMaxVUs);
arrival('browsers', 'browser', cfg.browseRate, cfg.browserMaxVUs);
arrival('newcomers', 'newcomer', cfg.registerRate, cfg.newcomerMaxVUs);

export const options = {
    scenarios,
    noConnectionReuse: cfg.noConnectionReuse,
    thresholds: {
        checks: ['rate>0.99'],
        http_req_failed: ['rate<0.01'],
        'http_req_duration{name:timeline/recent}': ['p(95)<300'],
        'http_req_duration{name:commit}': ['p(95)<500'],
        'http_req_duration{name:associations}': ['p(95)<200'],
        'http_req_duration{name:association-counts}': ['p(95)<200'],
        'http_req_duration{name:query}': ['p(95)<300'],
        'http_req_duration{name:resolve}': ['p(95)<200'],
        message_load_duration: ['p(95)<600'],
        realtime_event_latency: ['p(95)<2000'],
        ...workloadCounters(),
    },
};

const homeTimelines = (me) => [
    uri.timeline(me.ccid, 'home'),
    ...followsOf(me.index).map((j) => uri.timeline(userAt(j).ccid, 'home')),
];

// the posts among the timeline items (associations distributed to a timeline carry ccfs hrefs)
const postsOf = (tlItems) => tlItems.filter((it) => it.href && it.href.startsWith('cckv://'));

// the decision of this iteration; the same call with the same SEED and profile
// returns the same thing in every run
function decision() {
    const name = exec.scenario.name;
    const i = exec.scenario.iterationInTest;
    const d = decide[name](i);
    if (cfg.decisionLog) console.log(decisionLine(name, i, d));
    return d;
}

// what a state-dependent choice resolved to on this server
const outcome = (o) => {
    if (cfg.decisionLog) console.log(decisionLine(exec.scenario.name, exec.scenario.iterationInTest, o).replace(/^decision/, 'outcome'));
};

// seed.js names user i "user-<i>"; the profile is in the resolve cache after loadMessage
function indexOf(ccid, me) {
    const sd = resolveCached(uri.profile(ccid), me);
    const m = sd && /^user-(\d+)$/.exec(JSON.parse(sd.document).value.username || '');
    return m && Number(m[1]) < cfg.users ? Number(m[1]) : -1;
}

let popular = null;
const classOfCCID = (ccid) => {
    if (!popular) popular = new Set(Array.from({ length: popularCount }, (_, i) => userAt(i).ccid));
    return popular.has(ccid) ? 'popular' : 'other';
};

// a post of user index reached the server: every session subscribed to their home gets one "created"
function posted(index, kind) {
    const author = authorClass(index);
    metrics.posts.add(1, { author, kind });
    metrics.expectedEvents.add(subscribersOf(index), { type: 'created', author });
}

// an association on a post of user index: one "associated" per subscribed session,
// none if the server already holds the same statement (CIP-9 uniqueness)
function associated(index, kind, repeat) {
    const target = authorClass(index);
    metrics.associations.add(1, { target, kind, repeat: String(repeat) });
    if (!repeat) metrics.expectedEvents.add(subscribersOf(index), { type: 'associated', author: target });
}

let sessions = 0;

export function lurker() {
    const d = decision();
    const me = userAt(d.me);
    if (sessions === 0 || d.cold) {
        clearCache();
        metrics.sessionCold.add(1);
    }
    sessions++;

    // refreshFreshResources: what world-app fetches on every startup / return to foreground
    const listURI = uri.list(me.ccid, me.listId);
    wellKnown(me);
    query({ parent: uri.profiles(me.ccid), order: 'asc', limit: 100 }, me);
    resolve(uri.lists(me.ccid), me);
    query({ prefix: `${uri.lists(me.ccid)}/`, schema: SCHEMA.community, limit: 100 }, me);
    query({ prefix: `${uri.lists(me.ccid)}/`, schema: SCHEMA.apInbox, limit: 100 }, me);
    acknowledges({ from: me.ccid, schema: SCHEMA.followAck, limit: 100 }, me);
    acknowledges({ to: me.ccid, schema: SCHEMA.followAck, limit: 100 }, me);
    query({ prefix: uri.blocking(me.ccid), limit: 100 }, me);
    subscribeCounter(me, 'GET');
    resolve(listURI, me);
    query({ prefix: `${listURI}/`, limit: 100 }, me);
    resolve(uri.settings(me.ccid), me, { may404: true });
    resolveCached(uri.themes(me.ccid), me, { may404: true });
    resolveCached(uri.emojipacks(me.ccid), me, { may404: true });
    resolveCached(uri.entity(me.ccid), me);
    resolveCached(uri.keys(me.ccid, me.subkey.ckid), me);

    const timelines = homeTimelines(me);
    const first = timelineRecent(timelines, {}, me);
    check(first, { 'home timeline read': (r) => r.status === 200 });
    let oldest = Date.now();
    const show = (tlItems) => {
        for (const it of tlItems) {
            loadMessage(it.href, me);
            const t = Date.parse(it.timestamp);
            if (t < oldest) oldest = t;
        }
    };
    if (first.status === 200) show(JSON.parse(first.body));

    const rt = openRealtime(
        timelines,
        (ev) => {
            if (!ev.documents) return;
            for (const sd of Object.values(ev.documents)) {
                const doc = JSON.parse(sd.document);
                if (ev.type === 'created' && doc.schema === SCHEMA.reference) {
                    loadMessage(doc.value.href, me);
                    return;
                }
                if (ev.type === 'associated' && doc.kind === 'association') {
                    reloadAssociations(doc.associate, me);
                    return;
                }
            }
        },
        classOfCCID,
    );

    const scroll = setInterval(() => {
        const more = timelineRecent(timelines, { until: Math.ceil(oldest), limit: 8 }, me);
        if (more.status === 200) show(JSON.parse(more.body));
    }, d.scrollMs);

    setTimeout(() => {
        clearInterval(scroll);
        rt.close();
    }, cfg.sessionSeconds * 1000);
}

export function poster() {
    const d = decision();
    const me = userAt(d.me);
    const body = POST_SAMPLES[d.body];
    const key = `${uri.posts(me.ccid)}/${concrnt.newCDID(body)}`;
    const res = commit(me, docs.markdown(me.ccid, key, body, [uri.timeline(me.ccid, 'home')]));
    check(res, { 'post created': (r) => r.status === 200 });
    if (res.status === 200) posted(me.index, 'post');
}

export function engager() {
    const d = decision();
    const me = userAt(d.me);
    const tl = timelineRecent(homeTimelines(me), {}, me);
    const posts = tl.status === 200 ? postsOf(JSON.parse(tl.body)) : [];
    const item = pickAt(posts, d.pick);
    if (!item) return outcome({ n: 0 });
    const target = loadMessage(item.href, me);
    if (!target) return outcome({ n: posts.length, idx: posts.indexOf(item), author: 'missing' });
    const author = target.doc.author;
    const index = indexOf(author, me);
    const home = [uri.timeline(me.ccid, 'home')];
    let repeat = false;

    if (d.action === 'like') {
        repeat = target.mine().some((a) => a.schema === SCHEMA.like);
        const res = commit(me, docs.like(me.ccid, item.href, author));
        check(res, { 'liked': (r) => r.status === 200 });
        if (res.status === 200) associated(index, 'like', repeat);
    } else if (d.action === 'reaction') {
        const imageUrl = 'https://example.com/emoji/thumbsup.png';
        repeat = target.mine().some((a) => a.schema === SCHEMA.reaction && a.associationVariant === imageUrl);
        associations({ uri: item.href, schema: SCHEMA.reaction, variant: imageUrl, limit: 1 }, me);
        const res = commit(me, docs.reaction(me.ccid, item.href, author, 'thumbsup', imageUrl));
        check(res, { 'reacted': (r) => r.status === 200 });
        if (res.status === 200) associated(index, 'reaction', repeat);
    } else if (d.action === 'reply') {
        const body = POST_SAMPLES[d.body];
        const key = `${uri.posts(me.ccid)}/${concrnt.newCDID(body)}`;
        const post = commit(me, docs.reply(me.ccid, key, body, item.href, author, home));
        check(post, { 'reply posted': (r) => r.status === 200 });
        if (post.status === 200) posted(me.index, 'reply');
        const assoc = commit(me, docs.replyAssoc(me.ccid, item.href, author, key));
        check(assoc, { 'reply associated': (r) => r.status === 200 });
        if (assoc.status === 200) associated(index, 'reply', false);
    } else {
        const key = `${uri.posts(me.ccid)}/${concrnt.newCDID(item.href)}`;
        const post = commit(me, docs.reroute(me.ccid, key, item.href, author, home));
        check(post, { 'reroute posted': (r) => r.status === 200 });
        if (post.status === 200) posted(me.index, 'reroute');
        const assoc = commit(me, docs.rerouteAssoc(me.ccid, item.href, author, key));
        check(assoc, { 'reroute associated': (r) => r.status === 200 });
        if (assoc.status === 200) associated(index, 'reroute', false);
    }
    outcome({ n: posts.length, idx: posts.indexOf(item), author: index, subs: subscribersOf(index), repeat });
    reloadAssociations(item.href, me);
}

export function browser() {
    const d = decision();
    const me = userAt(d.me);

    if (d.view === 'profile') {
        const target = userAt(d.target);
        resolveCached(uri.entity(target.ccid), me);
        resolveCached(uri.profile(target.ccid), me);
        resolve(uri.profile(target.ccid), me);
        acknowledgeCounts({ from: target.ccid }, me);
        acknowledgeCounts({ to: target.ccid }, me);
        const prefix = `${uri.timeline(target.ccid, 'home')}/`;
        const page = query({ prefix, limit: 16 }, me);
        check(page, { 'profile posts read': (r) => r.status === 200 });
        if (page.status !== 200) return;
        const body = JSON.parse(page.body);
        for (const sd of body.items || []) loadMessage(JSON.parse(sd.document).value.href, me);
        if (body.next) {
            for (const sd of items(query({ prefix, limit: 16, until: body.next }, me))) {
                loadMessage(JSON.parse(sd.document).value.href, me);
            }
        }
        return;
    }

    if (d.view === 'post') {
        const tl = timelineRecent(homeTimelines(me), {}, me);
        const posts = tl.status === 200 ? postsOf(JSON.parse(tl.body)) : [];
        const item = pickAt(posts, d.pick);
        outcome({ n: posts.length, idx: posts.indexOf(item) });
        if (!item) return;
        loadMessage(item.href, me);
        const replies = associations({ uri: item.href, schema: SCHEMA.replyAssoc, limit: 100 }, me);
        check(replies, { 'replies read': (r) => r.status === 200 });
        for (const sd of items(replies)) loadMessage(JSON.parse(sd.document).value.targetURI, me);
        return;
    }

    subscribeCounter(me, 'DELETE');
    const page = query({ prefix: `${uri.timeline(me.ccid, 'notify')}/`, limit: 16 }, me);
    check(page, { 'notifications read': (r) => r.status === 200 });
    for (const sd of items(page)) loadMessage(JSON.parse(sd.document).value.href, me);
}

export function newcomer() {
    const i = exec.scenario.iterationInTest;
    // a new account every time: the clock names it unless RUN_ID does
    const seed = cfg.runId ? `${cfg.seed}/newcomer/${cfg.runId}/${i}` : `${cfg.seed}/newcomer/${i}/${Date.now()}`;
    const identity = concrnt.identityFromSeed(seed);
    const subkey = concrnt.subkeyFromSeed(identity, 'subkey');
    let token = null;
    const u = {
        index: `new-${i}`,
        identity,
        subkey,
        ccid: identity.address,
        token() {
            if (!token) token = concrnt.generateAuthTokenWithSubkey(subkey, cfg.fqdn);
            return token;
        },
    };
    if (cfg.decisionLog) console.log(decisionLine('newcomers', i, decide.newcomers(i)));
    registerUser(u, String(Date.now()), { rand: stream('newcomers', i) });
}
