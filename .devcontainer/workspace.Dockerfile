FROM golang:1.26-bookworm AS utls-builder

WORKDIR /src
COPY native/utls/go.mod native/utls/go.sum ./
RUN go mod download
COPY native/utls/ ./
RUN go test ./... && CGO_ENABLED=0 go build -trimpath -o /out/utls-worker .

FROM scratch AS utls-binary
COPY --from=utls-builder /out/utls-worker /utls-worker

FROM mcr.microsoft.com/devcontainers/typescript-node:24-bookworm

COPY --from=utls-builder /out/utls-worker /usr/local/bin/utls-worker
USER root
WORKDIR /workspace

CMD ["sleep", "infinity"]
