# @hualiong/dsh-cost-lite

DSH 的**真实花费**徽标：把本会话的 token 用量按模型价目换算成金额，显示在内置「Token 用量」徽标的旁边。

| 位置 | 挂点 | 行 id | 文案 |
| --- | --- | --- | --- |
| 每条助手消息的操作行 | `conversation.chat.assistant-actions` | `cost-lite-turn`（order 20） | `计费 0.01 元` |
| 输入框停靠栏 | `conversation.composer.dock` | `cost-lite-session`（order 5） | `3.42 元` |

点开任一徽标是一个与内置统计弹窗同款的浮层：标题是 `￥` 金额，下面按桶列出金额与单价（`未缓存输入 / 缓存读取 / 缓存写入 / 输出`，单价以 `￥x.xx/M` 表示）——**金额按各桶分别计价后相加**，与标题 6 位小数一致。单轮浮层多一行「提供方 / 模型」。

## 计费口径

* **供应商**：只统计价目表里能**精确**匹配到的（provider, model）组合，没有任何 provider 级兜底价；本轮没有官方用量时不显示徽标，混合轮次只计官方那一份。官方提供方为 `deepseek-account` / `deepseek-official`。
* **模型 key**（精确 id，只有两个）：`deepseek-flash`、`deepseek-v4-pro`。旧 id（`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`）**官方已不再提供**，价格表里也不再登记——精确匹配不到就不计费，不会套用同 provider 的 Flash 价。要恢复某个组合，只能显式写进 `config.models`（key 为 `<provider>/<model>`）。
* **价目**（CNY / 1M tokens，取自 <https://api-docs.deepseek.com/zh-cn/quick_start/pricing>，读取于 2026-10-11）：Flash 空闲 `缓存未命中 1 / 缓存命中 0.02 / 输出 4`；V4 Pro `4.5 / 0.15 / 13.5`（DeepSeek 只公布三档，`缓存写入` 记为 0）。
* **高峰时段**：北京时间周一至周五 `9:00-12:00`、`14:00-18:00` 为高峰，价目 ×2；周末与法定节假日全天按空闲价。时段按**该条事件自己的 `time`**（epoch 毫秒，落盘后不再变）判定，所以同一个数不会在两次轮询之间漂移。节假日内置 2026 年列表（`src/index.js` 的 `PEAK_HOLIDAYS`），需要按年补充；未收录的工作日节假日会按高峰计价（只会高估，不会低估）。
* **未知组合**：在折叠阶段就整条跳过（不计 token、不产生 message/turn 条目），响应里 `priced: false`，两端徽标都不渲染，绝不猜价。

## 安装

把本包加进 profile 的 `dependencies` 与 `dsh.profile.bundles`：

```jsonc
{
  "dependencies": { "@hualiong/dsh-cost-lite": "^0.1.1" },
  "dsh": { "profile": { "bundles": [ /* …, */ "@hualiong/dsh-cost-lite" ] } }
}
```

本包自带 `cordis.patch.yml`，会插入下面这行：

```yaml
- id: cost-lite
  name: '@hualiong/dsh-cost-lite'
```

profile 自己的 patch 文件按 `id: cost-lite` 覆盖该行来传配置（`config.models`、`config.currency`）或启停。改 `dependencies` / `bundles` 后必须**重启 DSH**：运行时解析器拒绝热替换。

> 本包目前**独立发布**，尚未并入 `@hualiong/dsh-plugin-suite`；并入后这一行改由套件插入，profile 只需依赖套件。

## 开发

* 宿主半边（`src/index.js`、`src/pricing.js`）改动需要**重启 DSH**：运行时按解析到的模块 URL 缓存，文件改了也不会重新 import。
* 浏览器半边（`src/client.js`）由宿主按 mtime 生成 `rev` 提供，改完**刷新页面**即可。
* HTTP 接口：`GET /__cost-lite/usage?sessionId=<id>`，返回 `{ ok, sessionId, currency, priced, session, messages, turns }`，响应头 `cache-control: no-store`。`messages` 以 MessageId 为键、`turns` 以轮号为键。

## 许可

MIT
