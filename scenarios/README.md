# world-app 相当の負荷試験シナリオ

concrnt v2 サーバーに対し、world-app が実際に発行する API 列(起動時の一括取得、ホームタイムライン+1 件毎の association 3 呼び出し、realtime の 30 秒ハートビート、投稿・いいね・リプライ・リルート、プロフィール/投稿詳細/通知の閲覧)を再現する k6 スクリプトです。リポジトリ層バックエンド(postgres / sqlite / spanner …)を同じ負荷で比較する目的で作られています。

## 構成

| ファイル | 役割 |
|---|---|
| `seed.js` | ユーザー群・デフォルト timeline/list/profile・初期投稿・フォローグラフ・いいねを投入する(2 フェーズ) |
| `load.js` | 定常負荷。`lurkers`(閲覧+realtime)・`posters`・`engagers`・`browsers`・`newcomers` の 5 シナリオ |
| `lib/env.js` | `-e` で渡す設定(下表) |
| `lib/users.js` | `SEED` から決定的に導出する identity/subkey とフォローグラフ |
| `lib/world.js` | world-app の URI・schema・document 形 |
| `lib/api.js` | endpoint ラッパー(`tags.name` で endpoint 別集計)、24h キャッシュ付き resolve、カスタム metrics |
| `lib/message.js` | worldlib の `Message.load` 相当(record/entity/profile は cache、association 3 呼び出しは毎回) |
| `lib/realtime.js` | `/api/v2/realtime` の listen・30 秒ハートビート・イベント計測 |
| `lib/register.js` | アカウント作成フロー(seed と newcomers で共用) |

ユーザーは `SEED` と連番から決定的に導出されるので、ファイル共有なしに seed と load が同じユーザー集合・同じフォローグラフを使えます。同じ `SEED`/`USERS`/`FOLLOWS` なら全バックエンドで同一データになります。

## 準備

### 1. サーバー側

`concrnt` の設定(例: `_etc/config/config.yaml`)で:

- `concrnt.registration: open`
- `integrations.captchaSecret` を削除(推奨)。残す場合は `-e CAPTCHA=<任意値>` を渡す。Google の reCAPTCHA テストシークレットなら任意値で通るが、登録ごとに Google へ外部呼び出しが発生する。
- `backends.database` を `postgres` / `sqlite` / `spanner` に切替。sqlite は `_etc` マウントが read-only なので `sqlite.path` は volume 上に置く。spanner は `docker compose --profile spanner up -d spanner-omni` と DB 作成が先(concrnt README 参照)。
- `backends.gatewayAddr` が自サーバーを指していること(compose なら `http://concrnt:8000`)。
- 他人の notify-timeline への配送は `https://policy.concrnt.world/t/write-public.json` を取得して判定するので、サーバーから外向き HTTPS が必要。
- `/metrics` は内部ポート 8001。compose に `"8001:8001"` を足すか `docker compose exec concrnt wget -qO- localhost:8001/metrics` で取る。

バックエンドを切り替えるときは DB だけでなく **redis(`FLUSHALL`)と memcached の再起動**も必要。前バックエンドの record キャッシュ・jobqueue・集計キャッシュが残ると結果が汚れる。

### 2. k6 のビルド

```sh
make build   # GOWORK=off xk6 build --with github.com/concrnt/xk6-concrnt=.
```

## 実行

```sh
# 変数は環境変数または make の引数で渡す
export TARGET=localhost:8000 TARGET_FQDN=example.com   # TARGET_FQDN はサーバーの fqdn と一致させる
make seed                       # PHASE=register → PHASE=social の順に 2 回 k6 を実行
make load BACKEND=postgres      # results/postgres-<timestamp>.json に summary を出力
make metrics BACKEND=postgres   # /metrics の jobqueue / go_sql / realtime / request_duration を保存
```

`make smoke` は USERS=5・1 分の小さな一式で、サーバー設定の確認用です。

`seed` は冪等です。profile が resolve できるユーザーは登録をスキップし、follow が `FOLLOWS` 件以上あるユーザーは social をスキップします(`-e SEED_FORCE=1` で強制)。

### 変数

| 変数 | 既定 | 意味 |
|---|---|---|
| `TARGET` | `localhost:8000` | host:port |
| `SECURE` | `false` | https/wss を使う |
| `TARGET_FQDN` | `localhost` | サーバーの `fqdn`。entity の domain と JWT の aud に使う |
| `SEED` | `concrnt-loadtest` | identity 導出のシード |
| `USERS` | 100 | ユーザー数 |
| `FOLLOWS` | 20 | 1 ユーザーのフォロー数(先頭 5% を「人気ユーザー」として半分まで優先) |
| `POSTS_PER_USER` | 10 | seed 時の初期投稿数 |
| `LIKES_PER_USER` | 5 | seed 時のいいね数 |
| `SEED_VUS` | 10 | seed の並列度 |
| `PHASE` | `register` | seed のフェーズ(`register` / `social`) |
| `CAPTCHA` | 空 | `/register` に付ける `captcha` ヘッダ |
| `SEED_FORCE` | `false` | seed のスキップ判定を無効化 |
| `LURKERS` | 50 | 閲覧 VU 数(1 分でランプアップ) |
| `DURATION` | `10m` | 定常区間 |
| `SESSION_SECONDS` | 120 | 1 閲覧セッションの長さ |
| `POST_RATE` | 0.5 | 投稿 /s |
| `ENGAGE_RATE` | 1 | いいね・リアクション・リプライ・リルート /s(60/15/15/10%) |
| `BROWSE_RATE` | 1 | プロフィール・投稿詳細・通知の閲覧 /s(50/30/20%) |
| `REGISTER_RATE` | 0 | 新規登録 /s(0 で無効) |
| `COLD_RATIO` | 0.1 | 閲覧セッションのうち resolve キャッシュを捨てる割合(初回は常にコールド) |

プリセットの目安: small = 既定値(USERS=100)、medium = `USERS=1000 LURKERS=300 POST_RATE=3 ENGAGE_RATE=6 BROWSE_RATE=6`(seed は `SEED_VUS=30`)。

## 各シナリオが再現する呼び出し

- **lurkers**(ramping-vus): 起動/復帰時の `refreshFreshResources`(well-known、profiles query、pinned lists、list 配下の community/inbox query、acknowledges from/to、blocking query、subscribe counter、settings/themes/emojipacks resolve)→ `timeline/recent?uris=<自分の home + フォロー先の home>` → 16 件それぞれ `Message.load`(record/entity/profile resolve は VU 内 24h キャッシュ、`associations?author=me` + `association-counts` ×2 は毎回)→ WebSocket listen(同じ URI 集合、30 秒毎に再送)。20〜40 秒毎に `until` でスクロール、`created` イベントで該当投稿を load、`associated` で association 3 呼び出し。
- **posters**: markdown 投稿を自分の home-timeline へ distributes。
- **engagers**: 自分のホームから投稿を 1 件選び、like / reaction(先に variant 照会)/ reply(record+association)/ reroute(同)→ association 3 呼び出しで再読込。
- **browsers**: プロフィール(entity/profile resolve、acknowledge-counts ×2、`query?prefix=<home>/&limit=16` + 各 load、1 ページ追加)/ 投稿詳細(load + `associations?schema=reply` + 各 reply の load)/ 通知(subscribe counter DELETE、`query?prefix=<notify>/` + 各 load。association とその対象の両方を load)。
- **newcomers**: 登録 → entity resolve 待ち → subkey enact → timeline ×3 → list/pinnedLists → profile → 初期投稿。

全 commit は world-app と同じ subkey 署名(`concrnt-ecrecover-subkey`)、JWT も `kid` 付き subkey トークンです。enact 文書は master key で署名します。

## 見るべき指標

k6 側(`results/*.json` と標準出力):

- endpoint 別 `http_req_duration{name:...}` の p50/p95/p99 と RPS(`timeline/recent`、`commit`、`associations`、`association-counts`、`query`、`resolve`)
- `message_load_duration`: 1 件の投稿を描画するまでの合計
- `realtime_event_latency`: 投稿の createdAt から `created` イベント受信までの遅延(distributes ジョブの遅れを含む)
- `realtime_events{type:...}`、`http_req_failed`、`checks`

サーバー側(`make metrics` を実行前後で取る):

- `concrnt_jobqueue_jobs_total{result="dlq"}` は 0 であること。distributes の失敗は commit の 200 には現れず、ここにしか出ない
- `concrnt_jobqueue_backlog{state=...}` が終了後に 0 へ戻ること
- `concrnt_realtime_connections` が LURKERS と一致すること
- `concrnt_echo_request_duration_seconds` の url 別ヒストグラム、`go_sql_*`(postgres のみ)
- `docker stats` の concrnt と DB の CPU/メモリ

## 注意

- arrival-rate の各シナリオは VU を persona 間で使い回すため、resolve キャッシュの温度は VU 単位です。
- `createdAt` は [now−7 日, now+12 時間] に収める必要があり、subkey 署名文書は enact より後でなければなりません。seed で過去日付の投稿は作りません。
- lurker のセッションは timer 駆動(`k6/websockets`)なので `sleep()` を入れないでください。受信処理が止まります。
- 既定の `TARGET_FQDN` は `localhost` です。実在ユーザーのドメインや CCID をスクリプトに書かないでください。
