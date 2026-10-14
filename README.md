# 每日点名自动打卡

把一个手工完成的「在寝点名」变成每天定时自动提交的小脚本。零依赖，只用 Node 自带的 `fetch`。

## 工作原理

小程序打卡本质上就是一次 GraphQL 请求：

```
POST https://www.aiphoto8.cn/api/graphql
mutation createBaomingByInput($input: createBaomingInput!)
```

脚本每天按时执行，把 `submitDayStr` 换成当天日期，其余参数从 `config.json` 读取，带上抓包得到的身份请求头发出去。

**服务端自己是幂等的**：当天重复提交会被拒绝并返回 `您已完成接龙，无需再接龙！`，所以不会产生重复记录。脚本把这条文案识别为 `ALREADY_DONE`，按成功处理。

## 快速开始

需要 Node 18 或更高版本（用到全局 `fetch`）。

```bash
# 1. 填凭证：把 config.json 复制成 config.local.json，填上真实 token
#    config.local.json 已被 .gitignore 排除，不会进版本库
cp config.json config.local.json

# 2. 干跑：只打印将要发送的请求，不发请求
node checkin.js --dry-run

# 3. 实跑
node checkin.js
```

### 怎么拿到 token

用 Fiddler / mitmproxy 抓一次小程序里的真实打卡请求，看 `authorization` 请求头：

```
authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

连 `Bearer ` 前缀一起填进 `config.local.json` 的 `headers.authorization`。

这是一个 JWT，解开 payload 里的 `exp` 就能知道过期时间。实测这个 token 的有效期是 **10 年**，所以配好之后基本不用维护。

## 命令

```
node checkin.js                      正常执行，日期 = 今天（本地时间）
node checkin.js --dry-run            只打印请求，不发送
node checkin.js --date=2026-10-11    指定日期，用于补打
node checkin.js --force              忽略「今天已成功」检查，强制重发
node checkin.js --help               看用法
```

退出码：`0` = 成功或今天已打卡；`1` = 失败。

## 定时运行

```powershell
# 管理员 PowerShell，注册每天 19:00 的计划任务
powershell -ExecutionPolicy Bypass -File ".\register-task.ps1" -At 19:00
```

`register-task.ps1` 的参数：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `-At` | `19:00` | 每天的触发时间 |
| `-StartDate` | 今天 | 从哪天起生效。若在触发时间之后注册、又不想当天补跑，就写明天 |

日志写在 `logs/checkin.log`（UTF-8 追加），每次运行同时输出到 stdout，任务计划程序会收走。

## 结果判定

脚本不看 HTTP 200 就下结论，而是解析响应体：

| 情况 | 判定 | 退出码 |
|---|---|---|
| 返回 `data.createBaomingByInput._id` | 成功 | 0 |
| 错误信息命中 `alreadyDonePatterns` | 已打过卡，按成功处理 | 0 |
| 其他 GraphQL `errors` | 失败 | 1 |
| 网络错误 / 超时 / 5xx | 重试 `retries` 次后仍失败则报错 | 1 |

只有网络类错误会重试——业务错误重试也是白搭。

## 已知限制

- **依赖固定参数**：`submitDayIndex`、`no` 等字段目前写死不变，只更新日期。如果服务端某天要求这些字段也变化，脚本会失败并留下完整返回体供排查。
- **token 失效后需重新抓包**：没有程序化的续期手段，只能重新抓一次请求头。
- **需要电脑在触发时间处于开机且已登录状态**。任务开了 `-StartWhenAvailable`，错过会在下次开机时补跑，但可能已经过了打卡窗口。

## 免责说明

本脚本只代替使用者本人按一次按钮，**不伪造任何使用者未产生的数据**——它复现的是一次真实提交。使用者需自行确认提交时本人确实符合打卡条件。
