FROM node:22-alpine
RUN apk add --no-cache openssl && corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm turbo run build --filter=@nhs/api
WORKDIR /repo/apps/api
ENV NODE_ENV=production
EXPOSE 3000
# Chạy migration trước khi mở API; dữ liệu mẫu nạp riêng bằng `pnpm db:seed`.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
