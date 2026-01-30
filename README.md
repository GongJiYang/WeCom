# 企业微信 (WeCom) 通道插件

> 本仓库完全由 AI 编写。

OpenClaw 的企业微信通道插件，通过企业微信应用接收与发送消息，与 Agent 对话。

## 功能概览

- **接收消息**：企业微信应用回调（Webhook）→ 验证签名 → 解密 → 解析文本消息 → 交给 Agent 处理
- **发送消息**：Agent 回复 → 调用企业微信「发送应用消息」API → 文本/媒体消息送达用户
- **私信策略**：支持 `pairing`（需配对）、`allowlist`（白名单）、`open`（所有人）、`disabled`（关闭）
- **群聊**：识别 `@chatroom` 等群组消息，按群策略处理

## 前置条件

1. **OpenClaw** 已安装并可运行 Gateway（本机或服务器）。
2. **企业微信** 已创建企业，并已创建「自建应用」：
   - 登录 [企业微信管理后台](https://work.weixin.qq.com/)
   - 进入「应用管理」→「自建」→ 创建应用，记下 **AgentId**、**Secret**
   - 企业 ID（**CorpId**）在「我的企业」→「企业信息」中查看
3. **接收消息** 需配置「接收消息」模式并设置 URL、Token、EncodingAESKey（见下文）。

---

## 一、企业微信后台配置

### 1. 获取基础参数

| 参数 | 说明 | 获取位置 |
|------|------|----------|
| **CorpId** | 企业 ID | 我的企业 → 企业信息 |
| **AgentId** | 应用 ID | 应用管理 → 自建应用 → 应用详情 |
| **Secret** | 应用密钥 | 应用管理 → 自建应用 → 应用详情 |

### 2. 配置「接收消息」

在应用详情中进入「接收消息」：

1. **启用**「接收消息」。
2. **URL**：填你的 Gateway 对外可访问地址，例如：
   - 本机调试：`https://你的域名或IP/webhook/wecom/default`（需 HTTPS，企业微信要求）
   - 常见形式：`https://your-domain.com/webhook/wecom/default` 或带 accountId 的路径
3. **Token**：自定义字符串，用于签名验证（与 OpenClaw 配置中 `webhookToken` 一致）。
4. **EncodingAESKey**：点击「随机获取」或使用已有 43 位密钥，用于消息加解密（与 OpenClaw 配置中 `encodingAESKey` 一致）。

保存后，企业微信会向该 URL 发 GET 请求做「URL 验证」；验证通过后才会推送消息。

### 3. 配置 IP 白名单（必做）

企业微信会校验服务器出口 IP，未在白名单内的请求会返回 **errcode 60020**。

1. 在「应用管理」或「企业微信开放平台」对应应用中找到 **IP 白名单** / **可信 IP**。
2. 将 **运行 Gateway 的服务器公网出口 IP** 加入白名单。
3. 若使用反向代理/负载均衡，请加入实际访问企业微信 API 的出口 IP。

---

## 二、OpenClaw 配置

### 方式 A：通过向导配置（推荐）

在 OpenClaw 项目根目录或已安装 CLI 的环境下执行：

```bash
openclaw onboard
# 或
pnpm openclaw onboard
```

在向导中：

1. 选择 **企业微信 (WeCom)**。
2. 按提示输入 **CorpId**、**AgentId**、**Secret**。
3. 若启用接收消息，输入 **Token**、**EncodingAESKey**（与后台一致）。
4. **允许发送消息的用户**：填企业微信成员 ID，多个用英文逗号分隔；或填 `*` 表示所有人。

向导会写入 `~/.openclaw/openclaw.json`（或 `$CLAWDBOT_STATE_DIR/openclaw.json`）。

### 方式 B：手动编辑配置文件

编辑 `~/.openclaw/openclaw.json`，在 `channels` 下增加 `wecom` 节点，例如：

```json
{
  "channels": {
    "wecom": {
      "corpId": "你的企业ID",
      "agentId": "你的应用ID",
      "secret": "你的Secret",
      "webhookToken": "接收消息的Token",
      "encodingAESKey": "43位EncodingAESKey",
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `corpId` | 是 | 企业 ID |
| `agentId` | 是 | 应用 ID |
| `secret` | 是 | 应用密钥（也可用 `secretFile` 指向文件） |
| `webhookToken` | 接收消息时必填 | 与后台 Token 一致 |
| `encodingAESKey` | 接收消息且加密时必填 | 43 位，与后台一致 |
| `dmPolicy` | 否 | `pairing` / `allowlist` / `open` / `disabled`，默认 `pairing` |
| `allowFrom` | 否 | 允许发私信的用户 ID 列表，`["*"]` 表示所有人 |

多账户时使用 `channels.wecom.accounts`，例如：

```json
{
  "channels": {
    "wecom": {
      "defaultAccount": "work",
      "accounts": {
        "default": { "corpId": "...", "agentId": "...", "secret": "..." },
        "work": { "corpId": "...", "agentId": "...", "secret": "..." }
      }
    }
  }
}
```

---

## 三、启动 Gateway 并验证

### 1. 启动 Gateway

在运行 OpenClaw 的机器上（本机或服务器）：

```bash
openclaw gateway run --bind loopback --port 18789 --force
# 或指定端口
pnpm openclaw gateway run --bind loopback --port 18789 --force
```

若使用提供的脚本（需在 Gateway 所在机器上）：

```bash
./restart-gateway.sh
```

### 2. 确保企业微信能访问到 Gateway

- Gateway 监听在 `loopback` 时，需通过 **反向代理**（如 Nginx、Caddy）或 **内网穿透**（如 ngrok、Tailscale）将 `https://你的域名/...` 转发到 `http://127.0.0.1:18789`。
- 企业微信「接收消息」里填的 URL 必须指向该对外地址，路径需包含 `/webhook/wecom/`，例如：`https://your-domain.com/webhook/wecom/default`。

### 3. 验证配置与通道状态

```bash
openclaw channels status
openclaw channels status --deep
```

若配置正确，WeCom 通道会显示为已配置；`--deep` 会尝试拉取 access_token 做连通性检查。

---

## 四、测试收发消息

1. 在企业微信 PC 端或手机端，进入你配置的 **自建应用**。
2. 发送一条 **文本消息**（当前仅处理 `MsgType=text`）。
3. 若 Gateway、Agent、企业微信后台与白名单均正确，应收到 Agent 的文本回复。
4. 若未收到回复，可查看 Gateway 日志（或 `restart-gateway.sh` 指定的日志文件），关注 `[wecom]` 相关行。

---

## 五、可选配置说明

- **dmPolicy**
  - `pairing`：未在白名单的用户首次发消息会进入配对流程，配对成功后允许。
  - `allowlist`：仅 `allowFrom` 中的用户可触发 Agent。
  - `open`：所有企业成员都可触发。
  - `disabled`：关闭私信。

- **allowFrom**  
  企业微信成员 ID 列表；`["*"]` 表示不限制（通常与 `dmPolicy: "open"` 一起使用）。

- **媒体与长度**  
  - `mediaMaxMb`：入站媒体大小上限（MB）。  
  - `textChunkLimit`：单条文本分片长度（字符），默认 2048（与企业微信限制一致）。

---

## 六、目录与脚本说明

- **restart-gateway.sh**：在 Gateway 所在机器上用于构建/安装并重启 Gateway 的脚本；会检测端口与进程，避免重复启动。按需修改其中的路径、端口、环境变量。
- **scripts/verify-decrypt.mjs**：独立于 OpenClaw 的解密/校验脚本，可用于用企业微信官方样例或自有密文做加解密联调。

---

## 七、常见问题

### 1. 提示 errcode 60020 / not allow to access from your ip

- **原因**：服务器出口 IP 未加入企业微信应用 IP 白名单。
- **处理**：在企业微信后台将该服务器公网 IP 加入白名单后重试。

### 2. URL 验证失败或收不到消息

- 确认 **URL**、**Token**、**EncodingAESKey** 与 OpenClaw 中 `webhookToken`、`encodingAESKey` 完全一致（含大小写、无多余空格）。
- 确认 Gateway 已启动，且反向代理/穿透将 `https://你的域名/webhook/wecom/...` 正确转发到 Gateway 端口。
- 查看 Gateway 日志中 `[wecom]` 的 GET/POST 请求与解密错误信息。

### 3. 解密失败 / bad decrypt

- 检查 `encodingAESKey` 是否为 **43 位** Base64 字符，复制时无空格、换行。
- 若请求经表单解析，Base64 中的 `+` 可能被转为空格，本插件已做兼容；若仍报错，可检查代理或中间件是否再次修改了 body。

### 4. 收得到消息但无回复 / unsupported msgType

- 当前仅处理 **文本消息**（`MsgType=text`）。事件、图片、语音等会打日志并返回 200，但不进入 Agent。
- 若日志里出现 `msgType=` 为空，多为解密后 XML 解析异常，可结合 `decrypted payload keys` 日志排查字段名或结构是否符合企业微信文档。

### 5. Agent 未响应 / 未配置模型

- 确保已配置 AI 模型与鉴权（如 ZAI/OpenAI 等），并已执行 `openclaw onboard` 或手动配置好对应 auth；否则会报「No API key found for provider」等错误。

---

## 八、参考链接

- [企业微信 - 接收消息](https://developer.work.weixin.qq.com/document/path/90239)
- [企业微信 - 发送应用消息](https://developer.work.weixin.qq.com/document/path/90236)
- [企业微信 - 消息加解密](https://developer.work.weixin.qq.com/document/path/101033)
