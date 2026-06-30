# 暑假学习生活计划 PWA

为南京一位准六年级、一位准三年级小学生做的暑假**学习与生活**管理 app：每日任务打卡、父母验收、积分奖励、统计报表、生活项记录，**爸妈多端同步**。

- **形态**：PWA（渐进式网页应用）。iPhone 用 Safari 打开网址 → 分享 →「添加到主屏幕」，桌面出现图标，全屏运行，可离线打开，**无需 App Store**。Android 同样可用。
- **后端**：Supabase（免费云数据库 + 实时同步 + 鉴权），爸妈各自登录看到同一份数据。
- **前端**：原生 HTML/JS/CSS，零构建零依赖，方便后续自己改。

---

## 一、第一次配置（约 15 分钟）

### 1. 注册并配置 Supabase

1. 打开 https://supabase.com 注册（GitHub/Google 登录即可），新建一个项目，记下区域和密码。
2. 项目准备好后，进入 **SQL Editor** → New query → 把本仓库里的 `schema.sql` 全部粘贴进去 → **Run** 执行。这会建好所有表、行级安全策略、积分触发器、注册触发器。
3. 进入 **Project Settings → API**，复制两个值：
   - `Project URL`（形如 `https://xxxxx.supabase.co`）
   - `anon public` key（一长串以 `eyJ...` 开头的字符串）

### 2. 填入配置

打开 `js/supabase.js`，把顶部两行替换为你的值：

```js
const SUPABASE_URL = 'https://你的项目.supabase.co';
const SUPABASE_ANON_KEY = '你的 anon public key';
```

### 3. 部署到网上（PWA 需要 HTTPS）

任选一种（都免费）：

**方式 A：GitHub Pages（推荐，最简单）**
1. 把整个 `summer-plan-app` 文件夹上传到一个 GitHub 仓库。
2. 仓库 Settings → Pages → Source 选 `main` 分支根目录 → Save。
3. 等几分钟，会得到一个 `https://你的用户名.github.io/仓库名/` 的网址。

**方式 B：Vercel / Cloudflare Pages**
- 把文件夹拖进去即可，自动分配 HTTPS 网址。

> ⚠️ 网址必须是 HTTPS（GitHub Pages / Vercel 都是），PWA 才能安装。

### 4. iPhone 安装（不走商店）

1. 用 iPhone 的 **Safari**（必须 Safari，不是微信内置浏览器）打开上面的网址。
2. 点底部分享按钮 → 下滑找到 **「添加到主屏幕」** → 右上角「添加」。
3. 桌面出现「暑假计划」图标，点开全屏运行，像原生 app 一样。
4. Android 用 Chrome 打开 → 菜单 →「添加到主屏幕」。

---

## 二、首次使用流程

1. **注册账号**：妈妈先打开 app → 填邮箱、密码、称呼（如「妈妈」）→ 点「注册」。
2. **创建家庭**：注册后点「创建家庭」→ 系统生成一个 6 位**邀请码**（在「设置」页可见）。
3. **添加孩子**：进入「设置 → 孩子档案」→ 添加两个孩子（准六年级、准三年级）。
4. **添加任务模板**：在「设置 → 任务模板」给每个孩子添加语数英每日任务（如「口算100题」「英语听写」「阅读30分钟」），设置默认用时和积分。当天首次打开「今日」会自动生成打卡清单。
5. **配偶加入**：爸爸用另一台手机打开 app → 自己注册一个账号 → 在登录页点「加入家庭」→ 输入妈妈的邀请码 → 两端数据同步。
6. 开始每天使用：孩子勾「今日」打卡 → 爸妈在「验收」页通过/打回 → 通过自动加积分 → 「积分」页可兑换奖励。

---

## 三、功能说明

| 模块 | 说明 |
|---|---|
| 📅 今日 | 按当天自动从模板生成任务清单，孩子勾选完成 |
| ✅ 验收 | 父母查看待验收任务，通过（自动加分）/打回（带备注）|
| 📊 统计 | 近 30 天完成率、连续打卡天数、累计积分、各科完成情况、近 7 天柱状图 |
| 🏃 生活 | 记录运动/阅读/家务/屏幕时间 |
| ⚙️ 设置 | 家庭邀请码、孩子档案、任务模板、积分中心、退出登录 |

### 多端同步
- 爸妈各自登录同一家庭。一端验收/打卡，另一端实时刷新（Supabase Realtime）。
- 数据以云端为准。断网时打卡会暂存本地，联网后自动同步。

### 离线
- app 外壳（界面）被 Service Worker 缓存，断网也能打开。
- 断网时的打卡进入本地队列，联网自动回放（最后写入胜出）。

---

## 四、本地预览（可选，调试用）

```bash
# 进入项目目录
cd summer-plan-app
# 任选一个起本地静态服务
python -m http.server 8080
# 然后浏览器打开 http://localhost:8080
```

> 注：PWA 的 Service Worker 和「添加到主屏幕」需 HTTPS 或 localhost 才生效；本地用 `localhost` 即可调试。

Chrome DevTools → Application 面板可查看 Manifest、Service Worker、IndexedDB 缓存。

---

## 五、文件结构

```
summer-plan-app/
├── index.html              # 入口
├── manifest.webmanifest    # PWA 清单
├── sw.js                   # Service Worker（离线缓存）
├── schema.sql              # Supabase 建表脚本（在 Dashboard 执行）
├── css/style.css           # 样式
├── js/
│   ├── supabase.js         # Supabase 客户端 + 配置（需填你的 key）
│   ├── auth.js             # 注册/登录/创建/加入家庭
│   ├── db.js               # 数据访问 + 离线队列 + Realtime
│   ├── tasks.js            # 今日打卡 + 任务模板管理
│   ├── verify.js           # 父母验收
│   ├── points.js           # 积分与奖励
│   ├── life.js             # 生活项记录
│   ├── stats.js            # 统计报表
│   └── app.js              # 路由/导航/设置页
├── icons/                  # PWA 图标
└── README.md
```

---

## 六、常见问题

**Q：iPhone 上微信里打开链接能装吗？**
不能。必须用 **Safari** 打开网址再「添加到主屏幕」。微信内置浏览器不支持。

**Q：换手机数据会丢吗？**
不会。数据在云端，新手机装好 app、登录同一账号即可看到全部记录。

**Q：Supabase 免费额度够吗？**
家庭用量极小，免费额度（500MB 数据库、5万月活）完全够用。

**Q：孩子要单独账号吗？**
不用。孩子由父母在 app 内切换查看，不单独注册。

**Q：怎么改任务清单/积分规则？**
直接在 app「设置」里增删任务模板；积分规则在「积分中心」兑换奖励时设定。
