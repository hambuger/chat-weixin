# WeChat Standalone Bridge

[��������](./README.zh_CN.md)

This project runs as a local WeChat bridge service.

## Quick Start

```bash
npm install
npm run build
npm run login -- --accountId your_account_id
npm run start -- --accountId your_account_id
```

## Default Local APIs

- Inbound callback: `POST http://127.0.0.1:8081/service/chat`
- Outbound send API: `POST http://127.0.0.1:8082/api/weixin/send-message`
- Outbound typing API: `POST http://127.0.0.1:8082/api/weixin/send-typing`
- Local media URL prefix: `http://127.0.0.1:8082/api/weixin/media/`

## Route/Host Configuration

- `WEIXIN_CHAT_CALLBACK_BASE_URL` (default `http://127.0.0.1:8081`)
- `WEIXIN_CHAT_CALLBACK_PATH` (default `/service/chat`)
- `WEIXIN_BRIDGE_API_PREFIX` (default `/api/weixin`)
- `WEIXIN_BRIDGE_HOST` (default `127.0.0.1`)
- `WEIXIN_BRIDGE_PORT` (default `8082`)

State/config/log options:

- `WEIXIN_STATE_DIR` (default `~/.chat-weixin`)
- `WEIXIN_CONFIG` (default `<WEIXIN_STATE_DIR>/chat-weixin.json`)
- `WEIXIN_LOG_DIR` (default system temp)
- `WEIXIN_LOG_LEVEL` or `CHAT_WEIXIN_LOG_LEVEL` (default `INFO`)

## API Definitions And Examples

### 1) Inbound callback

Endpoint:

`POST /service/chat`

Direction: bridge -> your backend.

Example payload:

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

Your callback should return HTTP 2xx quickly.

### 2) Outbound send API

Endpoint:

`POST /api/weixin/send-message`

Request fields:

- `accountId` string, required in multi-account mode
- `to` string, required
- `text` string, optional
- `mediaPath` string, optional local file path
- `mediaUrl` string, optional remote file URL

At least one of `text` or (`mediaPath`/`mediaUrl`) is required.

Text example:

```json
{
  "accountId": "f962368f313e-im-bot",
  "to": "o9cq80...@im.wechat",
  "text": "hello"
}
```

Media example:

```json
{
  "accountId": "f962368f313e-im-bot",
  "to": "o9cq80...@im.wechat",
  "mediaPath": "C:\\temp\\image.jpg"
}
```

Success response:

```json
{
  "ok": true,
  "messageId": "chat-weixin:1777..."
}
```

### 3) Outbound typing API

Endpoint:

`POST /api/weixin/send-typing`

Request example:

```json
{
  "accountId": "f962368f313e-im-bot",
  "to": "o9cq80...@im.wechat",
  "status": 1
}
```

`status` supports `typing`/`cancel` (or numeric protocol values).

Success response:

```json
{
  "ok": true
}
```

### 4) Local media API

Endpoint:

`GET /api/weixin/media/{mediaId}[.ext]`

Examples:

- `GET /api/weixin/media/wxm%3A1777524906580-a4084006.jpg`
- `GET /api/weixin/media/wxm%3A1777524906580-a4084006`

Both forms are supported.

## Notes

- `npm run login` only stores credentials; it does not start polling.
- `media.url` may be an upstream temporary CDN URL or local bridge URL.
- Local media URLs are temporary and can become invalid after process restart.