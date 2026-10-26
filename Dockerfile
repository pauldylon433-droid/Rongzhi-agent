# 融智 Agent 单镜像（后端 + 前端静态页面）。
# 本地 SQLite 模式可使用挂载卷；CloudBase 模式不依赖容器磁盘保存业务数据。
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY backend/package*.json ./backend/
RUN npm --prefix backend ci --no-audit --no-fund
COPY frontend/package*.json ./frontend/
RUN npm --prefix frontend ci --no-audit --no-fund
COPY backend ./backend
COPY frontend ./frontend
RUN npm --prefix frontend run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/backend/package*.json ./backend/
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/src ./backend/src
COPY --from=build /app/backend/scripts ./backend/scripts
COPY --from=build /app/frontend/dist ./frontend/dist
RUN mkdir -p /app/backend/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "backend/src/index.js"]
