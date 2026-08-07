# =============================================================================
# moq-interop Makefile
# =============================================================================
#
# Builds and runs the moq-interop test suite entirely inside Docker —
# no local C++ toolchain required.
#
# Targets
#   build        Build the moq-interop Docker image (skip if already present).
#   build-force  Unconditionally rebuild the image.
#   tests        Run the interop test binary against a live relay.
#   conformance  Run moxygen's conformance_test.sh against a relay.
#   shell        Open an interactive shell inside the container.
#   clean        Remove the local Docker image.
#   push         Tag and push the image to REGISTRY/IMAGE:TAG.
#   help         Print this help text.
#
# Build overview
#   The Dockerfile uses a two-stage build:
#     builder  — Ubuntu 22.04 + GCC 11; compiles moxygen and all Meta OSS
#                dependencies (folly, fizz, wangle, mvfst, proxygen) via
#                getdeps.py into a deterministic scratch directory
#                (/var/cache/getdeps inside the container), then compiles
#                the interop_tests binary.
#     runtime  — Minimal Ubuntu 22.04; contains only the statically-linked
#                interop_tests binary and optional conformance tooling.
#
#   The getdeps compile (folly/fizz/wangle/mvfst/proxygen/moxygen) takes
#   30–60 minutes on a cold build.  BuildKit caches the result in a
#   persistent cache volume (id=moq-interop-getdeps-v2) so subsequent
#   builds only recompile what changed in the interop tests source.
#
# Common variables (override on the command line)
#   IMAGE             Local image name                   (default: moq-interop)
#   TAG               Image tag                          (default: latest)
#   REGISTRY          Registry prefix for 'push'         (default: empty)
#   RELAY_URL         Relay URL used by 'tests'          (default: https://localhost:4433/moq)
#   TESTS_ARGS        Extra flags passed to interop_tests (default: empty)
#   WITH_CONFORMANCE  Include conformance tooling (0/1)  (default: 1)
#   CONFORMANCE_URL   Relay URL used by 'conformance'    (default: http://localhost:9999)
#   CONFORMANCE_ARGS  Extra args for conformance_test.sh (default: empty)
#   DOCKER_BUILD_FLAGS  Extra flags passed to docker build (default: empty)
#
# localhost rewriting
#   localhost and 127.0.0.1 in RELAY_URL and CONFORMANCE_URL are
#   automatically rewritten to host.docker.internal so the container can
#   reach services running on the host.  On Linux the --add-host flag is
#   added automatically; on macOS Docker Desktop provides the alias natively.
#
# Examples
#   make build
#   make build-force DOCKER_BUILD_FLAGS="--progress=plain"
#   make build WITH_CONFORMANCE=0
#   make tests RELAY_URL=https://relay.example.com:4433/moq
#   make tests RELAY_URL=https://localhost:9668/moq-relay
#   make tests TESTS_ARGS="--categories=Publisher,Subscriber"
#   make tests TESTS_ARGS="--tests=PublishTest"
#   make conformance CONFORMANCE_URL=http://relay.example.com:9999
#   make conformance CONFORMANCE_ARGS="16"
#   make push REGISTRY=ghcr.io/myorg TAG=v1.2.3
# =============================================================================

# ── Image coordinates ────────────────────────────────────────────────────────────────────────────
IMAGE     ?= moq-interop
TAG       ?= latest
REGISTRY  ?=

ifeq ($(REGISTRY),)
  IMAGE_REF := $(IMAGE):$(TAG)
else
  IMAGE_REF := $(REGISTRY)/$(IMAGE):$(TAG)
endif

# ── Runtime parameters ────────────────────────────────────────────────────────────────────
RELAY_URL   ?= https://localhost:4433/moq
TESTS_ARGS  ?=

# Rewrite localhost / 127.0.0.1 → host.docker.internal so the container can
# reach a relay running on the host.  Docker Desktop on macOS provides the
# alias automatically; on Linux the --add-host=host.docker.internal:host-gateway
# flag (added on the docker run line) creates it.
RELAY_URL_DOCKER := $(subst 127.0.0.1,host.docker.internal,$(subst localhost,host.docker.internal,$(RELAY_URL)))

# ── Conformance test parameters ───────────────────────────────────────────────────────
# WITH_CONFORMANCE=1 (default) builds and stages moqtest_client and
# conformance_test.sh inside the image, enabling the 'conformance' target.
# Set to 0 (make build WITH_CONFORMANCE=0) for a smaller image that only
# contains interop_tests.
WITH_CONFORMANCE  ?= 1
CONFORMANCE_URL   ?= http://localhost:9999
CONFORMANCE_ARGS  ?=

CONFORMANCE_URL_DOCKER := $(subst 127.0.0.1,host.docker.internal,$(subst localhost,host.docker.internal,$(CONFORMANCE_URL)))

# ── Build parameters ────────────────────────────────────────────────────────────────────────────
# CPU count forwarded to getdeps and ninja via the NPROC build-arg.
NPROC := $(shell nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 4)

# Extra flags forwarded verbatim to docker build.
# Useful values:
#   --progress=plain   verbose, non-TTY output (good for CI / log files)
#   --no-cache         force a completely clean rebuild
DOCKER_BUILD_FLAGS ?=

# ── Paths ─────────────────────────────────────────────────────────────────────────────────────
# Build context = the directory this Makefile lives in (moq-interop/).
BUILD_CTX  := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
DOCKERFILE := $(BUILD_CTX)/docker/Dockerfile

DOCKER := docker
# BuildKit is required for --mount=type=cache in the Dockerfile, which
# persists the getdeps build tree (folly/fizz/wangle/mvfst/proxygen/moxygen)
# across builds in a named cache volume (id=moq-interop-getdeps-v2).
# BuildKit is the default backend since Docker 23.x; this export ensures it
# is active on older Docker versions as well.
export DOCKER_BUILDKIT := 1

# ── Phony declarations ────────────────────────────────────────────────────────────────────────
.PHONY: all build build-force tests conformance shell clean push help

all: tests

# ── build ─────────────────────────────────────────────────────────────────────────────
# Builds the image only if it does not already exist locally.
# Skips the build entirely when the image is already present — use
# 'make build-force' to rebuild, or 'make clean && make build' to start fresh.
build:
	@if [ -z "$$($(DOCKER) images -q $(IMAGE_REF) 2>/dev/null)" ]; then \
		echo "==> Image $(IMAGE_REF) not found — building..."; \
		$(DOCKER) build \
			$(DOCKER_BUILD_FLAGS) \
			--build-arg NPROC=$(NPROC) \
			--build-arg WITH_CONFORMANCE=$(WITH_CONFORMANCE) \
			-t $(IMAGE_REF) \
			-f $(DOCKERFILE) \
			$(BUILD_CTX); \
	else \
		echo "==> Image $(IMAGE_REF) already exists — skipping build. Use 'make build-force' to rebuild."; \
	fi

# ── build-force ───────────────────────────────────────────────────────────────────────
# Unconditionally rebuilds the Docker image.  Docker layer caches and the
# BuildKit getdeps volume are still reused when available, so only layers
# that changed since the last build are recompiled.  Pass
# DOCKER_BUILD_FLAGS=--no-cache to force a completely clean rebuild.
build-force:
	$(DOCKER) build \
		$(DOCKER_BUILD_FLAGS) \
		--build-arg NPROC=$(NPROC) \
		--build-arg WITH_CONFORMANCE=$(WITH_CONFORMANCE) \
		-t $(IMAGE_REF) \
		-f $(DOCKERFILE) \
		$(BUILD_CTX)


# ── tests ─────────────────────────────────────────────────────────────────────────────
# Runs interop_tests inside the container against a relay at RELAY_URL.
# The relay must be running before invoking this target.
# localhost/127.0.0.1 in RELAY_URL are automatically rewritten to
# host.docker.internal so the container can reach the host relay.
# Use TESTS_ARGS to pass additional flags to interop_tests, e.g.:
#   make tests TESTS_ARGS="--tests=PublishTest"
#   make tests TESTS_ARGS="--categories=Publisher,Subscriber"
#   make tests TESTS_ARGS="--list"
tests: build
	$(DOCKER) run --rm \
		--name moq-interop-tests \
		--add-host=host.docker.internal:host-gateway \
		$(IMAGE_REF) --relay=$(RELAY_URL_DOCKER) $(TESTS_ARGS)

# ── interactive shell ───────────────────────────────────────────────────────────────
# Opens a bash shell in the runtime container.  Useful for ad-hoc inspection
# or running interop_tests with custom arguments.
shell: build
	$(DOCKER) run --rm -it \
		--name moq-interop-shell \
		--add-host=host.docker.internal:host-gateway \
		--entrypoint /bin/bash \
		$(IMAGE_REF)

# ── clean ─────────────────────────────────────────────────────────────────────────────────────
# Removes the local Docker image.  Does NOT prune the BuildKit cache volume
# (moq-interop-getdeps-v2); to wipe that too run:
#   docker buildx prune --filter type=exec.cachemount --force
clean:
	$(DOCKER) rmi -f $(IMAGE_REF) 2>/dev/null || true

# ── push ──────────────────────────────────────────────────────────────────────────────────────
# Pushes the image to REGISTRY/IMAGE:TAG.  REGISTRY must be set.
# Example: make push REGISTRY=ghcr.io/myorg TAG=v1.2.3
push: build
	$(DOCKER) push $(IMAGE_REF)

# ── conformance ───────────────────────────────────────────────────────────────────────────────
# Runs moxygen's conformance_test.sh inside the container against CONFORMANCE_URL.
# Requires the image to have been built with WITH_CONFORMANCE=1 (the default).
# The relay must be running before invoking this target.
# CONFORMANCE_ARGS is passed verbatim to conformance_test.sh — for example,
# pass "16" to restrict testing to MoQT draft-16.
conformance: build
	@if [ "$(WITH_CONFORMANCE)" = "0" ]; then \
		echo "Error: image built without conformance tooling (WITH_CONFORMANCE=0)." >&2; \
		echo "  Rebuild with: make build WITH_CONFORMANCE=1" >&2; \
		exit 1; \
	fi
	$(DOCKER) run --rm \
		--name moq-interop-conformance \
		--add-host=host.docker.internal:host-gateway \
		--entrypoint /opt/moq/conformance/run_conformance.sh \
		$(IMAGE_REF) $(CONFORMANCE_URL_DOCKER) $(CONFORMANCE_ARGS)

# ── help ──────────────────────────────────────────────────────────────────────────────────────
help:
	@printf '\nmoq-interop — available make targets\n\n'
	@printf '  %-14s  %s\n' build        'Build image only if it does not already exist locally'
	@printf '  %-14s  %s\n' build-force  'Unconditionally rebuild the Docker image'
	@printf '  %-14s  %s\n' tests        'Run the interop tests (auto-builds if image absent)'
	@printf '  %-14s  %s\n' conformance  'Run moxygen conformance tests against CONFORMANCE_URL'
	@printf '  %-14s  %s\n' shell        'Open an interactive shell in the container'
	@printf '  %-14s  %s\n' clean        'Remove the local Docker image'
	@printf '  %-14s  %s\n' push         'Push the image to REGISTRY/IMAGE:TAG'
	@printf '\nCurrent variable values\n\n'
	@printf '  %-28s  %s\n' IMAGE                  '$(IMAGE)'
	@printf '  %-28s  %s\n' TAG                    '$(TAG)'
	@printf '  %-28s  %s\n' REGISTRY               '$(if $(REGISTRY),$(REGISTRY),(none — local only))'
	@printf '  %-28s  %s\n' IMAGE_REF              '$(IMAGE_REF)'
	@printf '  %-28s  %s\n' RELAY_URL              '$(RELAY_URL)'
	@printf '  %-28s  %s\n' RELAY_URL_DOCKER       '$(RELAY_URL_DOCKER) (used inside container)'
	@printf '  %-28s  %s\n' TESTS_ARGS             '$(if $(TESTS_ARGS),$(TESTS_ARGS),(none))'
	@printf '  %-28s  %s\n' WITH_CONFORMANCE       '$(WITH_CONFORMANCE)'
	@printf '  %-28s  %s\n' CONFORMANCE_URL        '$(CONFORMANCE_URL)'
	@printf '  %-28s  %s\n' CONFORMANCE_URL_DOCKER '$(CONFORMANCE_URL_DOCKER) (used inside container)'
	@printf '  %-28s  %s\n' CONFORMANCE_ARGS       '$(if $(CONFORMANCE_ARGS),$(CONFORMANCE_ARGS),(none))'
	@printf '  %-28s  %s\n' NPROC                  '$(NPROC)'
	@printf '\nExamples\n\n'
	@printf '  make build\n'
	@printf '  make build-force DOCKER_BUILD_FLAGS="--progress=plain"\n'
	@printf '  make build WITH_CONFORMANCE=0\n'
	@printf '  make tests RELAY_URL=https://relay.example.com:4433/moq\n'
	@printf '  make tests RELAY_URL=https://localhost:9668/moq-relay\n'
	@printf '  make tests TESTS_ARGS="--categories=Publisher,Subscriber"\n'
	@printf '  make tests TESTS_ARGS="--tests=PublishTest"\n'
	@printf '  make tests TESTS_ARGS="--list"\n'
	@printf '  make conformance CONFORMANCE_URL=http://relay.example.com:9999\n'
	@printf '  make conformance CONFORMANCE_ARGS="16"\n'
	@printf '  make push REGISTRY=ghcr.io/openmoq TAG=v1.2.3\n'
	@printf '\n'
