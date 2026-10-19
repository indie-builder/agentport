FROM node:24-alpine

# 沙盒只包含运行时；智能体定义在运行时挂载到 /workspace
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY dist/ ./dist/

USER node
ENTRYPOINT ["node", "dist/runner.js"]
