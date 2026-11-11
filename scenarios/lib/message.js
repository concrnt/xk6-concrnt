import { SCHEMA, uri } from './world.js';
import { metrics, resolveCached, desc, batch, items, associationsURL, associationCountsURL } from './api.js';

// Message.load in worldlib: the record/author/profile come from the cache after
// the first time, the three association calls are made on every render
export function loadMessage(href, me, depth = 1) {
    const start = Date.now();
    const sd = resolveCached(href, me);
    if (!sd) {
        metrics.messageLoad.add(Date.now() - start, { result: 'missing' });
        return null;
    }
    const doc = JSON.parse(sd.document);
    resolveCached(uri.entity(doc.author), me);
    resolveCached(uri.profile(doc.author), me);
    const assoc = batch([
        desc('associations', associationsURL({ uri: href, author: me.ccid, limit: 100 }), me),
        desc('association-counts', associationCountsURL({ uri: href }), me),
        desc('association-counts', associationCountsURL({ uri: href, schema: SCHEMA.reaction }), me),
    ]);
    if (depth > 0) {
        const target =
            doc.kind === 'association'
                ? doc.associate
                : doc.schema === SCHEMA.reply || doc.schema === SCHEMA.reroute
                  ? doc.value.targetURI
                  : null;
        if (target) loadMessage(target, me, depth - 1);
    }
    metrics.messageLoad.add(Date.now() - start, { result: 'ok' });
    // mine: the viewer's own associations on this message (what world-app uses to show "liked")
    return { href, doc, sd, mine: () => items(assoc[0]).map((a) => JSON.parse(a.document)) };
}

export const reloadAssociations = (href, me) =>
    batch([
        desc('associations', associationsURL({ uri: href, author: me.ccid, limit: 100 }), me),
        desc('association-counts', associationCountsURL({ uri: href }), me),
        desc('association-counts', associationCountsURL({ uri: href, schema: SCHEMA.reaction }), me),
    ]);
