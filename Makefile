# Usage: make build && make seed && make load BACKEND=postgres
# Every variable can be overridden on the command line or via the environment.
TARGET      ?= localhost:8000
TARGET_FQDN ?= localhost
SEED        ?= concrnt-loadtest
USERS       ?= 100
BACKEND     ?= unknown
CAPTCHA     ?=
METRICS_URL ?= http://localhost:8001/metrics
K6          ?= ./k6
STAMP       := $(shell date +%Y%m%d-%H%M%S)
ENV         := -e TARGET=$(TARGET) -e TARGET_FQDN=$(TARGET_FQDN) -e SEED=$(SEED) -e USERS=$(USERS) -e CAPTCHA=$(CAPTCHA)
K6_EXTRA    ?=

.PHONY: build test plan decisions seed load smoke metrics

build:
	GOWORK=off xk6 build --with github.com/concrnt/xk6-concrnt=.

test:
	GOWORK=off go vet ./... && GOWORK=off go test ./...
	node --test scenarios/test/plan.test.mjs

# what load.js will decide for this SEED and profile, without a server (pass the profile with K6_EXTRA="-e ...")
plan:
	@$(K6) run --quiet $(ENV) $(K6_EXTRA) scenarios/plan.js

# the decision stream of a finished run (DECISION_LOG=1), sorted, to diff against another run or `make plan`
decisions:
	@sed -n 's/.*msg="\(decision [^"]*\)".*/\1/p' $(LOG) | sort

seed:
	$(K6) run $(ENV) -e PHASE=register $(K6_EXTRA) scenarios/seed.js
	$(K6) run $(ENV) -e PHASE=social $(K6_EXTRA) scenarios/seed.js

load: results
	$(K6) run $(ENV) --summary-export results/$(BACKEND)-$(STAMP).json $(K6_EXTRA) scenarios/load.js

# tiny end-to-end run to validate a server before a real measurement
smoke: results
	$(K6) run $(ENV) -e USERS=5 -e SEED_VUS=2 -e PHASE=register -e POSTS_PER_USER=3 scenarios/seed.js
	$(K6) run $(ENV) -e USERS=5 -e SEED_VUS=2 -e PHASE=social -e FOLLOWS=3 -e LIKES_PER_USER=2 scenarios/seed.js
	$(K6) run $(ENV) -e USERS=5 -e FOLLOWS=3 -e LURKERS=3 -e DURATION=1m -e SESSION_SECONDS=30 \
		-e POST_RATE=0.2 -e ENGAGE_RATE=0.2 -e BROWSE_RATE=0.2 \
		--summary-export results/smoke-$(BACKEND)-$(STAMP).json scenarios/load.js

# server-side counters worth snapshotting before and after a run
metrics: results
	curl -sf $(METRICS_URL) | grep -E '^(concrnt_jobqueue|go_sql|concrnt_realtime_connections|concrnt_echo_request_duration_seconds_(count|sum))' \
		| tee results/metrics-$(BACKEND)-$(STAMP).txt

results:
	mkdir -p results
