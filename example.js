import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";
import concrnt from 'k6/x/concrnt';
import { WebSocket } from "k6/websockets";

const maxVU = 100;
const isSecure = false;
const target = 'localhost:8080';
const targetFQDN = 'example.com'; // TODO: REPLACE WITH YOUR DOMAIN (must match the server's fqdn)
const captchaToken = ''; // TODO: set when the server enforces captcha on /register
const targetTimelines = [
    // TODO: REPLACE WITH TIMELINE URIs TO READ/POST. Posts only land on timelines whose policy lets the VUs write.
    'cckv://SET_YOUR_CCID_HERE/concrnt.world/profiles/main/home-timeline',
];

const apiBase = `${isSecure ? 'https' : 'http'}://${target}/api/v2`;
const wsURL = `${isSecure ? 'wss' : 'ws'}://${target}/api/v2/realtime`;

const postSamples = [
    "今日はいい天気ですね！🌞",
    "最近ハマっている本があります📚",
    "#今日のランチはカレーライス🍛",
    "週末に映画を見ました🎬",
    "コーヒーが美味しい朝☕",
    "新しいプロジェクトが始まりました💼",
    "最近運動不足なので、ジョギングを始めました🏃‍♂️",
    "この曲、最高です🎧 #音楽",
    "今日の仕事も頑張ります💪",
    "久しぶりに友達と会いました👫",
    "#DIY 初挑戦！家具を作りました🔨",
    "おすすめのアプリありますか？📱",
    "新しいカフェを見つけました☕ #カフェ巡り",
    "今日は家でのんびり過ごします🏡",
    "誕生日おめでとう！🎉 #誕生日",
    "新しいゲームにハマっています🎮",
    "#写真を撮りました 景色が綺麗です📸",
    "今日の予定は何もない…😴",
    "最近読んだ記事が面白かったです📰",
    "おすすめのレシピを教えてください！🍳",
    "#映画鑑賞 感動しました😢",
    "今日の朝ごはんはパンケーキでした🥞",
    "早く週末が来て欲しい…😅",
    "新しい靴を買いました👟 #ファッション",
    "今日は仕事が捗りました✌️",
    "旅行の計画を立てています✈️ #旅行",
    "ペットが可愛すぎる🐶 #癒し",
    "新しい趣味を始めました🎨 #趣味",
    "今日は健康診断に行ってきました🏥",
    "一日中雨でした…☔ #雨の日",
]

function getRandomPost() {
    return postSamples[Math.floor(Math.random() * postSamples.length)];
}

export const options = {
    thresholds: {
        http_req_duration: ['p(95)<300'],
    },
    stages: [
        { duration: '10s', target: maxVU },
        { duration: '3m', target: maxVU },
        { duration: '10s', target: 0 },
    ],
};

const realtimeEvents = new Counter('realtime_events');

const jsonHeaders = { 'Content-Type': 'application/json' };

const profileURI = (ccid) => `cckv://${ccid}/concrnt.world/profiles/main`;
const timelineURI = (ccid, name) => `${profileURI(ccid)}/${name}-timeline`;
const ownerOf = (uri) => uri.replace(/^cckv:\/\//, '').split(/[@/]/)[0];

const commit = (identity, document) => {
    return http.post(
        `${apiBase}/commit`,
        concrnt.signDocument(identity, JSON.stringify(document)),
        { headers: jsonHeaders },
    );
}

const register = (identity) => {
    const entity = {
        kind: 'entity',
        author: identity.address,
        schema: 'https://schema.concrnt.net/entity.json',
        value: { domain: targetFQDN },
        createdAt: new Date(),
    };
    const signed = JSON.parse(concrnt.signDocument(identity, JSON.stringify(entity)));
    signed.meta = {};

    const headers = Object.assign({}, jsonHeaders);
    if (captchaToken) headers['captcha'] = captchaToken;

    return http.post(`${apiBase}/register`, JSON.stringify(signed), { headers });
}

const createTimeline = (identity, name) => {
    return commit(identity, {
        kind: 'record',
        key: timelineURI(identity.address, name),
        author: identity.address,
        schema: 'https://schema.concrnt.world/t/user.json',
        value: {},
        createdAt: new Date(),
    });
}

const readTimelines = (uris) => {
    const timelineresp = http.get(
        `${apiBase}/timeline/recent?uris=${encodeURIComponent(uris.join(','))}&limit=16`
    );
    check(timelineresp, {
        'timelines queried': (r) => r.status === 200
    });
    if (timelineresp.status !== 200) return [];

    const items = JSON.parse(timelineresp.body);
    for (const item of items) {
        const msgresp = http.get(
            `${apiBase}/resolve?uri=${encodeURIComponent(item.href)}`
        );
        check(msgresp, {
            'post found': (r) => r.status === 200
        });
    }

    return items;
}

const likePost = (identity, href) => {
    return commit(identity, {
        kind: 'association',
        author: identity.address,
        schema: 'https://schema.concrnt.world/a/like.json',
        associate: href,
        value: { profileURI: profileURI(identity.address) },
        distributes: [
            timelineURI(identity.address, 'activity'),
            timelineURI(ownerOf(href), 'notify'),
        ],
        createdAt: new Date(),
    });
}

const post = (identity, body, timelines) => {
    return commit(identity, {
        kind: 'record',
        key: `${profileURI(identity.address)}/posts/${concrnt.newCDID(body)}`,
        author: identity.address,
        schema: 'https://schema.concrnt.world/m/markdown.json',
        value: { body: body, emojis: {} },
        distributes: timelines,
        createdAt: new Date(),
    });
}

export default function () {
    const identity = concrnt.generateIdentity();

    check(register(identity), {
        'entity registered': (r) => r.status === 200
    });

    for (const name of ['home', 'notify', 'activity']) {
        check(createTimeline(identity, name), {
            [`${name} timeline created`]: (r) => r.status === 200
        });
    }

    const profile = commit(identity, {
        kind: 'record',
        key: profileURI(identity.address),
        author: identity.address,
        schema: 'https://schema.concrnt.world/p/main.json',
        value: { username: `VU${__VU}` },
        createdAt: new Date(),
    });
    check(profile, {
        'profile created': (r) => r.status === 200
    });

    const timelines = [...targetTimelines, timelineURI(identity.address, 'home')];

    const ws = new WebSocket(wsURL);
    ws.binaryType = 'arraybuffer';

    ws.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        if (ev.type === 'subscribed') {
            check(ev, {
                'realtime subscribed': (ev) => ev.prefixes.length === timelines.length
            });
        } else {
            realtimeEvents.add(1, { type: ev.type });
        }
    };

    const round = () => {
        const items = readTimelines(timelines);
        if (items.length > 0) {
            check(likePost(identity, items[0].href), {
                'association created': (r) => r.status === 200
            });
        }

        check(post(identity, getRandomPost(), timelines), {
            'post created': (r) => r.status === 200
        });
    };

    // rounds run from timers so the websocket keeps receiving between them
    ws.onopen = () => {
        ws.send(JSON.stringify({
            type: 'listen',
            prefixes: timelines,
        }));

        let remaining = 3;
        const next = () => {
            round();
            remaining--;
            if (remaining > 0) {
                setTimeout(next, (3 + Math.random() * 10) * 1000);
            } else {
                setTimeout(() => ws.close(), 1000);
            }
        };
        next();
    };
}
