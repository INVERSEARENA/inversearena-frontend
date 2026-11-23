ARG NODE_VERSION=20.20.2
ARG NPM_VERSION=10.9.9
ARG PNPM_VERSION=10.11.1
ARG RUST_VERSION=1.82.0
ARG RUST_CI_VERSION=1.96.0
ARG RUST_NIGHTLY_VERSION=nightly-2026-10-01
ARG STELLAR_CLI_VERSION=22.6.0
ARG PRE_COMMIT_VERSION=4.7.0
ARG STELLAR_CLI_SHA256_X86_64=00936c190cb8be4adc1251c758656fff697d7f60e967ed3a782c9d981d0def20
ARG STELLAR_CLI_SHA256_AARCH64=ae07920d46363724e3af27570b41884dacf4e2c73d6184ec816766e3da31179d

FROM mcr.microsoft.com/devcontainers/base:ubuntu

ARG NODE_VERSION
ARG NPM_VERSION
ARG PNPM_VERSION
ARG RUST_VERSION
ARG RUST_CI_VERSION
ARG RUST_NIGHTLY_VERSION
ARG STELLAR_CLI_VERSION
ARG PRE_COMMIT_VERSION
ARG STELLAR_CLI_SHA256_X86_64
ARG STELLAR_CLI_SHA256_AARCH64

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/home/vscode/.cargo/bin:/usr/local/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    gnupg \
    jq \
    make \
    pkg-config \
    python3 \
    python3-pip \
    python3-venv \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-$(dpkg --print-architecture | sed 's/amd64/x64/;s/arm64/arm64/').tar.xz" -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && npm install -g "npm@${NPM_VERSION}" "pnpm@${PNPM_VERSION}" \
    && corepack disable || true

RUN curl https://sh.rustup.rs -sSf | su vscode -c "sh -s -- -y --default-toolchain ${RUST_VERSION} --profile minimal -c rustfmt -c clippy -t wasm32-unknown-unknown -t wasm32v1-none" \
    && su vscode -c "/home/vscode/.cargo/bin/rustup toolchain install ${RUST_CI_VERSION} --profile minimal -c rustfmt -c clippy -t wasm32-unknown-unknown -t wasm32v1-none" \
    && su vscode -c "/home/vscode/.cargo/bin/rustup toolchain install ${RUST_NIGHTLY_VERSION} --profile minimal -c llvm-tools-preview -t wasm32v1-none" \
    && su vscode -c "/home/vscode/.cargo/bin/rustup default ${RUST_VERSION}"

RUN ARCH="$(dpkg --print-architecture)" \
    && case "$ARCH" in \
      amd64) TARGET="x86_64-unknown-linux-gnu"; SHA="$STELLAR_CLI_SHA256_X86_64" ;; \
      arm64) TARGET="aarch64-unknown-linux-gnu"; SHA="$STELLAR_CLI_SHA256_AARCH64" ;; \
      *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac \
    && URL="https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-${TARGET}.tar.gz" \
    && curl -fsSL "$URL" -o /tmp/stellar-cli.tar.gz \
    && echo "${SHA}  /tmp/stellar-cli.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/stellar-cli.tar.gz -C /tmp \
    && install -m 0755 "/tmp/stellar-cli-${STELLAR_CLI_VERSION}-${TARGET}/stellar" /usr/local/bin/stellar \
    && ln -sf /usr/local/bin/stellar /usr/local/bin/soroban \
    && rm -rf /tmp/stellar-cli.tar.gz "/tmp/stellar-cli-${STELLAR_CLI_VERSION}-${TARGET}"

RUN python3 -m pip install --no-cache-dir --break-system-packages "pre-commit==${PRE_COMMIT_VERSION}"

USER vscode
WORKDIR /workspaces/inversearena-frontend
