# 微信独立桥接服务

[English](./README.md)

本项目以独立进程方式运行，提供微信消息收发桥接能力。

## 快速开始

```bash
npm install
npm run build
npm run login -- --accountId your_account_id
npm run start -- --accountId your_account_id
```

## 默认本地接口

- 入站回调: `POST http://127.0.0.1:8081/service/chat`
- 出站发送: `POST http://127.0.0.1:8082/api/weixin/send-message`
- 出站输入态: `POST http://127.0.0.1:8082/api/weixin/send-typing`
- 本地媒体前缀: `http://127.0.0.1:8082/api/weixin/media/`

## 路径与端口配置

- `WEIXIN_CHAT_CALLBACK_BASE_URL`（默认 `http://127.0.0.1:8081`）
- `WEIXIN_CHAT_CALLBACK_PATH`（默认 `/service/chat`）
- `WEIXIN_BRIDGE_API_PREFIX`（默认 `/api/weixin`）
- `WEIXIN_BRIDGE_HOST`（默认 `127.0.0.1`）
- `WEIXIN_BRIDGE_PORT`（默认 `8082`）

状态/配置/日志：

- `WEIXIN_STATE_DIR`（默认 `~/.chat-weixin`）
- `WEIXIN_CONFIG`（默认 `<WEIXIN_STATE_DIR>/chat-weixin.json`）
- `WEIXIN_LOG_DIR`（默认系统临时目录）
- `WEIXIN_LOG_LEVEL` 或 `CHAT_WEIXIN_LOG_LEVEL`（默认 `INFO`）

## 接口定义与示例

### 1) 入站回调接口

`POST /service/chat`

方向：桥接服务 -> 你的后端。

示例请求：

```json
{
  "accountId": "f962368f313e-im-bot",
  "fromUserId": "o9cq80...@im.wechat",
  "toUserId": "f962368f313e@im.bot",
  "messageId": 7455480047555111000,
  "messageSid": "chat-weixin:1777...",
  "createTimeMs": 1777524959320,
  "contextToken": "AARz...",
  "text": "",
  "media": {
    "type": "image",
    "mediaId": "wxm:1777524906580-a4084006",
    "path": "C:\\Users\\...\\wm-1777.jpg",
    "url": "http://127.0.0.1:8082/api/weixin/media/wxm%3A1777524906580-a4084006.jpg",
    "mimeType": "image/*"
  }
}
```

你的回调端请尽快返回 2xx。

### 2) 出站发送接口

`POST /api/weixin/send-message`

请求字段：

- `accountId` 字符串，多账号场景必填
- `to` 字符串，目标用户 ID
- `text` 字符串，可选
- `mediaPath` 字符串，可选，本地文件路径
- `mediaUrl` 字符串，可选，远端文件 URL

`text` 与 `mediaPath/mediaUrl` 至少要有一个。

文本示例：

```json
{
  "accountId": "f962368f313e-im-bot",
  "to": "o9cq80...@im.wechat",
  "text": "hello"
}
```

媒体示例：

```json
{
  "accountId": "f962368f313e-im-bot",
  "to": "o9cq80...@im.wechat",
  "mediaPath": "C:\\temp\\image.jpg"
}
```

成功响应：

```json
{
  "ok": true,
  "messageId": "chat-weixin:1777..."
}
```

### 3) 出站输入态接口

`POST /api/weixin/send-typing`

请求示例：

```json
{
  "accountId": "f962368f313e-im-bot",
  "to": "o9cq80...@im.wechat",
  "status": 1
}
```

`status` 支持 `typing` / `cancel`，也可不传由服务端使用默认值。

成功响应：

```json
{
  "ok": true
}
```

### 4) 本地媒体下载接口

`GET /api/weixin/media/{mediaId}[.ext]`

示例：

- `GET /api/weixin/media/wxm%3A1777524906580-a4084006.jpg`
- `GET /api/weixin/media/wxm%3A1777524906580-a4084006`

两种 URL 形式都支持。

## 说明

- `npm run login` 只保存凭据，不会启动消息轮询。
- 回调里的 `media.url` 可能是临时 CDN 地址，也可能是本地桥接地址。
- 临时媒体 URL 有时效，过期后需重新获取。
