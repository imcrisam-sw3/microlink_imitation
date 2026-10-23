FROM mcr.microsoft.com/devcontainers/typescript-node:24-bookworm

USER root
WORKDIR /workspace

CMD ["sleep", "infinity"]