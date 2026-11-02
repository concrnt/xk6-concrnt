const e = __ENV;
const str = (k, d) => (e[k] ? e[k] : d);
const num = (k, d) => (e[k] ? Number(e[k]) : d);
const bool = (k, d) => (e[k] ? ['1', 'true', 'yes'].includes(e[k].toLowerCase()) : d);

const target = str('TARGET', 'localhost:8000');
const secure = bool('SECURE', false);

export const cfg = {
    target,
    secure,
    fqdn: str('TARGET_FQDN', 'localhost'),
    baseURL: `${secure ? 'https' : 'http'}://${target}`,
    wsURL: `${secure ? 'wss' : 'ws'}://${target}/api/v2/realtime`,
    seed: str('SEED', 'concrnt-loadtest'),
    users: num('USERS', 100),
    follows: num('FOLLOWS', 20),
    postsPerUser: num('POSTS_PER_USER', 10),
    likesPerUser: num('LIKES_PER_USER', 5),
    seedVUs: num('SEED_VUS', 10),
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
};
