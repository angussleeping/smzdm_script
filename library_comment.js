/*
评论安全策略

为什么把评论单独拆出来：评论是整套脚本里唯一会留下公开内容、也是平台监管最严的动作。
历史实现（smzdm_task.js、smzdm_all.js）的评论流程有三个高危特征叠加在一起：

1. 发表评论后 20-30 秒就调用 delete_comment 删除，删除率接近 100%；
2. 遇到「发布 N 条评论」任务时循环发到 10~15 条，每条落在不同文章上；
3. 文案池用尽后给原文案追加句号生成「变体」，用于规避重复内容检测。

真实用户不会发完就删，也不会在几分钟内跨多篇文章发表结构雷同的评论，更不会靠改标点
绕过去重。这三点合起来是评论区风控里最典型的机器灌水特征，也是账号被判定「永久封禁评论」
的直接原因。平台对评论处罚通常落在 uid 维度且不随 Cookie 更换而解除。

因此本模块把评论相关的全部限制集中在这里，默认关闭，开启后按最保守的节奏执行：

* 需要同时设置 SMZDM_COMMENT_ENABLE=yes 与 SMZDM_COMMENT 才会执行评论任务；
* 每账号每日上限 2 条（可通过 SMZDM_COMMENT_DAILY_LIMIT 下调，硬上限 3 条）；
* 单次运行最多发表 1 条；
* 同一账号两次评论之间至少间隔 30 分钟（写入状态文件，跨运行生效）；
* 发表后保留，不再删除；
* 文案按 {title} 占位符与文章标题关联，近期用过的文案不再复用，不再生成变体；
* 「发布 N 条评论」且 N > 1 的任务一律跳过，请在 APP 内手动完成。
*/

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 状态文件放在脚本同目录（青龙的脚本目录可写），用于跨运行累计日额度与文案去重
const STATE_FILE = path.join(__dirname, '.smzdm_comment_state.json');

const DEFAULT_DAILY_LIMIT = 2;
const MAX_DAILY_LIMIT = 3;
const DEFAULT_READ_SECONDS = 25;
const KEEP_DAYS = 7;

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

// 用本地日期而不是 UTC，否则东八区凌晨会被算到前一天
const localDate = (offsetDays = 0) => {
  const date = new Date(Date.now() + offsetDays * 86400000);
  const pad = (num) => String(num).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const loadState = () => {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

    return state && typeof state === 'object' ? state : {};
  }
  catch (e) {
    // 首次运行或文件损坏，从空状态开始
    return {};
  }
};

const saveState = (state) => {
  const keep = {};

  // 只保留最近几天，避免文件无限增长
  for (let i = 0; i <= KEEP_DAYS; i++) {
    const day = localDate(-i);

    if (state[day]) {
      keep[day] = state[day];
    }
  }

  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(keep, null, 2));
  }
  catch (e) {
    // 写不进去不影响本次运行，只是下一次运行的额度判断会从零开始
  }
};

class CommentPolicy {
  constructor(cookie, log) {
    this.log = log || (() => {});
    this.userKey = CommentPolicy.getUserKey(cookie);
    this.state = loadState();
    this.today = localDate();

    if (!this.state[this.today]) {
      this.state[this.today] = {};
    }

    this.usage = this.state[this.today][this.userKey] || {
      count: 0,
      lastAt: 0,
      hashes: []
    };

    this.state[this.today][this.userKey] = this.usage;
  }

  // 按 smzdm_id 记账；个别 Cookie 只有 sess 时退化成 sess 的哈希，仍然能区分账号
  static getUserKey(cookie) {
    const id = String(cookie || '').match(/smzdm_id=([^;]*)/);

    if (id && id[1]) {
      return `id_${id[1]}`;
    }

    const sess = String(cookie || '').match(/sess=([^;]*)/);

    return `sess_${hash(sess ? sess[1] : 'unknown')}`;
  }

  // 必须显式开启，且文案池非空
  static get enabled() {
    return process.env.SMZDM_COMMENT_ENABLE === 'yes' && CommentPolicy.words.length > 0;
  }

  // 文案要求大于 10 个汉字，与历史行为一致
  static get words() {
    return String(process.env.SMZDM_COMMENT || '')
      .split(/[\n|]/)
      .map((word) => word.trim())
      .filter((word) => word.length > 10);
  }

  static get dailyLimit() {
    const value = parseInt(process.env.SMZDM_COMMENT_DAILY_LIMIT, 10);

    if (!Number.isFinite(value) || value < 1) {
      return DEFAULT_DAILY_LIMIT;
    }

    return Math.min(value, MAX_DAILY_LIMIT);
  }

  static get minGapMs() {
    return 30 * 60 * 1000;
  }

  static get maxPerRun() {
    return 1;
  }

  static readSeconds() {
    const value = parseInt(process.env.SMZDM_COMMENT_READ_SECONDS, 10);

    if (!Number.isFinite(value)) {
      return DEFAULT_READ_SECONDS;
    }

    return Math.min(Math.max(value, 15), 120);
  }

  get remaining() {
    return Math.max(0, CommentPolicy.dailyLimit - (this.usage.count || 0));
  }

  get waitMs() {
    return Math.max(0, CommentPolicy.minGapMs - (Date.now() - (this.usage.lastAt || 0)));
  }

  // 近期（含今天）用过的文案指纹
  get recentHashes() {
    const used = new Set();

    Object.keys(this.state).forEach((day) => {
      const record = (this.state[day] || {})[this.userKey];

      if (record && Array.isArray(record.hashes)) {
        record.hashes.forEach((item) => used.add(item));
      }
    });

    return used;
  }

  // 取一条近期没用过的文案；池子空了就返回 null，不生成变体
  pickContent(article) {
    const used = this.recentHashes;
    const fresh = CommentPolicy.words.filter((word) => !used.has(hash(word)));

    if (fresh.length < 1) {
      return null;
    }

    const word = fresh[Math.floor(Math.random() * fresh.length)];
    const title = String((article && (article.article_title || article.title)) || '').trim().slice(0, 30);

    if (!/\{title\}/.test(word)) {
      this.log('🟡当前文案没有 {title} 占位符：评论内容与文章无关时更容易被判灌水，建议改写成带 {title} 的形式');
    }

    return {
      content: word.replace(/\{title\}/g, title || '这篇文章'),
      key: hash(word)
    };
  }

  record(key) {
    this.usage.count = (this.usage.count || 0) + 1;
    this.usage.lastAt = Date.now();
    this.usage.hashes = (this.usage.hashes || []).concat(key);

    saveState(this.state);
  }
}

module.exports = {
  CommentPolicy
};
