# 企查查爬虫 - 服务器部署指南

## 核心挑战

企查查 WAF（阿里云 `acw_tc`）将 cookie 与 TLS 会话绑定，纯 API 模式（Python requests）无法复用浏览器 cookie，会返回 435。因此服务器部署必须使用**无头浏览器**。

## 方案概览

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  本地电脑     │    │  服务器       │    │  定时任务     │
│              │    │              │    │              │
│ 1.登录qcc.com │───▶│ 2.Puppeteer  │───▶│ 3.每日9:00   │
│   保存cookies │    │   无头Chrome  │    │   自动爬取    │
│              │    │   DOM提取     │    │   保存JSON    │
└──────────────┘    └──────────────┘    └──────────────┘
```

## 方案对比

| 方案 | 优点 | 缺点 |
|------|------|------|
| **A: Puppeteer（推荐）** | 稳定绕过WAF，cookie自动管理 | 需安装Chromium（~300MB） |
| B: opencli + Xvfb | 复用现有适配器 | opencli 为桌面设计，服务器维护成本高 |
| C: curl_cffi + API | 资源消耗小 | WAF TLS绑定导致435，不可靠 |

## 步骤一：服务器环境准备

### Ubuntu/Debian

```bash
# 安装 Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 安装 Chromium 依赖
sudo apt install -y \
  ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
  libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
  libnspr4 libnss3 libu2f-udev libx11-xcb1 libxcomposite1 \
  libxdamage1 libxrandr2 xdg-utils
```

### CentOS/Rocky Linux

```bash
# 安装 Node.js 18+
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# 安装 Chromium 依赖
sudo yum install -y \
  atk cups-libs gtk3 libXcomposite libXdamage libXrandr \
  mesa-libgbm nss pango alsa-lib
```

### Docker（最简单）

```bash
# 无需手动安装依赖
docker pull node:20-slim
```

## 步骤二：部署代码

```bash
# 将以下文件上传到服务器
scp qcc_server.js package.json user@server:/opt/qcc-spider/
scp qcc_cookies.json user@server:/opt/qcc-spider/   # 首次部署时需要

# 或者在服务器上 git clone
cd /opt
git clone <your-repo> qcc-spider
cd qcc-spider
npm install
```

## 步骤三：获取登录 Cookie（首次）

**在本地电脑上运行：**

```bash
cd /path/to/qichacha
npm install
node qcc_server.js --login
```

浏览器会自动打开 qcc.com，手动完成登录（扫码或手机号）。登录成功后 cookies 会自动保存到 `qcc_cookies.json`，浏览器自动关闭。

```bash
# 将 cookie 文件上传到服务器
scp qcc_cookies.json user@server:/opt/qcc-spider/
```

> **Cookie 有效期**：QCCSESSID 通常有效 24-48 小时。如果爬虫连续 2 天失败（HTTP 409），需要重新登录获取新 cookie。

## 步骤四：测试运行

```bash
# 在服务器上测试
cd /opt/qcc-spider
node qcc_server.js

# 预期输出:
# [启动] 目标日期: 2026-06-03 | 省份: BJ | 城市: 110101
# [Cookie] 已加载 8 个 cookies
# [导航] https://www.qcc.com/...
# [筛选] 点击"今天"按钮...
# [分页] 共 2 页
#   第 1 页: 20 条, 日期: 2026-06-03
# [结果] 共 20 条
# [保存] /opt/qcc-spider/new_companies_2026-06-03.json
```

```bash
# 其他用法
node qcc_server.js --province SH --city 310101   # 上海黄浦区
node qcc_server.js --date 2026-05-29              # 指定日期
node qcc_server.js --output /data/qcc             # 指定输出目录
```

## 步骤五：设置定时任务

```bash
# 编辑 crontab
crontab -e
```

```
# 每个工作日 9:00 AM 执行（周一至周五）
0 9 * * 1-5 cd /opt/qcc-spider && /usr/bin/node qcc_server.js >> /var/log/qcc-spider.log 2>&1
```

> **为什么是工作日？** 周末工商局不注册新企业，爬取结果为空。

## 步骤六：Cookie 过期监控

cookie 有效期约 24-48 小时。失效时爬虫返回 409。添加健康检查：

```bash
# 创建检查脚本
cat > /opt/qcc-spider/health_check.sh << 'EOF'
#!/bin/bash
LATEST=$(ls -t /opt/qcc-spider/new_companies_*.json 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then
  echo "[WARN] 无数据文件"
  exit 1
fi
COUNT=$(python3 -c "import json; print(len(json.load(open('$LATEST'))))" 2>/dev/null || echo 0)
TODAY=$(date +%Y-%m-%d)
if ! echo "$LATEST" | grep -q "$TODAY"; then
  echo "[WARN] 今日数据未生成: $LATEST"
  exit 1
fi
echo "[OK] $LATEST: $COUNT 条"
EOF
chmod +x /opt/qcc-spider/health_check.sh

# 添加到 crontab：每天 10:00 检查
# 0 10 * * 1-5 /opt/qcc-spider/health_check.sh || curl -X POST <你的告警webhook>
```

## Docker 部署（可选）

```dockerfile
# Dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y \
  ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
  libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
  libnspr4 libnss3 libu2f-udev libx11-xcb1 libxcomposite1 \
  libxdamage1 libxrandr2 xdg-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install
COPY qcc_server.js .
COPY qcc_cookies.json .

# Puppeteer 会用自带的 Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false

CMD ["node", "qcc_server.js"]
```

```bash
# 构建和运行
docker build -t qcc-spider .
docker run --rm -v $(pwd)/data:/app qcc-spider

# 或使用 docker-compose
```

## 故障排查

| 症状 | 原因 | 解决 |
|------|------|------|
| 返回 409 | cookie 过期 | 重新运行 `--login` 获取新 cookie |
| 返回 435 | WAF 拦截 | Chromium 版本过旧，升级 puppeteer |
| 无数据 | 周末/节假日 | 正常现象，工作日有数据 |
| `--no-sandbox` 错误 | Docker 权限 | 确保使用了 `--no-sandbox` 参数 |
| 内存溢出 | Chromium 内存大 | 限制 pagesize：加 `--max-old-space-size=512` |

## 可选优化

1. **数据库存储**：将 JSON 改为写入 MySQL/PostgreSQL
2. **多城市并行**：启动多个 browser context 同时爬取
3. **企微/钉钉通知**：`new_companies` 有数据时推送通知
4. **Cookie 自动刷新**：检测 409 后自动发邮件/企微提醒重新登录
