# world-app 相当の負荷試験シナリオ

concrnt v2 サーバーに対し、world-app が実際に発行する API 列(起動時の一括取得、ホームタイムライン+1 件毎の association 3 呼び出し、realtime の 30 秒ハートビート、投稿・いいね・リプライ・リルート、プロフィール/投稿詳細/通知の閲覧)を再現する k6 スクリプトです。リポジトリ層バックエンド(postgres / sqlite / spanner …)を同じ負荷で比較する目的で作られています。

## 構成

| ファイル | 役割 |
|---|---|
| `seed.js` | ユーザー群・デフォルト timeline/list/profile・初期投稿・フォローグラフ・いいねを投入する(2 フェーズ) |
| `load.js` | 定常負荷。`lurkers`(閲覧+realtime)・`posters`・`engagers`・`browsers`・`newcomers` の 5 シナリオ |
| `lib/env.js` | `-e` で渡す設定(下表) |
| `plan.js` | サーバーなしの dry-run。その `SEED`・プロファイルで `load.js` が下す全判断を出力する |
| `lib/plan.js` | `load.js` の全判断(誰が・何を・どの位置の投稿に・どの本文で)を `SEED` + シナリオ名 + iteration 番号から導出する純関数、フォローグラフ、購読者数 |
| `lib/users.js` | `SEED` から決定的に導出する identity/subkey |
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
| `SEED` | `concrnt-loadtest` | identity・フォローグラフ・負荷の判断列のシード |
| `WORKLOAD_SEED` | `SEED` と同じ | 負荷の判断列だけのシード。seed 済みのデータはそのままに別のワークロードを再生する |
| `DETERMINISTIC` | `true` | `0` で判断を `Math.random()` に戻す(以前の挙動) |
| `DECISION_LOG` | `false` | iteration ごとに `decision ...` 行(サーバー状態に依存する結果は `outcome ...` 行)をコンソールに出す |
| `RUN_ID` | 空 | newcomers の identity を `SEED`/`RUN_ID`/iteration から導出する。空なら時刻から(毎回別アカウント) |
| `USERS` | 100 | ユーザー数 |
| `FOLLOWS` | 20 | 1 ユーザーのフォロー数(先頭 5% を「人気ユーザー」として半分まで優先) |
| `POSTS_PER_USER` | 10 | seed 時の初期投稿数 |
| `LIKES_PER_USER` | 5 | seed 時のいいね数 |
| `SEED_VUS` | 100 | seed の並列度 |
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
| `NO_CONNECTION_REUSE` | `false` | リクエストごとに接続を張り直す(k6 の `noConnectionReuse`)。VU は keep-alive 接続をセッション中ずっと持つので、ClusterIP Service 直叩きでは VU の乗る replica が固定され、負荷が replica 間で偏る(5000 DAU r5 では 1 replica に associations の 39 %)。偏りを確認・解消する実験用で、接続確立のコストが加わる |
| `RAMP_UP` / `RAMP_DOWN` | `1m` / `30s` | lurkers のランプ時間。arrival 系シナリオは `RAMP_UP` 後に開始 |
| `POSTER_MAX_VUS` / `ENGAGER_MAX_VUS` / `BROWSER_MAX_VUS` / `NEWCOMER_MAX_VUS` | 50 / 100 / 100 / 10 | 各 arrival シナリオの VU 上限(1/5 を事前確保)。レートを上げるときは `dropped_iterations` を見て上げる |

プリセットの目安: small = 既定値(USERS=100)、medium = `USERS=1000 LURKERS=300 POST_RATE=3 ENGAGE_RATE=6 BROWSE_RATE=6`(seed は `SEED_VUS=30`)。

## 再現性(2 つのサーバーに同じワークロードを与える)

`load.js` の判断はすべて `SEED`(または `WORKLOAD_SEED`)+ シナリオ名 + `exec.scenario.iterationInTest` から導出されます(`lib/plan.js`)。VU は並行に走り、arrival-rate の executor は iteration n を空いている VU に渡すので、共有の乱数列や VU ごとの乱数列ではスケジューリングに依存してしまいます。iteration 番号だけを鍵にすれば、どの VU が実行しても同じ判断になります。

| シナリオ | 以前 `Math.random()` だったもの | 現在 |
|---|---|---|
| lurkers | ユーザーは VU 番号、コールド判定、スクロール間隔 | ユーザー = `(iteration % LURKERS) % USERS`(オンラインは常に user 0..LURKERS-1 の各 1 セッション)、コールド判定・スクロール間隔は iteration の乱数列 |
| posters | 投稿者、本文 | iteration の乱数列 |
| engagers | 行為者、ホームのどの投稿か、like/reaction/reply/reroute、本文 | 行為者・行為の種類・本文・**位置**(`pick` ∈ [0,1))は iteration の乱数列。対象は「行為者のホームタイムラインが返した投稿のうち `floor(pick × 件数)` 番目」 |
| browsers | 閲覧者、プロフィール/投稿詳細/通知、対象ユーザー、どの投稿か | 同上 |
| newcomers | 初期投稿の本文 | iteration の乱数列。identity は `RUN_ID` を渡さない限り時刻由来(同じサーバーで再実行しても別アカウントになる) |

**保証されること**: 同じ `SEED`・同じプロファイルなら、(シナリオ, iteration) → (行為ユーザー, 行為の種類, 対象の選択規則, 本文) は何回実行しても、どのサーバーに対しても同一です。rate・比率・人気ユーザー/その他の構造は以前のままです(`node --test scenarios/test/plan.test.mjs` が分布を検査します)。

**保証されないこと(サーバーの状態に依存する選択)**: engagers と browsers の対象投稿は「ホームタイムラインの何番目か」までが固定で、その位置にある投稿はサーバーが返す内容次第です。同じ seed データに同じワークロードを与えているので両サーバーが同じように振る舞えば同じ投稿になりますが、タイムラインの並びや件数が違えば(バグ、配送の遅れ、同時刻の投稿の順序、seed データの差)対象も変わります。対象の作者を先に決め打ちする方式にしなかったのは、world-app のユーザーは自分のホームに見えている投稿に反応するので、それをやめるとタイムライン読み込み→反応という呼び出し列と「新しい人気投稿に反応が集中する」偏りの両方が失われるためです。差が出たかどうかは下のカウンタと `outcome` 行で確認できます。そのほか、文書の `createdAt`・CDID は時刻由来、iteration の開始時刻はサーバーの応答時間に左右されます(`dropped_iterations` が 0 でなければ、落ちた分だけ判断列の末尾が実行されません)。

### dry-run と比較

```sh
make plan K6_EXTRA="-e LURKERS=240 -e POST_RATE=1.2 ..." > plan.txt   # k6 run --quiet -e ... scenarios/plan.js と同じ
```

`plan ...` 行は要約(人気ユーザーが投稿する iteration と時刻、posters 由来の `created` イベント期待値など)、`decision ...` 行は `DECISION_LOG=1` の実行がコンソールに出すものと同じ形式です。人気ユーザーが 1 回も投稿しないシードではイベント量が小さくなるので、`plan posters` / `plan engagers` の `popular_*` を見て `WORKLOAD_SEED` を選べます。

```sh
make decisions LOG=a/k6.log > a.txt; make decisions LOG=b/k6.log > b.txt
diff a.txt b.txt                                              # 2 つの実行の判断列(一致するはず)
grep -h '^decision' plan.txt | sort | comm -13 - a.txt        # 計画にない判断(空のはず)
sed -n 's/.*msg="\(outcome [^"]*\)".*/\1/p' a/k6.log | sort   # 状態依存の結果: n=件数 idx=選ばれた位置 author=対象の作者番号 subs=購読セッション数 repeat=既に同じ association あり
```

### ワークロードのカウンタ

`--summary-export` の JSON にはタグ付きサブメトリクスがしきい値のあるものしか出ないため、下のサブメトリクスには必ず通るしきい値 `count>=0` を付けています(合否の基準ではありません)。Prometheus には全タグ付きで出ます。

| メトリクス | タグ | 意味 |
|---|---|---|
| `workload_posts` | `author`=popular\|other, `kind`=post\|reply\|reroute | 200 が返った、作者のホームへ配送される投稿。popular は index < ⌊FOLLOWS/2⌋ |
| `workload_associations` | `target`=popular\|other, `kind`=like\|reaction\|reply\|reroute, `repeat`=true\|false | 200 が返った association。`target` は対象投稿の作者、`repeat` は同じユーザーの同じ like/reaction が既にある(CIP-9 の一意性でイベントは出ない) |
| `realtime_events` | `type`, `author`=popular\|other | lurker が受信したイベント。`author` はイベントの `uri` の所有者(`created` はタイムラインの持ち主、`associated` は対象投稿の作者) |
| `realtime_events_expected` | `type`=created\|associated, `author` | 出るべきイベント数。投稿 1 件につき作者のホームを購読しているオンラインセッション数(`created`)、`repeat` でない association 1 件につき対象作者のホームの購読セッション数(`associated`)を加算 |

読み方: 各サーバーで `realtime_events{type:T}` ÷ `realtime_events_expected{type:T}` ≈ 1.0(`author` 別にも)。2 つのサーバーの間では `workload_posts{...}` が一致し、`workload_associations{target:popular}` と `realtime_events_expected` が一致していれば同じワークロードを受けています(ずれていれば状態依存の選択が分かれたということ)。購読セッション数は「LURKERS 個のスロットが全部オンライン」として静的に数えます。arrival 系シナリオは ramp-up 後から ramp-down 前までしか走らないのでこの前提は成り立ちますが、セッションの切り替わり(終了→次の起動で listen し直すまでの 1 秒前後)に当たったイベントは届かないので、比は 1.0 をわずかに下回ります。newcomers の投稿は誰も購読していないので数えません。

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
- `realtime_events{type:...}` と `realtime_events_expected{type:...}` の比、`workload_posts` / `workload_associations`(「再現性」参照)、`http_req_failed`、`checks`

サーバー側(`make metrics` を実行前後で取る):

- `concrnt_jobqueue_jobs_total{result="dlq"}` は 0 であること。distributes の失敗は commit の 200 には現れず、ここにしか出ない
- `concrnt_jobqueue_backlog{state=...}` が終了後に 0 へ戻ること
- `concrnt_realtime_connections` が LURKERS と一致すること
- `concrnt_echo_request_duration_seconds` の url 別ヒストグラム、`go_sql_*`(postgres のみ)
- `docker stats` の concrnt と DB の CPU/メモリ

## 注意

- arrival-rate の各シナリオは VU を persona 間で使い回すため、resolve キャッシュの温度は VU 単位です(どの VU がどの iteration を実行するかは決定的でないので、キャッシュ済みの resolve の回数は実行ごとにわずかに変わります)。
- `createdAt` は [now−7 日, now+12 時間] に収める必要があり、subkey 署名文書は enact より後でなければなりません。seed で過去日付の投稿は作りません。
- lurker のセッションは timer 駆動(`k6/websockets`)なので `sleep()` を入れないでください。受信処理が止まります。
- 既定の `TARGET_FQDN` は `localhost` です。実在ユーザーのドメインや CCID をスクリプトに書かないでください。
