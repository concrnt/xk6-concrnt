import { check, sleep } from 'k6';
import concrnt from 'k6/x/concrnt';
import { cfg } from './env.js';
import { SCHEMA, uri, docs, randomBody } from './world.js';
import { register, commit, resolve, query } from './api.js';

// the whole new-account flow of world-app (AccountSetup → first launch of Home)
// shared by seed.js and the newcomers scenario of load.js
export function registerUser(u, listId) {
    check(register(u.identity), { 'entity registered': (r) => r.status === 200 });

    let ok = false;
    for (let i = 0; i < 30 && !ok; i++) {
        ok = resolve(uri.entity(u.ccid), null, { may404: true }).status === 200;
        if (!ok) sleep(1);
    }
    check(ok, { 'entity resolvable': (v) => v });
    if (!ok) return false;

    check(commit(u, docs.enact(u.ccid, u.subkey.ckid), { master: true }), {
        'subkey enacted': (r) => r.status === 200,
    });

    for (const kind of ['home', 'notify', 'activity']) {
        check(commit(u, docs.timeline(u.ccid, kind)), { [`${kind} timeline created`]: (r) => r.status === 200 });
    }

    const listURI = uri.list(u.ccid, listId);
    check(commit(u, docs.list(u.ccid, listId, 'home')), { 'home list created': (r) => r.status === 200 });
    check(commit(u, docs.pinnedLists(u.ccid, listURI)), { 'pinned lists created': (r) => r.status === 200 });
    query({ prefix: `${uri.lists(u.ccid)}/`, schema: SCHEMA.list, limit: 1 }, u);

    check(commit(u, docs.profile(u.ccid, `user-${u.index}`)), { 'profile created': (r) => r.status === 200 });
    query({ parent: uri.profiles(u.ccid), order: 'asc', limit: 100 }, u);

    for (let i = 0; i < cfg.postsPerUser; i++) {
        const body = randomBody();
        const key = `${uri.posts(u.ccid)}/${concrnt.newCDID(body)}`;
        check(commit(u, docs.markdown(u.ccid, key, body, [uri.timeline(u.ccid, 'home')])), {
            'post created': (r) => r.status === 200,
        });
    }
    return true;
}
