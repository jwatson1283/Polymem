# sim/Dockerfile — the simulation container.
#
# PINNED, and pinned by DIGEST. A `latest` or a bare tag would let the container
# that produced a given report be unreproducible — the report would claim a
# result nobody can re-derive, which is the same fabricated-provenance failure
# polymem.mjs:34-58 documents about seeding an index from another machine's
# counters. The digest below is node:22.14.0-alpine3.21, verified on this host.
#
# NO PACKAGE INSTALL. The library is zero-dependency and the harness uses only
# node: builtins and global fetch (Node >= 18). There is no npm install step in
# this image at all, which is the strongest possible statement that the
# simulation added nothing to the shipped package's dependency graph.
#
# WHAT IS COPIED. src/ is the library under test; sim/ is the harness. Nothing
# else — no test/, no docs/, no data/. The tarball's own contents are verified
# separately with `npm pack --dry-run`.
# The tag is kept after the digest purely as documentation; Docker resolves the
# digest, so the image content is fixed even if the tag is ever re-pushed.
FROM node:22.14.0-alpine3.21@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944

# Named here rather than only in the run script, so `docker inspect` on the built
# image reports which tag this actually was.
LABEL org.opencontainers.image.title="polymem-sim"
LABEL org.opencontainers.image.description="Persona + hostile-input simulation harness for Polymem. Dev-only; not part of the npm package."
LABEL org.opencontainers.image.base.name="node:22.14.0-alpine3.21"

WORKDIR /work

# Library under test. Copied first so a change to the harness does not bust the
# library layer and vice versa.
COPY src/ /work/src/
COPY sim/ /work/sim/

# Fail the BUILD, not the run, if the harness does not even parse. A sim image
# that builds and then fails on syntax is a wasted container start every time.
RUN node --check sim/run.mjs \
 && node --check sim/writer.mjs \
 && node --check sim/llm.mjs \
 && node --check sim/personas.mjs \
 && node --check sim/classify.mjs \
 && node -e "import('/work/src/index.mjs').then(m => console.log('polymem exports:', Object.keys(m).length))"

# Scratch MUST be outside /work. The library computes REPO_ROOT as
# resolve(src/..) = /work and refuses at load time to run if the index or the
# sessions dir resolves inside it (polymem.mjs:145-157). That guard fired on a
# first draft that put scratch at /work/scratch, and it was right to: a container
# working directory is not a safe place for runtime state, and the library does
# not care that the container is disposable.
ENV HOME=/tmp/sim-home \
    OMEGA_MEMORY_INDEX=/tmp/sim-home/memory/patterns-index.json \
    OMEGA_MEMORY_SESSIONS_DIR=/tmp/sim-home/sessions \
    SIM_OLLAMA_HOST=http://host.docker.internal:11434 \
    SIM_MODEL=qwen2.5-coder:14b \
    SIM_JUDGE_MODEL=qwen2.5-coder:14b \
    SIM_REPORT_OUT=/work/out/sim-report.json \
    NODE_ENV=development

RUN mkdir -p /tmp/sim-home/memory /tmp/sim-home/sessions /work/out
VOLUME ["/work/out"]

ENTRYPOINT ["node", "/work/sim/run.mjs"]
