# k6 with the concrnt extension and the world-app shaped scenarios baked in.
#   docker build -t <registry>/xk6-concrnt:<tag> .
#   docker run --rm <image> run -e TARGET=host:8000 /scenarios/load.js
FROM golang:1.26 AS build
WORKDIR /src
RUN go install go.k6.io/xk6/cmd/xk6@latest
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN GOWORK=off xk6 build --with github.com/concrnt/xk6-concrnt=/src --output /k6

FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /k6 /usr/local/bin/k6
COPY scenarios /scenarios
WORKDIR /scenarios
ENTRYPOINT ["/usr/local/bin/k6"]
