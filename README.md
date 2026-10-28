# 自用脚本 for 青龙面板

[![Node.js CI](https://github.com/hex-ci/smzdm_script/actions/workflows/node.js.yml/badge.svg)](https://github.com/hex-ci/smzdm_script/actions/workflows/node.js.yml)

## 脚本内容

* 每日签到
* 每日抽奖
  * ~生活频道转盘抽奖~ （官方原因，活动过期）
  * ~值会员转盘抽奖~ （官方原因，活动过期）
* 每日任务（指的是签到页面中的任务）
  * 浏览文章
  * 收藏文章
  * 点赞文章
  * 评论文章
  * 分享
  * 抽奖
    * 免费抽奖
    * 5 碎银子抽奖
  * 关注用户
  * 关注栏目
  * 关注品牌
  * 关注兴趣
  * 站外浏览
  * 打开第三方 App
  * 开启推送
  * 创建桌面签到快捷方式
  * 限时累计活动
* 全民众测能量值任务

## 整合版脚本（smzdm_all.js）

本仓库在原版 4 个任务脚本的基础上提供整合版 `smzdm_all.js`：单次定时任务依次执行**每日签到、每日抽奖、每日任务、全民众测**四个模块，运行结束汇总发送一条通知，相比原版有以下增强：

* Cookie 缺少 `z_dr` 字段时，自动按 APP 行为补齐（与 `device_id` 同值），无需重新抓包
* 评论任务支持「发布 N 条评论」类任务：自动解析任务要求的条数（上限 5 条），循环发评，每条落在不同文章
* 评论文案自动去重，文案池用尽时在原文案后补句号生成变体，避免短时间重复内容被判「请勿重复提交」
* 各模块独立容错，单个模块异常不影响其他模块执行

### 部署方式

把 `smzdm_all.js` 与公共库 `env.js`、`bot.js`、`library_task.js`、`sendNotify.js` 放在同一目录（建议独立子目录，如 `smzdm_all/`），添加定时任务：

```bash
task smzdm_all/smzdm_all.js
```

cron 示例：`10 8 * * *`（每天 08:10 运行一次即可，四个模块一次跑完）

### 整合版环境变量

在原版环境变量的基础上增加模块开关（默认签到、抽奖、任务三个模块开启）：

* `SMZDM_RUN_CHECKIN`: 设为 `no` 关闭每日签到模块
* `SMZDM_RUN_LOTTERY`: 设为 `no` 关闭每日抽奖模块
* `SMZDM_RUN_TASK`: 设为 `no` 关闭每日任务模块
* `SMZDM_TASK_TESTING`: 设为 `yes` 开启全民众测模块（默认关闭）

评论任务建议在 `SMZDM_COMMENT` 配置 3 条以上不同文案（用换行或 `|` 分隔）。

### 已知限制

* 发布笔记（`publish.biji_new`）、发布原创长文（`publish.yuanchuang_new`）、申请众测（`guide.apply_zhongce`）等任务需要人工创作或申请，脚本会跳过并在日志中提示
* 转盘抽奖活动由官方运营，活动过期时日志提示「活动已过期」属正常现象

## 使用方法

### 青龙拉库

```bash
ql repo https://github.com/hex-ci/smzdm_script.git "smzdm_" "" "env.js|bot.js|sendNotify.js|library_" "main"
```

建议自行更改青龙面板的脚本执行时间

### NodeJS 依赖

* got@11
* crypto-js

### 抓包

建议使用 Android 手机抓包（iOS 也可以）域名为 `user-api.smzdm.com` 的任意链接，把**所有** Cookie 取出来放到青龙面板的 `SMZDM_COOKIE` 环境变量中，多用户请添加多个同名环境变量或者用 `&` 符号分隔。

如果手机实在抓不到，也可以用浏览器的 Cookie，但是强烈建议使用手机端的 Cookie。脚本会自动检查 `device_id`、`device_rid`、`z_dr` 等设备字段，缺失时在日志里提示，缺字段的 Cookie 更容易被风控。

#### 抓包教程

以下教程请大家自行尝试，本人没有亲自尝试，如有问题可以进群交流。

* https://www.jianshu.com/p/5e5524868442
* https://www.zqh.plus/2022/03/19/Android-Capture/
* https://jishuin.proginn.com/p/763bfbd5f92e
* https://juejin.cn/post/7091524392005566471
* https://www.caq98i.top/article/?page=38

### 青龙环境变量

环境变量请使用环境变量列表直接添加，不要使用 `export xxx=""` 这种方式添加环境变量。

* `SMZDM_COOKIE`: 抓包抓到的 Cookie 内容，需要所有 Cookie 内容，多用户可以用 `&` 分隔，或者使用多个同名环境变量。
* `SMZDM_SK`: 签到请求里的设备签名，从安卓 App 的 `https://user-api.smzdm.com/checkin` 请求参数中抓包得到，多用户可以用 `&` 分隔，或者使用多个同名环境变量，顺序要保持与 `SMZDM_COOKIE` 多用户顺序一致。不填时脚本会按账号派生一个固定的设备串来生成 sk（跨运行不变，但与真机的设备串不同）；填了之后会解密校验它是否属于对应的 Cookie，不属于会在日志里提示（通常是多账号顺序错位）。无论哪种情况，脚本都会把 Cookie 的 `device_rid`/`device_s` 对齐成 md5(实际使用的设备串)——同机抓的 Cookie 这两个值本来就相等，不会变；不一致时说明 Cookie 和 sk 可能不是同一台设备，日志会提示。
* `SMZDM_USER_AGENT_APP`: 这个值是可选值，是指 APP 的 User-Agent，从 APP 的 API 请求头中抓包得到，建议抓取 Android 的 User-Agent，不填使用脚本默认值。
* `SMZDM_USER_AGENT_WEB`: 这个值是可选值，是指 APP 中访问网页的 User-Agent，一般在 APP 内的转盘网页中抓包得到，建议抓取 Android 的 User-Agent，不填使用脚本默认值。
* `SMZDM_COMMENT`: 如果要完成评论文章的任务请设置这个环境变量，环境变量的内容是评论的文案，文案要大于 10 个汉字，建议用比较个性化的文案，脚本发布评论后会删除这条评论，但是为防止删除失败的情况，请尽量用好一点的文案，防止被判定为恶意灌水。可以写多条文案（用换行或 `|` 分隔，每条都要大于 10 个汉字），脚本每次随机选一条，避免每天发同样的内容。
* `SMZDM_CROWD_SILVER_5`: 每日抽奖任务默认只进行免费抽奖，如要进行 5 碎银子的抽奖，请设置这个环境变量的值为 `yes`，请注意，只有在没有免费抽奖的时候，才会执行非免费抽奖，而且，这个抽奖不是转盘抽奖。
* `SMZDM_CROWD_KEYWORD`: 抽奖关键词，执行非免费抽奖时，会优先选择包含此关键词的抽奖，如果未找到包含此关键词的抽奖，则会随机选择一个。
* `SMZDM_TASK_TESTING`: 是否运行全民众测能量值任务，如要运行此任务，请设置这个环境变量的值为 `yes`，否则不运行。

## 交流群

https://t.me/smzdm_script

## 推荐🐔场

自用🐔场，稳定，线路多，速度快，[点这里注册](https://xs-us.xyz/register?code=GMsubu2k)

## 其他🐑毛

微软积分商城奖励，[点这里注册](https://rewards.bing.com/welcome?rh=15761308&ref=rafsrchae)，脚本看[这里](https://github.com/hex-ci/Microsoft-Rewards-Script)

## 其它说明

使用本脚本可能会造成你的账号临时或永久封禁，请自行评估是否使用本脚本。

## 注意事项

本仓库发布的脚本及其中涉及的任何解密分析脚本，仅用于测试和学习研究，禁止用于商业用途，不能保证其合法性，准确性，完整性和有效性，请根据情况自行判断。本项目内所有资源文件，禁止任何公众号、自媒体进行任何形式的转载、发布。您必须在下载后的 24 小时内从计算机或手机中完全删除以上内容。
