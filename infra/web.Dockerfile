FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm turbo run build --filter=@nhs/tablet --filter=@nhs/pos --filter=@nhs/kds

FROM nginx:1.27-alpine
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/tablet/dist /usr/share/nginx/html/tablet
COPY --from=build /repo/apps/pos/dist /usr/share/nginx/html/pos
COPY --from=build /repo/apps/kds/dist /usr/share/nginx/html/kds
