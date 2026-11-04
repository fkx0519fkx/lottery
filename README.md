# 抽奖 · Lottery v2

单活动抽奖系统。服务端为纯 Node 标准库(**零第三方依赖**;云端部署可选 PostgreSQL),
前端为单文件 SPA(**零 CDN 依赖**,断网/公司内网也能用)。

- **管理员**:输密码登录 → 配置奖项 → 复制"同事参与链接"发群 → 「全部结果」看名单、导出 CSV、重置
- **同事**:点链接 → 只看到「抽奖」「我的结果」→ 输入名字当场出结果 → 刷新不变、不能重抽
- **公平性**:`crypto.randomFillSync` + 拒绝采样,无取模偏差;每人中奖概率严格均等
- **稳定**:端口被占自动顺延;重复启动自动检测并复用;数据原子写入(断电不损坏)

## 管理员密码

默认 `fkxfkxfkx`,环境变量 `ADMIN_PASSWORD` 覆盖。

## 本地跑(最快,同一 WiFi 可用)

```bash
双击 启动抽奖.bat      # 已内置 runtime\node.exe,不需要安装 Node.js
```

浏览器开 `http://localhost:8788/`,密码登录,配置奖项,
复制「同事参与链接」(控制台和页面上都有)发给同事。

小白版图文说明见同目录 `使用说明.txt`。

## 持久化(自动检测)

| 环境 | 方式 |
| --- | --- |
| 本地(无 `DATABASE_URL`) | `./data/lottery.json`(原子写入:临时文件 + 改名) |
| 云端(设了 `DATABASE_URL`) | PostgreSQL 单表 `lottery_state` |

## 公网部署到 Render(永久链接)

1. 代码传到 GitHub(**不要**上传 `data/`、`runtime/`、`*.bat`)
2. [render.com](https://render.com) → New + → Web Service → 选仓库
   - Build Command: `npm install`
   - Start Command: `node server.js`
3. 环境变量:
   - `ADMIN_PASSWORD` = 你的密码
   - `DATABASE_URL` = Render/Neon 免费 PostgreSQL 连接串(必须,云磁盘会重置)
4. 部署完成后根链接即管理员入口,`https://xxx.onrender.com/?p=token` 即参与者链接

免费版 15 分钟无访问会休眠,下次访问自动唤醒(数据在数据库,不会丢)。

## 临时公网:cpolar 内网穿透

双击 `start-public.bat`,按窗口提示操作。适合"今天就要用"。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/state | 状态(是否管理员/奖品/统计/我的结果;名单仅管理员可见) |
| POST | /api/draw | 抽奖 `{name}`,按名字幂等,不可重抽 |
| POST | /api/admin/login | 登录 `{password}` → 发会话 cookie |
| POST | /api/admin/logout | 退出 |
| POST | /api/admin/setup | 设奖项 `{prizes:[{name,count}]}`(需管理员) |
| POST | /api/admin/regen-token | 重新生成参与者链接(需管理员) |
| POST | /api/admin/reset | 清空抽奖记录,奖项保留(需管理员) |
