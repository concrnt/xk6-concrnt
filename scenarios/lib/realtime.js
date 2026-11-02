import { WebSocket } from 'k6/websockets';
import { check } from 'k6';
import { cfg } from './env.js';
import { metrics } from './api.js';

// world-app opens one socket per host, sends the full prefix list on open and
// re-sends it every 30s as a heartbeat (the server answers "subscribed")
export function openRealtime(prefixes, onEvent) {
    const ws = new WebSocket(cfg.wsURL);
    let heartbeat = null;
    const listen = () => ws.send(JSON.stringify({ type: 'listen', prefixes }));
    ws.onopen = () => {
        listen();
        heartbeat = setInterval(listen, 30000);
    };
    ws.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        if (ev.type === 'subscribed') {
            check(ev, { 'realtime subscribed': (v) => v.prefixes.length === prefixes.length });
            return;
        }
        metrics.realtimeEvents.add(1, { type: ev.type });
        if (ev.type === 'created' && ev.documents) {
            // the oldest createdAt among the carried documents is the original post
            let oldest = Infinity;
            for (const sd of Object.values(ev.documents)) {
                const t = Date.parse(JSON.parse(sd.document).createdAt);
                if (t && t < oldest) oldest = t;
            }
            if (oldest !== Infinity) metrics.realtimeLatency.add(Date.now() - oldest);
        }
        if (onEvent) onEvent(ev);
    };
    ws.onerror = (e) => console.error(`realtime error: ${e.error}`);
    return {
        close() {
            if (heartbeat) clearInterval(heartbeat);
            ws.close();
        },
    };
}
