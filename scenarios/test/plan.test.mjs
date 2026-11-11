// node --test scenarios/test/plan.test.mjs   (no k6, no server)
// The decision stream of load.js is a pure function of the environment:
// generated twice it is identical, another SEED gives another stream, and
// its statistics are the ones the scenario had with Math.random().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROFILE = {
    SEED: 'unit-test', USERS: '3000', FOLLOWS: '20', LURKERS: '240', DURATION: '10m', RAMP_UP: '1m', RAMP_DOWN: '30s',
    SESSION_SECONDS: '180', POST_RATE: '1.2', ENGAGE_RATE: '3.6', BROWSE_RATE: '4.8', REGISTER_RATE: '0.06',
};

// env.js reads __ENV when it is loaded, so every environment is its own process
function plan(env, expr = 'render()') {
    const url = new URL('../plan.js', import.meta.url).href;
    const code = `globalThis.__ENV = ${JSON.stringify({ ...PROFILE, ...env })};
        const m = await import(${JSON.stringify(url)}); const l = await import(${JSON.stringify(new URL('../lib/plan.js', import.meta.url).href)});
        const render = m.render; process.stdout.write(String(await (async () => ${expr})()));`;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', maxBuffer: 1 << 28 });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
}
const decisions = (text, scenario) =>
    text.split('\n').filter((l) => l.startsWith(`decision ${scenario} `)).map((l) => Object.fromEntries(l.split(' ').slice(3).map((kv) => kv.split('='))));

test('the same SEED and profile give the same decisions', () => {
    const a = plan({});
    assert.equal(a, plan({}));
    assert.equal(a.split('\n').filter((l) => l.startsWith('decision posters ')).length, 721);
    assert.equal(a.split('\n').filter((l) => l.startsWith('decision engagers ')).length, 2161);
    assert.equal(a.split('\n').filter((l) => l.startsWith('decision browsers ')).length, 2881);
});

test('another SEED gives other decisions, the target does not matter', () => {
    const a = plan({});
    assert.notEqual(a, plan({ SEED: 'unit-test-2' }));
    assert.equal(a, plan({ TARGET: 'other:8000', TARGET_FQDN: 'other.example', DECISION_LOG: '1' }));
});

test('a longer run extends the stream instead of changing it', () => {
    const short = plan({}).split('\n').filter((l) => l.startsWith('decision engagers '));
    const long = plan({ DURATION: '20m' }).split('\n').filter((l) => l.startsWith('decision engagers '));
    assert.deepEqual(long.slice(0, short.length), short);
});

test('DETERMINISTIC=0 is the old behaviour', () => {
    assert.notEqual(plan({ DETERMINISTIC: '0' }), plan({ DETERMINISTIC: '0' }));
});

test('the mix and the user distribution are unchanged', () => {
    // 40 minutes of the 3000 DAU profile for a usable sample
    const text = plan({ DURATION: '40m' });
    const eng = decisions(text, 'engagers');
    const share = (list, key, value) => list.filter((d) => d[key] === value).length / list.length;
    const near = (got, want, tol) => assert.ok(Math.abs(got - want) < tol, `${got} is not within ${tol} of ${want}`);
    near(share(eng, 'action', 'like'), 0.6, 0.02);
    near(share(eng, 'action', 'reaction'), 0.15, 0.02);
    near(share(eng, 'action', 'reply'), 0.15, 0.02);
    near(share(eng, 'action', 'reroute'), 0.1, 0.02);
    const br = decisions(text, 'browsers');
    near(share(br, 'view', 'profile'), 0.5, 0.02);
    near(share(br, 'view', 'post'), 0.3, 0.02);
    near(share(br, 'view', 'notifications'), 0.2, 0.02);

    // acting users are uniform over the population: chi-square over 30 buckets of 100 users
    const all = [...eng, ...br, ...decisions(text, 'posters')];
    const buckets = new Array(30).fill(0);
    for (const d of all) buckets[Math.floor(Number(d.me) / 100)]++;
    const expected = all.length / 30;
    const chi2 = buckets.reduce((s, n) => s + (n - expected) ** 2 / expected, 0);
    assert.ok(chi2 < 60, `chi2 ${chi2} (29 degrees of freedom, 99.9 % point 58.3)`);
    // popular users act as often as anyone: 10 of 3000
    near(all.filter((d) => Number(d.me) < 10).length / all.length, 10 / 3000, 0.0015);

    // the pick position is uniform and independent of the user and of the action
    const picks = eng.map((d) => Number(d.pick));
    near(picks.reduce((s, p) => s + p, 0) / picks.length, 0.5, 0.01);
    const likes = eng.filter((d) => d.action === 'like').map((d) => Number(d.pick));
    near(likes.reduce((s, p) => s + p, 0) / likes.length, 0.5, 0.015);
    const sixteenths = new Array(16).fill(0);
    for (const p of picks) sixteenths[Math.floor(p * 16)]++;
    const e16 = picks.length / 16;
    assert.ok(sixteenths.reduce((s, n) => s + (n - e16) ** 2 / e16, 0) < 40, 'pick positions are not uniform');
});

test('lurkers: every slot is online once, cold ratio and scroll period as before', () => {
    const lur = decisions(plan({}), 'lurkers');
    assert.deepEqual(lur.slice(0, 240).map((d) => Number(d.me)), Array.from({ length: 240 }, (_, i) => i));
    assert.equal(lur[240].me, '0');
    const cold = lur.filter((d) => d.cold === 'true').length / lur.length;
    assert.ok(Math.abs(cold - 0.1) < 0.03, `cold ratio ${cold}`);
    assert.ok(lur.every((d) => Number(d.scrollMs) >= 20000 && Number(d.scrollMs) <= 40000));
});

test('subscribers: all lurkers listen to a popular author, the follow graph is the seeded one', () => {
    assert.equal(plan({}, 'l.subscribersOf(0)'), '240');
    assert.equal(plan({}, 'l.subscribersOf(9)'), '240');
    // user 10 is a lurker (own session) and not popular
    const ten = Number(plan({}, 'l.subscribersOf(10)'));
    assert.ok(ten >= 1 && ten < 20, `subscribers of user 10: ${ten}`);
    // mean over everyone: LURKERS x (1 + FOLLOWS) subscriptions spread over USERS
    const total = Number(plan({}, 'Array.from({length:3000},(_,i)=>l.subscribersOf(i)).reduce((a,b)=>a+b,0)'));
    assert.equal(total, 240 * 21);
    // follow graph untouched by this change (pinned from the commit before it)
    assert.equal(plan({ SEED: 'concrnt-loadtest' , USERS: '100' }, 'l.followsOf(42).join(",")'), FOLLOWS_42);
});

const FOLLOWS_42 = '0,1,2,3,4,5,6,7,8,9,55,25,80,48,68,54,51,41,28,39';
