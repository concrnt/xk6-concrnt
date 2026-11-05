// Steady-state load shaped like world-app traffic against a population made by
// seed.js (same SEED/USERS). Every rate and size is overridable with -e, see README.
import { check } from 'k6';
import exec from 'k6/execution';
import concrnt from 'k6/x/concrnt';
import { cfg } from './lib/env.js';
import { userAt, randomUser, followsOf } from './lib/users.js';
import { SCHEMA, uri, docs, randomBody } from './lib/world.js';
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

// constant-arrival-rate needs an integer rate, so sub-1/s rates are expressed per minute.
// maxVUs caps the concurrency of each persona (check dropped_iterations when raising rates);
// a fifth of it is pre-allocated
const arrival = (name, fn, perSecond, max) => {
    if (perSecond <= 0) return;
    scenarios[name] = {
        executor: 'constant-arrival-rate',
        exec: fn,
        rate: Math.max(1, Math.round(perSecond * 60)),
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
    },
};

const homeTimelines = (me) => [
    uri.timeline(me.ccid, 'home'),
    ...followsOf(me.index).map((j) => uri.timeline(userAt(j).ccid, 'home')),
];

// pick a post from the timeline items (associations distributed to a timeline carry ccfs hrefs)
const pickPost = (tlItems) => {
    const posts = tlItems.filter((it) => it.href && it.href.startsWith('cckv://'));
    return posts.length ? posts[Math.floor(Math.random() * posts.length)] : null;
};

let sessions = 0;

export function lurker() {
    const me = userAt((exec.vu.idInTest - 1) % cfg.users);
    if (sessions === 0 || Math.random() < cfg.coldRatio) {
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

    const rt = openRealtime(timelines, (ev) => {
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
    });

    const scroll = setInterval(() => {
        const more = timelineRecent(timelines, { until: Math.ceil(oldest), limit: 8 }, me);
        if (more.status === 200) show(JSON.parse(more.body));
    }, (20 + Math.random() * 20) * 1000);

    setTimeout(() => {
        clearInterval(scroll);
        rt.close();
    }, cfg.sessionSeconds * 1000);
}

export function poster() {
    const me = randomUser();
    const body = randomBody();
    const key = `${uri.posts(me.ccid)}/${concrnt.newCDID(body)}`;
    check(commit(me, docs.markdown(me.ccid, key, body, [uri.timeline(me.ccid, 'home')])), {
        'post created': (r) => r.status === 200,
    });
}

export function engager() {
    const me = randomUser();
    const tl = timelineRecent(homeTimelines(me), {}, me);
    const item = tl.status === 200 ? pickPost(JSON.parse(tl.body)) : null;
    if (!item) return;
    const target = loadMessage(item.href, me);
    if (!target) return;
    const author = target.doc.author;

    const dice = Math.random();
    if (dice < 0.6) {
        check(commit(me, docs.like(me.ccid, item.href, author)), { 'liked': (r) => r.status === 200 });
    } else if (dice < 0.75) {
        const imageUrl = 'https://example.com/emoji/thumbsup.png';
        associations({ uri: item.href, schema: SCHEMA.reaction, variant: imageUrl, limit: 1 }, me);
        check(commit(me, docs.reaction(me.ccid, item.href, author, 'thumbsup', imageUrl)), {
            'reacted': (r) => r.status === 200,
        });
    } else if (dice < 0.9) {
        const body = randomBody();
        const key = `${uri.posts(me.ccid)}/${concrnt.newCDID(body)}`;
        check(commit(me, docs.reply(me.ccid, key, body, item.href, author, [uri.timeline(me.ccid, 'home')])), {
            'reply posted': (r) => r.status === 200,
        });
        check(commit(me, docs.replyAssoc(me.ccid, item.href, author, key)), { 'reply associated': (r) => r.status === 200 });
    } else {
        const key = `${uri.posts(me.ccid)}/${concrnt.newCDID(item.href)}`;
        check(commit(me, docs.reroute(me.ccid, key, item.href, author, [uri.timeline(me.ccid, 'home')])), {
            'reroute posted': (r) => r.status === 200,
        });
        check(commit(me, docs.rerouteAssoc(me.ccid, item.href, author, key)), { 'reroute associated': (r) => r.status === 200 });
    }
    reloadAssociations(item.href, me);
}

export function browser() {
    const me = randomUser();
    const dice = Math.random();

    if (dice < 0.5) {
        const target = randomUser();
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

    if (dice < 0.8) {
        const tl = timelineRecent(homeTimelines(me), {}, me);
        const item = tl.status === 200 ? pickPost(JSON.parse(tl.body)) : null;
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
    const seed = `${cfg.seed}/newcomer/${exec.scenario.iterationInTest}/${Date.now()}`;
    const identity = concrnt.identityFromSeed(seed);
    const subkey = concrnt.subkeyFromSeed(identity, 'subkey');
    let token = null;
    const u = {
        index: `new-${exec.scenario.iterationInTest}`,
        identity,
        subkey,
        ccid: identity.address,
        token() {
            if (!token) token = concrnt.generateAuthTokenWithSubkey(subkey, cfg.fqdn);
            return token;
        },
    };
    registerUser(u, String(Date.now()));
}
