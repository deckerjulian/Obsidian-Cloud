# Build context is the repo root (see docker-compose.yml).
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
ARG VITE_API_BASE=""
ENV VITE_API_BASE=$VITE_API_BASE
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @oc/shared build \
  && pnpm --filter @oc/web build

FROM nginx:alpine
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 80
