import concrnt from 'k6/x/concrnt';
import { cfg } from './env.js';
import { hash32, rng, followsOf } from './plan.js';

export { rng, followsOf };

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
