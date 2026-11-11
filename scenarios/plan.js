// Dry run: prints what load.js will decide for this SEED and profile, without a
// server. Same -e variables as load.js.
//   k6 run --quiet -e SEED=... -e USERS=... scenarios/plan.js > plan.txt
// The "decision" lines are the ones load.js logs with DECISION_LOG=1; the
// "plan" lines summarise them (who the popular posters are, events to expect).
import { cfg } from './lib/env.js';
import { decide, decisionLine, plannedIterations, ratePerMinute, subscribersOf, isPopular, popularCount } from './lib/plan.js';

export const options = { vus: 1, iterations: 1 };

export default function () {}

export function render() {
    const planned = plannedIterations();
    const out = [];
    const summary = [
        `plan seed=${cfg.seed} workload_seed=${cfg.workloadSeed} deterministic=${cfg.deterministic} users=${cfg.users} follows=${cfg.follows} popular=${popularCount} lurkers=${cfg.lurkers}`,
        `plan subscribers popular=${subscribersOf(0)} (sessions listening to one popular home timeline)`,
    ];
    for (const [name, n] of Object.entries(planned)) {
        const count = {};
        let popular = 0;
        let created = 0;
        const popularAt = [];
        const at = (i, perSecond) => `${i}@${Math.round((i * 60) / ratePerMinute(perSecond))}s`;
        for (let i = 0; i < n; i++) {
            const d = decide[name](i);
            out.push(decisionLine(name, i, d));
            const kind = d.action || d.view;
            if (kind) count[kind] = (count[kind] || 0) + 1;
            if (name !== 'lurkers' && isPopular(d.me)) popular++;
            // a reply or a reroute is also a post on the home timeline of its author
            if (name === 'engagers' && isPopular(d.me) && (d.action === 'reply' || d.action === 'reroute')) popularAt.push(at(i, cfg.engageRate));
            if (name === 'posters') {
                created += subscribersOf(d.me);
                if (isPopular(d.me)) popularAt.push(at(i, cfg.postRate));
            }
        }
        let line = `plan ${name} iterations=${n}`;
        if (name !== 'lurkers' && name !== 'newcomers') line += ` by_popular_user=${popular}`;
        for (const [k, v] of Object.entries(count)) line += ` ${k}=${v}`;
        if (name === 'posters') line += ` popular_posts=[${popularAt.join(',')}] expected_created_events=${created}`;
        if (name === 'engagers') line += ` popular_replies_reroutes=[${popularAt.join(',')}]`;
        summary.push(line);
    }
    return `${summary.join('\n')}\n${out.join('\n')}\n`;
}

export function handleSummary() {
    return { stdout: render() };
}
