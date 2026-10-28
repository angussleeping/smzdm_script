/*
smzdm 综合任务脚本（签到 + 抽奖 + 每日任务 + 全民众测）
整合自 hex-ci/smzdm_script 的 smzdm_checkin.js / smzdm_lottery.js / smzdm_task.js / smzdm_testing.js，
合并为单个入口：单次 cron 运行、按账号顺序执行全部模块、汇总发送一条通知。

cron: 10 8 * * *

依赖公共库（与原仓库一致）: env.js / bot.js / library_task.js / sendNotify.js
NodeJS 依赖: got@11, crypto-js

环境变量：
* SMZDM_COOKIE            必填，抓包获得的完整 Cookie，多账号用 & 分隔，同原脚本
* SMZDM_SK                可选，签到请求的设备签名，同原签到脚本
*                         （Cookie 缺 z_dr 时脚本会按 APP 行为自动补齐，优先取 device_id 同值）
* SMZDM_USER_AGENT_APP    可选，APP 的 User-Agent，同原脚本
* SMZDM_USER_AGENT_WEB    可选，APP 内网页的 User-Agent，同原脚本
* SMZDM_COMMENT           可选，评论任务的文案，同原脚本；多条用换行或 | 分隔，建议配 3 条以上
* SMZDM_CROWD_SILVER_5    可选，设为 yes 时进行 5 碎银子抽奖，同原脚本
* SMZDM_CROWD_KEYWORD     可选，非免费抽奖的关键词，同原脚本
* SMZDM_RUN_CHECKIN       可选，设为 no 关闭每日签到模块（默认开启）
* SMZDM_RUN_LOTTERY       可选，设为 no 关闭每日抽奖模块（默认开启）
* SMZDM_RUN_TASK          可选，设为 no 关闭每日任务模块（默认开启）
* SMZDM_TASK_TESTING      可选，设为 yes 才运行全民众测模块（默认关闭，同原众测脚本）
* SMZDM_DEBUG             可选，开启请求调试输出，同 bot.js
*/

const crypto = require('crypto');
const Env = require('./env');
const {
  SmzdmBot,
  requestApi,
  removeTags,
  parseJSON,
  getEnvCookies,
  wait,
  waitHuman,
  CREATE_CENTER_VIEW,
  IS_INSTALL_ZHANGDAMA
} = require('./bot');
const notify = require('./sendNotify');
const CryptoJS = require('crypto-js');
const { SmzdmTaskBot } = require('./library_task');

// ------------------------------------

const $ = new Env('smzdm 综合任务');

// ============ 每日签到模块（来自 smzdm_checkin.js）============

class SmzdmCheckinBot extends SmzdmBot {
  constructor(cookie, sk) {
    super(cookie);

    this.sk = sk ? sk.trim() : '';
  }

  async run() {
    // 客户端先渲染签到卡片，用户点签到后才发 /checkin
    await this.getCheckinCard();

    const { msg: msg1 } = await this.checkin();

    const { msg: msg2 } = await this.allReward();

    const { msg: msg3 } = await this.extraReward();

    return `${msg1}${msg2}${msg3}`;
  }

  async checkin() {
    const { isSuccess, data, response } = await requestApi('https://user-api.smzdm.com/checkin', {
      method: 'post',
      headers: this.getHeaders(),
      data: {
        touchstone_event: '',
        sk: this.sk,
        token: this.token,
        captcha: ''
      }
    });

    if (isSuccess) {
      let msg = `⭐签到成功${data.data.daily_num}天
🏅金币: ${data.data.cgold}
🏅碎银: ${data.data.pre_re_silver}
🏅补签卡: ${data.data.cards}`;

      await waitHuman(3, 10);

      const vip = await this.getVipInfo();

      if (vip) {
        msg += `\n🏅经验: ${vip.vip.exp_current}
🏅值会员等级: ${vip.vip.exp_level}
🏅值会员经验: ${vip.vip.exp_current_level}
🏅值会员有效期至: ${vip.vip.exp_level_expire}`;
      }

      $.log(`${msg}\n`);

      return {
        isSuccess,
        msg: `${msg}\n\n`
      };
    }
    else {
      $.log(`签到失败！${response}`);

      return {
        isSuccess,
        msg: '签到失败！'
      };
    }
  }

  async allReward() {
    const { isSuccess, data, response } = await requestApi('https://user-api.smzdm.com/checkin/all_reward', {
      method: 'post',
      headers: this.getHeaders(),
      debug: process.env.SMZDM_DEBUG
    });

    if (isSuccess) {
      const normal = data.data.normal_reward;

      // reward_add 为空说明今天没有奖励增加（已领过或没有），退回展示签到卡片文案
      const msg1 = normal.reward_add.title
        ? `${normal.reward_add.title}: ${normal.reward_add.content}`
        : removeTags(normal.gift.content);

      const msg2 = normal.gift.title
        ? `${normal.gift.title}: ${normal.gift.content_str}`
        : normal.gift.sub_content;

      const msg = [msg1, msg2].filter(text => text).join('\n');

      $.log(`${msg}\n`);

      return {
        isSuccess,
        msg: `${msg}\n\n`
      };
    }
    else {
      if (data.error_code != '4') {
        $.log(`查询奖励失败！${response}`);
      }

      return {
        isSuccess,
        msg: ''
      };
    }
  }

  async extraReward() {
    // 连签奖励状态以签到后的卡片为准，所以这里重新拉一次
    const isContinue = this.isContinueCheckin(await this.getCheckinCard());

    if (!isContinue) {
      const msg = '今天没有额外奖励';

      $.log(`${msg}\n`);

      return {
        isSuccess: false,
        msg: `${msg}\n`
      };
    }

    await waitHuman(5, 10);

    const { isSuccess, data, response } = await requestApi('https://user-api.smzdm.com/checkin/extra_reward', {
      method: 'post',
      headers: this.getHeaders()
    });

    if (isSuccess) {
      const msg = `${data.data.title}: ${removeTags(data.data.gift.content)}`;

      $.log(msg);

      return {
        isSuccess: true,
        msg: `${msg}\n`
      };
    }
    else {
      $.log(`领取额外奖励失败！${response}`);

      return {
        isSuccess: false,
        msg: ''
      };
    }
  }

  // 签到卡片，APP 进签到页时先渲染它
  async getCheckinCard() {
    const { isSuccess, data, response } = await requestApi('https://user-api.smzdm.com/checkin/show_view_v2', {
      method: 'post',
      headers: this.getHeaders()
    });

    if (isSuccess) {
      return data.data;
    }

    $.log(`查询签到卡片失败！${response}`);

    return false;
  }

  // 连续签到的卡片，直接按有没有 checkin_continue 来找
  isContinueCheckin(card) {
    if (!card || !card.rows) {
      return false;
    }

    const result = card.rows.find(item => item.cell_data && item.cell_data.checkin_continue);

    return !!(result && result.cell_data.checkin_continue.continue_checkin_reward_show);
  }

  async getVipInfo() {
    const { isSuccess, data, response } = await requestApi('https://user-api.smzdm.com/vip', {
      method: 'post',
      headers: this.getHeaders(),
      data: {
        token: this.token,
        create_center_view: CREATE_CENTER_VIEW
      }
    });

    if (isSuccess) {
      return data.data;
    }
    else {
      $.log(`查询信息失败！${response}`);

      return false;
    }
  }
}

// —— 签到模块的 sk / 设备处理辅助（来自 smzdm_checkin.js）——

const SK_KEY = 'geZm53XAspb02exN';
const warned = new Set();

function warnOnce(key, message) {
  if (warned.has(key)) {
    return;
  }

  warned.add(key);

  $.log(message);
}

function getUserId(cookie) {
  const match = cookie.match(/smzdm_id=([^;]*)/);

  return match ? match[1] : '';
}

const DEVICE_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// 盐值一旦定下就不能改，改了等于所有账号换设备
const DEVICE_SALT = 'smzdm_script_device_v1';

// APP 的设备串是 62 字符集 32 位随机串，这里按账号确定性派生，保证跨运行固定不变
function makeDeviceId(userId) {
  const digest = crypto.createHash('sha256').update(`${DEVICE_SALT}:${userId}`).digest();
  let result = '';

  for (let i = 0; i < 32; i++) {
    result += DEVICE_ALPHABET.charAt(digest[i] % DEVICE_ALPHABET.length);
  }

  return result;
}

function makeSk(userId, deviceId) {
  const key = CryptoJS.enc.Utf8.parse(SK_KEY);
  const cipherText = CryptoJS.DES.encrypt(userId + deviceId, key, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7
  });

  return cipherText.toString();
}

// sk 是 DES(userId + 设备 id) 的 Base64，可逆；返回设备段，不属于这个账号就返回空串
function decodeSkDevice(sk, userId) {
  if (!userId) {
    return '';
  }

  try {
    const plain = CryptoJS.DES.decrypt(
      { ciphertext: CryptoJS.enc.Base64.parse(sk) },
      CryptoJS.enc.Utf8.parse(SK_KEY),
      {
        mode: CryptoJS.mode.ECB,
        padding: CryptoJS.pad.Pkcs7
      }
    ).toString(CryptoJS.enc.Utf8);

    return plain.indexOf(userId) === 0 ? plain.slice(userId.length) : '';
  }
  catch (e) {
    return '';
  }
}

// cookie 缺 smzdm_id 时，/vip 的 data.base.user_smzdm_id 还能拿到（APP 也用它回写 sp，sk 的 userId 正是来自这里）
async function fetchUserId(cookie) {
  const bot = new SmzdmBot(cookie);
  const { isSuccess, data } = await requestApi('https://user-api.smzdm.com/vip', {
    method: 'post',
    headers: bot.getHeaders(),
    data: {
      token: bot.token,
      create_center_view: CREATE_CENTER_VIEW
    }
  });
  // smzdm_id 在响应信封顶层（每个响应都有），base.user_smzdm_id 作为兜底
  const userId = isSuccess
    ? (data.smzdm_id || (data.data && data.data.base ? data.data.base.user_smzdm_id : ''))
    : '';

  return userId && userId != '0' ? String(userId) : '';
}

const md5 = (str) => crypto.createHash('md5').update(str).digest('hex');

function getCookieValue(cookie, name) {
  const match = cookie.match(new RegExp(`(?:^|;)\\s*${name}=([^;]*)`, 'i'));

  return match ? match[1] : '';
}

// 覆盖或补上 cookie 字段，值为空也要能覆盖
function upsertCookie(cookie, name, value) {
  const re = new RegExp(`(^|;)\\s*${name}=[^;]*;?`, 'i');

  if (re.test(cookie)) {
    return cookie.replace(re, `$1${name}=${value};`);
  }

  return `${cookie.replace(/;?\s*$/, ';')} ${name}=${value};`;
}

// APP 的 device_rid/device_s 就是 md5(设备串)，z_dr 与 device_id 同为原始设备串；
// 把 cookie 对齐到 sk 实际用的设备段，并补上缺失的 z_dr
function alignDeviceCookie(cookie, deviceId) {
  const hash = md5(deviceId);
  let result = cookie;

  if (getCookieValue(result, 'device_rid') !== hash) {
    result = upsertCookie(result, 'device_rid', hash);
  }

  if (getCookieValue(result, 'device_s') !== hash) {
    result = upsertCookie(result, 'device_s', hash);
  }

  // z_dr 缺失时按 APP 行为补成与 device_id 一致的原始设备串（无 device_id 则用 sk 的设备串）
  if (!getCookieValue(result, 'z_dr')) {
    result = upsertCookie(result, 'z_dr', getCookieValue(result, 'device_id') || deviceId);
  }

  return result;
}

// ============ 每日抽奖模块（来自 smzdm_lottery.js）============

class SmzdmLotteryBot extends SmzdmBot {
  async run() {
    let notifyMsg = '';

    const vipId1 = await this.getActivityIdFromVip('https://m.smzdm.com/topic/bwrzf5/516lft');

    if (vipId1) {
      await waitHuman(3, 10);

      notifyMsg += `转盘抽奖ID: ${vipId1}\n`;
      notifyMsg += await this.draw(vipId1);
      notifyMsg += '\n\n';
    }

    $.log();
    await waitHuman(5, 15);
    $.log();

    const vipId2 = await this.getActivityIdFromVip('https://m.smzdm.com/topic/zhyzhuanpan/cjzp/');

    if (vipId2) {
      await waitHuman(3, 10);

      notifyMsg += `转盘抽奖ID: ${vipId2}\n`;
      notifyMsg += await this.draw(vipId2);
    }

    return notifyMsg;
  }

  async draw(id) {
    const { isSuccess, data, response } = await requestApi('https://zhiyou.smzdm.com/user/lottery/jsonp_draw', {
      sign: false,
      parseJSON: false,
      headers: {
        ...this.getHeadersForWeb(),
        'x-requested-with': 'com.smzdm.client.android',
        Referer: 'https://m.smzdm.com/'
      },
      data: {
        active_id: id,
        callback: `jQuery34107538452897131465_${new Date().getTime()}`
      }
    });

    if (isSuccess) {
      const match = data.match(/\((.*)\)/);

      if (match) {
        const result = parseJSON(match[1]);

        if (result.error_code == 0 || result.error_code == 1 || result.error_code == 4) {
          $.log(result.error_msg);

          return result.error_msg;
        }
        else {
          $.log(`转盘抽奖失败，接口响应异常：${response}`);

          return '转盘抽奖失败，接口响应异常';
        }
      }
      else {
        $.log(`转盘抽奖失败，接口响应异常: ${response}`);

        return '转盘抽奖失败，接口响应异常';
      }
    }
    else {
      $.log(`转盘抽奖失败，接口响应异常: ${response}`);

      return '转盘抽奖失败，接口响应异常';
    }
  }

  // 获取会员中心转盘抽奖ID
  async getActivityIdFromVip(url) {
    const { isSuccess, data, response } = await requestApi(url, {
      sign: false,
      parseJSON: false,
      headers: {
        ...this.getHeadersForWeb(),
        'x-requested-with': 'com.smzdm.client.android'
      }
    });

    if (isSuccess) {
      const match = data.match(/\\"hashId\\":\\"([^\\]+)\\"/i);

      if (match) {
        $.log(`转盘抽奖ID: ${match[1]}`);

        return match[1];
      }
      else {
        $.log(`未找到转盘抽奖ID`);

        return false;
      }
    }
    else {
      $.log(`获取转盘抽奖失败: ${response}`);

      return false;
    }
  }
}

// ============ 每日任务模块（来自 smzdm_task.js）============

// 评论任务增强。原版 doCommentTask 一次只发一条评论，遇到「发布N条评论」任务会因进度不足
// 领奖失败（您还未完成）；同一天多个评论任务复用同一文案时，短时间重复内容会被判「请勿重复提交」。
// 这里按任务要求的条数循环发评（每条不同文章、不同内容），文案池用尽时补句号生成变体保证内容唯一。
const usedCommentContents = new Set();

class SmzdmAllTaskBot extends SmzdmTaskBot {
  // 取一条没用过的文案；池子用尽时在原文案后补 1-9 个句号（发完即删，不影响观感）
  getCommentContent() {
    const words = String(process.env.SMZDM_COMMENT || '')
      .split(/[\n|]/)
      .map(word => word.trim())
      .filter(word => word.length > 10);

    if (words.length === 0) {
      return '';
    }

    const fresh = words.filter(word => !usedCommentContents.has(word));

    let content;

    if (fresh.length > 0) {
      content = this.getOneByRandom(fresh);
    }
    else {
      const base = this.getOneByRandom(words);
      let suffix = 1;

      while (usedCommentContents.has(base + '。'.repeat(suffix)) && suffix < 10) {
        suffix++;
      }

      content = base + '。'.repeat(suffix);
    }

    usedCommentContents.add(content);

    return content;
  }

  // 解析任务要求的评论条数，如「发布3条评论」；解析不到按 1 条，上限 10
  getCommentTaskCount(task) {
    const text = `${task.task_name || ''} ${task.task_description || ''}`;
    const match = text.match(/(\d+)\s*条/);
    const count = match ? parseInt(match[1], 10) : 1;

    return Math.min(Math.max(count, 1), 10);
  }

  // 发一条评论并在计分后删除（发完即删不留评）
  async postOneComment(article, content) {
    await this.getArticleDetail(article.article_id);

    await wait(3, 10);

    const { isSuccess, data } = await this.submitComment({
      articleId: article.article_id,
      channelId: article.article_channel_id,
      content
    });

    if (!isSuccess) {
      return false;
    }

    this.$env.log('删除评论');
    await wait(20, 30);

    const { isSuccess: removed } = await this.removeComment(data.data.comment_ID);

    if (!removed) {
      this.$env.log('再试一次');
      await wait(10, 20);

      // 不成功再执行一次删除
      await this.removeComment(data.data.comment_ID);
    }

    await wait(5, 10);

    return true;
  }

  async doCommentTask(task, content) {
    this.$env.log(`开始任务: ${task.task_name}`);

    const need = this.getCommentTaskCount(task);
    const articles = await this.getArticleList(20);

    if (articles.length < 1) {
      return {
        isSuccess: false
      };
    }

    // 打乱后逐篇取用，保证每条评论落在不同文章上；
    // 解析到的条数只是底线，任务实际要求可能更多（如「评论赢限定勋章」），领奖失败时继续补发
    const pool = this.getShuffled(articles);
    const MAX_COMMENTS = 15;
    let done = 0;
    let text = content;

    while (done < need && done < pool.length && done < MAX_COMMENTS) {
      if (!text) {
        break;
      }

      if (await this.postOneComment(pool[done], text)) {
        done++;
        text = this.getCommentContent();
      }
      else {
        // 提交被拒（如内容重复），不硬重试
        break;
      }
    }

    this.$env.log('领取奖励');
    await waitHuman(5, 15);

    let result = await this.receiveReward(task.task_id);

    // 领奖失败说明实际要求的条数比解析到的多，自动补齐：继续发评论直到领奖成功
    while (!result.isSuccess && done < pool.length && done < MAX_COMMENTS) {
      this.$env.log(`任务还差评论（已发 ${done} 条），继续补发`);

      text = this.getCommentContent();

      if (!text) {
        break;
      }

      if (await this.postOneComment(pool[done], text)) {
        done++;

        await waitHuman(5, 15);
        this.$env.log('再次领取奖励');

        result = await this.receiveReward(task.task_id);
      }
      else {
        break;
      }
    }

    if (!result.isSuccess) {
      this.$env.log(`本次共发 ${done} 条评论仍未达到任务要求，建议在 SMZDM_COMMENT 配置更多不同文案`);
    }

    return result;
  }
}

class SmzdmNormalTaskBot extends SmzdmAllTaskBot {
  constructor(cookie) {
    super(cookie, $);
  }

  // 主函数
  async run() {
    $.log('获取任务列表');

    const { tasks } = await this.getTaskList();

    await waitHuman(5, 10);

    let notifyMsg = '';

    notifyMsg = await this.doTasks(tasks);

    $.log('查询是否有限时累计活动阶段奖励');
    await waitHuman(5, 15);

    // 领取活动奖励
    const { detail } = await this.getTaskList();

    if (detail.cell_data && detail.cell_data.activity_reward_status == '1') {
      $.log('有奖励，领取奖励');
      await waitHuman(5, 15);

      const { isSuccess } = await this.receiveActivity(detail.cell_data);

      notifyMsg += `${isSuccess ? '🟢' : '❌'}限时累计活动阶段奖励领取${isSuccess ? '成功' : '失败！请查看日志'}\n`;
    }
    else {
      $.log('无奖励');
    }

    return notifyMsg || '无可执行任务';
  }

  // 获取任务列表
  async getTaskList() {
    const { isSuccess, data, response } = await requestApi('https://user-api.smzdm.com/task/list_v2', {
      method: 'post',
      headers: this.getHeaders(),
      data: {
        is_install_zhangdama: IS_INSTALL_ZHANGDAMA
      }
    });

    if (isSuccess) {
      let tasks = [];

      if (data.data.rows[0]?.cell_data?.activity_task?.default_list_v2) {
        data.data.rows[0].cell_data.activity_task.default_list_v2.forEach(item => {
          tasks = tasks.concat(item.task_list);
        });

        return {
          tasks: tasks,
          detail: data.data.rows[0]
        };
      }
      else {
        $.log(`任务列表获取失败！${response}`);

        return {
          tasks: [],
          detail: {}
        };
      }
    }
    else {
      $.log(`任务列表获取失败！${response}`);

      return {
        tasks: [],
        detail: {}
      };
    }
  }

  // 领取活动奖励
  async receiveActivity(activity) {
    $.log(`领取奖励: ${activity.activity_name}`);

    const { isSuccess, data, response } = await requestApi('https://user-api.smzdm.com/task/activity_receive', {
      method: 'post',
      headers: this.getHeaders(),
      data: {
        activity_id: activity.activity_id
      }
    });

    if (isSuccess) {
      $.log(removeTags(data.data.reward_msg));

      return {
        isSuccess
      };
    }
    else {
      $.log(`领取奖励失败！${response}`);

      return {
        isSuccess
      };
    }
  }

  // 领取任务奖励
  async receiveReward(taskId) {
    const robotToken = await this.getRobotToken();

    if (robotToken === false) {
      return {
        isSuccess: false,
        msg: '领取任务奖励失败！'
      };
    }

    // 客户端初始化验证码组件时就会查一次，用来说明被要求的是哪种验证码
    const captchaType = await this.getCaptchaType();

    const { isSuccess, data, response } = await requestApi('https://user-api.smzdm.com/task/activity_task_receive', {
      method: 'post',
      headers: this.getHeaders(),
      data: {
        robot_token: robotToken,
        geetest_seccode: '',
        geetest_validate: '',
        geetest_challenge: '',
        captcha: '',
        task_id: taskId
      }
    });

    if (isSuccess) {
      const msg = removeTags(data.data.reward_msg);

      $.log(msg);

      return {
        isSuccess,
        msg
      };
    }

    // 110202 = 服务端要求人机验证，空验证码一定过不了
    if (data.error_code == '110202') {
      const type = captchaType === 'geetest' ? '滑块' : '图形';

      $.log(`🟡[${taskId}] 领取需要${type}验证码，脚本无法通过，请到 APP 内手动领取`);

      return {
        isSuccess: false,
        msg: '需要验证码'
      };
    }

    $.log(`领取任务奖励失败！${response}`);

    return {
      isSuccess,
      msg: '领取任务奖励失败！'
    };
  }

  // 验证码类型：geetest 走滑块，其余走图形
  async getCaptchaType() {
    const { isSuccess, data, response } = await requestApi('https://user-api.smzdm.com/getcaptcha/switch', {
      method: 'post',
      headers: this.getHeaders(),
      data: {
        token: this.token,
        create_center_view: CREATE_CENTER_VIEW
      }
    });

    if (isSuccess && data.data) {
      return data.data.type || '';
    }

    $.log(`获取验证码配置失败！${response}`);

    return '';
  }
}

// ============ 全民众测能量值任务模块（来自 smzdm_testing.js）============

class SmzdmTestingTaskBot extends SmzdmAllTaskBot {
  constructor(cookie) {
    super(cookie, $);
  }

  // 主函数
  async run() {
    let notifyMsg = await this.doTestingTasks();

    await waitHuman(5, 10);

    notifyMsg += await this.getEnergyList();

    await waitHuman(5, 10);

    notifyMsg += await this.getWinCouponList();

    return notifyMsg;
  }

  // 执行众测能量值任务
  async doTestingTasks() {
    const activityId = await this.getTestingActivityId();

    if (!activityId) {
      return this.wafBlocked ? '🟡众测任务未执行：接口被 WAF/风控拦截\n' : '';
    }

    await waitHuman(5, 10);

    const activityInfo = await this.getTestingActivityInfo(activityId);

    if (!activityInfo) {
      return '';
    }

    await waitHuman(5, 10);

    return await this.doTasks(activityInfo.activity_task.default_list);
  }

  // 众测接口被 WAF 拦时返回 403、429 或 HTML 验证码页，不是 JSON
  isWafBlocked(response) {
    return /WAF|验证码|<!DOCTYPE html>|<script|Response code 40[13]|Response code 429|ECONNRESET|ETIMEDOUT/i.test(String(response));
  }

  // 请求众测接口，被 WAF 拦时置标记并返回 false
  async requestTestingApi(url, data) {
    const { response } = await requestApi(url, {
      method: 'get',
      data,
      headers: {
        ...this.getHeadersForWeb(),
        Origin: 'https://test.m.smzdm.com',
        Referer: 'https://test.m.smzdm.com/'
      },
      parseJSON: false
    });

    if (this.isWafBlocked(response)) {
      this.wafBlocked = true;

      $.log('🔴众测任务接口被 WAF 拦截，本次跳过众测任务');

      return false;
    }

    try {
      const json = JSON.parse(response);

      if (json.error_code == '0') {
        return json.data;
      }

      $.log(`众测接口返回错误：${json.error_msg}`);
    }
    catch (e) {
      $.log(`众测接口返回异常：${String(response).slice(0, 150)}`);
    }

    return false;
  }

  // 获取众测能量值任务的活动 ID
  async getTestingActivityId() {
    $.log('获取众测活动 ID');

    const data = await this.requestTestingApi('https://zhiyou.m.smzdm.com/task/task/ajax_get_activity_id', {
      'from': 'zhongce'
    });

    return data ? data.activity_id : false;
  }

  // 获取活动下的所有任务
  async getTestingActivityInfo(id) {
    $.log('获取众测活动信息');

    return await this.requestTestingApi('https://zhiyou.m.smzdm.com/task/task/ajax_get_activity_info', {
      'activity_id': id
    });
  }

  // 领取奖励
  async receiveReward(taskId) {
    const { isSuccess, response } = await requestApi('https://zhiyou.m.smzdm.com/task/task/ajax_activity_task_receive', {
      method: 'post',
      data: {
        'task_id': taskId
      },
      headers: this.getHeadersForWeb(),
      parseJSON: false
    });

    if (!this.isWafBlocked(response) && isSuccess) {
      $.log('领取成功！');

      return {
        isSuccess,
        msg: ''
      };
    }

    $.log(`领取任务奖励失败！${String(response).slice(0, 150)}`);

    return {
      isSuccess: false,
      msg: '领取任务奖励失败！'
    };
  }

  // 能量值数量、过期时间与明细
  async getEnergyList() {
    $.log('查询能量值');

    const { isSuccess, data, response } = await requestApi('https://test-api.smzdm.com/win_coupon/energy_list', {
      method: 'get',
      headers: this.getHeaders(),
      data: {
        'page': 1
      }
    });

    if (!isSuccess) {
      $.log(`查询能量值失败！${response}`);

      return '';
    }

    const myEnergy = data.data.my_energy || {};
    const list = data.data.list || [];

    let msg = `🏅能量值: ${myEnergy.my_energy_total}\n🏅能量值过期时间: ${myEnergy.energy_expired_time}\n`;

    if (list.length > 0) {
      msg += `🏅能量值明细:\n${list.map(item => `  ${item.article_title}`).join('\n')}\n`;
    }

    $.log(msg);

    return `${msg}\n`;
  }

  // 必中券列表
  async getWinCouponList() {
    $.log('查询必中券列表');

    const { isSuccess, data, response } = await requestApi('https://test-api.smzdm.com/win_coupon/win_coupon_list', {
      method: 'get',
      headers: this.getHeaders(),
      data: {
        'page': 1,
        'type': '0'
      }
    });

    if (!isSuccess) {
      $.log(`查询必中券列表失败！${response}`);

      return '';
    }

    const list = data.data.list || [];

    if (list.length < 1) {
      return '🏅暂无必中券\n';
    }

    const msg = `🏅必中券 ${list.length} 项:\n${list.map(item => `  ${item.article_title}`).join('\n')}\n`;

    $.log(msg);

    return msg;
  }
}

// ============ 主流程：单次账号循环，按模块顺序执行 ============

!(async () => {
  const cookies = getEnvCookies();

  if (cookies === false) {
    $.log('\n请先设置 SMZDM_COOKIE 环境变量');

    return;
  }

  // 模块开关，默认签到/抽奖/任务开启；众测沿用 SMZDM_TASK_TESTING 单独控制，默认关闭
  const enabled = {
    checkin: process.env.SMZDM_RUN_CHECKIN !== 'no',
    lottery: process.env.SMZDM_RUN_LOTTERY !== 'no',
    task: process.env.SMZDM_RUN_TASK !== 'no',
    testing: process.env.SMZDM_TASK_TESTING === 'yes'
  };

  const moduleNames = {
    checkin: '每日签到',
    lottery: '每日抽奖',
    task: '每日任务',
    testing: '全民众测'
  };

  // —— SMZDM_SK 解析，同原签到脚本 ——
  let sks = [];

  if (process.env.SMZDM_SK) {
    if (process.env.SMZDM_SK.indexOf('&') > -1) {
      sks = process.env.SMZDM_SK.split('&');
    }
    else if (process.env.SMZDM_SK.indexOf('\n') > -1) {
      sks = process.env.SMZDM_SK.split('\n');
    }
    else {
      sks = [process.env.SMZDM_SK];
    }
  }

  let notifyContent = '';

  for (let i = 0; i < cookies.length; i++) {
    let cookie = cookies[i];

    if (!cookie) {
      continue;
    }

    // —— 签到模块的 sk / 设备对齐预处理，同原签到脚本 ——
    let sk = '';

    if (enabled.checkin) {
      let userId = getUserId(cookie);
      let deviceId = '';

      if (!userId) {
        // 少数 Cookie 只有 sess 没 smzdm_id，用 /vip 把它补回来，避免退化成 sk=1
        userId = await fetchUserId(cookie);

        if (userId) {
          warnOnce('vip-id', 'Cookie 里没有 smzdm_id，已从 /vip 接口取到');
        }
      }

      sk = (sks[i] || '').trim();

      if (sk) {
        // 用配置的真 sk，并把 cookie 对齐到它自己的设备段（同机抓的两个值本来就相等）
        deviceId = decodeSkDevice(sk, userId);

        if (!deviceId) {
          $.log(`🟡第 ${i + 1} 个 SMZDM_SK 解不出设备段（不是有效的 sk 或不属于这个账号），签到很可能失败，请检查多账号顺序`);
        }
      }
      else if (userId) {
        // 没有真值就按账号派生一个固定设备串，sk 和 cookie 用同一个
        deviceId = makeDeviceId(userId);
        sk = makeSk(userId, deviceId);

        warnOnce(
          'auto',
          '未配置 SMZDM_SK，改用按账号派生的固定设备串生成 sk；如需与真机完全一致，请在 APP 的签到请求里抓 sk 填入 SMZDM_SK'
        );
      }
      else {
        // cookie 和 /vip 都拿不到 userId，sk 拼不出来；发 1 是最后一档，至少保持参数存在
        sk = '1';

        warnOnce(
          'empty',
          'Cookie 里没有 smzdm_id，/vip 也没取到，只能发 sk=1；这种 Cookie 很可能被判定异常，建议重新从 APP 抓包'
        );
      }

      if (deviceId) {
        const aligned = alignDeviceCookie(cookie, deviceId);

        if (aligned !== cookie) {
          warnOnce(
            'align',
            'cookie 的 device_rid/device_s 与 sk 的设备段不一致，已按 sk 对齐（cookie 和 sk 可能不是同一台设备）'
          );
        }

        cookie = aligned;
      }
    }

    if (i > 0) {
      $.log();
      await wait(10, 30);
      $.log();
    }

    const sep = `\n****** 账号${i + 1} ******\n`;

    $.log(sep);

    // —— 依次执行各模块，单个模块出错不影响后续模块 ——
    let accountMsg = '';

    for (const key of ['checkin', 'lottery', 'task', 'testing']) {
      if (!enabled[key]) {
        continue;
      }

      if (accountMsg) {
        // 模块之间留出人类操作间隔
        await wait(5, 10);
      }

      $.log(`—— ${moduleNames[key]} ——`);

      let msg = '';

      try {
        if (key === 'checkin') {
          msg = await new SmzdmCheckinBot(cookie, sk).run();
        }
        else if (key === 'lottery') {
          msg = await new SmzdmLotteryBot(cookie).run();
        }
        else if (key === 'task') {
          msg = await new SmzdmNormalTaskBot(cookie).run();
        }
        else if (key === 'testing') {
          msg = await new SmzdmTestingTaskBot(cookie).run();
        }
      }
      catch (e) {
        $.log(`❌${moduleNames[key]}模块执行出错: ${e}`);

        msg = `❌模块执行出错\n`;
      }

      if (msg && msg.trim()) {
        accountMsg += `【${moduleNames[key]}】\n${msg.trimEnd()}\n\n`;
      }
    }

    notifyContent += sep + (accountMsg || '本次没有启用任何模块\n') + '\n';
  }

  $.log();

  await notify.sendNotify($.name, notifyContent);
})().catch((e) => {
  $.log('', `❌ ${$.name}, 失败! 原因: ${e}!`, '')
}).finally(() => {
  $.done();
});
