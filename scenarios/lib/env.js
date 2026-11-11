const e = __ENV;
const str = (k, d) => (e[k] ? e[k] : d);
const num = (k, d) => (e[k] ? Number(e[k]) : d);
const bool = (k, d) => (e[k] ? ['1', 'true', 'yes'].includes(e[k].toLowerCase()) : d);

const target = str('TARGET', 'localhost:8000');
const seed = str('SEED', 'concrnt-loadtest');
const secure = bool('SECURE', false);

export const cfg = {
    target,
    secure,
    fqdn: str('TARGET_FQDN', 'localhost'),
    baseURL: `${secure ? 'https' : 'http'}://${target}`,
    wsURL: `${secure ? 'wss' : 'ws'}://${target}/api/v2/realtime`,
    seed,
    // the load decisions only: another value replays another workload on the
    // population seeded with SEED
    workloadSeed: str('WORKLOAD_SEED', seed),
    users: num('USERS', 100),
    follows: num('FOLLOWS', 20),
    postsPerUser: num('POSTS_PER_USER', 10),
    likesPerUser: num('LIKES_PER_USER', 5),
    seedVUs: num('SEED_VUS', 100),
    phase: str('PHASE', 'register'),
    captcha: str('CAPTCHA', ''),
    seedForce: bool('SEED_FORCE', false),
    lurkers: num('LURKERS', 50),
    duration: str('DURATION', '10m'),
    sessionSeconds: num('SESSION_SECONDS', 120),
    postRate: num('POST_RATE', 0.5),
    engageRate: num('ENGAGE_RATE', 1),
    browseRate: num('BROWSE_RATE', 1),
    registerRate: num('REGISTER_RATE', 0),
    coldRatio: num('COLD_RATIO', 0.1),
    rampUp: str('RAMP_UP', '1m'),
    rampDown: str('RAMP_DOWN', '30s'),
    posterMaxVUs: num('POSTER_MAX_VUS', 50),
    engagerMaxVUs: num('ENGAGER_MAX_VUS', 100),
    browserMaxVUs: num('BROWSER_MAX_VUS', 100),
    newcomerMaxVUs: num('NEWCOMER_MAX_VUS', 10),
    // a VU keeps its keep-alive connections for its whole session, so with
    // a ClusterIP Service the replica each VU lands on is fixed for minutes
    // and the load spreads unevenly; this opens a new connection per request
    noConnectionReuse: bool('NO_CONNECTION_REUSE', false),
    // every workload decision of load.js comes from SEED + scenario + iteration
    // number (lib/plan.js); 0 draws them from Math.random() again
    deterministic: bool('DETERMINISTIC', true),
    // one "decision ..." line per iteration (and an "outcome ..." line where the
    // result depends on the server) on the console, to diff two runs
    decisionLog: bool('DECISION_LOG', false),
    // names the newcomers of one run; unset, their identities come from the clock
    runId: str('RUN_ID', ''),
};
