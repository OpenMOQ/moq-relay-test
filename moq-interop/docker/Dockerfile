# =============================================================================
# moq-interop — Multi-stage Docker build
#
# Stages
#   builder  — Ubuntu 22.04 + full C++20 toolchain; builds moxygen and all
#              Meta OSS deps via getdeps, then compiles the interop tests.
#   runtime  — Minimal Ubuntu 22.04; contains the interop_tests binary.
#              All Meta OSS deps are statically linked.
#
# Cache strategy
#   getdeps compiles folly/fizz/wangle/mvfst/proxygen/moxygen from source
#   (30–60 min cold build) into /tmp/fbcode_builder_getdeps-*/. That directory
#   is wired to a BuildKit persistent cache volume (--mount=type=cache) rather
#   than a regular Docker layer, so it survives Dockerfile edits without
#   needing to be invalidated or re-built.
#
#   Subsequent builds (e.g. after editing interop_tests source) still get the
#   full cached getdeps tree and only spend the ~1 min on the test compile.
#
# Build context: moq-interop/
# Usage:        see Makefile  (make build / make run / make tests / …)
# =============================================================================

# ── Build arguments ──────────────────────────────────────────────────────────
ARG UBUNTU_VERSION=22.04
# Set to 0 to produce a smaller image without the moqtest_client binary and
# conformance_test.sh.  Default is 1 (include conformance tooling).
ARG WITH_CONFORMANCE=1

# =============================================================================
# Stage 1 — builder
# =============================================================================
FROM ubuntu:${UBUNTU_VERSION} AS builder

ARG DEBIAN_FRONTEND=noninteractive
# Respect parallelism passed from the host (Makefile sets this automatically).
ARG NPROC=4
# Re-declare global ARG so this stage's RUN commands can access its value.
ARG WITH_CONFORMANCE

# ── System toolchain + getdeps runtime requirements ──────────────────────────
# We keep this intentionally lean: getdeps builds its own copies of folly,
# fizz, wangle, mvfst, proxygen, boost, libevent, etc.
# System deps are for the compiler/build system and a few build-script tools.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        # Compiler — gcc-11 ships with build-essential on Ubuntu 22.04
        build-essential \
        # Build systems
        cmake \
        ninja-build \
        make \
        # getdeps runtime
        python3 \
        python3-dev \
        python3-pip \
        # Source control / downloads
        git \
        wget \
        curl \
        ca-certificates \
        unzip \
        # Autotools (required by several getdeps packages)
        autoconf \
        automake \
        libtool \
        pkg-config \
        bison \
        flex \
        # Headers that getdeps packages rely on from the system
        libssl-dev \
        zlib1g-dev \
        libjemalloc-dev \
        libunwind-dev \
        libiberty-dev \
        # Miscellaneous utilities used by build scripts
        patch \
        perl \
        # Required at link time: getdeps-built libunwind.a references liblzma
        liblzma-dev \
        # Used in the staging step to strip embedded RPATH from the binary so
        # the runtime stage can resolve shared libs via /opt/moq/lib + ldconfig
        patchelf \
    && rm -rf /var/lib/apt/lists/*

# Use GCC — gcc-11 ships with build-essential on Ubuntu 22.04 and handles
# the full moxygen/proxygen/folly dependency tree without the structured-
# binding capture strictness that clang-14 enforces.
ENV CC=gcc CXX=g++

# Deterministic getdeps scratch path (sources, build dirs, install prefix).
# Both setup-deps.sh and build.sh honor MOXYGEN_SCRATCH and pass --scratch-path
# to every getdeps invocation.  This path is mounted as a BuildKit persistent
# cache below so the 30–60 min cold compile is paid only once.
ENV MOXYGEN_SCRATCH=/var/cache/getdeps

WORKDIR /workspace

# ── Layer 2 — moxygen submodule ───────────────────────────────────────────────────────
# Copy only the moxygen submodule and helper scripts.
COPY moqt_implementation/moxygen/moxygen/ ./moqt_implementation/moxygen/moxygen/
COPY moqt_implementation/moxygen/scripts/ ./moqt_implementation/moxygen/scripts/

# ── Layer 3 — Meta OSS deps + moxygen (BuildKit persistent cache) ────────────
# getdeps.py fetches, patches, and compiles:
#   folly → fizz → wangle → mvfst → proxygen → moxygen
# All artefacts go into ${MOXYGEN_SCRATCH} which is mounted as a BuildKit
# persistent cache volume.  This volume survives across ALL builds regardless
# of whether earlier Dockerfile layers changed, so the 30–60 min compile is
# paid only once (cold) and never again unless the moxygen submodule changes.
#
# When WITH_CONFORMANCE=1 (default) we also build moqtest_client and
# moqtest_server from the moxygen samples.  Both are needed by the conformance
# target: moqtest_server connects to the relay as a publisher and
# moqtest_client probes it.
RUN --mount=type=cache,id=moq-interop-getdeps-v2,target=/var/cache/getdeps,sharing=locked \
    set -e; \
    cd /workspace/moqt_implementation/moxygen && bash scripts/setup-deps.sh; \
    mkdir -p /opt/moq/moxygen-tools; \
    if [ "${WITH_CONFORMANCE}" = "1" ]; then \
        cd /workspace/moqt_implementation/moxygen/moxygen; \
        GETDEPS="./build/fbcode_builder/getdeps.py"; \
        eval "$(python3 $GETDEPS --scratch-path "$MOXYGEN_SCRATCH" --install-prefix "$MOXYGEN_SCRATCH/installed" env moxygen)"; \
        echo "==> Building moqtest_client and moqtest_server from workspace source..."; \
        mkdir -p /tmp/moqtest-build; \
        cmake -S /workspace/moqt_implementation/moxygen/moxygen \
              -B /tmp/moqtest-build \
              -DBUILD_SAMPLES=ON \
              -DBUILD_TESTS=OFF; \
        cmake --build /tmp/moqtest-build --target moqtest_client moqtest_server -- -j${NPROC}; \
        cp /tmp/moqtest-build/moxygen/moqtest/moqtest_client /opt/moq/moxygen-tools/moqtest_client; \
        cp /tmp/moqtest-build/moxygen/moqtest/moqtest_server /opt/moq/moxygen-tools/moqtest_server; \
        echo "==> moqtest tooling pre-staged to /opt/moq/moxygen-tools/"; \
        ls -la /opt/moq/moxygen-tools/; \
    else \
        echo "==> WITH_CONFORMANCE=0: skipping moqtest tooling build."; \
    fi

# ── Layer 4 — interop tests source (changes frequently, cheap to rebuild) ────
COPY moq-interop_tests/ ./moq-interop_tests/

# ── Layer 5 — build interop_tests binary and stage it ───────────────────────
# build.sh emits ~2 MiB of verbose getdeps/cmake output that clips the log
# before configure/link errors become visible.  Redirect to a file; on failure
# the last 80 lines are printed so the actual error is always shown.
RUN --mount=type=cache,id=moq-interop-getdeps-v2,target=/var/cache/getdeps,sharing=locked \
    set -e; \
    if [ -z "$(ls "$MOXYGEN_SCRATCH"/installed/folly/lib/libfolly.* 2>/dev/null)" ]; then \
        echo "==> BuildKit cache was evicted — re-running setup-deps.sh to repopulate..."; \
        cd /workspace/moqt_implementation/moxygen && bash scripts/setup-deps.sh; \
    else \
        echo "==> getdeps cache intact, skipping setup-deps.sh"; \
    fi; \
    cd /workspace/moq-interop_tests; \
    bash scripts/build.sh > /tmp/build-docker.log 2>&1 || { echo "==> build.sh FAILED:"; tail -80 /tmp/build-docker.log; exit 1; }; \
    echo "==> build.sh succeeded. Last configure/build lines:"; \
    tail -20 /tmp/build-docker.log; \
    mkdir -p /opt/moq/bin /opt/moq/lib; \
    cp /workspace/moq-interop_tests/build/bin/interop_tests /opt/moq/bin/interop_tests; \
    chmod +x /opt/moq/bin/interop_tests; \
    patchelf --remove-rpath /opt/moq/bin/interop_tests; \
    echo "==> Staging glog/gflags (.so files):"; \
    for pattern in "glog*/lib/libglog.so*" "gflags*/lib/libgflags.so*"; do \
        find "$MOXYGEN_SCRATCH"/installed/ -path "*/${pattern}" 2>/dev/null | while read f; do \
            cp -L "$f" "/opt/moq/lib/$(basename "$f")" && echo "  staged: $(basename "$f")" || true; \
        done; \
    done; \
    echo "==> Staged libs:"; ls -la /opt/moq/lib/

# ── Layer 6 — moqtest_client + conformance_test.sh (optional) ─────────────────
# Enabled when WITH_CONFORMANCE=1 (the default).  Pass
# --build-arg WITH_CONFORMANCE=0 to produce a smaller image that omits the
# conformance tooling.  The directories are always created so that the
# unconditional COPY instructions in the runtime stage work regardless.
# Binaries are taken from /opt/moq/moxygen-tools/ which was populated by
# Layer 3 (setup-deps + moqtest build) and lives in a regular Docker layer —
# no BuildKit cache dependency here.
RUN set -e; \
    mkdir -p /opt/moq/moxygen/moqtest /opt/moq/conformance; \
    if [ "${WITH_CONFORMANCE}" = "1" ]; then \
        TOOLS=/opt/moq/moxygen-tools; \
        if [ ! -x "${TOOLS}/moqtest_client" ]; then \
            echo "ERROR: moqtest_client not found at ${TOOLS}/moqtest_client" >&2; \
            echo "  This means the moxygen build layer did not compile moqtest." >&2; \
            echo "  Rebuild with --no-cache to trigger a full getdeps rebuild." >&2; \
            exit 1; \
        fi; \
        echo "==> Staging moqtest_client from ${TOOLS}/moqtest_client"; \
        cp "${TOOLS}/moqtest_client" /opt/moq/moxygen/moqtest/moqtest_client; \
        chmod +x /opt/moq/moxygen/moqtest/moqtest_client; \
        patchelf --remove-rpath /opt/moq/moxygen/moqtest/moqtest_client; \
        if [ ! -x "${TOOLS}/moqtest_server" ]; then \
            echo "ERROR: moqtest_server not found at ${TOOLS}/moqtest_server." >&2; \
            echo "  This means the moxygen build layer did not produce moqtest_server." >&2; \
            echo "  Rebuild with --no-cache to trigger a full getdeps rebuild." >&2; \
            exit 1; \
        fi; \
        echo "==> Staging moqtest_server from ${TOOLS}/moqtest_server"; \
        cp "${TOOLS}/moqtest_server" /opt/moq/moxygen/moqtest/moqtest_server; \
        chmod +x /opt/moq/moxygen/moqtest/moqtest_server; \
        patchelf --remove-rpath /opt/moq/moxygen/moqtest/moqtest_server; \
        cp /workspace/moqt_implementation/moxygen/moxygen/moxygen/moqtest/conformance_test.sh \
           /opt/moq/conformance/conformance_test.sh; \
        chmod +x /opt/moq/conformance/conformance_test.sh; \
        echo "==> Conformance tooling staged."; \
    else \
        echo "==> WITH_CONFORMANCE=0: skipping moqtest tooling and conformance_test.sh."; \
    fi

# =============================================================================
# Stage 2 — runtime
# =============================================================================
FROM ubuntu:${UBUNTU_VERSION} AS runtime

LABEL org.opencontainers.image.source="https://github.com/openmoq/moq-relay-test" \
      org.opencontainers.image.title="moq-interop"

ARG DEBIAN_FRONTEND=noninteractive

# Install only what the dynamic linker will need at runtime.
# (All Meta OSS code is statically linked; the only dynamic deps are
#  standard system libs and OpenSSL below.)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libssl3 \
        zlib1g \
        libunwind8 \
        libjemalloc2 \
        liblzma5 \
        libsnappy1v5 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/moq/bin/interop_tests /opt/moq/bin/interop_tests
# Bundle any getdeps-built shared libs the binary was dynamically linked against
# (e.g. libglog, libgflags built with a different ABI than the system package).
COPY --from=builder /opt/moq/lib/ /opt/moq/lib/
# Conformance tooling — moqtest_client binary and conformance_test.sh.
# These directories are always present in the builder (empty when
# WITH_CONFORMANCE=0), so this COPY is unconditional.
COPY --from=builder /opt/moq/moxygen/ /opt/moq/moxygen/
COPY --from=builder /opt/moq/conformance/ /opt/moq/conformance/
# Register /opt/moq/lib in the dynamic linker cache so the binary can find
# the bundled glog/gflags at runtime without an LD_LIBRARY_PATH override.
RUN echo "/opt/moq/lib" > /etc/ld.so.conf.d/moq.conf && ldconfig

COPY docker/entrypoint.sh /opt/moq/entrypoint.sh
COPY docker/run_conformance.sh /opt/moq/conformance/run_conformance.sh
RUN chmod +x /opt/moq/entrypoint.sh /opt/moq/bin/interop_tests /opt/moq/conformance/run_conformance.sh

ENV PATH="/opt/moq/bin:${PATH}"

ENTRYPOINT ["/opt/moq/entrypoint.sh"]
CMD ["--relay=https://localhost:4433/moq"]
