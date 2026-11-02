import { check, sleep } from 'k6';
import concrnt from 'k6/x/concrnt';
import { cfg } from './env.js';
import { SCHEMA, uri, docs, randomBody } from './world.js';
import { register, commit, commitBatch, resolve, query } from './api.js';

// the whole new-account flow of world-app (AccountSetup → first launch of Home)
// shared by seed.js and the newcomers scenario of load.js.
// parallel=true (seed) sends the independent commits of a step as one http.batch;
// the newcomer of load.js keeps world-app's one-at-a-time order.
export function registerUser(u, listId, { parallel = false } = {}) {
    check(register(u.identity), { 'entity registered': (r) => r.status === 200 });

    // the entity becomes resolvable once the registration job ran; poll quickly (<= 30s)
    let ok = false;
    for (let i = 0; i < 150 && !ok; i++) {
        ok = resolve(uri.entity(u.ccid), null, { may404: true }).status === 200;
        if (!ok) sleep(0.2);
    }
    check(ok, { 'entity resolvable': (v) => v });
    if (!ok) return false;

    check(commit(u, docs.enact(u.ccid, u.subkey.ckid), { master: true }), {
        'subkey enacted': (r) => r.status === 200,
    });

    const timelines = ['home', 'notify', 'activity'];
    if (parallel) {
        check(commitBatch(u, timelines.map((kind) => docs.timeline(u.ccid, kind))), {
            'timelines created': (rs) => rs.every((r) => r.status === 200),
        });
    } else {
        for (const kind of timelines) {
            check(commit(u, docs.timeline(u.ccid, kind)), { [`${kind} timeline created`]: (r) => r.status === 200 });
        }
    }

    const listURI = uri.list(u.ccid, listId);
    check(commit(u, docs.list(u.ccid, listId, 'home')), { 'home list created': (r) => r.status === 200 });
    check(commit(u, docs.pinnedLists(u.ccid, listURI)), { 'pinned lists created': (r) => r.status === 200 });
    query({ prefix: `${uri.lists(u.ccid)}/`, schema: SCHEMA.list, limit: 1 }, u);

    check(commit(u, docs.profile(u.ccid, `user-${u.index}`)), { 'profile created': (r) => r.status === 200 });
    query({ parent: uri.profiles(u.ccid), order: 'asc', limit: 100 }, u);

    const posts = [];
    for (let i = 0; i < cfg.postsPerUser; i++) {
        const body = randomBody();
        const key = `${uri.posts(u.ccid)}/${concrnt.newCDID(body)}`;
        posts.push(docs.markdown(u.ccid, key, body, [uri.timeline(u.ccid, 'home')]));
    }
    if (parallel) {
        check(commitBatch(u, posts), { 'posts created': (rs) => rs.every((r) => r.status === 200) });
    } else {
        for (const doc of posts) check(commit(u, doc), { 'post created': (r) => r.status === 200 });
    }
    return true;
}
