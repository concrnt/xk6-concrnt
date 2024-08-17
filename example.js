import http from "k6/http";
import { sleep, check } from "k6";
import concrnt from 'k6/x/concrnt';
import { WebSocket } from "k6/experimental/websockets";

const maxVU = 100;
const isSecure = false;
const target = 'localhost:8080';
const targetFQDN = 'example.com'; // TODO: REPLACE WITH YOUR DOMAIN
const timelineID = 'SET_YOUR_TIMELINE_ID_HERE'; // TODO: REPLACE WITH YOUR TIMELINE ID

const apiBase = `${isSecure ? 'https' : 'http'}://${target}/api/v1`;

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

const postDocument = (identity, document, option) => {
    const signedDoc = JSON.stringify(document);
    const signature = concrnt.sign(identity.privkey, signedDoc);

    const body = JSON.stringify({
        document: signedDoc,
        signature: signature,
        option: JSON.stringify(option),
    });

    return http.post(
        `${apiBase}/commit`,
        body,
        {
            headers: {
                'Content-Type': 'application/json',
            },
        }
    );
}

const readTimeline = () => {

    const timelineresp = http.get(
        `${apiBase}/timelines/recent?timelines=${timelineID}`
    );
    check(timelineresp, {
        'timeline queried': (r) => r.status === 200
    });

    const items = JSON.parse(timelineresp.body).content;
    for (const item of items) {

        const msgresp = http.get(
            `${apiBase}/message/${item.resourceID}`
        );
        check(msgresp, {
            'message found': (r) => r.status === 200
        });
    }

    return items;

}

const readTimelines = (timelines, token) => {

    const timelineresp = http.get(
        `${apiBase}/timelines/recent?timelines=${timelines.join(',')}`
    );

    check(timelineresp, {
        'timelines queried': (r) => r.status === 200
    });

    const items = JSON.parse(timelineresp.body).content;
    for (const item of items) {

        const msgresp = http.get(
            `${apiBase}/message/${item.resourceID}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            }
        );
        check(msgresp, {
            'message found': (r) => r.status === 200
        });
    }

    return items;
}

const attachAssociation = (identity, resourceID, ownerID) => {
    const association = {
        signer: identity.address,
        type: 'association',
        target: resourceID,
        schema: 'https://schema.concrnt.world/a/like.json',
        body: {},
        owner: ownerID,
        timelines: [],
        signedAt: new Date()
    }

    return postDocument(identity, association);
}

export default function () {
    const identity = concrnt.generateIdentity()

    const token = concrnt.generateAuthToken(identity, targetFQDN);

    const affiliation = {
        signer: identity.address,
        type: 'affiliation',
        domain: targetFQDN,
        signedAt: new Date()
    }
    const register = postDocument(identity, affiliation, {
        info: '{}'
    });
    check(register, {
        'affiliation created': (r) => r.status === 201
    });

    const profile = {
        signer: identity.address,
        type: 'profile',
        schema: 'https://schema.concrnt.world/p/main.json',
        body: {
            username: `VU${__VU}`,
        },
        semanticID: 'world.concrnt.p',
        signedAt: new Date()
    }
    const prof = postDocument(identity, profile);
    check(prof, {
        'profile created': (r) => r.status === 201
    });

    const home = {
        signer: identity.address,
        type: 'timeline',
        schema: 'https://schema.concrnt.world/t/empty.json',
        body: {},
        semanticID: 'world.concrnt.t-home',
        policy: 'https://policy.concrnt.world/t/inline-read-write.json',
        policyParams: `{"isWritePublic": false, "isReadPublic": true, "writer": ["${identity.address}"], "reader": []}`,
        signedAt: new Date()
    }
    const homeres = postDocument(identity, home);
    check(homeres, {
        'home timeline created': (r) => r.status === 201
    });

    const ws = new WebSocket(`${isSecure ? 'wss' : 'ws'}://${target}/api/v1/timelines/realtime`);
    ws.binaryType = 'arraybuffer';


    const tl = readTimeline();
    const timelines = tl.map((item) => item.timelineID);

    ws.onopen = () => {
        ws.send(JSON.stringify({
            type: 'listen',
            channels: timelines
        }));

        for (let i = 0; i < 3; i++) {
            const tl = readTimelines(timelines, token);
            const at = attachAssociation(identity, tl[0].resourceID, tl[0].owner);
            check(at, {
                'association created': (r) => r.status === 201
            });

            const message = {
                signer: identity.address,
                type: 'message',
                schema: 'https://schema.concrnt.world/m/markdown.json',
                body: {
                    body: getRandomPost(),
                },
                timelines: [timelineID, `world.concrnt.t-home@${identity.address}`],
                signedAt: new Date()
            }

            const post = postDocument(identity, message);
            check(post, {
                'post created': (r) => r.status === 201
            });
            sleep(3 + Math.random() * 10);
        }

        ws.close();
    };
}
