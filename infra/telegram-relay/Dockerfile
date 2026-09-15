FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS test
WORKDIR /relay
COPY relay.mjs relay.node-test.mjs ./
RUN node --test relay.node-test.mjs

FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5
ARG OCI_REVISION
ARG OCI_SOURCE
LABEL org.opencontainers.image.source="${OCI_SOURCE}" org.opencontainers.image.revision="${OCI_REVISION}"
WORKDIR /relay
COPY --from=test /relay/relay.mjs ./
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "relay.mjs"]
