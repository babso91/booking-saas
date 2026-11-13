# syntax=docker/dockerfile:1
# Booking SaaS — production image (Next.js standalone server).
# Build:   docker build -t booking-saas:<sha> \
#            --build-arg NEXT_PUBLIC_APP_URL=https://booking-saas-staging.duckdns.org \
#            --build-arg NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
#            --build-arg NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key> .
# The three NEXT_PUBLIC_* values are public (sent to every browser) and are
# inlined at build time. Server secrets are given at run time only
# (deploy/hetzner/booking-saas.env, never in the image).
# NODE_IMAGE: the same image from a mirror if Docker Hub limits pulls, e.g.
#   --build-arg NODE_IMAGE=public.ecr.aws/docker/library/node:24-bookworm-slim

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# extra_ca: optional build secret, only for a build behind a TLS-intercepting
# proxy; never part of the image.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG GIT_COMMIT=unknown
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
RUN test -n "$NEXT_PUBLIC_APP_URL" && test -n "$NEXT_PUBLIC_SUPABASE_URL" \
      && test -n "$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" \
    && npm run build

FROM ${NODE_IMAGE} AS run
WORKDIR /app
ARG GIT_COMMIT=unknown
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    TZ=UTC
LABEL org.opencontainers.image.source="https://github.com/babso91/booking-saas" \
      org.opencontainers.image.revision=$GIT_COMMIT
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
