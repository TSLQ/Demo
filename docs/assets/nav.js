/* ============================================================
   导航与角色配置 —— 唯一来源
   ------------------------------------------------------------
   shell.js（应用壳）与 core.js（内容页独立打开时的自我渲染）
   都从这里取配置，避免两处各写一套导致菜单不一致。

   在应用壳里：由 app.html 先加载 nav.js，再加载 shell.js
   内容页独立打开：core.js 检测到自己不在壳内 → 加载时同步引用
   ============================================================ */

/** 页面 → 归属角色（越权拦截 + 侧栏高亮都依赖它） */
var PAGE_ROLE = {
  "schedule.html":      "teacher",
  "lesson.html":        "teacher",
  "exam.html":          "teacher",
  "courseware.html":    "teacher",     // 「发布课件作业」：老师写 / 传课件并发布（第 47 轮）
  "homework.html":      "student",     // 「我的作业」：学生端接收老师发布的试卷（第 44 轮）
  "class.html":         "teacher",
  "stu.html":           "teacher",     // 「学生管理」：学生总册 + 学习活跃 + 作业情况（第 48 轮）
  "training.html":      "teacher",
  "training-student.html": "student",  // 「实训」：学生端参与 + 发起（灵感 01 层 2 + 灵感 02）
  "agent.html":         "teacher",
  "workbench.html":     "both",       // 双端共用（灵感 01 层 3：学生和老师都要有）
  "chat.html":          "student",
  "reader.html":        "student",
  "analysis.html":      "student",
  "agent-student.html": "student",
  "settings.html":      "both",
  "index.html":         "login",
  "app.html":           "shell",
};

/** 角色元信息 */
var ROLES = {
  teacher: { id: "teacher", label: "教师", mark: "师", name: "李老师", home: "class.html" },
  student: { id: "student", label: "学生", mark: "生", name: "李同学", home: "chat.html" },
};

/* ============================================================
   账号体系 —— 唯一来源
   ------------------------------------------------------------
   ⚠️ 纯静态站没有服务端，账号只能存在浏览器本地（localStorage）。
      这**不是真实鉴权**，任何本地凭据都挡不住有心人（F12 即可查看）。
      定位是「校园内网自建系统的模拟」：有注册、有账号库、有登录校验，
      但明确定位为教学原型，正式版本应由后端签发会话票据。

   存储：st_accounts = [{ role, user, pass, name, createdAt }]
   ============================================================ */
var SCHOOL = "cdut";                             // 成都理工大学

var ACCOUNT_KEY = "st_accounts";                 // 本地账号库

/** 首次打开时自动写入的预置账号（让观众不必先注册就能进） */
var SEED_ACCOUNTS = [
  { role: "teacher", user: "teacher", pass: "cdut@2026", name: "李老师" },
  { role: "student", user: "student", pass: "cs@2026",   name: "李同学" },
];

/** 角色的默认展示名（注册新账号时若未填姓名，用它兜底） */
var ROLE_PERSONA = {
  teacher: "老师",
  student: "同学",
};

/* ============================================================
   侧栏分组标题右侧的「＋」按钮 —— 唯一来源
   ------------------------------------------------------------
   分组对象写 `action: "addXxx"`，壳（shell.js）与独立模式（core.js）
   都从这里取 id / 文案，避免两处各写一套导致按钮走样。
   ============================================================ */
var GROUP_ACTIONS = {
  addCourse:  { id: "addCourseBtn",  label: "添加课程" },
  addClass:   { id: "addClassBtn",   label: "添加班级" },
  // 学生端「我的课程 ＋」：不是"新建"，是**加入**已有的课堂（第 32 轮）
  joinCourse: { id: "joinCourseBtn", label: "输入邀请码加入课堂" },
};

/* ============================================================
   班级目录 —— 唯一来源
   ------------------------------------------------------------
   · 左侧栏「班级管理」的菜单项由它**派生**（refreshClassNav()）
   · class.html 也读它渲染「当前是哪个班」
   · 🔴 第 55 轮起**真的可以新建**：数据层在下方「班级目录 —— 数据层」
     （loadClasses() / saveClasses() / createClass()），与课程同一套
     「按账号分桶 + 预置账号才播种」的约定。

   ⚠️ 多个班共用同一个 class.html，靠 URL 查询串区分（class.html?cls=cs2301）。
      若不加区分，点任一个班都会让**所有**班级项同时高亮，看起来像坏了。
   ============================================================ */
var CLASSES = [];            /* ← 由下方班级数据层的 loadClasses() 回填 */
var CLASS_NAV_ITEMS = [];    /* ← 由 refreshClassNav() 从 CLASSES 派生 */

/* ============================================================
   课程目录 —— 唯一来源
   ------------------------------------------------------------
   · 左侧栏「我的课程」的菜单项由它**派生**（第 19 轮起可新建课程）
   · 「＋ 添加课程」保存时 push 一条 → 落库 → 重渲染侧栏
   · class.html 读 `?course=xxx` 显示当前课程

   ⚠️ 与 CLASSES 同理：多门课共用 class.html，靠查询串区分，
      否则点一门课会让**所有**课程项同时高亮。
   ⚠️ 读写本机存储自带 try/catch —— file:// 下 localStorage 会抛错，
      这时退化为「只在内存里生效」（本次会话能用，刷新丢），不炸页面。
   ============================================================ */
var COURSE_KEY = "st_courses";              // 键基名；实际键见 courseStoreKey()
var CURRENT_USER_KEY = "st_current_user";   // 与 core.js 的 STORE_KEY.currentUser 同名

/* ------------------------------------------------------------
   课程存储**按账号分开**（第 23 轮）
   ------------------------------------------------------------
   🔴 课程是「某位老师在教的课」，不是全局数据 ——
      换个账号登录必须看到自己的课，而不是上一个人的。
      所以存档键带账号标识：`st_courses:teacher:zhangsan`。
   · `st_current_user` 由登录页（index.html）写入，形如 `teacher:zhangsan`
   · 没有账号标识（直接双击打开某个页面）→ 退回全局桶 `st_courses`
   · **只有预置的预置账号**才播种预置课程；自己注册的账号从空的开始
   ============================================================ */

/** 当前登录账号（形如 "teacher:zhangsan"）；读不到返回 "" */
function currentUserKey() {
  try {
    const v = window.localStorage.getItem(CURRENT_USER_KEY);
    if (v) return String(v).replace(/^"|"$/g, "").trim();
  } catch (_) { /* file:// / 隐私模式 */ }
  return "";
}

/** 当前账号的课程存档键 */
function courseStoreKey() {
  const u = currentUserKey();
  return u ? COURSE_KEY + ":" + u : COURSE_KEY;
}

/** 是不是预置的预置账号（只有它才播种预置课程） */
function isSeedAccount(u) {
  return (SEED_ACCOUNTS || []).some((a) => (a.role + ":" + a.user) === u);
}

/** 预置课程（预置账号首次进入时用它；settings 的「清空本机数据」后也会回到它） */
var SEED_COURSES = [
  { id: "ds", name: "数据结构与算法", code: "CS201", term: "2026 秋季",
    weeks: "1–16 周", desc: "线性表、树、图与经典算法", page: "class.html" },
];

/* ------------------------------------------------------------
   课程表单的**候选值**（第 26 轮）
   ------------------------------------------------------------
   🔴 只是 `<datalist>` 的备选，**不是可选范围**。
      学期与周次各校各专业千差万别（暑假小学期、集中实践周、单双周、
      前 8 周 / 后 8 周、甚至"随到随学"）——用固定下拉会把「其他情况」堵死。
      表单里是普通输入框，任何写法都能填；这里只提供常用值省打字。
   ============================================================ */

/** 学期候选：按当天日期推三个相邻学期（写死年份迟早会过期） */
function termSuggestions(now) {
  // 🔴 别用 `instanceof Date` —— 跨 realm（jsdom / iframe）会静默失效，
  //    参数被丢掉、改用真实时钟，测试就永远测不准。鸭子类型判断。
  const d = (now && typeof now.getFullYear === "function") ? now : new Date();
  const y = d.getFullYear();
  return d.getMonth() >= 7                  // 8 月起算秋季学期
    ? [y + " 秋季", (y + 1) + " 春季", (y + 1) + " 秋季"]
    : [y + " 春季", y + " 秋季", (y + 1) + " 春季"];
}

/** 周次候选：常见排课形态（含非整周的教学安排） */
var COURSE_WEEKS = [
  "1–16 周", "1–8 周", "9–16 周", "1–18 周", "单周", "双周", "集中实践周",
];

/** 规整课程数据：坏条目丢掉，字段补齐（存档坏了也不能白屏） */
function normalizeCourses(list) {
  if (!Array.isArray(list)) return null;
  return list
    .filter((c) => c && typeof c === "object" && String(c.name || "").trim())
    .map((c, i) => ({
      id: String(c.id || `course-${i + 1}`).trim(),
      name: String(c.name).trim(),
      code: String(c.code || "").trim(),
      term: String(c.term || "").trim(),
      weeks: String(c.weeks || "").trim(),
      desc: String(c.desc || "").trim(),
      page: String(c.page || "").trim(),
    }));
}

/**
 * 丢掉「旧版预置课程」—— 没有归属页面（`page` 为空）的那些（第 30 轮）。
 *
 * 🔴 为什么删种子删不干净：
 *   第 24 轮把「操作系统」那条 `page:""` 从 `SEED_COURSES` 里去掉了，
 *   但**已经按账号落过盘的存档**里还留着它。`loadCourses()` 是**先读存档、读不到才回落种子**，
 *   所以改种子对老存档完全无效 —— 侧栏会一直挂着一条灰的、点不动的「操作系统」，
 *   看着像"没删掉"。
 *
 * 🔴 为什么丢掉是安全的：
 *   现在**没有任何入口**能造出没有 page 的课程 —— `createCourse()` 一律给 `class.html`，
 *   `updateCourse()` 根本不碰 `page`。所以存档里出现的无 page 课程只能是那批预置残留，
 *   不可能是用户自己建的数据。
 *
 * 注意：清理放在这里（读存档之后），**不要塞进 `normalizeCourses()`** ——
 * 那个函数只管"形状"（字段补齐、坏条目丢掉），两者混在一起，
 * 「规整」的用例会被误伤。
 */
function dropLegacyDemoCourses(list) {
  return (list || []).filter(function (c) { return String((c && c.page) || "").trim(); });
}

/**
 * 老版本的**全局存档** → 迁到当前账号名下（只迁一次，迁完删掉旧键防止重复复制）。
 * 课程与实训共用这一份实现（第 31 轮抽出来），差别只在 normalizer / cleaner：
 *   · `normalize` 把存档规整成合法数组（坏值返回 null → 当作"没有记录"）
 *   · `clean`（可选）再清掉不该留的历史残留，如无 page 的旧预置课程
 */
function migrateLegacyStore(baseKey, newKey, normalize, clean) {
  try {
    const raw = window.localStorage.getItem(baseKey);
    if (!raw) return null;
    const shaped = normalize(JSON.parse(raw));
    if (!shaped || !shaped.length) return null;
    const list = clean ? clean(shaped) : shaped;
    window.localStorage.setItem(newKey, JSON.stringify(list));
    window.localStorage.removeItem(baseKey);
    // 清完是空的 → 当作"这个账号还没数据"，交给上层回落（种子 / 空）
    return list.length ? list : null;
  } catch (_) { return null; }
}

/** 老版本的全局课程存档 → 迁到当前账号名下 */
function tryMigrateLegacyCourses(newKey) {
  return migrateLegacyStore(COURSE_KEY, newKey, normalizeCourses, dropLegacyDemoCourses);
}

function loadCourses() {
  const key = courseStoreKey();
  const user = currentUserKey();

  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const ok = normalizeCourses(JSON.parse(raw));
      // ⚠️ 空数组也算有效（用户删光课程不该复活预置）；
      //    但旧存档里那条无 page 的预置课程要在这一步清掉（见 dropLegacyDemoCourses）。
      if (ok) {
        const clean = dropLegacyDemoCourses(ok);
        // 顺手把残留从存档里**抹掉**（不是只在内存里过滤）——
        // 否则每开一次页面都要清一次，而且别处读原始存档时会再看到它。
        // ⚠️ 这里不能调 saveCourses()：COURSES 还没赋值（就是本函数的返回值）。
        if (clean.length !== ok.length) {
          try { window.localStorage.setItem(key, JSON.stringify(clean)); } catch (_) { /* 存不下不影响显示 */ }
        }
        return clean;
      }
    }
  } catch (_) { /* 隐私模式 / file:// —— 退化为内存态 */ }

  // 老版本的全局存档：迁给当前账号（只迁一次）
  if (key !== COURSE_KEY) {
    const migrated = tryMigrateLegacyCourses(key);
    if (migrated) return migrated;
  }

  // 🔴 预置账号 / 没有账号标识（直接打开页面）→ 给预置课程，方便一眼看到效果；
  //    自己注册的账号 → **从空的开始**，不塞别人的预置数据。
  return (!user || isSeedAccount(user)) ? SEED_COURSES.slice() : [];
}

function saveCourses() {
  try { window.localStorage.setItem(courseStoreKey(), JSON.stringify(COURSES)); }
  catch (_) { /* 存不下就算了，界面照常能用 */ }
}

var COURSES = loadCourses();

/* ============================================================
   班级目录 —— 数据层（第 55 轮：从写死的 3 个班改成**可新建**）
   ------------------------------------------------------------
   🔴 与课程同一套约定（形态照抄 courseStoreKey / loadCourses）：
     · **按账号分桶**（`st_classes:teacher:zhangsan`）—— 班级是"这位老师带的班"，
       换个账号登录必须看到自己的班，而不是上一个人的
     · **只有预置账号才播种** `SEED_CLASSES`；自己注册的账号从**空**开始
     · 老版全局存档**一次性迁到当前账号**（迁完删旧键，防止重复复制）
     · 存不下（file:// / 隐私模式）就退化为内存态，不炸页面

   ⚠️ 班级**没有**真实的在册名单（那要教务系统，见 class.html 的说明）——
      这里的 `count` 只是用户填的"额定人数"，页面上必须标注清楚，
      别把它当成"这门课真有这么多学生"。
   ============================================================ */

var CLASS_KEY = "st_classes";        // 键基名；实际键见 classStoreKey()

/** 当前账号的班级存档键（与 courseStoreKey 同一形状） */
function classStoreKey() {
  const u = currentUserKey();
  return u ? CLASS_KEY + ":" + u : CLASS_KEY;
}

/** 预置班级（预置账号首次进入时用它）—— 就是原先写死的那 3 个 */
var SEED_CLASSES = [
  { id: "cs2301", label: "计科 2301 班", course: "数据结构与算法",
    major: "计算机科学与技术", grade: "2023 级", count: 48 },
  { id: "cs2302", label: "计科 2302 班", course: "数据结构与算法",
    major: "计算机科学与技术", grade: "2023 级", count: 45 },
  { id: "se2301", label: "软工 2301 班", course: "数据结构与算法",
    major: "软件工程",         grade: "2023 级", count: 52 },
];

/** 规整班级数据：坏条目丢掉，字段补齐（存档坏了也不能白屏） */
function normalizeClasses(list) {
  if (!Array.isArray(list)) return null;
  return list
    .filter(function (c) { return c && typeof c === "object" && String(c.label || "").trim(); })
    .map(function (c, i) {
      const n = Number(c.count);
      return {
        id: String(c.id || ("cls-" + (i + 1))).trim(),
        label: String(c.label).trim(),
        course: String(c.course || "").trim(),
        major: String(c.major || "").trim(),
        grade: String(c.grade || "").trim(),
        // 额定人数：非数字 / 非正数一律记 0（表示"未填"），别把 NaN 传下去
        count: (isFinite(n) && n > 0) ? Math.round(n) : 0,
      };
    });
}

function loadClasses() {
  const key = classStoreKey();
  const user = currentUserKey();

  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const ok = normalizeClasses(JSON.parse(raw));
      // ⚠️ 空数组也算有效（用户把班级删光了，不该复活预置）
      if (ok) return ok;
    }
  } catch (_) { /* 隐私模式 / file:// —— 退化为内存态 */ }

  // 老版本的全局存档：迁给当前账号（只迁一次）
  if (key !== CLASS_KEY) {
    const migrated = migrateLegacyStore(CLASS_KEY, key, normalizeClasses, null);
    if (migrated) return migrated;
  }

  // 预置账号 / 没有账号标识（直接打开页面）→ 给预置班级；自注册账号 → 从空开始
  return (!user || isSeedAccount(user)) ? SEED_CLASSES.slice() : [];
}

function saveClasses() {
  try { window.localStorage.setItem(classStoreKey(), JSON.stringify(CLASSES)); }
  catch (_) { /* 存不下就算了，界面照常能用 */ }
}

CLASSES = loadClasses();

/**
 * 重建「班级管理」菜单项并写回 NAV。
 * ⚠️ 必须**先重算 CLASS_NAV_ITEMS、再把同一个数组挂到 NAV 那组上** ——
 *    重新赋值 CLASS_NAV_ITEMS 之后，NAV 里若还指着旧数组，侧栏就不会更新。
 */
function refreshClassNav() {
  CLASS_NAV_ITEMS = CLASSES.map(function (c) {
    return {
      key: c.id, label: c.label, page: "class.html",
      arg: "cls=" + c.id,        // 附在页名后的查询串，见 navTarget()
      dot: true,
      // 🔴 这里**不挂「48 人」那种徽标**（第 33 轮）：`count` 是用户填的**额定人数**，
      //    本机根本没这么多学生，挂在侧栏等于宣称它是真的。
      //    真实的"谁在课里"由 enrolledStudentsOf(courseId) 算，页面自己显示。
    };
  });
  const groups = (typeof NAV !== "undefined" && NAV.teacher) || [];
  groups.forEach(function (g) { if (g.action === "addClass") g.items = CLASS_NAV_ITEMS; });
  return CLASS_NAV_ITEMS;
}

// ⚠️ 此刻 NAV 还没定义（它在下面）—— 这次只把 CLASS_NAV_ITEMS 算出来；
//    NAV 里那一组由文件下方（NAV 定义之后）的 refreshClassNav() 再补一次。
refreshClassNav();

/**
 * 新建班级：校验 → 生成 id → 落库 → 刷新菜单。
 * 返回 { ok, error?, klass? }，调用方只负责提示与重渲染。
 * 🔴 壳（shell.js）与独立模式（core.js）共用这一个实现，不要在两边各写一套。
 */
function createClass(data) {
  const label = String((data && data.label) || "").trim();
  if (!label) return { ok: false, error: "请先填写班级名称" };
  if (CLASSES.some(function (c) { return c.label === label; })) {
    return { ok: false, error: "已有同名班级「" + label + "」" };
  }

  // id：cls / cls-2 / cls-3 …（班级名多为中文，不做 slug，避免生成空 id）
  let id = "cls", n = 2;
  while (CLASSES.some(function (c) { return c.id === id; })) id = "cls-" + (n++);

  // 「暂不关联」是关联课程下拉里的占位项 —— 存进去等于"没关联"，归一成空串
  let course = String((data && data.course) || "").trim();
  if (course === "暂不关联") course = "";

  const num = Number(data && data.count);
  const klass = {
    id: id,
    label: label,
    course: course,
    major: String((data && data.major) || "").trim(),
    grade: String((data && data.grade) || "").trim(),
    count: (isFinite(num) && num > 0) ? Math.round(num) : 0,
  };
  CLASSES.push(klass);
  saveClasses();
  refreshClassNav();
  return { ok: true, klass: klass };
}

/**
 * 重建「我的课程」菜单项并写回 NAV。
 * 只作用于**教师端** —— 学生端「我的课程」是「我选的课」，与教师「我教的课」
 * 不是同一份数据，不能共用（学生端也没有那个「＋」）。
 */
function refreshCourseNav() {
  const items = COURSES.map(function (c) {
    // 每门课都带 `page` —— 没有页面（旧版预置残留）的课程在读档时就被清掉了
    // （见 dropLegacyDemoCourses），所以这里不会再产出「暗的、点不动的」条目。
    // 渲染侧仍保留兜底：万一真的没有 page，shell.js / core.js 会按 `!it.page`
    // 渲染成 `.side-item.disabled`（点不动），而不是给一个点了没反应的死链接。
    return {
      key: c.id, label: c.name, dot: true,
      page: c.page || null,
      arg: c.page ? "course=" + c.id : "",
    };
  });
  (NAV.teacher || []).forEach(function (g) {
    if (g.action === "addCourse") g.items = items;
  });
  return items;
}

/**
 * 新建课程：校验 → 生成 id → 落库 → 刷新菜单。
 * 返回 { ok, error?, course? }，调用方只负责提示与重渲染。
 * 🔴 壳（shell.js）与独立模式（core.js）共用这一个实现，不要在两边各写一套。
 */
function createCourse(data) {
  const name = String((data && data.name) || "").trim();
  if (!name) return { ok: false, error: "请先填写课程名称" };
  if (COURSES.some(function (c) { return c.name === name; })) {
    return { ok: false, error: "已有同名课程「" + name + "」" };
  }

  // id 优先用课程代码（可读、便于分享链接），没有就 course / course-2 / …
  const code = String((data && data.code) || "").trim();
  const base = /^[A-Za-z0-9_-]{1,16}$/.test(code) ? code.toLowerCase() : "course";
  let id = base, n = 2;
  while (COURSES.some(function (c) { return c.id === id; })) id = base + "-" + (n++);

  const course = {
    id: id,
    name: name,
    code: code,
    term: String((data && data.term) || "").trim(),
    weeks: String((data && data.weeks) || "").trim(),
    desc: String((data && data.desc) || "").trim(),
    page: "class.html",           // 新建的课都可点，落到「班级学情」
  };
  COURSES.push(course);
  saveCourses();
  refreshCourseNav();
  return { ok: true, course: course };
}

/**
 * 修改课程信息（名称 / 代码 / 学期 / 周次 / 简介）。
 * 校验规则与 createCourse 一致：空名、和别人重名都拦下。
 * 🔴 与 createCourse 一样，壳（shell.js）与独立模式（core.js）共用这一个实现。
 */
function updateCourse(id, patch) {
  const c = (COURSES || []).find(function (x) { return x.id === id; });
  if (!c) return { ok: false, error: "找不到该课程" };

  const name = String((patch && patch.name) || "").trim();
  if (!name) return { ok: false, error: "课程名称不能为空" };
  if (COURSES.some(function (x) { return x.id !== id && x.name === name; })) {
    return { ok: false, error: "已有同名课程「" + name + "」" };
  }

  c.name = name;
  c.code = String((patch && patch.code) || "").trim();
  c.term = String((patch && patch.term) || "").trim();
  c.weeks = String((patch && patch.weeks) || "").trim();
  c.desc = String((patch && patch.desc) || "").trim();
  saveCourses();
  refreshCourseNav();
  return { ok: true, course: c };
}

/** 这门课下挂着多少东西 —— 删除前要先告诉用户，别让他蒙着删 */
function courseAssetCount(id) {
  const lessons = Object.keys(LESSONS).filter(function (k) { return LESSONS[k].courseId === id; });
  const syl = SYLLABUS[id];
  return {
    lessons: lessons.length,
    chapters: syl ? syl.chapters.length : 0,
    hasSyllabus: !!syl,
  };
}

/**
 * 删除课程 —— **会连带删掉这门课的教案大纲与全部课时教案**（不可撤销）。
 * ⚠️ 调用方必须先把这个后果告诉用户并取得确认（见 shell.js / core.js 的 askDeleteCourse）。
 */
function deleteCourse(id) {
  const i = (COURSES || []).findIndex(function (c) { return c.id === id; });
  if (i < 0) return { ok: false, error: "找不到该课程" };

  const course = COURSES[i];
  const lessonIds = Object.keys(LESSONS).filter(function (k) { return LESSONS[k].courseId === id; });

  COURSES.splice(i, 1);
  saveCourses();

  delete SYLLABUS[id];                 // 教案大纲
  saveSyllabus();
  lessonIds.forEach(function (k) { delete LESSONS[k]; });
  saveLessons();

  refreshCourseNav();
  return { ok: true, course: course, removedLessons: lessonIds.length };
}

/** 菜单项的完整跳转目标。
 * 例：{ page: "class.html", arg: "cls=cs2301" } → "class.html?cls=cs2301"
 * 壳与独立模式共用这一个实现，避免一边带查询串一边不带。 */
function navTarget(it) {
  if (!it || !it.page) return "";
  return it.arg ? it.page + "?" + it.arg : it.page;
}

/**
 * 算出侧栏里哪一项是「当前项」，返回它在 targets 里的下标（没有则 -1）。
 *
 * 规则：**先找完整目标精确相等的；一个都没有时，才退回比对裸页名。**
 *
 * 为什么必须这样分两步：
 *  · 只按裸页名比 → `class.html?cls=cs2301` 与 `?cls=cs2302` 会**同时高亮**（看着像坏了）
 *  · 只按完整目标比 → 深链 `agent.html?task=parse-schedule` 匹配不到任何菜单项
 *    → 侧栏一个高亮都没有（也像坏了）
 * 两步走刚好覆盖两种情形：多个班各自精确命中，带任务的深链退回让「AI 助手」亮。
 */
function currentIndex(targets, current) {
  const cur = String(current || "").trim();
  if (!cur || !Array.isArray(targets)) return -1;

  let hit = targets.findIndex((t) => t && t === cur);
  if (hit >= 0) return hit;

  const bare = cur.split("?")[0];
  return targets.findIndex((t) => t && t.split("?")[0] === bare);
}

/** 双端菜单 —— 两套完全独立，互不包含对方专属入口 */
var NAV = {
  teacher: [
    {
      title: "我的工作",
      items: [
        { key: "schedule", label: "课表与事项", page: "schedule.html" },
        { key: "lesson",   label: "教案",       page: "lesson.html"   },
      ],
    },
    {
      title: "我的课程",
      action: "addCourse",              // 组标题右侧的「+」按钮
      items: [],                        // ← 由 COURSES 派生，见文件末尾的 refreshCourseNav()
    },
    {
      title: "教学",
      items: [
        { key: "exam",     label: "出题与组卷",   page: "exam.html"  },
        // 发布课件作业（第 47 轮）：选课程 + 圈章节 → 写 / 传正文 → 发布到班级
        //   🔴 学生端读的是**同一份记录**（跨账号桶），不是各存一份 —— 见 §18
        { key: "push",     label: "发布课件作业", page: "courseware.html" },
        // 实训管理（第 31 轮）：灵感见 docs/IDEAS.md
        //   灵感 01 层 2「实训活动」（教师发布 / 学生参与）
        //   灵感 02「学生发起的探究式实训」—— 核心是**不给答案、给路径**
        // 🔴 badge 由 refreshActivityNav() 现算（学生发起直接开启后恒 0，不再挂徽标），
        //    不要在字面量里写死一个数字。
        { key: "training", label: "实训管理",     page: "training.html" },
        // 「课程成员」= class.html 的课程视角：**真实的在课学生**（谁用邀请码进了这门课）。
        // 班级视角（?cls=）由「班级管理」组进入 —— 见 class.html 的说明。
        { key: "class",    label: "课程成员",     page: "class.html" },
        // 学生管理（第 48 轮）：以「人」为中心的总册 —— 本机每个学生 + 学习活跃 + 作业提交。
        //   与「课程成员」（以课为中心）互补：那边是"这门课里有哪些人"，
        //   这边是"本机有哪些学生、各人跨课什么样、谁该跟进"。
        { key: "stu",      label: "学生管理",     page: "stu.html"   },
      ],
    },
    {
      title: "班级管理",
      action: "addClass",              // 组标题右侧的「+」按钮
      items: CLASS_NAV_ITEMS,
    },
    {
      title: "智能体",
      items: [
        // 工作台在前：它是「容器」，AI 助手是「对话」——用户 9/29 的灵感里
        // 「一站式工作台」就是要把这类东西收进一个地方
        { key: "workbench", label: "工作台", page: "workbench.html" },
        { key: "agent", label: "AI 助手", page: "agent.html" },
      ],
    },
    {
      title: "设置",
      items: [
        { key: "settings", label: "偏好设置", page: "settings.html" },
      ],
    },
  ],

  student: [
    {
      title: "我的课程",
      action: "joinCourse",             // 组标题右侧的「＋」= 输入邀请码加入课堂
      // 🔴 学生端「我的课程」= **我加入的课堂**，与教师端「我教的课」（COURSES 派生）
      //    不是同一份数据，所以 items 初始为空、由 refreshStudentCourseNav() 回填
      //    （数据源是 ENROLLED，见文件末尾的「学生选课」一节）。
      //    ⚠️ 别在字面量里写死课程 —— 写死的那两条预置占位第 30 轮已清掉。
      //    ⚠️ 每一项都带 page（没有 page 的项会渲染成灰的、点不动，用户以为坏了）。
      items: [],
    },
    {
      title: "学习",
      items: [
        { key: "chat",     label: "AI 答疑",  page: "chat.html"     },
        { key: "reader",   label: "课件阅读", page: "reader.html"   },
        { key: "analysis", label: "我的学情", page: "analysis.html" },
        // 🔴 badge 由 refreshExamNav() 现算（老师发来的卷子数），不要在字面量里写死 ——
        //    老版这里写死的 "2" 是假数据（用户一眼就能看出跟真卷子对不上）。
        { key: "hw",       label: "我的作业", page: "homework.html" },
        // 实训（学生侧）：参与老师发布的探究式实训 + 自己发起（灵感 01 层 2 + 灵感 02）。
        //   🔴 badge 由 refreshStudentTrainingNav() 现算（进行中的实训数），别写死。
        { key: "training", label: "实训",     page: "training-student.html" },
      ],
    },
    {
      title: "智能体",
      items: [
        { key: "workbench", label: "工作台", page: "workbench.html" },
        { key: "agent", label: "AI 助手", page: "agent-student.html" },
      ],
    },
    {
      title: "设置",
      items: [
        { key: "settings", label: "偏好设置", page: "settings.html" },
      ],
    },
  ],
};

/* 菜单项要等 NAV 定义完才能回填 —— 「我的课程」/「班级管理」的 items
   分别由 COURSES / CLASSES 派生 */
refreshCourseNav();
refreshClassNav();

/* ============================================================
   教案：大纲 / 课时教案 / 版本链 —— 唯一来源（第 20 轮）
   ------------------------------------------------------------
   设计稿：docs/PLAN-lesson.md。四层：
     课程 COURSES → 教案大纲（课程级）→ 课时教案（每次课一份）→ 版本链
   粒度：**大纲切到「章」，教案切到「课时」**。

   存储：
     st_syllabus = { [courseId]: { courseId, goal, updated, chapters:[…] } }
     st_lessons  = { [lessonId]: { …, head, commits:[…] } }

   🔴 版本历史**只增不减**：编辑是追加一条 commit，回退也是追加一条
      （kind:"revert"），语义等同 git revert —— 用户永远不会因点错而丢内容。

   🔴 与 COURSES 同理：空对象 {} 是**有效存档**（用户删光教案不该复活种子）。
   ============================================================ */

var SYLLABUS_KEY = "st_syllabus";
var LESSON_KEY = "st_lessons";
var LESSON_PICK_KEY = "st_lesson_pick";     // 记住上次看的是哪门课 / 哪个课时
var DAY_MS = 86400000;
var SEED_NOW = Date.now();                  // 种子数据的时间基准

/** 课时状态（三档，够用且不啰嗦） */
var LESSON_STATUS = {
  draft:  { label: "草稿", tone: "muted" },
  ready:  { label: "待上", tone: "info"  },
  taught: { label: "已上", tone: "ok"    },
};

/** 提交类型 —— 版本时间线上的徽标（教案版本链与大纲版本链共用这一份） */
var COMMIT_KIND = {
  init:      { label: "新建",     tone: "muted" },
  edit:      { label: "编辑",     tone: "muted" },
  structure: { label: "调整结构", tone: "info"  },
  reflect:   { label: "课后改进", tone: "info"  },
  ai:        { label: "AI 建议",  tone: "info"  },
  revert:    { label: "回退",     tone: "warn"  },
};

/**
 * 取提交类型的展示信息 —— **永远走这个**，不要直接 `COMMIT_KIND[kind]`。
 * 存档里可能出现本版本还不认识的 kind（降级打开、手工改过存档），
 * 直接索引会得到 undefined 再读 `.label` → 整页崩。
 */
var COMMIT_KIND_FALLBACK = { label: "改动", tone: "muted" };
function commitKind(kind) {
  return COMMIT_KIND[kind] || COMMIT_KIND_FALLBACK;
}

/** 教案的结构化字段 —— **渲染与 diff 共用这一份定义**，不要在两处各写一套 */
var SNAP_FIELDS = [
  { key: "goals",      label: "教学目标", kind: "text"  },
  { key: "keyPoints",  label: "教学重点", kind: "list"  },
  { key: "hardPoints", label: "教学难点", kind: "text"  },
  { key: "steps",      label: "课堂流程", kind: "steps" },
  { key: "homework",   label: "作业布置", kind: "text"  },
  { key: "note",       label: "学情提示", kind: "text"  },
];

/** tone → 标签 class（壳内 design.css 提供 .tag / .tag-primary / .tag-success / .tag-warning） */
function toneClass(tone) {
  if (tone === "info") return "tag tag-primary";
  if (tone === "ok")   return "tag tag-success";
  if (tone === "warn") return "tag tag-warning";
  return "tag";
}

/** 当前用户名（没登录信息就退回「我」） */
function localName() {
  try {
    const n = window.localStorage.getItem("st_display_name");
    if (n) {
      const s = String(n).replace(/^"|"$/g, "").trim();
      if (s) return s;
    }
  } catch (_) { /* file:// 或隐私模式 */ }
  return "我";
}

function cloneData(x) { return JSON.parse(JSON.stringify(x)); }

/* ---------------- 种子：把原来写死的三章教案「课时化」 ---------------- */
var SEED_SYLLABUS = {
  ds: {
    courseId: "ds",
    goal: "掌握常用数据结构的逻辑结构与存储实现，能分析经典算法的时空复杂度，并针对具体问题选择合适的组织方式。",
    updated: SEED_NOW - 11 * DAY_MS,
    chapters: [
      { id: "ds-c1", title: "第 1 章 · 绪论", hours: 2, points: "数据结构基本概念、算法复杂度分析", lessonIds: [] },
      { id: "ds-c6", title: "第 6 章 · 图",   hours: 5, points: "图的存储结构、DFS/BFS、最短路径", lessonIds: ["ds-c6-1", "ds-c6-2"] },
      { id: "ds-c7", title: "第 7 章 · 排序", hours: 4, points: "五类排序的过程、复杂度与稳定性",   lessonIds: ["ds-c7-1", "ds-c7-2", "ds-c7-3"] },
      { id: "ds-c8", title: "第 8 章 · 查找", hours: 3, points: "折半查找的前提、二叉搜索树、散列冲突", lessonIds: ["ds-c8-1"] },
    ],
  },
};

var SEED_LESSONS = {
  "ds-c6-1": {
    id: "ds-c6-1", courseId: "ds", chapterId: "ds-c6",
    title: "第 6 章 · 第 1 课时：图的存储与遍历",
    minutes: 45, status: "ready", taughtAt: "", head: 0,
    commits: [{
      id: "v1", at: SEED_NOW - 9 * DAY_MS, by: "李老师", kind: "init", msg: "新建课时教案",
      snap: {
        goals: "掌握邻接矩阵与邻接表两种存储结构，能说清各自的适用场景；能手工写出给定图的 DFS 与 BFS 遍历序列。",
        keyPoints: [
          "邻接矩阵与邻接表在空间与查询效率上的取舍",
          "DFS 的递归实现与显式栈实现",
          "BFS 的队列实现与「层」的概念",
        ],
        hardPoints: "为什么 BFS 能求无权图的最短路径而 DFS 不能；邻接表的空间复杂度为什么是 O(V+E)。",
        steps: [
          { t: "导入", min: 8,  d: "用「校园各教学楼之间的通道」引入图，让学生先凭直觉说出从图书馆到实验楼怎么走。" },
          { t: "探究", min: 22, d: "给出 6 个节点的小图，分别用邻接矩阵和邻接表写出存储结构，对比两者占用的格子数。" },
          { t: "练习", min: 10, d: "手写该图的 DFS 与 BFS 序列，当堂核对差异。" },
          { t: "小结", min: 5,  d: "归纳两种遍历的走法与适用场景。" },
        ],
        homework: "完成课后练习 3–10 题；绘制一张包含 8 个节点的图并写出其 DFS 与 BFS 序列。",
        note: "本班在第 6 章整体正确率偏低，遍历部分建议放慢节奏、多留当堂练习时间。",
      },
    }],
  },

  "ds-c6-2": {
    id: "ds-c6-2", courseId: "ds", chapterId: "ds-c6",
    title: "第 6 章 · 第 2 课时：最短路径",
    minutes: 45, status: "ready", taughtAt: "", head: 0,
    commits: [{
      id: "v1", at: SEED_NOW - 8 * DAY_MS, by: "李老师", kind: "init", msg: "新建课时教案",
      snap: {
        goals: "理解 Dijkstra 的贪心思想与执行过程，能说清它为什么要求边权非负。",
        keyPoints: [
          "Dijkstra 的「已确定集合」什么时候扩大",
          "负权边为什么会让贪心失效",
          "单源最短路与多源最短路的算法选择",
        ],
        hardPoints: "Dijkstra 贪心正确性的直观解释；负权边导致失效的具体反例。",
        steps: [
          { t: "导入", min: 10, d: "用校园地图导航引入「最短路径」，让学生先凭直觉说出路线选择依据。" },
          { t: "探究", min: 25, d: "以 6 个节点的小图为例，手动执行 Dijkstra 全过程，逐步标注已确定节点。" },
          { t: "练习", min: 5,  d: "给定含负权边的图，尝试执行并发现异常，引出算法适用条件。" },
          { t: "小结", min: 5,  d: "归纳无负权 / 有负权 / 多源三类场景的算法选择。" },
        ],
        homework: "完成课后练习 12–18 题；对给定的含负权图说明 Dijkstra 会在哪一步出错。",
        note: "接续上一课时，学生此时对遍历已较熟悉，可把重心完全放在算法执行过程上。",
      },
    }],
  },

  "ds-c7-1": {
    id: "ds-c7-1", courseId: "ds", chapterId: "ds-c7",
    title: "第 7 章 · 第 1 课时：冒泡与插入排序",
    minutes: 45, status: "taught", taughtAt: "", head: 1,
    commits: [
      {
        id: "v1", at: SEED_NOW - 7 * DAY_MS, by: "李老师", kind: "init", msg: "新建课时教案",
        snap: {
          goals: "理解冒泡与插入排序的过程，能从比较与移动次数推出 O(n²) 的来源。",
          keyPoints: [
            "冒泡排序每一轮把最大值「冒」到末尾",
            "插入排序维持「前面已有序」的不变式",
            "两种排序在近乎有序数据上的表现差异",
          ],
          hardPoints: "为什么插入排序在近乎有序的数据上接近 O(n)，而冒泡不会。",
          steps: [
            { t: "导入", min: 8,  d: "用「整理一摞乱序试卷」引入排序问题，提问：人工整理和机器整理有什么共同点？" },
            { t: "探究", min: 25, d: "动画演示冒泡与插入排序，让学生手写前 3 轮状态。" },
            { t: "练习", min: 10, d: "完成 5 道复杂度判断题 + 2 道手写排序过程题，当堂点评共性问题。" },
            { t: "小结", min: 2,  d: "用一张表对比两种排序的时间与稳定性。" },
          ],
          homework: "完成课后练习 1–5 题，写出冒泡与插入排序在最坏情况下的比较次数。",
          note: "本章是重点章，开头的复习环节建议顺带回顾拓扑排序。",
        },
      },
      {
        id: "v2", at: SEED_NOW - 2 * DAY_MS, by: "李老师", kind: "reflect",
        msg: "课后改进：导入环节发卡片，让全班动手排一遍再讲代码",
        reflect: {
          at: SEED_NOW - 2 * DAY_MS, date: "第 4 教学周 周三",
          saw: "学生对「每一轮把最大值冒到末尾」理解很快，但对插入排序的「移位」过程普遍卡住，有近一半人把插入写成了交换。",
          todo: "下次导入就发排序卡片让全班动手排一遍，再对照代码；插入排序补一张移位过程的逐步图。",
        },
        snap: {
          goals: "理解冒泡与插入排序的过程，能从比较与移动次数推出 O(n²) 的来源。",
          keyPoints: [
            "冒泡排序每一轮把最大值「冒」到末尾",
            "插入排序维持「前面已有序」的不变式",
            "插入是「移位」而不是「两两交换」",
            "两种排序在近乎有序数据上的表现差异",
          ],
          hardPoints: "为什么插入排序在近乎有序的数据上接近 O(n)，而冒泡不会。",
          steps: [
            { t: "导入", min: 13, d: "每人发 5 张数字卡片，先自己排一遍并说出「你每一步在做什么」，再引入排序问题的形式化描述。" },
            { t: "探究", min: 20, d: "动画演示冒泡与插入排序，让学生手写前 3 轮状态；插入排序额外用一张移位过程图逐步对照。" },
            { t: "练习", min: 10, d: "完成 5 道复杂度判断题 + 2 道手写排序过程题，当堂点评共性问题。" },
            { t: "小结", min: 2,  d: "用一张表对比两种排序的时间与稳定性。" },
          ],
          homework: "完成课后练习 1–5 题，写出冒泡与插入排序在最坏情况下的比较次数。",
          note: "已上过一轮：插入排序的移位过程需要配图，学生容易与交换混淆。",
        },
      },
    ],
  },

  "ds-c7-2": {
    id: "ds-c7-2", courseId: "ds", chapterId: "ds-c7",
    title: "第 7 章 · 第 2 课时：快速排序",
    minutes: 45, status: "ready", taughtAt: "", head: 2,
    commits: [
      {
        id: "v1", at: SEED_NOW - 6 * DAY_MS, by: "李老师", kind: "init", msg: "新建课时教案",
        snap: {
          goals: "理解分治思想在快速排序中的体现，能手工完成一次分区过程。",
          keyPoints: [
            "分区（partition）的目标：左边都不大于主元，右边都不小于主元",
            "平均 O(n log n) 与最坏 O(n²) 的差别从哪里来",
          ],
          hardPoints: "最坏情况的构造方式，以及随机化主元为什么能缓解。",
          steps: [
            { t: "导入", min: 8,  d: "回顾分治：把大问题切成两个同类小问题。" },
            { t: "探究", min: 25, d: "以 8 个数的数组演示分区过程，逐轮标出左右指针。" },
            { t: "练习", min: 10, d: "给两组数据（随机 / 已有序）手工执行，对比轮数。" },
            { t: "小结", min: 2,  d: "归纳快排的适用场景。" },
          ],
          homework: "完成课后练习 6–9 题。",
          note: "",
        },
      },
      {
        id: "v2", at: SEED_NOW - 4 * DAY_MS, by: "李老师", kind: "edit",
        msg: "把「已有序数据」的对比练习移到探究环节，避免最后时间不够",
        snap: {
          goals: "理解分治思想在快速排序中的体现，能手工完成一次分区过程，并说明最坏情况的成因。",
          keyPoints: [
            "分区（partition）的目标：左边都不大于主元，右边都不小于主元",
            "平均 O(n log n) 与最坏 O(n²) 的差别从哪里来",
            "主元选取对递归深度的影响",
          ],
          hardPoints: "最坏情况的构造方式，以及随机化主元为什么能缓解。",
          steps: [
            { t: "导入", min: 8,  d: "回顾分治：把大问题切成两个同类小问题。" },
            { t: "探究", min: 28, d: "以 8 个数的数组演示分区过程，逐轮标出左右指针；紧接着对同一批数用「已有序」的输入再走一遍，对比递归深度。" },
            { t: "练习", min: 7,  d: "给出 3 组输入，判断哪一组会退化成 O(n²)。" },
            { t: "小结", min: 2,  d: "归纳快排的适用场景与规避最坏情况的常用做法。" },
          ],
          homework: "完成课后练习 6–9 题；说明随机化主元把「必然最坏」变成「概率最坏」的原因。",
          note: "上个课时发现学生对「指针移动」理解较慢，本课时需要现场多走几遍。",
        },
      },
      {
        id: "v3", at: SEED_NOW - 1 * DAY_MS, by: "李老师", kind: "reflect",
        msg: "预计难点：分区指针移动 + 最坏情况，先补一张指针轨迹图",
        reflect: {
          at: SEED_NOW - 1 * DAY_MS, date: "第 4 教学周 周五",
          saw: "本课时尚未上，但上一课时的观察显示：学生对手写指针移动的过程明显吃力，反复问「指针什么时候停」。",
          todo: "课前补一张指针轨迹图放在课件里；探究环节先让学生两人一组互相讲一遍指针怎么走，再全班复盘。",
        },
        snap: {
          goals: "理解分治思想在快速排序中的体现，能手工完成一次分区过程，并说明最坏情况的成因。",
          keyPoints: [
            "分区（partition）的目标：左边都不大于主元，右边都不小于主元",
            "左右指针各自的移动条件与停止条件",
            "平均 O(n log n) 与最坏 O(n²) 的差别从哪里来",
            "主元选取对递归深度的影响",
          ],
          hardPoints: "最坏情况的构造方式，以及随机化主元为什么能缓解。",
          steps: [
            { t: "导入", min: 8,  d: "回顾分治：把大问题切成两个同类小问题。" },
            { t: "探究", min: 28, d: "先发指针轨迹图，两人一组互相讲一遍左右指针怎么走；再按轨迹图对 8 个数完整演示一次分区。" },
            { t: "练习", min: 7,  d: "给出 3 组输入，判断哪一组会退化成 O(n²)。" },
            { t: "小结", min: 2,  d: "归纳快排的适用场景与规避最坏情况的常用做法。" },
          ],
          homework: "完成课后练习 6–9 题；说明随机化主元把「必然最坏」变成「概率最坏」的原因。",
          note: "上一课时学生对指针移动吃力，本课时已补轨迹图并增加同伴讲解环节。",
        },
      },
    ],
  },

  "ds-c7-3": {
    id: "ds-c7-3", courseId: "ds", chapterId: "ds-c7",
    title: "第 7 章 · 第 3 课时：堆排序",
    minutes: 45, status: "draft", taughtAt: "", head: 0,
    commits: [{
      id: "v1", at: SEED_NOW - 3 * DAY_MS, by: "李老师", kind: "init", msg: "新建课时教案",
      snap: {
        goals: "理解完全二叉树的数组表示，能完成一次自顶向下的「下沉」调整。",
        keyPoints: [
          "下标 i 的左右孩子为什么是 2i+1 与 2i+2",
          "建堆为什么是 O(n) 而不是 O(n log n)",
        ],
        hardPoints: "建堆的复杂度证明；下沉与上浮的使用场景差异。",
        steps: [
          { t: "导入", min: 5, d: "尚未填写，点「编辑」可继续。" },
        ],
        homework: "（待定）",
        note: "本章尚未定稿。",
      },
    }],
  },

  "ds-c8-1": {
    id: "ds-c8-1", courseId: "ds", chapterId: "ds-c8",
    title: "第 8 章 · 第 1 课时：折半查找",
    minutes: 45, status: "draft", taughtAt: "", head: 0,
    commits: [{
      id: "v1", at: SEED_NOW - 12 * DAY_MS, by: "李老师", kind: "init", msg: "新建课时教案",
      snap: {
        goals: "掌握折半查找的实现与 O(log n) 的来源，能说明「必须有序」这一前提。",
        keyPoints: [
          "每次比较都能排除一半候选区间",
          "循环边界为什么写 left <= right",
          "有序前提被破坏后会怎样",
        ],
        hardPoints: "边界条件的推导；为什么不能对链表高效地做折半查找。",
        steps: [
          { t: "导入", min: 6, d: "用「猜数字」游戏引入：每次告诉「大了 / 小了」，最快几次能猜到？" },
          { t: "探究", min: 24, d: "在 16 个有序数上手工执行折半查找，记录每次的区间。" },
          { t: "练习", min: 10, d: "写出边界条件的两种写法并验证是否正确。" },
          { t: "小结", min: 5, d: "归纳前提、复杂度与失效条件。" },
        ],
        homework: "完成课后练习 1–6 题。",
        note: "本章尚未定稿，结构与上一版保持一致即可。",
      },
    }],
  },
};

/* ---------------- 规整（存档坏了也不能白屏） ---------------- */

function normSnap(s) {
  const o = (s && typeof s === "object") ? s : {};
  return {
    goals: String(o.goals || ""),
    keyPoints: Array.isArray(o.keyPoints)
      ? o.keyPoints.map((x) => String(x).trim()).filter(Boolean) : [],
    hardPoints: String(o.hardPoints || ""),
    steps: Array.isArray(o.steps)
      ? o.steps.filter((x) => x && (x.t || x.d)).map((x) => ({
          t: String(x.t || "").trim(),
          min: Number(x.min) > 0 ? Math.floor(Number(x.min)) : 0,
          d: String(x.d || "").trim(),
        }))
      : [],
    homework: String(o.homework || ""),
    note: String(o.note || ""),
  };
}

function normCommit(c, i) {
  const o = (c && typeof c === "object") ? c : {};
  const kinds = Object.keys(COMMIT_KIND);
  const r = o.reflect;
  return {
    id: String(o.id || "v" + (i + 1)),
    at: Number(o.at) || 0,
    by: String(o.by || "我"),
    kind: kinds.indexOf(o.kind) >= 0 ? o.kind : "edit",
    msg: String(o.msg || ""),
    snap: normSnap(o.snap),
    reflect: (r && typeof r === "object") ? {
      at: Number(r.at) || 0,
      date: String(r.date || ""),
      saw: String(r.saw || ""),
      todo: String(r.todo || ""),
    } : null,
  };
}

function normLesson(l, key) {
  if (!l || typeof l !== "object") return null;
  const commits = (Array.isArray(l.commits) ? l.commits : []).map(normCommit);
  if (!commits.length) return null;                  // 没有版本 = 无效教案
  let head = Math.floor(Number(l.head));
  if (!(head >= 0 && head < commits.length)) head = commits.length - 1;
  const status = Object.prototype.hasOwnProperty.call(LESSON_STATUS, l.status) ? l.status : "draft";
  return {
    id: String(l.id || key || "").trim(),
    courseId: String(l.courseId || "").trim(),
    chapterId: String(l.chapterId || "").trim(),
    title: String(l.title || "未命名课时").trim(),
    minutes: Number(l.minutes) > 0 ? Math.floor(Number(l.minutes)) : 45,
    status: status,
    taughtAt: String(l.taughtAt || ""),
    head: head,
    commits: commits,
  };
}

/* ---------------- 大纲快照（第 29 轮：大纲也有版本链了）----------------
   大纲 = 这门课的「章节结构」：章的先后顺序、每章的标题/课时数/核心知识点、
   以及章下挂着哪些课时、章内的先后顺序。
   🔴 课时**内容**不进这个快照 —— 它有自己的版本链（commits[head].snap）。
      这里只记结构，两套版本链各管各的，diff 才读得懂。
   ============================================================ */

/** 规整一章（没有标题的章视为无效，直接丢掉） */
function normChapter(c, courseId, i) {
  if (!c || typeof c !== "object") return null;
  const title = String(c.title || "").trim();
  if (!title) return null;
  return {
    id: String(c.id || courseId + "-c" + (i + 1)).trim(),
    title: title,
    hours: Number(c.hours) > 0 ? Math.floor(Number(c.hours)) : 0,
    points: String(c.points || "").trim(),
    lessonIds: (Array.isArray(c.lessonIds) ? c.lessonIds : []).map(String).filter(Boolean),
  };
}

function normOutlineSnap(s, courseId) {
  const arr = (s && typeof s === "object" && Array.isArray(s.chapters)) ? s.chapters : [];
  return { chapters: arr.map((c, i) => normChapter(c, courseId, i)).filter(Boolean) };
}

function normOutlineCommit(c, i, courseId) {
  const o = (c && typeof c === "object") ? c : {};
  return {
    id: String(o.id || "v" + (i + 1)),
    at: Number(o.at) || 0,
    by: String(o.by || "我"),
    kind: Object.prototype.hasOwnProperty.call(COMMIT_KIND, o.kind) ? o.kind : "edit",
    msg: String(o.msg || ""),
    snap: normOutlineSnap(o.snap, courseId),
  };
}

/**
 * 当前结构 = `commits[head].snap.chapters` —— **唯一真相**。
 * 用一个不可枚举的 getter 暴露成 `syl.chapters`：
 *   · 既有代码（读）不用改一行
 *   · **结构不会存两份**，否则迟早不同步（这是教案那套已经验证过的教训）
 * 赋值会直接抛错 —— 结构只能通过 commitOutline() 追加版本，别就地改。
 */
function attachChaptersGetter(syl) {
  Object.defineProperty(syl, "chapters", {
    get() {
      const c = this.commits[this.head];
      return (c && c.snap && c.snap.chapters) || [];
    },
    set() {
      throw new Error("大纲结构是只读的：请用 commitOutline() 追加一版，不要直接赋值");
    },
    enumerable: false,
    configurable: true,
  });
}

function normSyllabus(s, courseId) {
  if (!s || typeof s !== "object") return null;
  const cid = String(s.courseId || courseId).trim();

  let commits;
  if (Array.isArray(s.commits) && s.commits.length) {
    commits = s.commits.map((c, i) => normOutlineCommit(c, i, cid));
  } else {
    // 老存档（只有 chapters、没有版本）→ 包成一条 v1，**不丢数据**
    const snap = normOutlineSnap({ chapters: s.chapters }, cid);
    if (!snap.chapters.length) return null;            // 旧格式里「没有章」= 无效大纲
    commits = [{
      id: "v1",
      at: Number(s.updated) || 0,
      by: localName(),
      kind: "init",
      msg: "新建教案大纲",
      snap: snap,
    }];
  }
  if (!commits.length) return null;

  let head = Math.floor(Number(s.head));
  if (!(head >= 0 && head < commits.length)) head = commits.length - 1;

  const out = {
    courseId: cid,
    goal: String(s.goal || ""),
    updated: Number(s.updated) || 0,
    head: head,
    commits: commits,
  };
  attachChaptersGetter(out);
  return out;
}

/* ---------------- 读写 ---------------- */

function loadSyllabus() {
  try {
    const raw = window.localStorage.getItem(SYLLABUS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const out = {};
        Object.keys(obj).forEach((k) => { const v = normSyllabus(obj[k], k); if (v) out[k] = v; });
        return out;                                  // ⚠️ 空对象也算有效存档
      }
    }
  } catch (_) { /* 隐私模式 / file:// → 退化为内存态 */ }
  // 🔴 种子也必须过一遍 normSyllabus —— 否则它没有 commits / 没有 getter，
  //    大纲版本链在「首次打开」时是空的（用户第一次进来就看不到历史）。
  const seed = {};
  Object.keys(SEED_SYLLABUS).forEach((k) => {
    const v = normSyllabus(SEED_SYLLABUS[k], k);
    if (v) seed[k] = v;
  });
  return seed;
}

function loadLessons() {
  try {
    const raw = window.localStorage.getItem(LESSON_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const out = {};
        Object.keys(obj).forEach((k) => { const v = normLesson(obj[k], k); if (v) out[k] = v; });
        return out;                                  // ⚠️ 空对象也算有效存档（删光不复活）
      }
    }
  } catch (_) { /* 同上 */ }
  return cloneData(SEED_LESSONS);
}

function saveSyllabus() {
  try { window.localStorage.setItem(SYLLABUS_KEY, JSON.stringify(SYLLABUS)); } catch (_) {}
}

function saveLessons() {
  try { window.localStorage.setItem(LESSON_KEY, JSON.stringify(LESSONS)); } catch (_) {}
}

var SYLLABUS = loadSyllabus();
var LESSONS = loadLessons();

/* ---------------- 查询 ---------------- */

function syllabusOf(courseId) { return SYLLABUS[courseId] || null; }

/**
 * 章节的「核心知识点」在存档里是**顿号 / 逗号分隔的字符串**
 * （见 `SEED_SYLLABUS` 的 `points: "图的存储结构、DFS/BFS、最短路径"`），
 * 但旧的 / 手改的存档可能是数组 —— 这里统一切成数组。
 * ⚠️ 别直接 `points.slice()`：字符串也有 `slice`，会切出半个字符串然后 `.join` 崩掉（踩过）。
 */
function splitPoints(v) {
  if (Array.isArray(v)) return v.map(function (s) { return String(s).trim(); }).filter(Boolean);
  return String(v == null ? "" : v).split(/[、,，;；]\s*/)
    .map(function (s) { return s.trim(); }).filter(Boolean);
}
function lessonById(id) { return LESSONS[id] || null; }
function lessonSnap(l) { return (l && l.commits[l.head] && l.commits[l.head].snap) || normSnap({}); }
function lessonReflects(l) {
  if (!l) return [];
  return l.commits
    .map((c, i) => ({ commit: c, index: i }))
    .filter((x) => x.commit.reflect)
    .reverse();
}
/** 版本时间线（倒序，带原下标，便于「对比 / 回退 / 查看」定位） */
function lessonHistory(l) {
  if (!l) return [];
  return l.commits.map((c, i) => ({ commit: c, index: i })).reverse();
}

/* ---------------- 大纲：版本链查询 ---------------- */

/** 当前大纲结构（章数组）—— 唯一真相在 commits[head].snap */
function syllabusChapters(courseId) {
  const syl = syllabusOf(courseId);
  if (!syl) return [];
  const c = syl.commits[syl.head];
  return (c && c.snap && c.snap.chapters) || [];
}

/** 大纲的版本时间线（倒序，带原下标） */
function syllabusHistory(syl) {
  if (!syl) return [];
  return syl.commits.map((c, i) => ({ commit: c, index: i })).reverse();
}

/** 两套「章数组」是否结构相同（顺序也算） */
function outlineEqual(a, b) {
  const A = Array.isArray(a) ? a : [];
  const B = Array.isArray(b) ? b : [];
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) {
    const x = A[i], y = B[i];
    if (x.id !== y.id || x.title !== y.title || (x.hours || 0) !== (y.hours || 0)) return false;
    if ((x.points || "") !== (y.points || "")) return false;
    if ((x.lessonIds || []).join("\u0001") !== (y.lessonIds || []).join("\u0001")) return false;
  }
  return true;
}

/**
 * 追加一版大纲。
 * 🔴 结构没有变化就**不产生新版本** —— 否则「点了一下没改」也会堆一条历史，
 *    时间线很快被噪声淹没（教案那边同一条规矩）。
 */
function commitOutline(courseId, chapters, msg, kind) {
  const syl = syllabusOf(courseId);
  if (!syl) return { ok: false, error: "该课程还没有教案大纲" };

  const snap = normOutlineSnap({ chapters: chapters }, courseId);
  if (outlineEqual(syllabusChapters(courseId), snap.chapters)) {
    return { ok: false, unchanged: true, error: "结构没有变化，未产生新版本" };
  }

  const k = Object.prototype.hasOwnProperty.call(COMMIT_KIND, kind) ? kind : "edit";
  const now = Date.now();
  const commit = {
    id: "v" + (syl.commits.length + 1),
    at: now,
    by: localName(),
    kind: k,
    msg: String(msg || "").trim() || "编辑教案大纲",
    snap: snap,
  };
  syl.commits.push(commit);
  syl.head = syl.commits.length - 1;
  syl.updated = now;
  saveSyllabus();
  return { ok: true, commit: commit };
}

/**
 * 回退大纲到某一版 —— 与教案一样：**追加一条 revert 版本，不删历史**（等同 git revert）。
 * 返回 `missingLessons`：快照里引用了、但现在已经不存在的课时数。
 *   （回退不会凭空把删掉的教案变回来 —— 那部分数据真的没了。要如实告诉用户，
 *     而不是悄悄回退成一个指向空处的结构。）
 */
function revertSyllabus(courseId, index) {
  const syl = syllabusOf(courseId);
  if (!syl) return { ok: false, error: "该课程还没有教案大纲" };
  const i = Math.floor(Number(index));
  if (!(i >= 0 && i < syl.commits.length)) return { ok: false, error: "版本号越界" };
  if (i === syl.head) return { ok: false, error: "这就是当前版本，不用回退" };

  const src = syl.commits[i];
  const snap = cloneData(src.snap);
  let missing = 0;
  snap.chapters.forEach((ch) => {
    (ch.lessonIds || []).forEach((id) => { if (!LESSONS[id]) missing++; });
  });

  const now = Date.now();
  const commit = {
    id: "v" + (syl.commits.length + 1),
    at: now,
    by: localName(),
    kind: "revert",
    msg: "回到 " + src.id + "（" + (src.msg || "无说明") + "）",
    snap: snap,
  };
  syl.commits.push(commit);
  syl.head = syl.commits.length - 1;
  syl.updated = now;
  saveSyllabus();
  return { ok: true, commit: commit, missingLessons: missing };
}

/** 课时标题太长时只留「：」之后的部分（侧栏 / 日志里都用它） */
function shortTitle(t) {
  const s = String(t || "");
  const i = s.lastIndexOf("：");
  return (i >= 0 && i < s.length - 1) ? s.slice(i + 1) : s;
}

/**
 * 课时的显示名。
 * ⚠️ 教案被删掉之后就查不到标题了（数据真的没了）—— 这时退回课时 id，
 *    至少能追到是哪一条；标题本身在**那条「删除课时教案「X」」提交说明**里还留着。
 */
function lessonLabelOf(id) {
  const L = LESSONS[id];
  return L ? shortTitle(L.title) : "（已删除的课时 " + id + "）";
}

/**
 * 大纲结构对比 —— 按章 id 配对，产出 新增 / 删除 / 改动 三类条目。
 * 章的顺序变化、标题、课时数、核心知识点、章下课时增删与章内顺序都覆盖到。
 * `op === "="` 的条目表示这一章没动（渲染时可以过滤掉，只用来数个数）。
 */
function diffChapters(from, to) {
  const A = Array.isArray(from) ? from : [];
  const B = Array.isArray(to) ? to : [];
  const aAt = {}, bAt = {};
  A.forEach((c, i) => { aAt[c.id] = i; });
  B.forEach((c, i) => { bAt[c.id] = i; });

  const out = [];
  A.forEach((c, i) => {
    if (bAt[c.id] === undefined) {
      out.push({ op: "del", text: c.title, note: "原第 " + (i + 1) + " 章" });
    }
  });
  B.forEach((c, i) => {
    const ai = aAt[c.id];
    if (ai === undefined) {
      out.push({ op: "add", text: c.title, note: "放在第 " + (i + 1) + " 章" });
      return;
    }
    const a = A[ai];
    const notes = [];
    if (ai !== i) notes.push("位置 " + (ai + 1) + " → " + (i + 1));
    if (a.title !== c.title) notes.push("标题「" + a.title + "」→「" + c.title + "」");
    if ((a.hours || 0) !== (c.hours || 0)) {
      notes.push("计划课时 " + (a.hours || "未定") + " → " + (c.hours || "未定"));
    }
    if ((a.points || "") !== (c.points || "")) notes.push("核心知识点有改动");

    const la = a.lessonIds || [];
    const lb = c.lessonIds || [];
    const added = lb.filter((x) => la.indexOf(x) < 0);
    const removed = la.filter((x) => lb.indexOf(x) < 0);
    if (added.length) notes.push("移入/新增课时：" + added.map(lessonLabelOf).join("、"));
    if (removed.length) notes.push("移出/删除课时：" + removed.map(lessonLabelOf).join("、"));
    if (!added.length && !removed.length && la.join("\u0001") !== lb.join("\u0001")) {
      notes.push("章内课时顺序有调整");
    }

    out.push(notes.length
      ? { op: "chg", text: c.title, note: notes.join("；") }
      : { op: "=", text: c.title, note: "" });
  });
  return out;
}

function chapterOf(courseId, chapterId) {
  const syl = syllabusOf(courseId);
  return syl ? (syl.chapters.find((c) => c.id === chapterId) || null) : null;
}
/** 章下的课时教案（按 lessonIds 顺序，跳过已不存在的） */
function lessonsOfChapter(ch) {
  if (!ch) return [];
  return ch.lessonIds.map((id) => LESSONS[id]).filter(Boolean);
}
/** 大纲统计：章数 / 课时数 / 各状态计数 */
function syllabusStats(courseId) {
  const syl = syllabusOf(courseId);
  const st = { chapters: 0, lessons: 0, draft: 0, ready: 0, taught: 0, hours: 0 };
  if (!syl) return st;
  st.chapters = syl.chapters.length;
  syl.chapters.forEach((ch) => {
    st.hours += ch.hours || 0;
    lessonsOfChapter(ch).forEach((l) => {
      st.lessons++;
      if (st.hasOwnProperty(l.status)) st[l.status]++;
    });
  });
  return st;
}

/**
 * 删除整份教案大纲 —— 连同它下面**全部**课时教案一起删。
 * 🔴 不许留下「没有大纲、却还挂着一堆课时教案」的孤儿数据：
 *    那种教案在界面上永远点不到，等于悄悄丢了用户的东西。
 *    所以这里按 `courseId` 遍历 LESSONS 删除，而不是只顺着 chapters[].lessonIds
 *    （存档被外部改坏、lessonIds 漏记时，前者依然清得干净）。
 * 返回 remove 的数量，供界面做二次确认时告知。
 */
function deleteSyllabus(courseId) {
  const syl = SYLLABUS[courseId];
  if (!syl) return { ok: false, error: "该课程还没有教案大纲" };

  const before = syllabusStats(courseId);
  Object.keys(LESSONS).forEach(function (id) {
    if (LESSONS[id] && LESSONS[id].courseId === courseId) delete LESSONS[id];
  });
  delete SYLLABUS[courseId];
  saveSyllabus();
  saveLessons();

  return { ok: true, removed: { chapters: before.chapters, lessons: before.lessons } };
}

/* ---------------- 变更（校验 + 落库，壳与页面共用同一份实现） ---------------- */

function nextChapterId(courseId, chapters) {
  let n = 1;
  while (chapters.some((c) => c.id === courseId + "-c" + n)) n++;
  return courseId + "-c" + n;
}

/**
 * 取一份**可安全修改**的当前结构副本。
 * 🔴 直接改 `syl.chapters` 是在改**历史快照**上的对象 —— 会把过去某一版的内容
 *    也一起改掉（版本链就失去意义了）。所有变更函数都必须先拿到副本再改。
 */
function workingChapters(courseId) {
  return cloneData(syllabusChapters(courseId));
}

/** 课程还没有大纲时手动建一份空骨架（**不编造章节内容**） */
function createSyllabus(courseId) {
  const course = (COURSES || []).find((c) => c.id === courseId);
  if (!course) return { ok: false, error: "找不到该课程" };
  if (SYLLABUS[courseId]) return { ok: false, error: "该课程已有教案大纲" };

  const now = Date.now();
  const chapters = [{ id: courseId + "-c1", title: "第 1 章", hours: 0, points: "", lessonIds: [] }];
  const syl = {
    courseId: courseId,
    goal: "",
    updated: now,
    head: 0,
    commits: [{
      id: "v1", at: now, by: localName(), kind: "init", msg: "新建教案大纲",
      snap: normOutlineSnap({ chapters: chapters }, courseId),
    }],
  };
  attachChaptersGetter(syl);
  SYLLABUS[courseId] = syl;
  saveSyllabus();
  return { ok: true, syllabus: syl };
}

function updateChapter(courseId, chapterId, patch) {
  const cur = syllabusChapters(courseId).find((c) => c.id === chapterId);
  if (!cur) return { ok: false, error: "找不到该章节" };

  const p = patch || {};
  let title = cur.title, points = cur.points, hours = cur.hours;
  if (p.title !== undefined) {
    title = String(p.title).trim();
    if (!title) return { ok: false, error: "章节名称不能为空" };
  }
  if (p.points !== undefined) points = String(p.points).trim();
  if (p.hours !== undefined) {
    hours = Math.floor(Number(p.hours));
    if (!(hours >= 0)) return { ok: false, error: "课时数必须是不小于 0 的整数" };
  }
  if (title === cur.title && points === cur.points && hours === cur.hours) {
    return { ok: false, unchanged: true, error: "章节信息没有变化" };
  }

  const chapters = workingChapters(courseId);
  const ch = chapters.find((c) => c.id === chapterId);
  ch.title = title;
  ch.points = points;
  ch.hours = hours;

  // 说明里带上「改了什么」，时间线才读得懂
  const msg = title !== cur.title
    ? "章节改名「" + cur.title + "」→「" + title + "」"
    : "编辑章节「" + title + "」";
  const r = commitOutline(courseId, chapters, msg, "edit");
  if (!r.ok) return r;

  const saved = chapterOf(courseId, chapterId);
  // 🔴 改了课时数之后，章下教案数量不再匹配 → 只做提示，不自动删教案
  return {
    ok: true,
    chapter: saved,
    mismatch: saved.hours > 0 && lessonsOfChapter(saved).length !== saved.hours,
  };
}

function addChapter(courseId, title) {
  const syl = syllabusOf(courseId);
  if (!syl) return { ok: false, error: "该课程还没有教案大纲" };
  const t = String(title || "").trim();
  if (!t) return { ok: false, error: "请填写章节名称" };
  const cur = syllabusChapters(courseId);
  if (cur.some((c) => c.title === t)) return { ok: false, error: "已有同名章节「" + t + "」" };

  const chapters = workingChapters(courseId);
  const ch = { id: nextChapterId(courseId, chapters), title: t, hours: 0, points: "", lessonIds: [] };
  chapters.push(ch);
  const r = commitOutline(courseId, chapters, "新增章节「" + t + "」", "structure");
  return r.ok ? { ok: true, chapter: ch } : r;
}

function removeChapter(courseId, chapterId) {
  const cur = syllabusChapters(courseId);
  const i = cur.findIndex((c) => c.id === chapterId);
  if (i < 0) return { ok: false, error: "找不到该章节" };
  const ch = cur[i];
  const n = lessonsOfChapter(ch).length;
  if (n) {
    return { ok: false, error: "本章还有 " + n + " 份课时教案，请先删掉教案再删章节" };
  }
  const chapters = workingChapters(courseId).filter((c) => c.id !== chapterId);
  const r = commitOutline(courseId, chapters, "删除章节「" + ch.title + "」", "structure");
  return r.ok ? { ok: true } : r;
}

function nextLessonId(chapterId) {
  let n = 1;
  while (LESSONS[chapterId + "-" + n]) n++;
  return chapterId + "-" + n;
}

function addLesson(courseId, chapterId, title, minutes) {
  const ch = chapterOf(courseId, chapterId);
  if (!ch) return { ok: false, error: "找不到该章节" };
  const t = String(title || "").trim();
  if (!t) return { ok: false, error: "请填写课时名称" };
  if (lessonsOfChapter(ch).some((l) => l.title === t)) {
    return { ok: false, error: "本章已有同名课时「" + t + "」" };
  }

  const id = nextLessonId(chapterId);
  const now = Date.now();
  LESSONS[id] = normLesson({
    id: id, courseId: courseId, chapterId: chapterId, title: t,
    minutes: Number(minutes) > 0 ? Math.floor(Number(minutes)) : 45,
    status: "draft", taughtAt: "", head: 0,
    commits: [{ id: "v1", at: now, by: localName(), kind: "init", msg: "新建课时教案", snap: {} }],
  }, id);

  const chapters = workingChapters(courseId);
  const target = chapters.find((c) => c.id === chapterId);
  if (!target) { delete LESSONS[id]; return { ok: false, error: "找不到该章节" }; }
  target.lessonIds.push(id);

  const r = commitOutline(courseId, chapters, "新增课时教案「" + t + "」", "structure");
  if (!r.ok) { delete LESSONS[id]; return r; }        // 结构没落库就别留下教案
  saveLessons();
  return { ok: true, lesson: LESSONS[id] };
}

function deleteLesson(lessonId) {
  const L = LESSONS[lessonId];
  if (!L) return { ok: false, error: "找不到该教案" };
  const courseId = L.courseId;
  const label = shortTitle(L.title);

  const chapters = workingChapters(courseId);
  let touched = false;
  chapters.forEach((c) => {
    const before = c.lessonIds.length;
    c.lessonIds = c.lessonIds.filter((x) => x !== lessonId);
    if (c.lessonIds.length !== before) touched = true;
  });

  // 存档被改坏、教案没挂在任何章下时也要能删掉 —— 只是没有结构变化可提交
  if (touched && chapters.length) {
    const r = commitOutline(courseId, chapters, "删除课时教案「" + label + "」", "structure");
    if (!r.ok && !r.unchanged) return r;
  }
  delete LESSONS[lessonId];
  saveLessons();
  return { ok: true };
}

function setLessonStatus(lessonId, status) {
  const L = LESSONS[lessonId];
  if (!L) return { ok: false, error: "找不到该教案" };
  if (!Object.prototype.hasOwnProperty.call(LESSON_STATUS, status)) {
    return { ok: false, error: "状态取值不合法" };
  }
  L.status = status;
  saveLessons();
  return { ok: true, lesson: L };
}

/* ---------------- 调序（拖动 / 上移下移共用这一份实现）----------------
   🔴 接口都用「插到谁前面」表达（`beforeXxxId`，null = 放到末尾），
      不用下标。理由：下标在「同一个列表内移动」时含义会变 ——
      先摘掉自己再插入，原来的下标就已经错位了。
      「插到某条前面」在摘掉自己之后依然有明确含义，调用方不用做心算。
   ============================================================ */

/** 把某章挪到「另一章前面」；beforeChapterId 为 null 时放到最后 */
function moveChapter(courseId, chapterId, beforeChapterId) {
  const cur = syllabusChapters(courseId);
  if (!cur.length) return { ok: false, error: "该课程还没有教案大纲" };
  if (!cur.some((c) => c.id === chapterId)) return { ok: false, error: "找不到该章节" };

  const ids = cur.map((c) => c.id).filter((x) => x !== chapterId);
  let at = ids.length;
  if (beforeChapterId) {
    at = ids.indexOf(beforeChapterId);
    if (at < 0) return { ok: false, error: "找不到目标章节" };
  }
  ids.splice(at, 0, chapterId);
  if (ids.join("\u0001") === cur.map((c) => c.id).join("\u0001")) {
    return { ok: false, unchanged: true, error: "位置没有变化" };
  }

  const byId = {};
  workingChapters(courseId).forEach((c) => { byId[c.id] = c; });
  const r = commitOutline(courseId, ids.map((id) => byId[id]), "调整章节顺序", "structure");
  return r.ok ? { ok: true } : r;
}

/** 把某课时挪到「某章的第 N 位」——支持跨章移动；beforeLessonId 为 null 时放到该章末尾 */
function moveLesson(lessonId, targetChapterId, beforeLessonId) {
  const L = LESSONS[lessonId];
  if (!L) return { ok: false, error: "找不到该教案" };

  const chapters = workingChapters(L.courseId);
  if (!chapters.length) return { ok: false, error: "该课程还没有教案大纲" };
  const to = chapters.find((c) => c.id === targetChapterId);
  if (!to) return { ok: false, error: "找不到目标章节" };

  // 🔴 先把这份教案从**所有**章里摘掉：跨章移动时会同时挂在两章下面
  //    （界面看像"复制"了一份，两处点进去还是同一份教案）。
  chapters.forEach((c) => { c.lessonIds = (c.lessonIds || []).filter((x) => x !== lessonId); });

  let at = to.lessonIds.length;
  if (beforeLessonId) {
    at = to.lessonIds.indexOf(beforeLessonId);
    if (at < 0) return { ok: false, error: "找不到目标教案" };
  }
  to.lessonIds.splice(at, 0, lessonId);

  const cross = L.chapterId !== targetChapterId;
  const msg = cross
    ? "课时「" + shortTitle(L.title) + "」移到「" + to.title + "」"
    : "调整课时顺序";
  const r = commitOutline(L.courseId, chapters, msg, "structure");
  if (!r.ok) return r;

  L.chapterId = to.id;              // 结构提交成功之后再改教案的归属
  saveLessons();
  return { ok: true, crossed: cross };
}

/** 上移 / 下移一章（delta = -1 / +1） */
function moveChapterBy(courseId, chapterId, delta) {
  const syl = syllabusOf(courseId);
  if (!syl) return { ok: false, error: "该课程还没有教案大纲" };
  const i = syl.chapters.findIndex((c) => c.id === chapterId);
  if (i < 0) return { ok: false, error: "找不到该章节" };
  const j = i + delta;
  if (j < 0) return { ok: false, error: "已经是第一章了" };
  if (j >= syl.chapters.length) return { ok: false, error: "已经是最后一章了" };

  const rest = syl.chapters.map((c) => c.id).filter((x) => x !== chapterId);
  const k = rest.indexOf(syl.chapters[j].id);
  const before = delta < 0 ? rest[k] : (rest[k + 1] || null);
  return moveChapter(courseId, chapterId, before);
}

/** 上移 / 下移一个课时（只在所属章内移动） */
function moveLessonBy(lessonId, delta) {
  const L = LESSONS[lessonId];
  if (!L) return { ok: false, error: "找不到该教案" };
  const ch = chapterOf(L.courseId, L.chapterId);
  if (!ch) return { ok: false, error: "找不到该教案所在的章节" };

  const ids = (ch.lessonIds || []).filter((x) => LESSONS[x]);
  const i = ids.indexOf(lessonId);
  if (i < 0) return { ok: false, error: "该教案不在本章的列表里" };
  const j = i + delta;
  if (j < 0) return { ok: false, error: "已经是本章第一个了" };
  if (j >= ids.length) return { ok: false, error: "已经是本章最后一个了" };

  const rest = ids.filter((x) => x !== lessonId);
  const k = rest.indexOf(ids[j]);
  const before = delta < 0 ? rest[k] : (rest[k + 1] || null);
  return moveLesson(lessonId, ch.id, before);
}

function defaultCommitMsg(kind) {
  const k = commitKind(kind);
  return (k.label || "编辑") + "教案";
}

/**
 * 提交一版教案 —— **版本历史只增不减**。
 * 内容没变且不是「课后反思」这类纯记录时，不产生新版本（返回 ok:false）。
 */
function commitLesson(lessonId, snap, msg, kind, reflect) {
  const L = LESSONS[lessonId];
  if (!L) return { ok: false, error: "找不到该教案" };
  const k = Object.prototype.hasOwnProperty.call(COMMIT_KIND, kind) ? kind : "edit";
  const next = normSnap(snap);

  if (k !== "reflect" && snapEqual(lessonSnap(L), next)) {
    return { ok: false, error: "内容没有变化，未产生新版本" };
  }

  const now = Date.now();
  const commit = {
    id: "v" + (L.commits.length + 1),
    at: now,
    by: localName(),
    kind: k,
    msg: String(msg || "").trim() || defaultCommitMsg(k),
    snap: next,
    reflect: reflect || null,
  };
  L.commits.push(commit);
  L.head = L.commits.length - 1;
  if (k === "reflect" && reflect && reflect.date) L.taughtAt = String(reflect.date);
  if (k === "reflect") L.status = "taught";        // 记录了反思 → 这节课显然已经上过
  saveLessons();
  return { ok: true, commit: commit };
}

/** 回退：把旧版内容**作为一次新提交**写入（等同 git revert，不删历史） */
function revertLesson(lessonId, index) {
  const L = LESSONS[lessonId];
  if (!L) return { ok: false, error: "找不到该教案" };
  const i = Math.floor(Number(index));
  if (!(i >= 0 && i < L.commits.length)) return { ok: false, error: "版本号超出范围" };
  if (i === L.head) return { ok: false, error: "这已经是当前版本" };

  const src = L.commits[i];
  const now = Date.now();
  const commit = {
    id: "v" + (L.commits.length + 1),
    at: now,
    by: localName(),
    kind: "revert",
    msg: "回到 " + src.id + "（" + (src.msg || "无说明") + "）",
    snap: normSnap(cloneData(src.snap)),
    reflect: null,
  };
  L.commits.push(commit);
  L.head = L.commits.length - 1;
  saveLessons();
  return { ok: true, commit: commit };
}

/* ============================================================
   结构化 diff —— 纯函数，可单独测（不碰 DOM）
   ------------------------------------------------------------
   标量字段（目标 / 难点 / 作业 / 学情）：按句切分后做最长公共子序列
   数组字段（重点 / 流程）：按索引对齐 —— 文档已约定的口径
   ============================================================ */

/** 按句切分（句号 / 问号 / 感叹号 / 分号 / 换行），保留分隔符 */
function splitSentences(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t) return [];
  const out = [];
  let buf = "";
  for (const ch of t) {
    buf += ch;
    if ("。！？；!?;\n".indexOf(ch) >= 0) {
      const s = buf.trim();
      if (s) out.push(s);
      buf = "";
    }
  }
  const last = buf.trim();
  if (last) out.push(last);
  return out;
}

/** 最长公共子序列 diff → [{ op: "=" | "-" | "+", text }] */
function lcsDiff(a, b) {
  const A = Array.isArray(a) ? a : [];
  const B = Array.isArray(b) ? b : [];
  const n = A.length, m = B.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = (A[i] === B[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: "=", text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: "-", text: A[i] }); i++; }
    else { out.push({ op: "+", text: B[j] }); j++; }
  }
  while (i < n) out.push({ op: "-", text: A[i++] });
  while (j < m) out.push({ op: "+", text: B[j++] });
  return out;
}

/**
 * 数组字段的 diff：**先按内容做最长公共子序列**，再把相邻的「删 + 增」配成「同位置改动」。
 *
 * 为什么不是「按下标一一对齐」：
 *   按位置比时，只要中间插入一条，它后面每一条都会被标成「改动」——
 *   实测「教学重点」插一条会渲染出 2 行删除 + 3 行新增，噪声盖过了真正的改动。
 *   按内容比后，插入只显示一行新增，位置上的修改才配对成 −/+ 两行。
 */
function alignListDiff(a, b) {
  const A = (Array.isArray(a) ? a : []).map((x) => String(x));
  const B = (Array.isArray(b) ? b : []).map((x) => String(x));
  const raw = lcsDiff(A, B);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].op === "-" && raw[i + 1] && raw[i + 1].op === "+") {
      out.push({ op: "~", text: raw[i].text, to: raw[i + 1].text });
      i++;
    } else {
      out.push(raw[i]);
    }
  }
  return out;
}

/** 课堂流程的一步 → 单行文本（diff 与展示共用） */
function stepText(s) {
  if (!s) return "";
  const parts = [];
  if (s.t) parts.push(String(s.t));
  if (Number(s.min) > 0) parts.push(Number(s.min) + " 分钟");
  if (s.d) parts.push(String(s.d));
  return parts.join(" · ");
}

/**
 * 结构化对比两份快照。
 * 返回 { fields: [{ key, label, kind, same, parts }], changed }
 * parts 里的 op： "=" 未变 · "-" 删除 · "+" 新增 · "~" 改前改后
 */
function diffSnap(a, b) {
  const A = normSnap(a), B = normSnap(b);
  const fields = SNAP_FIELDS.map((f) => {
    const x = A[f.key], y = B[f.key];
    let parts;
    if (f.kind === "list") {
      parts = alignListDiff(x, y);
    } else if (f.kind === "steps") {
      parts = alignListDiff((x || []).map(stepText), (y || []).map(stepText));
    } else {
      parts = lcsDiff(splitSentences(x), splitSentences(y));
    }
    return {
      key: f.key, label: f.label, kind: f.kind,
      parts: parts, same: parts.every((p) => p.op === "="),
    };
  });
  return { fields: fields, changed: fields.filter((f) => !f.same).length };
}

/** 两份快照是否完全相同（逐字段比对） */
function snapEqual(a, b) {
  const A = normSnap(a), B = normSnap(b);
  return SNAP_FIELDS.every((f) => JSON.stringify(A[f.key]) === JSON.stringify(B[f.key]));
}

/** 相对时间文案（「2 天前」）—— now 可注入，便于确定性断言 */
function agoText(at, now) {
  const t = Number(at) || 0;
  if (!t) return "时间未知";
  const base = Number(now) || Date.now();
  const d = base - t;
  if (d < 60000) return "刚刚";
  if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
  if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
  if (d < 30 * DAY_MS) return Math.floor(d / DAY_MS) + " 天前";
  const dt = new Date(t);
  return (dt.getMonth() + 1) + "-" + dt.getDate();
}

/* ============================================================
   实训活动 —— 唯一来源（第 31 轮）
   ------------------------------------------------------------
   灵感出处：`docs/IDEAS.md`
     · 灵感 01 层 2「实训活动」：教师发布、学生参与、项目制（`st_activities`）
     · 灵感 02「学生发起的探究式实训（Search-then-Construct）」

   🔴 这一层的核心主张是「**不给答案，给路径**」：
      学生问「圆的面积公式怎么来的」，AI 不该直接答 πr²，而是把
      **人类已有的创造路径**（刘徽割圆术 / 阿基米德穷竭法）提炼成一串
      **引导骨架** —— 每一步只给「往哪想」的问题 + 可查的线索 + 动手做的一件事，
      带学生自己走完，并且**允许偏离骨架、试自己的方向**（`openEnded`）。
      ⚠️ 骨架里**不许带结论**（`PATH_LIB[].answerNote` 只给教师看，
         `skeletonFromPath()` 明确不把它拷进骨架 —— 有断言盯着）。

   ⚠️ **纯静态站不能真联网检索** → 这里用「**预置路径库 + 关键词命中**」，
      没命中给通用探究骨架；界面必须**如实标注骨架来源**（命中哪条路径 / 通用），
      不许假装"AI 联网搜过了"。
      答辩口径：正式版由模型检索创造史；本版把「检索 → 提炼骨架」这段固化成本地路径库。

   🔴 存储按账号分桶（与 COURSES 同一套路，见 `activityStoreKey()`）；
      **空数组是有效存档**（用户删光活动不该复活预置数据）；
      种子数据也过一遍 `normalizeActivities()`（拿深拷贝，且字段补齐）。
   ============================================================ */

var ACTIVITY_KEY = "st_activities";

/** 活动状态：草案 → 进行中 → 已归档 */
var ACTIVITY_STATUS = {
  draft: { key: "draft", label: "草案",   tone: "warn" },
  open:  { key: "open",  label: "进行中", tone: "ok"   },
  done:  { key: "done",  label: "已归档", tone: ""     },
};
var ACTIVITY_STATUS_FALLBACK = { key: "draft", label: "草案", tone: "warn" };
/** 🔴 枚举一律走这里读 —— `ACTIVITY_STATUS[k].label` 遇到未知值会 `undefined.label` 崩 */
function activityStatus(k) { return ACTIVITY_STATUS[k] || ACTIVITY_STATUS_FALLBACK; }
/** 合法状态（按「草案 → 进行中 → 已归档」顺序，界面按钮就按它排） */
function activityStatusKeys() { return ["draft", "open", "done"]; }

/** 谁发起的 —— 灵感 02 的关键：发起权不只属于教师 */
var ACTIVITY_ORIGIN = { teacher: "教师发布", student: "学生发起" };
function activityOrigin(k) { return ACTIVITY_ORIGIN[k] || "教师发布"; }

/* ------------------------------------------------------------
   预置「创造史路径库」
   ------------------------------------------------------------
   每一条 = 人类把某个结论**创造出来**的真实路线，拆成若干步。
   · `keys`      关键词（命中用；按命中字符数打分，阈值 2，见 matchPath）
   · `stages`    引导骨架：title 这一步在干什么 / prompt 往哪想 /
                 clue 可查的线索（**不是结论**）/ tryIt 动手做的一件事
   · `answerNote` **只给教师看**：提醒这条路径的终点在哪、以及为什么别急着给
   ============================================================ */
var PATH_LIB = [
  {
    id: "circle-area",
    title: "圆的面积公式是怎么被创造出来的",
    era: "古希腊 · 中国古代（阿基米德穷竭法 · 刘徽割圆术）",
    keys: ["圆", "面积", "圆周率", "π", "割圆", "曲线"],
    answerNote: "终点是 S = πr²。整条路径的价值恰恰在于让学生自己逼近到这一步 —— 直接给公式，这条路就白走了。",
    stages: [
      { title: "先问：我们凭什么知道它？",
        prompt: "我们已经能算哪些图形的面积？圆和它们的差别在哪一个地方？",
        clue: "古人先做的是「内接正多边形」—— 边数越多，它越像圆。",
        tryIt: "画一个圆和它的内接正六边形，估一下正六边形占了圆的几分之几。" },
      { title: "让误差「看得见」，再一步步压小",
        prompt: "如果换成内接正 12 边形、24 边形，误差会怎么变？你能说清它在变小吗？",
        clue: "刘徽从正六边形出发，逐次加倍边数（6→12→24→48→96），把误差一步步压小。",
        tryIt: "算（或查）正六边形、正十二边形的面积与 r² 的比值，看它朝哪个数靠近。" },
      { title: "跨越那一步：从「算得快」到「无限逼近」",
        prompt: "边数无限加倍时，这个比值会停在什么地方？你怎么说明它「停」住了？",
        clue: "人类真正跨过去的地方就是这一步 —— 承认「无限逼近」可以得到一个确切的数。",
        tryIt: "把边数 6/12/24/48/96 与对应比值列成表，画出来看它奔向哪里。" },
      { title: "写成你自己的结论",
        prompt: "能用一句话（一条式子）把刚才走的路概括出来吗？",
        clue: "古人写的是「半周半径相乘得积步」——你看得出它和今天的写法是一回事吗？",
        tryIt: "用自己的话写一遍，并标出每一步用到了哪个已知事实。" },
    ],
  },
  {
    id: "pythagoras",
    title: "直角三角形三边的关系是怎么被发现的",
    era: "中国古代《周髀算经》 · 古希腊毕达哥拉斯学派",
    keys: ["勾股", "直角", "三角形", "斜边", "毕达哥拉斯", "平方"],
    answerNote: "终点是 a² + b² = c²。别直接说出口 —— 让学生先在格纸上把它「看出来」。",
    stages: [
      { title: "先动手量，找规律",
        prompt: "画几个直角三角形，量三边并平方，能看出什么关系？",
        clue: "古代人先量的是 3-4-5 这类整数边，整数最容易看出规律。",
        tryIt: "取 3-4-5、6-8-10、5-12-13 三组边长，分别算三边的平方。" },
      { title: "把「平方」变成看得见的图形",
        prompt: "a² 在图上是什么？能不能把三个正方形摆到三角形边上？",
        clue: "「平方」在几何上就是正方形面积 —— 这是把代数关系变回图形的关键一跳。",
        tryIt: "在格纸上以三边为边各画一个正方形，数格子比面积。" },
      { title: "证明：为什么一定成立，而不只是这几组数凑巧",
        prompt: "你验证的是几个例子，怎么说明它对**所有**直角三角形都成立？",
        clue: "古人用「面积拼补」：把图形剪开重排，让两块面积相等。",
        tryIt: "用两个全等正方形各剪一刀拼出两个图形，比较剩下部分的面积。" },
      { title: "反过来用：这条关系还能干什么",
        prompt: "知道两条边，能不能求出第三条？这在测量里有什么用？",
        clue: "测距、测高、坐标系里的两点距离，全靠这一步。",
        tryIt: "用你自己的方法算一次「两点距离」，再和公式对一对。" },
    ],
  },
  {
    id: "calculus",
    title: "「瞬时变化」这个概念是怎么被逼出来的",
    era: "17 世纪（牛顿流数 · 莱布尼茨微分）",
    keys: ["微积分", "导数", "瞬时", "变化率", "极限", "切线", "速度"],
    answerNote: "终点是极限与导数。核心难点是「0/0」这种说不通的东西怎么被合法化 —— 让学生自己撞上这个矛盾才有意义。",
    stages: [
      { title: "从「平均」出发 —— 能算的只有平均",
        prompt: "只知道起点和终点，你能算出什么？它和真实情况差在哪？",
        clue: "「平均速度」只用两个时刻就能算，但它抹掉了中间发生的一切。",
        tryIt: "取一段 10 秒的运动记录，算平均速度，再算 0–1 秒、1–2 秒的平均速度，比一比。" },
      { title: "把间隔缩短，看它往哪儿靠",
        prompt: "把时间间隔取得越来越小，平均速度会怎样？它有没有停在某个数上？",
        clue: "牛顿当年管这个叫「流数」—— 他就是在缩间隔的过程里看出它趋于一个定值的。",
        tryIt: "把间隔依次取 1、0.5、0.1、0.01 秒，列成表，看那一列数字靠向哪里。" },
      { title: "承认卡住：分母变成 0 说不通",
        prompt: "间隔取到 0 的时候，式子变成了什么？为什么这一步不能直接算？",
        clue: "「0/0」正是历史上卡住所有人的地方 —— 把它变成合法的，就是微积分的第一步。",
        tryIt: "写出间隔为 0 时的式子，看它为什么没有意义，再想：刚才的「靠向」能不能代替它？" },
      { title: "给你的做法起个名字、立个规矩",
        prompt: "能不能定义一个操作：输入一个函数，输出它在每一点的「瞬时变化」？",
        clue: "导数、求导、切线斜率 —— 名字都是后来才定的，规矩才是创造。",
        tryIt: "用它算一遍最简单函数的瞬时变化，看看结果合不合直觉。" },
    ],
  },
];

/** 未命中路径库时的通用探究骨架 —— 依然只给路径，不给答案 */
function genericSkeletonStages() {
  return [
    { title: "先把要解释的东西说清楚",
      prompt: "这个结论「是什么」？用一句话写下来 —— 先不管为什么。",
      clue: "说不清问题，就找不准路径。写下来再往下走。",
      tryIt: "把结论写成一句话，并标出你还不确定的词。" },
    { title: "回到它出现之前：当时的人已经会什么",
      prompt: "在它被创造出来的时候，人们手上已经有哪些工具、事实和需求？",
      clue: "几乎所有的创造都是「把未知化归为已知」——先清点手里的牌。",
      tryIt: "列出 3 条当时已经知道的事实，圈出哪一条最可能被用来撬动这个问题。" },
    { title: "拆到能动手：找一个最小可试的例子",
      prompt: "它有没有一个能算、能量、能画的小例子？先把最小的情形走一遍。",
      clue: "大事化小的具体例子，往往能暴露出真正的困难在哪。",
      tryIt: "把问题缩小到一个具体数值或图形，动手算/画一次。" },
    { title: "逼近、检验，并承认卡住的地方",
      prompt: "你的路线在哪一步会崩？换个方向再试一次会怎样？",
      clue: "「卡住」不是失败，是这条路径给你的最有价值的信息。",
      tryIt: "写下你卡住的那一步，再写一个你还没试过的方向。" },
  ];
}

/** 路径库条目 → 骨架（深拷贝；🔴 **不拷 `answerNote`** —— 那是给教师看的，别带到学生面前） */
function skeletonFromPath(p) {
  return {
    source: "path",
    pathId: String(p.id || ""),
    pathTitle: String(p.title || ""),
    era: String(p.era || ""),
    stages: (p.stages || []).map(function (s, i) { return normStage(s, i); }),
  };
}

/** 通用骨架 */
function genericSkeleton() {
  return {
    source: "generic",
    pathId: "",
    pathTitle: "通用探究骨架",
    era: "",
    stages: genericSkeletonStages().map(function (s, i) { return normStage(s, i); }),
  };
}

/**
 * 关键词命中路径库。
 * 打分 = 命中关键词的**字符总长**（不是命中个数）—— 单字关键词（如「圆」）
 * 太容易误命中，让「面积」「割圆」这类更具体的词贡献更多权重。
 * 阈值 2：至少命中一个两字词，或两个单字词，才算真命中。
 */
function matchPath(goal) {
  const q = String(goal || "");
  if (!q.trim()) return null;
  let best = null, bestScore = 0;
  PATH_LIB.forEach(function (p) {
    const score = (p.keys || []).reduce(function (n, k) {
      return n + (k && q.indexOf(k) >= 0 ? String(k).length : 0);
    }, 0);
    if (score > bestScore) { best = p; bestScore = score; }
  });
  return bestScore >= 2 ? best : null;
}

/** 一句话目标 → 引导骨架（命中路径库就用它，否则给通用骨架） */
function draftSkeleton(goal) {
  const g = String(goal || "").trim();
  const hit = matchPath(g);
  const skel = hit ? skeletonFromPath(hit) : genericSkeleton();
  skel.goal = g;
  return skel;
}

/** 骨架来源的人话说明 —— 界面必须如实标注，不许假装联网检索过 */
function skeletonSourceText(skel) {
  if (!skel) return "";
  if (skel.source === "path") {
    return "命中预置路径库「" + (skel.pathTitle || skel.pathId) + "」" + (skel.era ? " · " + skel.era : "");
  }
  return "未命中路径库 —— 给了通用探究骨架，可自行改写";
}

/* ------------------------------------------------------------
   规整 / 读写
   ============================================================ */

let ACT_STAGE_SEQ = 0;
/** 新步骤 id（同一会话内不重复即可；存档读回来时以存档里的 id 为准） */
function newStageId() { ACT_STAGE_SEQ += 1; return "st" + Date.now().toString(36) + "-" + ACT_STAGE_SEQ; }

/** 规整一个步骤（title 为空但有 prompt/tryIt 的也保留 —— 骨架允许"只给问题"） */
function normStage(s, i) {
  const o = (s && typeof s === "object") ? s : {};
  return {
    id: String(o.id || "stage-" + (i + 1)).trim() || "stage-" + (i + 1),
    title:  String(o.title  || "").trim(),
    prompt: String(o.prompt || "").trim(),
    clue:   String(o.clue   || "").trim(),
    tryIt:  String(o.tryIt  || "").trim(),
  };
}

/** 一条「学生的新发现」（灵感 02 的收口：学生主动标记 + 教师点评/推荐） */
function normFinding(f, i) {
  const o = (f && typeof f === "object") ? f : {};
  const text = String(o.text || "").trim();
  if (!text) return null;
  return {
    id: String(o.id || "f" + (i + 1)).trim() || "f" + (i + 1),
    who: String(o.who || "学生").trim(),
    at: Number(o.at) || 0,
    text: text,
    pinned: !!o.pinned,
  };
}

function normMessage(m, i) {
  const o = (m && typeof m === "object") ? m : {};
  const text = String(o.text || "").trim();
  if (!text) return null;
  return {
    id: String(o.id || "m" + (i + 1)).trim() || "m" + (i + 1),
    who: String(o.who || "").trim(),
    role: o.role === "teacher" ? "teacher" : "student",
    at: Number(o.at) || 0,
    text: text,
  };
}

function normSkeleton(sk) {
  const o = (sk && typeof sk === "object") ? sk : {};
  return {
    source: o.source === "path" ? "path" : "generic",
    pathId: String(o.pathId || ""),
    pathTitle: String(o.pathTitle || ""),
    era: String(o.era || ""),
    goal: String(o.goal || ""),
    stages: (Array.isArray(o.stages) ? o.stages : []).map(normStage),
  };
}

/** 规整活动：没有标题的丢掉，字段补齐（存档坏了也不能白屏） */
function normalizeActivities(list) {
  if (!Array.isArray(list)) return null;
  return list
    .filter(function (a) { return a && typeof a === "object" && String(a.title || a.goal || "").trim(); })
    .map(function (a, i) {
      const title = String(a.title || a.goal || "").trim();
      const origin = a.origin === "student" ? "student" : "teacher";
      const status = ACTIVITY_STATUS[a.status] ? a.status : "draft";
      return {
        id: String(a.id || "act-" + (i + 1)).trim() || "act-" + (i + 1),
        title: title,
        goal: String(a.goal || "").trim(),
        courseId: String(a.courseId || "").trim(),
        origin: origin,
        createdBy: String(a.createdBy || "").trim(),
        status: status,
        openEnded: a.openEnded !== false,          // 默认开放：允许偏离骨架
        skeleton: normSkeleton(a.skeleton),
        participants: (Array.isArray(a.participants) ? a.participants : [])
          .map(function (x) { return String(x || "").trim(); }).filter(Boolean),
        findings: (Array.isArray(a.findings) ? a.findings : []).map(normFinding).filter(Boolean),
        messages: (Array.isArray(a.messages) ? a.messages : []).map(normMessage).filter(Boolean),
        createdAt: Number(a.createdAt) || 0,
        updatedAt: Number(a.updatedAt) || Number(a.createdAt) || 0,
      };
    });
}

/** 当前账号的实训存档键（与 courseStoreKey 同一套路） */
function activityStoreKey() {
  const u = currentUserKey();
  return u ? ACTIVITY_KEY + ":" + u : ACTIVITY_KEY;
}

/**
 * 预置活动（只给预置示例账号播种；自注册账号从空的开始）。
 * ⚠️ 参与者与「新发现」都是**预置数据**，界面上标了「预置示例」——
 *    纯静态站没有服务端，多用户协作只能是本地模拟性质。
 */
var SEED_ACTIVITIES = [
  {
    id: "act-round-area",
    title: "圆面积公式是怎么被创造出来的",
    goal: "课程只讲了 S=πr²，但这个公式是怎么来的？想自己走一遍。",
    courseId: "ds",
    origin: "teacher",
    status: "open",
    openEnded: true,
    skeleton: skeletonFromPath(PATH_LIB[0]),
    participants: ["李同学", "张同学", "王同学", "赵同学"],
    findings: [
      { id: "f1", who: "王同学", at: 1759400000000, pinned: true,
        text: "我试了「把圆切成很多小扇形再拼成长方形」，拼出来一看长就是半周长、宽就是半径 —— 和割圆术是两条不同的路。" },
      { id: "f2", who: "李同学", at: 1759480000000, pinned: false,
        text: "边数加倍时比值每次只多一点点，我怀疑它一定有个上界，但我还说不清为什么。" },
    ],
    messages: [
      { id: "m1", who: "李老师", role: "teacher", at: 1759401000000,
        text: "开始前先想一想：我们现在会算哪些图形的面积？圆和它们最大的差别在哪？" },
      { id: "m2", who: "王同学", role: "student", at: 1759410000000,
        text: "我会算长方形、三角形。圆是弯的，没法直接套公式。" },
      { id: "m3", who: "李老师", role: "teacher", at: 1759415000000,
        text: "对，关键就是「弯」。古人想的办法是把它变成已经会算的东西 —— 试着沿这个方向走。" },
      { id: "m4", who: "赵同学", role: "student", at: 1759420000000,
        text: "是不是可以像切披萨那样，切成很多小三角形再拼起来？" },
    ],
    createdAt: 1759300000000,
    updatedAt: 1759480000000,
  },
  {
    id: "act-sort-why",
    title: "排序算法为什么会有这么多种",
    goal: "既然有快排了，为什么还要学冒泡、归并？我怀疑每种排序都在解决某个别的排序解决不了的问题。",
    courseId: "ds",
    origin: "student",                 // 灵感 02：学生可以自己发起
    createdBy: "student:student",      // 预置示例：由预置学生账号发起（学生端能看到「我发起的」）
    status: "open",                    // 学生发起**直接开启**（不等老师确认）
    openEnded: true,
    skeleton: genericSkeleton(),
    participants: ["陈同学"],
    findings: [],
    messages: [
      { id: "m5", who: "陈同学", role: "student", at: 1759502000000,
        text: "我发起这个是因为：既然有快排了，为什么还要学那么多别的排序？" },
      { id: "m6", who: "李老师", role: "teacher", at: 1759510000000,
        text: "好问题。先别急着要结论 —— 试试找出每种排序「最擅长」和「最怕」的场景。" },
    ],
    createdAt: 1759500000000,
    updatedAt: 1759500000000,
  },
];

function loadActivities() {
  const key = activityStoreKey();
  const user = currentUserKey();

  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const ok = normalizeActivities(JSON.parse(raw));
      if (ok) return ok;                 // ⚠️ 空数组也算有效（删光活动不该复活预置数据）
    }
  } catch (_) { /* 隐私模式 / file:// —— 退化为内存态 */ }

  // 老版本的全局存档：迁给当前账号（只迁一次）
  if (key !== ACTIVITY_KEY) {
    const migrated = migrateLegacyStore(ACTIVITY_KEY, key, normalizeActivities, null);
    if (migrated) return migrated;
  }

  // 预置账号才播种；⚠️ 必须过 normalizeActivities —— 既补齐字段，也拿到**深拷贝**
  // （否则页面里改一步骨架会改到 SEED_ACTIVITIES 上，本次会话里"改不动"）
  return (!user || isSeedAccount(user)) ? normalizeActivities(SEED_ACTIVITIES) : [];
}

function saveActivities() {
  try { window.localStorage.setItem(activityStoreKey(), JSON.stringify(ACTIVITIES)); }
  catch (_) { /* 存不下就算了，界面照常能用 */ }
}

var ACTIVITIES = loadActivities();

/** 找一条活动；找不到返回 null */
function activityOf(id) {
  return (ACTIVITIES || []).find(function (a) { return a.id === id; }) || null;
}

/** 生成活动 id：act-1 / act-2 …（数字后缀从现有最大者往后排，不与被删过的撞号） */
function nextActivityId() {
  let max = 0;
  (ACTIVITIES || []).forEach(function (a) {
    const m = /^act-(\d+)$/.exec(a.id || "");
    if (m) max = Math.max(max, Number(m[1]));
  });
  return "act-" + (max + 1);
}

/** 新建实训（默认草案，不直接发布 —— 骨架先给教师过一眼） */
function createActivity(data) {
  const d = data || {};
  const title = String(d.title || d.goal || "").trim();
  if (!title) return { ok: false, error: "请先写一句实训目标（或标题）" };

  const skel = d.skeleton ? normSkeleton(d.skeleton) : draftSkeleton(d.goal || title);
  const now = Number(d.now) || Date.now();
  const act = {
    id: nextActivityId(),
    title: title,
    goal: String(d.goal || "").trim(),
    courseId: String(d.courseId || "").trim(),
    origin: d.origin === "student" ? "student" : "teacher",
    createdBy: String(d.createdBy || "").trim(),
    status: "draft",
    openEnded: d.openEnded !== false,
    skeleton: skel,
    participants: [],
    findings: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  ACTIVITIES.push(act);
  saveActivities();
  refreshActivityNav();
  return { ok: true, activity: act };
}

/** 改活动基本信息 / 开放性 / 骨架（只传要改的字段） */
function updateActivity(id, patch) {
  const a = activityOf(id);
  if (!a) return { ok: false, error: "找不到该实训活动" };
  const p = patch || {};

  if ("title" in p) {
    const t = String(p.title || "").trim();
    if (!t) return { ok: false, error: "实训标题不能为空" };
    a.title = t;
  }
  if ("goal" in p)     a.goal = String(p.goal || "").trim();
  if ("courseId" in p) a.courseId = String(p.courseId || "").trim();
  if ("openEnded" in p) a.openEnded = p.openEnded !== false;
  if ("skeleton" in p) a.skeleton = normSkeleton(p.skeleton);
  if ("status" in p) {
    const r = setActivityStatus(id, p.status, true);      // 内部校验，不发重复的保存
    if (!r.ok) return r;
  }
  a.updatedAt = Number(p.now) || Date.now();
  saveActivities();
  refreshActivityNav();
  return { ok: true, activity: a };
}

/**
 * 改状态（草案 → 进行中 → 已归档）。
 * `skipSave` 给 updateActivity 内部用，避免一次改动写两遍盘。
 */
function setActivityStatus(id, status, skipSave) {
  const a = activityOf(id);
  if (!a) return { ok: false, error: "找不到该实训活动" };
  if (activityStatusKeys().indexOf(status) < 0) {
    return { ok: false, error: "未知状态：" + status };
  }
  if (status === "open" && !(a.skeleton.stages || []).length) {
    return { ok: false, error: "这条实训还没有任何引导步骤，先补上再发布" };
  }
  a.status = status;
  a.updatedAt = Date.now();
  if (!skipSave) { saveActivities(); refreshActivityNav(); }
  return { ok: true, activity: a };
}

/** 删除前先数清楚挂了什么 —— 别让用户蒙着删（与 courseAssetCount 同一用意） */
function activityAssetCount(id) {
  const a = activityOf(id);
  if (!a) return { stages: 0, participants: 0, findings: 0, messages: 0, progress: 0 };
  return {
    stages: (a.skeleton.stages || []).length,
    participants: a.participants.length,
    findings: a.findings.length,
    messages: (a.messages || []).length,
    // 🔴 第 55 轮：真正"做过"的人数（跨桶读学生自己的进度），不是被圈进名单的人数
    progress: progressOfActivity(id).length,
  };
}

/**
 * 删除一条实训活动（连带它的骨架与参与者记录一起没）。
 * 🔴 第 55 轮修：同一条活动**可能在多个账号桶里各有一份副本** ——
 *    学生发起的会同时落「学生桶」与「教师桶」（见 createStudentActivity）。
 *    只删当前桶 = 学生那边还留着，他刷新后又看到这条已被删掉的实训。
 *    → 遍历所有桶，把同 id 的副本一并清掉（与 addMyFinding / addChatMessage 同一套广播思路）。
 */
function deleteActivity(id) {
  const i = (ACTIVITIES || []).findIndex(function (a) { return a.id === id; });
  if (i < 0) return { ok: false, error: "找不到该实训活动" };
  const act = ACTIVITIES[i];
  const count = activityAssetCount(id);
  ACTIVITIES.splice(i, 1);
  saveActivities();

  // 其余账号桶里的同 id 副本（当前桶刚保存过，那边已经没有了 → 会自然跳过）
  const also = [];
  activityBucketKeys().forEach(function (k) {
    const list = readActivityBucket(k);
    if (!list || !list.length) return;
    const left = list.filter(function (a) { return !a || a.id !== id; });
    if (left.length === list.length) return;          // 这个桶里本来就没有它
    try {
      window.localStorage.setItem(k, JSON.stringify(left));
      also.push(k);
    } catch (_) { /* 这个桶写不进就算了 */ }
  });

  refreshActivityNav();
  return { ok: true, activity: act, removed: count, alsoRemovedFrom: also };
}

/* ---------------- 骨架步骤的增 / 删 / 调序 ----------------
   🔴 调序接口同样用「**插到谁前面**」表达（`beforeStageId`，null = 末尾），
      不传下标 —— 与教案大纲那套保持同一个约定（下标在"先摘自己再插入"时会错位）。
   ============================================================ */

/** 在 afterStageId 之后插入一步（null = 追加到末尾）；返回新步骤 */
function addStage(activityId, afterStageId) {
  const a = activityOf(activityId);
  if (!a) return { ok: false, error: "找不到该实训活动" };
  const stages = a.skeleton.stages || (a.skeleton.stages = []);
  const step = normStage({ id: newStageId(), title: "新的一步" }, stages.length);
  const at = afterStageId ? stages.findIndex(function (s) { return s.id === afterStageId; }) : -1;
  if (at >= 0) stages.splice(at + 1, 0, step); else stages.push(step);
  a.updatedAt = Date.now();
  saveActivities();
  refreshActivityNav();
  return { ok: true, activity: a, stage: step };
}

/** 删一步 */
function removeStage(activityId, stageId) {
  const a = activityOf(activityId);
  if (!a) return { ok: false, error: "找不到该实训活动" };
  const stages = a.skeleton.stages || [];
  if (stages.length <= 1) return { ok: false, error: "至少留一步 —— 骨架不能是空的" };
  const i = stages.findIndex(function (s) { return s.id === stageId; });
  if (i < 0) return { ok: false, error: "找不到该步骤" };
  stages.splice(i, 1);
  a.updatedAt = Date.now();
  saveActivities();
  refreshActivityNav();
  return { ok: true, activity: a };
}

/** 把某一步挪到 `beforeStageId` 前面（null = 末尾） */
function moveStage(activityId, stageId, beforeStageId) {
  const a = activityOf(activityId);
  if (!a) return { ok: false, error: "找不到该实训活动" };
  const stages = a.skeleton.stages || [];
  const cur = stages.findIndex(function (s) { return s.id === stageId; });
  if (cur < 0) return { ok: false, error: "找不到该步骤" };
  if (stageId === beforeStageId) return { ok: true, activity: a };   // 原地，什么也不做
  const step = stages.splice(cur, 1)[0];
  const at = beforeStageId ? stages.findIndex(function (s) { return s.id === beforeStageId; }) : -1;
  if (at >= 0) stages.splice(at, 0, step); else stages.push(step);
  a.updatedAt = Date.now();
  saveActivities();
  refreshActivityNav();
  return { ok: true, activity: a, moved: stageId };
}

/** 上移 / 下移（复用 moveStage，边界给人话） */
function moveStageBy(activityId, stageId, delta) {
  const a = activityOf(activityId);
  if (!a) return { ok: false, error: "找不到该实训活动" };
  const stages = a.skeleton.stages || [];
  const i = stages.findIndex(function (s) { return s.id === stageId; });
  if (i < 0) return { ok: false, error: "找不到该步骤" };
  const j = i + (delta > 0 ? 1 : -1);
  if (j < 0) return { ok: false, error: "已经是第一步了" };
  if (j >= stages.length) return { ok: false, error: "已经是最后一步了" };
  return moveStage(activityId, stageId, delta > 0 ? (stages[j + 1] ? stages[j + 1].id : null) : stages[j].id);
}

/**
 * 「推荐方向」标记 —— 灵感 02 里「学生走出新方向如何被系统识别」的落地：
 * 系统无法自动判定什么叫"新发现"，退化为**学生主动标记 + 教师推荐**（原话就是"万一……"），
 * 所以这里只做教师侧的一次布尔翻转，不假装 AI 判断了创新性。
 */
function toggleFindingPin(activityId, findingId) {
  const a = activityOf(activityId);
  if (!a) return { ok: false, error: "找不到该实训活动" };
  const f = a.findings.find(function (x) { return x.id === findingId; });
  if (!f) return { ok: false, error: "找不到这条发现" };
  f.pinned = !f.pinned;
  a.updatedAt = Date.now();
  saveActivities();
  return { ok: true, activity: a, finding: f };
}

/**
 * 学生发起、还停在草案的活动数（侧栏徽标用）。
 * 🔴 自「学生发起直接开启」后，这个数恒为 0（学生发起不再等老师确认）——
 *    函数与徽标机制保留，只是不再有非零来源；教师端「待确认」提示因此不再出现。
 */
function pendingStudentActivities() {
  return (ACTIVITIES || []).filter(function (a) {
    return a.origin === "student" && a.status === "draft";
  }).length;
}

/** 找教师端菜单里的一项（按 key） */
function findTeacherNavItem(key) {
  const groups = (typeof NAV !== "undefined" && NAV.teacher) || [];
  for (let i = 0; i < groups.length; i++) {
    const items = groups[i].items || [];
    for (let j = 0; j < items.length; j++) if (items[j].key === key) return items[j];
  }
  return null;
}

/** 学生端菜单项的查找（与 `findTeacherNavItem` 同一写法） */
function findStudentNavItem(key) {
  const groups = (typeof NAV !== "undefined" && NAV.student) || [];
  for (let i = 0; i < groups.length; i++) {
    const items = groups[i].items || [];
    for (let j = 0; j < items.length; j++) if (items[j].key === key) return items[j];
  }
  return null;
}

/**
 * 重建「实训管理」菜单项的徽标 = 待确认的学生发起活动数。
 * 🔴 自「学生发起直接开启」后 `pendingStudentActivities()` 恒 0 → 徽标不再出现；
 *    函数与侧栏渲染机制保留，将来若恢复「确认」环节即可复用。
 * 侧栏渲染前必须调它（壳与独立模式各渲染一次），否则徽标是旧的。
 *    页面里改了活动后要通知壳重挂侧栏：`notifyActivitiesChanged()`（见 core.js）。
 */
function refreshActivityNav() {
  const item = findTeacherNavItem("training");
  if (!item) return 0;
  const n = pendingStudentActivities();
  if (n) item.badge = n + " 待确认"; else delete item.badge;
  return n;
}

// 菜单项的徽标要在侧栏渲染前就位（NAV 已定义完，此刻可以回填）
refreshActivityNav();

/* ============================================================
   实训 —— 学生端（参与 + 发起）
   ------------------------------------------------------------
   教师端「实训管理」（training.html）发布/确认活动；学生端「实训」
   （training-student.html）参与、逐步推进、记路线、标记新发现、并自己发起。
   配套灵感：docs/IDEAS.md 灵感 01 层 2「实训活动」+ 灵感 02「学生发起的探究式实训」。

   🔴 存储与跨桶规矩（与 exam / courseware 同一套）：
     · 活动记录按账号分桶（`st_activities:<角色>:<账号>`）。
     · 老师发布的 open/done 活动：学生**跨账号桶**读（记录在老师桶里）。
     · 学生发起：写**学生自己桶**（`createdBy` 标发起人，**直接开启**）+ **同步一份到本机教师桶**
       （纯静态单机，学生发起后老师登录本机即见这条活动；见 createStudentActivity）。
     · 学生自己的进度 / 路线笔记：存**学生桶** `st_training_progress:<角色>:<账号>`。
     · 「新发现」要写回活动记录本身（老师才看得到）→ 广播到所有含该 id 的桶。
   ============================================================ */

var TRAINING_PROGRESS_KEY = "st_training_progress";

/** 当前账号的学生实训进度桶键 */
function trainingProgressKey() {
  const u = currentUserKey();
  return u ? TRAINING_PROGRESS_KEY + ":" + u : TRAINING_PROGRESS_KEY;
}

/** 规整进度存档：{ [activityId]: { currentStage, done, notes:[{at,text}], updatedAt } } */
function normalizeTrainingProgress(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out = {};
  Object.keys(obj).forEach(function (id) {
    const p = obj[id];
    if (!p || typeof p !== "object") return;
    out[id] = {
      activityId: String(id),
      currentStage: String(p.currentStage || ""),
      done: !!p.done,
      notes: (Array.isArray(p.notes) ? p.notes : []).map(function (n) {
        return { at: Number(n && n.at) || 0, text: String(n && n.text || "").trim() };
      }).filter(function (n) { return n.text; }),
      deductions: (Array.isArray(p.deductions) ? p.deductions : []).map(function (n) {
        return {
          at: Number(n && n.at) || 0,
          text: String(n && n.text || "").trim(),
          source: (n && (n.source === "ai" || n.source === "sample")) ? n.source : "me",
        };
      }).filter(function (n) { return n.text; }),
      updatedAt: Number(p.updatedAt) || 0,
    };
  });
  return out;
}

var TRAINING_PROGRESS = loadTrainingProgress();

function loadTrainingProgress() {
  const key = trainingProgressKey();
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const v = JSON.parse(raw);
      if (typeof v === "string") return normalizeTrainingProgress(JSON.parse(v));  // 老档双重编码
      return normalizeTrainingProgress(v);
    }
  } catch (_) { /* 隐私模式 / file:// —— 退化为内存态 */ }
  return {};
}

function saveTrainingProgress() {
  try { window.localStorage.setItem(trainingProgressKey(), JSON.stringify(TRAINING_PROGRESS)); }
  catch (_) { /* 存不下就算了 */ }
}

/** 某活动的进度（没开始过返回 null） */
function myProgressOf(activityId) {
  return TRAINING_PROGRESS[String(activityId)] || null;
}

/** 更新自己的进度（合并写回） */
function saveMyProgress(activityId, patch) {
  const id = String(activityId);
  const p = TRAINING_PROGRESS[id] || (TRAINING_PROGRESS[id] = {
    activityId: id, currentStage: "", done: false, notes: [], deductions: [], updatedAt: 0,
  });
  if ("currentStage" in patch) p.currentStage = String(patch.currentStage || "");
  if ("done" in patch) p.done = !!patch.done;
  if ("notes" in patch) p.notes = patch.notes;
  if ("deductions" in patch) p.deductions = patch.deductions;
  p.updatedAt = Date.now();
  saveTrainingProgress();
  return { ok: true, progress: p };
}

/** 推进到某一步（done 表示「走完了」） */
function markStageDone(activityId, stageId, done) {
  return saveMyProgress(activityId, { currentStage: String(stageId || ""), done: !!done });
}

/** 记一条路线笔记（我自己的探究思路） */
function addRouteNote(activityId, text) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, error: "笔记不能为空" };
  const id = String(activityId);
  const p = TRAINING_PROGRESS[id] || (TRAINING_PROGRESS[id] = {
    activityId: id, currentStage: "", done: false, notes: [], deductions: [], updatedAt: 0,
  });
  p.notes.push({ at: Date.now(), text: t });
  p.updatedAt = Date.now();
  saveTrainingProgress();
  return { ok: true, progress: p };
}

/** 记一条「推导出来的有帮助的信息」（source："me" 学生自己推导 / "ai" 猜想的 AI 验证结论） */
function addDeduction(activityId, text, source) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, error: "推导不能为空" };
  const id = String(activityId);
  const p = TRAINING_PROGRESS[id] || (TRAINING_PROGRESS[id] = {
    activityId: id, currentStage: "", done: false, notes: [], deductions: [], updatedAt: 0,
  });
  p.deductions = p.deductions || [];
  p.deductions.push({ at: Date.now(), text: t, source: (source === "ai" || source === "sample") ? source : "me" });
  p.updatedAt = Date.now();
  saveTrainingProgress();
  return { ok: true, progress: p };
}

/* ============================================================
   跨桶读「谁真的在做」（第 55 轮）
   ------------------------------------------------------------
   进度存在**学生自己的桶**（`st_training_progress:<角色>:<账号>`）——
   老师在教师端要看"学生做到哪了、推导出了什么"就必须跨桶读。
   🔴 与 activitiesForStudent / simOfAnywhere 同一套：桶键**由 `st_accounts` 推**，
      不枚举 `localStorage.key(i)`；读桶一律走 readBucket（兼容老档双重编码）。
   ============================================================ */

/** 本机各账号的进度桶键（含全局桶与当前账号桶），去重 */
function trainingProgressBucketKeys() {
  return bucketKeys(TRAINING_PROGRESS_KEY, trainingProgressKey());
}

/** 读一个进度桶（兼容老档双重编码） */
function readProgressBucket(key) {
  return readBucket(TRAINING_PROGRESS_KEY, key, normalizeTrainingProgress);
}

/** 账号 key（`student:zhangsan`）→ 显示名；查不到就退回账号本身 */
function accountNameOf(accKey) {
  const want = String(accKey || "").trim().toLowerCase();
  if (!want) return "";
  let list = [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(ACCOUNT_KEY) || "[]");
    list = Array.isArray(raw) ? raw : [];
  } catch (_) { return want; }
  const hit = list.filter(function (a) {
    return a && (String(a.role || "") + ":" + String(a.user || "")).toLowerCase() === want;
  })[0];
  return hit ? String(hit.name || hit.user).trim() : want;
}

/** 桶键 → 账号 key（`st_training_progress:student:zhangsan` → `student:zhangsan`） */
function accountKeyFromBucket(bucketKey, baseKey) {
  const k = String(bucketKey || "");
  if (!k || k === baseKey) return "";
  const want = baseKey + ":";
  return k.indexOf(want) === 0 ? k.slice(want.length) : "";
}

/**
 * 这条实训**真实的参与情况** —— 跨所有账号桶，取每人对该活动的进度。
 * 返回 `[{ key, name, done, currentStage, updatedAt, notes, deductions }]`，按更新时间倒序。
 *
 * 🔴 「参与」= **留下过进度记录**（哪怕只点开看了一步），**不是**"被圈进参与者名单"——
 *    `participants` 只是发布时圈定的人，不等于他们真的做了。
 */
function progressOfActivity(activityId) {
  const id = String(activityId || "");
  if (!id) return [];
  const seen = {};
  const out = [];
  const push = function (accKey, prog) {
    const key = String(accKey || "").toLowerCase();
    if (!key || seen[key]) return;
    const p = prog && prog[id];
    if (!p) return;                       // 这个人在这条实训上还没有任何记录
    seen[key] = 1;
    out.push({
      key: key,
      name: accountNameOf(key),
      done: !!p.done,
      currentStage: p.currentStage || "",
      updatedAt: p.updatedAt || 0,
      notes: p.notes || [],
      deductions: p.deductions || [],
    });
  };

  // 当前账号：内存里那份最新（可能刚改完还没被别的键读到）
  const mine = currentUserKey();
  if (mine) push(mine, TRAINING_PROGRESS);
  // 其余账号桶
  trainingProgressBucketKeys().forEach(function (k) {
    push(accountKeyFromBucket(k, TRAINING_PROGRESS_KEY), readProgressBucket(k));
  });

  return out.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
}

/** 本机账号库里 role=teacher 的账号（学生发起实训时同步给老师用） */
function localTeacherAccounts() {
  let list = [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(ACCOUNT_KEY) || "[]");
    list = Array.isArray(raw) ? raw : [];
  } catch (_) { return []; }
  return list
    .filter(function (a) { return a && a.role === "teacher" && String(a.user || "").trim(); })
    .map(function (a) {
      const user = String(a.user).trim();
      return {
        user: user,
        name: String(a.name || user).trim(),
        createdAt: Number(a.createdAt) || 0,
        key: "teacher:" + user.toLowerCase(),
      };
    })
    .sort(function (a, b) { return a.createdAt - b.createdAt; });
}

/** 本机各账号的实训桶键（含全局桶与当前账号桶），去重 —— 与 simBucketKeys 同一套路 */
function activityBucketKeys() {
  return bucketKeys(ACTIVITY_KEY, (typeof activityStoreKey === "function") ? activityStoreKey() : "");
}

/** 读一个实训桶（兼容老档双重编码） */
function readActivityBucket(key) { return readBucket(ACTIVITY_KEY, key, normalizeActivities); }

/** 状态优先级：已归档 > 进行中 > 草案 —— 同 id 多副本时取「更靠后」的状态 */
function activityStatusRank(status) {
  if (status === "done") return 3;
  if (status === "open") return 2;
  return 1;
}

/**
 * 学生能看到的实训 —— 跨账号桶读 + 按 id 合并。
 * 规则：老师发布的 open/done 活动（公开可参与）+ 自己发起的（createdBy === who，直接开启）。
 * 同 id 出现多份（学生发起会同时落学生桶与教师桶）→ 取状态最靠后、更新时间最新的一份。
 */
function activitiesForStudent(who) {
  const w = String(who || "").trim().toLowerCase();
  if (!w) return [];
  const merged = {};
  const take = function (arr) {
    (arr || []).forEach(function (a) {
      if (!a || !a.id) return;
      const cur = merged[a.id];
      if (!cur ||
          activityStatusRank(a.status) > activityStatusRank(cur.status) ||
          (activityStatusRank(a.status) === activityStatusRank(cur.status) &&
           (a.updatedAt || 0) > (cur.updatedAt || 0))) {
        merged[a.id] = a;
      }
    });
  };
  take(ACTIVITIES);                                     // 先看内存里最新的（可能刚改完还没落盘到别的键）
  activityBucketKeys().forEach(function (k) { take(readActivityBucket(k)); });

  return Object.keys(merged).map(function (id) { return merged[id]; })
    .filter(function (a) {
      if (a.status === "open" || a.status === "done") return true;
      return a.origin === "student" && String(a.createdBy || "").toLowerCase() === w;
    })
    .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
}

/** 学生端「实训」进行中的数量（菜单徽标 / 页面统计都用它） */
function studentTrainingCount(who) {
  return activitiesForStudent(who).filter(function (a) { return a.status === "open"; }).length;
}

/** 跨桶找一条活动（学生打开「老师发来的」或「自己发起的」用） */
function activityOfAnywhere(id) {
  const a = activityOf(id);
  if (a) return a;
  const target = String(id || "");
  let hit = null;
  activityBucketKeys().forEach(function (k) {
    if (hit) return;
    const list = readActivityBucket(k);
    (list || []).forEach(function (x) { if (!hit && x.id === target) hit = x; });
  });
  return hit;
}

let FINDING_SEQ = 0;
/** 新发现 id（同一会话内不重复） */
function newFindingId() { FINDING_SEQ += 1; return "f" + Date.now().toString(36) + "-" + FINDING_SEQ; }

/**
 * 学生标记「这是我的新发现」—— 写回**活动记录本身**（老师才看得到）。
 * 同一 id 可能有多个副本（学生桶 + 教师桶）→ 广播到所有含该 id 的桶，保持一致。
 */
function addMyFinding(activityId, text, who) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, error: "新发现不能为空" };
  const whoName = String(who || "").trim();
  const finding = { id: newFindingId(), who: whoName || localName(), at: Date.now(), text: t, pinned: false };

  let touched = 0;
  activityBucketKeys().forEach(function (k) {
    const list = readActivityBucket(k);
    if (!list) return;
    const hit = (list || []).filter(function (x) { return x.id === activityId; })[0];
    if (!hit) return;
    hit.findings = hit.findings || [];
    hit.findings.push(finding);
    try { window.localStorage.setItem(k, JSON.stringify(list)); } catch (_) { /* 这个桶写不进就算了 */ }
    touched++;
  });

  // 内存里的本桶记录也同步（当前会话重新渲染要立刻看到）
  const local = activityOf(activityId);
  if (local) {
    local.findings = local.findings || [];
    if (!local.findings.some(function (f) { return f.id === finding.id; })) local.findings.push(finding);
  }

  if (!touched) return { ok: false, error: "找不到这条实训" };
  return { ok: true, finding: finding, touched: touched };
}

let MESSAGE_SEQ = 0;
/** 群聊消息 id（同一会话内不重复） */
function newMessageId() { MESSAGE_SEQ += 1; return "m" + Date.now().toString(36) + "-" + MESSAGE_SEQ; }

/**
 * 实训群聊里发一条消息 —— 写回活动记录本身（与 addMyFinding 同一套广播）。
 * 老师与学生都从各自页面发，广播到所有含该 id 的桶，跨账号看得到。
 */
function addChatMessage(activityId, text, who, role) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, error: "消息不能为空" };
  const whoName = String(who || "").trim();
  const msg = {
    id: newMessageId(),
    who: whoName || localName(),
    role: role === "teacher" ? "teacher" : "student",
    at: Date.now(),
    text: t,
  };

  let touched = 0;
  activityBucketKeys().forEach(function (k) {
    const list = readActivityBucket(k);
    if (!list) return;
    const hit = (list || []).filter(function (x) { return x.id === activityId; })[0];
    if (!hit) return;
    hit.messages = hit.messages || [];
    hit.messages.push(msg);
    // 🔴 第 55 轮：发消息也是"活动有更新" —— 不刷新 updatedAt 的话，
    //    「最近更新」列表的排序永远不动，刚讨论完的活动还沉在下面。
    hit.updatedAt = Date.now();
    try { window.localStorage.setItem(k, JSON.stringify(list)); } catch (_) { /* 这个桶写不进就算了 */ }
    touched++;
  });

  // 内存里的本桶记录也同步（当前会话重新渲染要立刻看到）
  const local = activityOf(activityId);
  if (local) {
    local.messages = local.messages || [];
    if (!local.messages.some(function (m) { return m.id === msg.id; })) local.messages.push(msg);
    local.updatedAt = Date.now();
  }

  if (!touched) return { ok: false, error: "找不到这条实训" };
  return { ok: true, message: msg, touched: touched };
}

/**
 * 学生发起实训 —— 灵感 02 的落地。
 * ① 写**学生自己桶**（origin:student、createdBy=当前学生）→ 学生端「我发起的」看得到；
 * ② 🔴 **直接开启**（status=open，不等老师确认）—— 用户要求「学生可以自己开启」；
 * ③ **同步一份到本机教师桶**（纯静态单机：老师登录本机即见这条学生发起的活动）；
 * ④ participants 可带「拉的协作者」（本机账号的显示名，纯本地模拟）。
 */
function createStudentActivity(data) {
  const d = data || {};
  const who = currentUserKey();
  const r = createActivity({
    goal: d.goal, title: d.title, courseId: d.courseId,
    origin: "student", createdBy: who,
  });
  if (!r.ok) return r;

  // 学生发起**直接开启**：骨架已由 draftSkeleton 生成（≥3 步），open 校验能过。
  const opened = setActivityStatus(r.activity.id, "open");
  if (!opened.ok) return opened;

  if (Array.isArray(d.participants)) {
    r.activity.participants = d.participants.map(function (x) { return String(x || "").trim(); }).filter(Boolean);
    saveActivities();
  }

  let synced = 0;
  localTeacherAccounts().forEach(function (t) {
    const key = ACTIVITY_KEY + ":" + t.key;
    try {
      // 🔴 用 readActivityBucket 读（兼容老档双重编码）—— 手写 JSON.parse 只解一层，
      //    会把双重编码的存档读成字符串 → 归一化成空 → 覆盖掉老师桶里原有的活动。
      const list = readActivityBucket(key) || [];
      if (list.some(function (x) { return x.id === r.activity.id; })) return;
      list.push(normalizeActivities([r.activity])[0]);
      window.localStorage.setItem(key, JSON.stringify(list));
      synced++;
    } catch (_) { /* 这个教师桶写不进就算了 */ }
  });

  return { ok: true, activity: r.activity, synced: synced };
}

/**
 * 学生端「实训」菜单徽标 = 进行中的实训数（0 就不显示）。
 * 与 refreshExamNav 同一套路；必须在数据层加载完再调（见文件末尾）。
 */
function refreshStudentTrainingNav() {
  const item = findStudentNavItem("training");
  if (!item) return 0;
  const u = (typeof currentUserKey === "function") ? currentUserKey() : "";
  const n = u ? studentTrainingCount(u) : 0;
  if (n) item.badge = n + " 个"; else delete item.badge;
  return n;
}

/* ============================================================
   学生选课 —— 「输入邀请码加入课堂」（第 32 轮）
   ------------------------------------------------------------
   与教师端「我的课程」**不是同一份数据**：
     教师：COURSES   ← 我教的课（「＋ 添加课程」新建、课程项「⋯」改信息 / 删课）
     学生：ENROLLED  ← 我加入的课堂（「＋ 输入邀请码加入课堂」）
   学生菜单项由 `refreshStudentCourseNav()` 从 ENROLLED 派生，
   **别在 NAV.student 字面量里写死课程**。

   🔴 邀请码是**确定性派生**的，不是随机数：同一门课在任何时候、任何账号下算出来
      完全一样 —— 所以教师端「查看邀请码」与学生端「输入邀请码」必然对得上。
      `joinCodeOf()` 是唯一实现，两处都调它；**别在页面里另写一套生成规则**
      （各写一套的话，老师看到的码和学生要输入的码迟早不是同一个）。

   ⚠️ 纯静态站没有服务端，学生的「加入」是在**本机浏览器**里完成的：查的是
      本机所有账号的课程存档（+ 预置课程），相当于"校园内网里的公开课堂目录"。
      换浏览器 / 换机器就查不到 —— 界面上如实说明，答辩也照这个口径讲。
   ============================================================ */

var ENROLL_KEY = "st_enroll";

/** 邀请码字母表：去掉容易看错的 0/O/1/I —— 念给同学听、手抄都不会错 */
var JOIN_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** 4 位校验位（FNV-1a 哈希）—— 让课程代码相同的两门课（不同老师各开一门 CS201）也有不同的码 */
function joinHash(s) {
  let h = 2166136261;
  const t = String(s);
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let n = h >>> 0, out = "";
  for (let i = 0; i < 4; i++) { out += JOIN_ALPHABET.charAt(n % 32); n = Math.floor(n / 32); }
  return out;
}

/**
 * 一门课的邀请码，形如 `CS201-7K3M`。
 * 前缀取课程代码（没代码就用 id），后缀是 4 位校验位 ——
 * 课程代码便于老师口头报，校验位保证不同课程不会撞码。
 */
function joinCodeOf(course) {
  const c = course || {};
  const base = String(c.code || c.id || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return (base || "COURSE") + "-" + joinHash(String(c.id || c.name || ""));
}

/** 规范化学生输入：忽略大小写、空格、连字符（少抄一个横线也能进） */
function normalizeJoinCode(raw) {
  return String(raw == null ? "" : raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** 从课程存档键解析出「哪个账号的课」：st_courses:teacher:zhangsan → "teacher:zhangsan" */
function ownerOfCourseKey(key) {
  const k = String(key || "");
  if (k.indexOf(COURSE_KEY + ":") !== 0) return "";
  return k.slice(COURSE_KEY.length + 1);
}

/** 账号标识（teacher:zhangsan）→ 显示名（找不到就退回账号名） */
function accountDisplayName(roleUser) {
  const u = String(roleUser || "").trim();
  if (!u) return "";
  try {
    const list = JSON.parse(window.localStorage.getItem(ACCOUNT_KEY) || "[]");
    const hit = (Array.isArray(list) ? list : []).find(function (a) {
      return a && (a.role + ":" + String(a.user).toLowerCase()) === u.toLowerCase();
    });
    if (hit && hit.name) return String(hit.name);
  } catch (_) { /* 账号库读不出来就算了 */ }
  return u.split(":")[1] || u;
}

/**
 * 本机所有账号的课程存档。
 * ⚠️ 不用枚举 localStorage 的键（`length` / `key(i)` 在隐私模式与桩环境里不一定给），
 *    而是**由账号库推出键名**：每个账号一个桶，再加全局桶。
 */
function courseArchives() {
  const keys = [COURSE_KEY];
  try {
    const list = JSON.parse(window.localStorage.getItem(ACCOUNT_KEY) || "[]");
    (Array.isArray(list) ? list : []).forEach(function (a) {
      if (a && a.role && a.user) {
        keys.push(COURSE_KEY + ":" + a.role + ":" + String(a.user).toLowerCase());
      }
    });
  } catch (_) { /* 账号库坏了 → 至少还有全局桶 */ }

  const out = [];
  keys.forEach(function (k) {
    try {
      const list = normalizeCourses(JSON.parse(window.localStorage.getItem(k) || "null"));
      if (list) list.forEach(function (c) { out.push({ course: c, key: k }); });
    } catch (_) { /* 这个桶的存档坏了，跳过 */ }
  });
  return out;
}

/** 可加入的课堂目录 = 本机各账号的课程存档 + 预置课程（预置课相当于学校开的公共课） */
function classroomCatalog() {
  const out = courseArchives();
  const seen = {};
  out.forEach(function (x) { seen[x.course.id] = 1; });
  SEED_COURSES.forEach(function (c) {
    if (!seen[c.id]) out.push({ course: c, key: "(预置课程)" });
  });
  return out;
}

/**
 * 按邀请码找课堂。找不到返回 null；找到返回 `{ course, key, owner }`。
 * 兼容两种输入：完整邀请码（CS201-7K3M），或**只有课程代码**（CS201，≥3 位且唯一时才认）——
 * 老师常常只把「CS201」念给学生，别让这种情形卡住。
 */
function findClassroom(raw) {
  const code = normalizeJoinCode(raw);
  if (!code) return null;
  const catalog = classroomCatalog();

  const hit = catalog.filter(function (x) {
    return normalizeJoinCode(joinCodeOf(x.course)) === code;
  })[0];
  if (hit) return { course: hit.course, key: hit.key, owner: ownerOfCourseKey(hit.key) };

  if (code.length >= 3) {
    const byCode = catalog.filter(function (x) {
      return normalizeJoinCode(x.course.code) === code;
    });
    if (byCode.length === 1) {
      return { course: byCode[0].course, key: byCode[0].key, owner: ownerOfCourseKey(byCode[0].key) };
    }
  }
  return null;
}

/* ---------------- 选课表（ENROLLED）---------------- */

/** 预置账号的选课：一进来就有课看，不必先跑去教师端建课（自注册账号从空的开始） */
var SEED_ENROLLMENTS = [
  { courseId: "ds", name: "数据结构与算法", code: "CS201",
    joinCode: joinCodeOf(SEED_COURSES[0]), by: "李老师", at: 0 },
];

/** 规整选课记录：没有 courseId 的丢掉，字段补齐 */
function normalizeEnrollments(list) {
  if (!Array.isArray(list)) return null;
  return list
    .filter(function (e) { return e && typeof e === "object" && String(e.courseId || "").trim(); })
    .map(function (e, i) {
      return {
        courseId: String(e.courseId).trim(),
        name: String(e.name || "").trim(),
        code: String(e.code || "").trim(),
        joinCode: String(e.joinCode || "").trim(),
        by: String(e.by || "").trim(),
        at: Number(e.at) || 0,
      };
    });
}

/** 当前账号的选课存档键（与 courseStoreKey 同一套路：业务数据按账号分开） */
function enrollStoreKey() {
  const u = currentUserKey();
  return u ? ENROLL_KEY + ":" + u : ENROLL_KEY;
}

function loadEnrollments() {
  const key = enrollStoreKey();
  const user = currentUserKey();

  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const ok = normalizeEnrollments(JSON.parse(raw));
      if (ok) return ok;                 // ⚠️ 空数组也算有效（退掉全部课堂不该复活预置选课）
    }
  } catch (_) { /* 隐私模式 / file:// —— 退化为内存态 */ }

  if (key !== ENROLL_KEY) {
    const migrated = migrateLegacyStore(ENROLL_KEY, key, normalizeEnrollments, null);
    if (migrated) return migrated;
  }

  return (!user || isSeedAccount(user)) ? normalizeEnrollments(SEED_ENROLLMENTS) : [];
}

function saveEnrollments() {
  try { window.localStorage.setItem(enrollStoreKey(), JSON.stringify(ENROLLED)); }
  catch (_) { /* 存不下就算了，界面照常能用 */ }
}

var ENROLLED = loadEnrollments();

/** 这门课加过没有；返回选课记录或 null */
function enrolledOf(courseId) {
  return (ENROLLED || []).find(function (e) { return e.courseId === courseId; }) || null;
}

/**
 * 学生看到的课程名：**优先用实时目录里的名字**（老师改了名学生跟着变），
 * 只有在本机已经找不到那门课时，才退回加入时的快照。
 */
function studentCourseName(courseId) {
  const live = classroomCatalog().filter(function (x) { return x.course.id === courseId; })[0];
  if (live) return live.course.name;
  const e = enrolledOf(courseId);
  return e ? e.name : courseId;
}

/** 加入课堂：重复加入会被拦下并说明（不静默复制一条） */
function enrollCourse(course, ownerRoleUser, now) {
  const c = course;
  if (!c || !c.id) return { ok: false, error: "找不到这门课" };
  if (enrolledOf(c.id)) {
    return { ok: false, error: "你已经在「" + studentCourseName(c.id) + "」课堂里了" };
  }
  const e = {
    courseId: c.id,
    name: String(c.name || "").trim(),
    code: String(c.code || "").trim(),
    joinCode: joinCodeOf(c),
    by: ownerRoleUser ? accountDisplayName(ownerRoleUser) : "",
    at: Number(now) || Date.now(),
  };
  ENROLLED.push(e);
  saveEnrollments();
  refreshStudentCourseNav();
  return { ok: true, enrollment: e };
}

/** 退出课堂（只删学生自己这条选课记录，不动老师的课） */
function leaveCourse(courseId) {
  const i = (ENROLLED || []).findIndex(function (e) { return e.courseId === courseId; });
  if (i < 0) return { ok: false, error: "你本来就没在这门课的课堂里" };
  const e = ENROLLED[i];
  ENROLLED.splice(i, 1);
  saveEnrollments();
  refreshStudentCourseNav();
  return { ok: true, enrollment: e };
}

/**
 * 重建学生端「我的课程」菜单项（数据源 ENROLLED）。
 * 只作用于**学生端带 `action: "joinCourse"` 的那组** —— 教师端「我的课程」走 refreshCourseNav()。
 * ⚠️ 课程项带 `arg: "course=<id>"`：多门课共用 chat.html，不带参数会一起高亮。
 */
function refreshStudentCourseNav() {
  const items = ENROLLED.map(function (e) {
    return {
      key: e.courseId,
      label: studentCourseName(e.courseId),
      page: "chat.html",
      arg: "course=" + e.courseId,
      dot: true,
    };
  });
  (NAV.student || []).forEach(function (g) {
    if (g.action === "joinCourse") g.items = items;
  });
  return items;
}

// 学生端课程菜单：NAV 已定义完，此刻回填（页面脚本在这之后才跑）
refreshStudentCourseNav();

/* ============================================================
   谁在课里 —— 真实的课程成员（第 33 轮）
   ------------------------------------------------------------
   🔴 这一块**不许有假数据**（用户原话：「不要假数据了，要真的看谁在课程里列出来」）。

   好消息是「谁加入了这门课」在纯静态站是**真的能查到的**：
     · 本机账号库 `st_accounts` 里 role=student 的账号 = 本机存在的学生
     · 每个学生账号**自己的**选课桶 `st_enroll:student:<账号>` = 他加入了哪些课堂
   交叉一下就是「这门课的在课学生」。查不到就是空 —— 不编造名单。
   而「掌握度 / 成绩 / 作业提交率」这类**没有真实来源**的，displayed 干脆不显示
   （原来那一列是拿班级 id 伪随机派生的假数字，已删）。

   ⚠️ 与选课一样，这是**本机浏览器内**的口径：别的机器上的学生查不到。
      界面上写清楚，答辩也照这个口径讲。
   ============================================================ */

/** 本机账号库里 role=student 的账号（按注册时间排，早的在前） */
function localStudentAccounts() {
  let list = [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(ACCOUNT_KEY) || "[]");
    list = Array.isArray(raw) ? raw : [];
  } catch (_) { return []; }
  return list
    .filter(function (a) { return a && a.role === "student" && String(a.user || "").trim(); })
    .map(function (a) {
      const user = String(a.user).trim();
      return {
        user: user,
        name: String(a.name || user).trim(),
        createdAt: Number(a.createdAt) || 0,
        key: "student:" + user.toLowerCase(),     // 与 st_enroll:<角色>:<账号> 的拼法一致
      };
    })
    .sort(function (a, b) { return a.createdAt - b.createdAt; });
}

/**
 * 某个**学生账号**的选课表（按账号分桶读）。
 * ⚠️ 预置账号没写过存档（种子只在内存里）→ 回落 `SEED_ENROLLMENTS`，
 *    否则教师端会看到"李同学不在数据结构课里"，与学生的实际界面自相矛盾。
 */
function enrollmentsOfStudent(studentRoleUser) {
  const key = ENROLL_KEY + ":" + String(studentRoleUser || "");
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const ok = normalizeEnrollments(JSON.parse(raw));
      if (ok) return ok;
    }
  } catch (_) { /* 这个桶的存档坏了，走下面的回落 */ }
  return isSeedAccount(String(studentRoleUser || "")) ? normalizeEnrollments(SEED_ENROLLMENTS) : [];
}

/** 这门课的**在课学生**（真实：本机学生账号 × 各自的选课表），按加入时间倒序 */
function enrolledStudentsOf(courseId) {
  const id = String(courseId || "").trim();
  if (!id) return [];
  const out = [];
  localStudentAccounts().forEach(function (s) {
    const hit = enrollmentsOfStudent(s.key).filter(function (e) { return e.courseId === id; })[0];
    if (hit) {
      out.push({
        user: s.user, name: s.name, key: s.key,
        joinCode: String(hit.joinCode || ""), by: String(hit.by || ""), at: Number(hit.at) || 0,
      });
    }
  });
  return out.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
}

/** 本机**还没**加入这门课的学生账号（老师可以把邀请码发给他们） */
function studentsNotInCourse(courseId) {
  const inIt = {};
  enrolledStudentsOf(courseId).forEach(function (s) { inIt[s.user.toLowerCase()] = 1; });
  return localStudentAccounts().filter(function (s) { return !inIt[s.user.toLowerCase()]; });
}

/** 某个学生在本机加入的全部课堂（点学生看详情时用） */
function coursesOfStudent(studentRoleUser) {
  return enrollmentsOfStudent(studentRoleUser).map(function (e) {
    return {
      courseId: e.courseId,
      name: studentCourseName(e.courseId),
      joinCode: String(e.joinCode || ""),
      at: Number(e.at) || 0,
    };
  });
}

/** 最后加入时间（详情/统计用）：没有则 0 */
function lastEnrollAt(courseId) {
  const list = enrolledStudentsOf(courseId);
  return list.length ? Math.max.apply(null, list.map(function (s) { return s.at || 0; })) : 0;
}

/* ============================================================
   学习行为日志 —— 唯一来源（第 34 轮）
   ------------------------------------------------------------
   为什么先有它：第 33 轮把 class.html 的假数据清了之后，学生详情弹窗只剩
   「账号 / 加入时间 / 邀请码」这类**静字段**。这轮用户要求「点开详细信息要像
   学生自己看的那个图表」—— 要出图表就得有数据，所以先把数据**真的记下来**：

     · 答疑页每问一句                              → ask
     · 答疑页点「懂了 / 看代码 / 展开推导 / 自测一题」→ got / code / deeper / quiz
     · 课件页写批注 / 请求重讲 / 朗读 / 选中段落     → note / reteach / speak / read

   全部按账号分桶存 `st_behavior:<角色>:<账号>`，**只在本机**。

   🔴 学生自己看的（analysis.html）与教师端点学生姓名看的（class.html）
      **是同一份数据、同一组聚合函数**（behaviorSummary / behaviorByTopic /
      behaviorWeakTopics / behaviorByDay）—— 两边数字天然一致，不许各算一套。

   🔴 算不出来的指标就不显示：本版**不记停留时长**（没有可靠的测量口径），
      所以任何依赖它的画像维度都不出现，不猜、不编。
   ============================================================ */

var BEHAVIOR_KEY = "st_behavior";
var BEHAVIOR_MAX = 400;                 // 每账号最多保留 400 条（只丢最旧的）

/** 行为类型 —— 唯一来源；界面文案从这里取，别在页面里另写一份 */
var BEHAVIOR_KIND = {
  ask:     { key: "ask",     label: "答疑提问",   icon: "?"   },
  note:    { key: "note",    label: "课件批注",   icon: "✎"   },
  reteach: { key: "reteach", label: "请求重讲",   icon: "↻"   },
  read:    { key: "read",    label: "阅读段落",   icon: "▤"   },
  speak:   { key: "speak",   label: "朗读段落",   icon: "♪"   },
  got:     { key: "got",     label: "标记懂了",   icon: "✓"   },
  code:    { key: "code",    label: "看代码示例", icon: "{ }" },
  deeper:  { key: "deeper",  label: "展开推导",   icon: "↓"   },
  quiz:    { key: "quiz",    label: "自测一题",   icon: "◈"   },
  other:   { key: "other",   label: "其他行为",   icon: "·"   },
};
function behaviorKind(k) { return BEHAVIOR_KIND[k] || BEHAVIOR_KIND.other; }
/** 界面上按这个顺序列行为类型（提问 → 批注 → 阅读 → 理解，读起来是条线） */
function behaviorKindKeys() {
  return ["ask", "note", "read", "reteach", "speak", "got", "code", "deeper", "quiz"];
}

/* ------------------------------------------------------------
   提问 / 批注的话题分类
   ------------------------------------------------------------
   图表要按话题分堆，就得有个稳定的分类口径。这里**按关键词命中**分类，
   命中最多的那个胜出；一个都没命中算「其他」——**不硬塞一个话题**。
   ============================================================ */
var TOPIC_NONE = "其他";
var TOPICS = [
  { key: "复杂度",     keys: ["复杂度", "时间复杂度", "空间复杂度", "大o", "渐进", "o(n", "o(1"] },
  { key: "排序",       keys: ["排序", "快排", "快速排序", "冒泡", "归并", "堆排序", "pivot", "基准", "划分"] },
  { key: "树",         keys: ["二叉树", "树", "遍历", "平衡", "旋转", "avl", "红黑", "堆"] },
  { key: "图",         keys: ["图", "最短路径", "dijkstra", "拓扑", "邻接", "广度", "深度优先", "连通"] },
  { key: "查找",       keys: ["查找", "哈希", "散列", "冲突", "二分", "索引", "搜索"] },
  { key: "线性表",     keys: ["链表", "数组", "栈", "队列", "线性表", "指针"] },
  { key: "进程与线程", keys: ["进程", "线程", "协程", "并发", "死锁", "锁", "调度"] },
];
function topicOf(text) {
  const q = String(text == null ? "" : text).toLowerCase();
  if (!q.trim()) return TOPIC_NONE;
  let best = TOPIC_NONE, bestScore = 0;
  TOPICS.forEach(function (t) {
    const score = t.keys.reduce(function (n, k) { return n + (q.indexOf(k) >= 0 ? 1 : 0); }, 0);
    if (score > bestScore) { bestScore = score; best = t.key; }
  });
  return best;
}

/* ---------------- 规整 / 读 / 写 ---------------- */

let BEHAVIOR_SEQ = 0;
function newBehaviorId() { BEHAVIOR_SEQ += 1; return "b" + Date.now().toString(36) + "-" + BEHAVIOR_SEQ; }

/** 规整一条行为记录：没类型或没时间的丢掉（存档坏了也不能白屏） */
function normBehaviorEntry(e, i) {
  const o = (e && typeof e === "object") ? e : {};
  const kind = behaviorKind(o.kind).key;
  const at = Number(o.at) || 0;
  if (!kind || !at) return null;
  return {
    id: String(o.id || "b" + (i + 1)).trim() || "b" + (i + 1),
    kind: kind,
    label: String(o.label || "").trim().slice(0, 120),
    topic: String(o.topic || topicOf(o.label)).trim() || TOPIC_NONE,
    courseId: String(o.courseId || "").trim(),
    seg: Number(o.seg) || 0,               // 段落号（课件批注用；0 = 不挂段）
    // 🔴 还要记是**哪一份课件**的第几段 —— 光有段号，换了一份课件批注就张冠李戴。
    //    老记录没这个字段 → 空串，页面按"没标就当当前这份"处理（见 reader.html）。
    cwId: String(o.cwId || "").trim(),
    at: at,
    seed: !!o.seed,                        // 预置示例记录（界面会标出来）
  };
}

/**
 * 规整整份日志。
 * 🔴 返回**按时间升序**的数组；超过 BEHAVIOR_MAX 只留最新的那批（丢最旧的，
 *    不是丢最新的 —— 日志的价值在「最近发生了什么」）。
 */
function normBehavior(list) {
  if (!Array.isArray(list)) return null;
  const out = list.map(normBehaviorEntry).filter(Boolean);
  out.sort(function (a, b) { return a.at - b.at; });
  return out.length > BEHAVIOR_MAX ? out.slice(out.length - BEHAVIOR_MAX) : out;
}

/** 某个账号的行为存档键（u 形如 "student:zhangsan"） */
function behaviorKeyOf(u) {
  return u ? BEHAVIOR_KEY + ":" + String(u) : BEHAVIOR_KEY;
}
function behaviorStoreKey() { return behaviorKeyOf(currentUserKey()); }

function readBehaviorBucket(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const ok = normBehavior(JSON.parse(raw));
      if (ok) return ok;                   // ⚠️ 空数组也算有效（删光了不该复活预置记录）
    }
  } catch (_) { /* 隐私模式 / file:// —— 退化为内存态 */ }
  return null;
}

/**
 * 读**某个账号**的行为日志（教师端看学生就走这里）。
 * ⚠️ 键名由调用方给出的账号标识拼出来（`student:<账号>`），**不去枚举 localStorage 的键**。
 * ⚠️ 预置账号没写过存档 → 回落预置示例记录，否则老师点开会是一片空、
 *    而学生自己明明能看到内容，自相矛盾。
 */
function behaviorOf(roleUser) {
  const u = String(roleUser || "").trim();
  if (!u) return [];
  const got = readBehaviorBucket(behaviorKeyOf(u));
  if (got) return got;
  return isSeedAccount(u) ? normalizeSeedBehavior() : [];
}

function loadBehavior() {
  const key = behaviorStoreKey();
  const user = currentUserKey();
  const got = readBehaviorBucket(key);
  if (got) return got;

  // 老版本的全局存档：迁给当前账号（只迁一次）
  if (key !== BEHAVIOR_KEY) {
    const migrated = migrateLegacyStore(BEHAVIOR_KEY, key, normBehavior, null);
    if (migrated) return migrated;
  }

  // 预置账号给一段历史，好让图表一眼看得出形状；自注册账号从**空的**开始
  return (!user || isSeedAccount(user)) ? normalizeSeedBehavior() : [];
}

function saveBehavior() {
  try { window.localStorage.setItem(behaviorStoreKey(), JSON.stringify(BEHAVIOR)); }
  catch (_) { /* 存不下就算了，界面照常能用 */ }
}

/**
 * 记一条行为 —— **页面在真实动作发生时调它**，不要为了「好看」补记。
 * 返回记下的那条；kind 不认识就归到 other。
 */
function logBehavior(entry) {
  const e = (entry && typeof entry === "object") ? entry : {};
  const at = Number(e.at) || Date.now();
  const kind = behaviorKind(e.kind).key;
  const label = String(e.label || "").trim().slice(0, 120);
  if (!label && kind === "other") return null;      // 既没类型又没内容 → 不值得记
  const rec = {
    id: newBehaviorId(),
    kind: kind,
    label: label,
    topic: String(e.topic || "").trim() || topicOf(label),
    courseId: String(e.courseId || "").trim(),
    seg: Number(e.seg) || 0,
    cwId: String(e.cwId || "").trim(),     // 哪一份课件的批注（见 normBehaviorEntry）
    at: at,
    seed: false,
  };
  BEHAVIOR.push(rec);
  if (BEHAVIOR.length > BEHAVIOR_MAX) BEHAVIOR = BEHAVIOR.slice(BEHAVIOR.length - BEHAVIOR_MAX);
  saveBehavior();
  return rec;
}

/**
 * 清空当前账号的行为日志。
 * 🔴 存**空数组**而不是删键：删掉键，下次加载时预置账号会重新回落成预置示例记录，
 *    于是「清空 → 刷新又长出来」。空数组表示"这个账号确实没有记录"，会被当作有效存档
 *    （与 COURSES / ENROLLED 的"空数组也算有效"是同一条规矩）。
 */
function clearBehavior() {
  BEHAVIOR = [];
  try { window.localStorage.setItem(behaviorStoreKey(), '[]'); } catch (_) { }
  return BEHAVIOR;
}

var BEHAVIOR = loadBehavior();

/* ============================================================
   聚合 —— 纯函数：输入一串日志 + 一个「现在」，输出图表要的数
   ------------------------------------------------------------
   🔴 全部做成**「时间从参数进来」的纯函数**（第 16 轮的规矩）：断言可以喂固定
      时间点，不会因为「跑测试那一刻是几点」而时好时坏。
   ============================================================ */

/** 本地零点（图表按「天」分堆，不能用 UTC 零点，否则晚上 8 点后算到明天） */
function dayStart(at) {
  const d = new Date(Number(at) || 0);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function behaviorCountByKind(list, kind) {
  return (list || []).filter(function (e) { return e.kind === kind; }).length;
}

/** 概览：总量 / 今天 / 近 7 天 / 活跃天数 / 连续天数 / 各类型计数 */
function behaviorSummary(list, now) {
  const arr = Array.isArray(list) ? list : [];
  const base = Number(now) || Date.now();
  const today = dayStart(base);
  const week = today - 6 * DAY_MS;
  const days = {};
  let lastAt = 0;
  arr.forEach(function (e) {
    days[dayStart(e.at)] = 1;
    if (e.at > lastAt) lastAt = e.at;
  });
  const out = {
    total: arr.length,
    today: arr.filter(function (e) { return e.at >= today; }).length,
    week: arr.filter(function (e) { return e.at >= week; }).length,
    activeDays: Object.keys(days).length,
    streak: behaviorStreak(arr, base),
    lastAt: lastAt,
    seedCount: arr.filter(function (e) { return e.seed; }).length,
    byKind: {},
  };
  behaviorKindKeys().concat(["other"]).forEach(function (k) {
    out.byKind[k] = behaviorCountByKind(arr, k);
  });
  return out;
}

/** 连续活跃天数：从今天（或昨天）往前数，断了就停 */
function behaviorStreak(list, now) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return 0;
  const days = {};
  arr.forEach(function (e) { days[dayStart(e.at)] = 1; });
  const today = dayStart(Number(now) || Date.now());
  // 今天还没动过不算断 —— 从昨天起算（「昨晚学到 11 点」不该显示成断了）
  let cursor = days[today] ? today : today - DAY_MS;
  let n = 0;
  while (days[cursor]) { n += 1; cursor -= DAY_MS; }
  return n;
}

/** 按类型分布（降序；只含有记录的） */
function behaviorByKind(list) {
  const arr = Array.isArray(list) ? list : [];
  return behaviorKindKeys().concat(["other"]).map(function (k) {
    return { kind: k, label: behaviorKind(k).label, icon: behaviorKind(k).icon, count: behaviorCountByKind(arr, k) };
  }).filter(function (x) { return x.count > 0; })
    .sort(function (a, b) { return b.count - a.count; });
}

/** 按话题分布（只统计和知识内容有关的：提问 / 重讲 / 批注） */
var TOPIC_KINDS = ["ask", "reteach", "note"];
function behaviorByTopic(list, limit) {
  const arr = (Array.isArray(list) ? list : []).filter(function (e) {
    return TOPIC_KINDS.indexOf(e.kind) >= 0;
  });
  const map = {};
  arr.forEach(function (e) {
    const t = e.topic || TOPIC_NONE;
    if (!map[t]) map[t] = { topic: t, count: 0, ask: 0, note: 0, reteach: 0 };
    map[t].count += 1;
    if (map[t][e.kind] != null) map[t][e.kind] += 1;
  });
  const out = Object.keys(map).map(function (k) { return map[k]; })
    .sort(function (a, b) { return b.count - a.count || (a.topic < b.topic ? -1 : 1); });
  return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * 「该补的地方」——**从行为里推出来的**，不是编的：
 * 一个话题被反复问（提问 + 重讲 ≥ 2 次），却**从来没有标记过「懂了」** → 大概率还没通。
 * 两个条件都满足才列，按次数降序；一条都没有就返回空数组（页面自己给空状态）。
 */
function behaviorWeakTopics(list, limit) {
  const arr = Array.isArray(list) ? list : [];
  const got = {};
  arr.forEach(function (e) {
    if (e.kind === "got") got[e.topic || TOPIC_NONE] = 1;
  });
  const asked = {};
  arr.forEach(function (e) {
    if (e.kind !== "ask" && e.kind !== "reteach") return;
    const t = e.topic || TOPIC_NONE;
    asked[t] = (asked[t] || 0) + 1;
  });
  const out = Object.keys(asked)
    .filter(function (t) { return asked[t] >= 2 && !got[t] && t !== TOPIC_NONE; })
    .map(function (t) { return { topic: t, count: asked[t] }; })
    .sort(function (a, b) { return b.count - a.count || (a.topic < b.topic ? -1 : 1); });
  return limit > 0 ? out.slice(0, limit) : out;
}

/** 近 n 天逐日计数（没有记录的那几天补 0 —— 柱状图要连续的横轴） */
function behaviorByDay(list, days, now) {
  const n = Math.max(1, Number(days) || 14);
  const arr = Array.isArray(list) ? list : [];
  const today = dayStart(Number(now) || Date.now());
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = today - i * DAY_MS;
    out.push({
      at: start,
      label: (new Date(start).getMonth() + 1) + "/" + new Date(start).getDate(),
      count: arr.filter(function (e) { return dayStart(e.at) === start; }).length,
    });
  }
  return out;
}

/** 最近 n 条（倒序，界面上「最近发生了什么」） */
function behaviorTimeline(list, limit) {
  const arr = (Array.isArray(list) ? list : []).slice();
  arr.sort(function (a, b) { return b.at - a.at; });
  return limit > 0 ? arr.slice(0, limit) : arr;
}

/** 日志里有多少条是预置示例记录（界面要如实标出来，不能装成用户自己产生的） */
function behaviorSeedCount(list) {
  return (Array.isArray(list) ? list : []).filter(function (e) { return e.seed; }).length;
}

/* ------------------------------------------------------------
   预置示例记录（**只给预置示例账号**）
   ------------------------------------------------------------
   ⚠️ 做成**函数**：时间相对「现在」现算，这样 demo 里图表永远呈「最近两周在学」
      的形状，而不是冻在某一天。写进存档之前它是只读的（不会被页面改坏）。
      自注册账号从空开始（与 SEED_COURSES / SEED_ENROLLMENTS / SEED_ACTIVITIES 同一约定）。
   ============================================================ */
function seedBehaviorAt(daysAgo, hhmm) {
  const d = new Date(Date.now() - daysAgo * DAY_MS);
  const hm = String(hhmm || "20:00").split(":");
  d.setHours(Number(hm[0]) || 0, Number(hm[1]) || 0, 0, 0);
  // 🔴 不能落在"未来"：展示常常是**上午**打开的，而种子写的是 20:31 ——
  //    那会产生一个未来时间戳，agoText 算出差值为负 → 显示"刚刚"，
  //    时间线还把它排在"最新"。夹到 6 分钟前，历史就是历史。
  return Math.min(d.getTime(), Date.now() - 6 * 60 * 1000);
}
function rawSeedBehavior() {
  /** 每行：[几天前, 几点, 类型, 内容, 话题, 段落号?] */
  const rows = [
    [13, "20:12", "read",    "7.2 快速排序的复杂度分析 · 第 1 段", "排序"],
    [13, "20:26", "ask",     "为什么快速排序最坏是 O(n²)？", "复杂度"],
    [13, "20:31", "reteach", "第 1 段", "排序"],
    [13, "20:38", "got",     "第 1 段", "排序"],
    [11, "19:40", "ask",     "怎样判断算法的时间复杂度？", "复杂度"],
    [11, "19:52", "deeper",  "O(n log n) 的推导", "复杂度"],
    [10, "21:03", "note",    "随机化 pivot 与洗牌的区别？", "排序", 4],
    [10, "21:20", "speak",   "第 4 段", "排序"],
    [9,  "18:55", "read",    "7.2 快速排序的复杂度分析 · 第 6 段", "排序"],
    [8,  "20:10", "ask",     "哈希表冲突怎么解决？", "查找"],
    [8,  "20:22", "code",    "链地址法的插入代码", "查找"],
    [6,  "21:15", "ask",     "图的最短路径算法适用条件是什么？", "图"],
    [6,  "21:30", "ask",     "Dijkstra 为什么不能有负权边？", "图"],
    [5,  "20:05", "reteach", "第 2 段", "图"],
    [4,  "19:30", "ask",     "图的最短路径算法适用条件是什么？", "图"],
    [4,  "19:48", "note",    "三路划分处理重复元素", "排序", 6],
    [12, "20:05", "note",    "划分不平衡 → 递归深度变 n", "排序", 1],
    [3,  "20:40", "ask",     "平衡二叉树旋转怎么判断方向？", "树"],
    [2,  "21:10", "read",    "第 5 章 树与二叉树", "树"],
    [2,  "21:26", "ask",     "平衡二叉树旋转怎么判断方向？", "树"],
    [1,  "19:55", "ask",     "排序算法稳定性怎么判断？", "排序"],
    [1,  "20:12", "got",     "排序稳定性", "排序"],
    [1,  "20:30", "quiz",    "排序 · 自测一题", "排序"],
    [0,  "20:14", "ask",     "图的最短路径算法适用条件是什么？", "图"],
    [0,  "20:20", "read",    "第 6 章 · 图", "图"],
    [0,  "20:31", "speak",   "第 6 段", "排序"],
    [7,  "20:44", "code",    "Dijkstra 的松弛操作代码", "图"],
    [5,  "20:18", "deeper",  "为什么松弛能保证最优", "图"],
    [5,  "20:26", "got",     "松弛操作", "图"],
    [4,  "20:02", "code",    "三路划分的划分函数", "排序"],
    [3,  "20:12", "got",     "平衡二叉树旋转方向", "树"],
    [12, "21:02", "deeper",  "正多边形面积怎么算", "复杂度"],
  ];
  return rows.map(function (r, i) {
    return {
      id: "seed-b" + (i + 1),
      kind: r[2],
      label: r[3],
      topic: r[4],
      courseId: "ds",
      seg: Number(r[5]) || 0,
      at: seedBehaviorAt(r[0], r[1]),
      seed: true,
    };
  });
}
function normalizeSeedBehavior() { return normBehavior(rawSeedBehavior()); }

/* ------------------------------------------------------------
   「学习方式」画像 —— 从上面的行为日志**统计**出来的（第 34 轮）
   ------------------------------------------------------------
   🔴 这不是模型判断，是**比例**：某项相对提问次数的占比越高，说明这个学生越多地
      主动索取这类帮助。所以文案要写「从你的行为统计」，不能写成「AI 认为你适合…」。
   ⚠️ 分母用「提问次数」而不是全部行为：提问是这套行为里最稳定的一个基准，
      用总行为数会让"读了几段课件"把画像稀释掉。
   ============================================================ */
var TRAIT_ORDER = [
  { key: "example", name: "要例子 / 看代码", kind: "code"    },
  { key: "derive",  name: "要推导过程",     kind: "deeper"  },
  { key: "reask",   name: "要换个说法",     kind: "reteach" },
  { key: "got",     name: "当场听懂",       kind: "got"     },
  { key: "note",    name: "随手记笔记",     kind: "note"    },
];
function traitLabel(v) {
  if (v >= 75) return "很强";
  if (v >= 50) return "较强";
  if (v >= 25) return "一般";
  return "较少";
}
/**
 * 返回 5 条画像 [ { key, name, score(0-100), label, count, base } ]。
 * `count` 是这类行为的次数、`base` 是提问次数 —— 页面上要能摊开给人看，
 * 不然「较强」这种词就成了新的黑箱。
 */
function behaviorTraits(list, now) {
  const arr = Array.isArray(list) ? list : [];
  const base = behaviorCountByKind(arr, "ask");
  return TRAIT_ORDER.map(function (t) {
    const count = behaviorCountByKind(arr, t.kind);
    // 没有提问时没有分母 → 分数 0（页面会直接显示"还没有提问记录"）
    const score = base ? Math.min(100, Math.round((count / base) * 100)) : 0;
    return { key: t.key, name: t.name, kind: t.kind, count: count, base: base, score: score, label: traitLabel(score) };
  });
}

/* ------------------------------------------------------------
   批注（kind = "note"）—— 课件页的批注列表与学情里的「批注条数」**同源**
   ------------------------------------------------------------
   🔴 批注只存一份：就是行为日志里的那些 note 条目。课件页不该另建一套
      「我的批注」存储，否则两处数目对不上，谁也说不清哪个是真的。
   ⚠️ `seg` 是段落号（0 = 没挂段）。课件正文是静态 HTML，段落用 1..n 编号，
      所以批注与段落靠这个序号关联，不存正文。
   ============================================================ */

/**
 * 按课堂筛行为日志 —— 🔴 **学生自己的学情页与教师端点开学生详情，必须用同一条规则**。
 * 不收紧的话会出现这种别扭：学生在自己页面看到「提问 4 次」（只算本课），
 * 老师点开看到「提问 9 次」（算了他在别的课里的动作），两边一对质就说不清了。
 * ⚠️ 没有 courseId 的老记录（不分课）也算进每一门课，不然它们会在界面上凭空消失。
 */
function behaviorInCourse(list, courseId) {
  const id = String(courseId || "").trim();
  if (!id) return Array.isArray(list) ? list : [];
  return (Array.isArray(list) ? list : []).filter(function (e) {
    return !e.courseId || e.courseId === id;
  });
}

/** 某门课的批注，按时间倒序（courseId 传空 = 不过滤课程） */
function behaviorNotes(list, courseId) {
  const want = String(courseId || "").trim();
  return (Array.isArray(list) ? list : [])
    .filter(function (e) { return e.kind === "note" && (!want || e.courseId === want); })
    .sort(function (a, b) { return b.at - a.at; });
}

/** 某一段落有没有批注（课件页给段落加标记用） */
function hasNoteAt(list, courseId, seg) {
  const n = Number(seg) || 0;
  return behaviorNotes(list, courseId).some(function (e) { return e.seg === n; });
}

/**
 * 某一份课件的批注（第 47 轮：课件可替换，光靠段号会张冠李戴）。
 * 🔴 **没标 `cwId` 的老记录算当前这份** —— 第 47 轮之前写的记录都没有这个字段，
 *    直接按 `cwId` 严格过滤会让它们集体消失（用户会以为批注丢了）。
 *    但**标了别人 `cwId` 的必须排除**（那是另一份课件第 3 段的批注，不是这一份的）。
 */
function notesOfCw(list, cwId, courseId) {
  const want = String(cwId || "").trim();
  if (!want) return [];
  return behaviorNotes(list, courseId).filter(function (e) {
    return !e.cwId || e.cwId === want;
  });
}

/* ============================================================
   三层技能库 + 画像（第 35 轮）
   ------------------------------------------------------------
   参考 DeepTutor 的分工（`DeepTutor/deeptutor/skills/`、`deeptutor/services/persona/`）：
     · **skill**   ＝ 会做某件事的流程包（SKILL.md：frontmatter 的 name + description
                       常驻系统提示，正文按需取用）。它教的是「怎么做」。
     · **persona** ＝ 说话与讲法的预设（PERSONA.md），**每轮都要注入** ——
                       它必须从第一个字开始就影响语气。它管的是「用什么方式讲」。
   🔴 两者不许混：讲法写进 skill 会「挂载太晚」（按需取用，语气已经定了）；
      流程写进 persona 会「挤爆上下文」（每轮都注入）。这是 DeepTutor 明确划的界。

   技能按用户指定分三层：
     · 系统层 system —— 怎么用这个应用（`always: true`，每次都会挂上）
     · 群组层 group  —— 某个班 / 某门课 / 某类通用场景（**由 CLASSES / ENROLLED 真实派生**）
     · 原子层 atomic —— 最细的一件活（校对、编写、出题…）

   🔴 群组层不许是写死的分类名：教师端的「计科 2301 班」必须来自 `CLASSES`、
      学生端的「数据结构与算法 课堂」必须来自他的 `ENROLLED` —— 否则「群组」只是个装饰词。

   🔴 原子层里凡是**能算出结果的**（校对、时长加总、差异摘要、文本转表格），
      一律写成确定性的纯函数（`run`），不假装「AI 想过了」。只有真正需要模型的重活
      （起草教案、生成题目正文）才交给 LLM，且**没有 API Key 时如实说"这里需要 Key"**，
      并退化成一个可用的骨架。
   ============================================================ */

/** 三层 */
var SKILL_LAYER = {
  system: { key: "system", name: "系统层", hint: "怎么用这个应用 —— 每次都会挂上" },
  group:  { key: "group",  name: "群组层", hint: "某个班 / 某门课 / 某类通用场景" },
  atomic: { key: "atomic", name: "原子层", hint: "最细的一件活" },
};
var SKILL_LAYER_ORDER = ["system", "group", "atomic"];

/** 只读 / 会改动 —— 会改动的技能一律要过「改前确认」这道闸 */
var SKILL_KIND = {
  read:  { key: "read",  label: "只读" },
  write: { key: "write", label: "会改动" },
};

/* ------------------------------------------------------------
   ① 系统层：怎么用这个应用（always）
   ============================================================ */

var SYSTEM_SKILLS = [
  {
    id: "sys-app-map", layer: "system", always: true, kind: "read",
    role: ["teacher", "student"],
    name: "应用地图",
    desc: "这个应用有哪些页、切页是怎么发生的、当前角色能走到哪儿",
    when: "用户问「这个功能在哪」「去哪儿做 X」「你能做什么」时",
    keys: ["怎么用", "在哪", "哪个页", "哪个页面", "功能", "能做", "不能做", "导航", "干什么", "帮忙", "助手"],
    steps: [{ name: "读取当前角色的菜单", arg: "source=NAV[角色]" }],
    run: function (p, ctx) {
      const role = ctx.role === "student" ? "student" : "teacher";
      const groups = (NAV[role] || []);
      const lines = ["你是**" + (role === "student" ? "学生端" : "教师端") + "**，左栏的入口就是全部能到的地方："];
      groups.forEach(function (g) {
        const items = (g.items || []).filter(function (it) { return it.page; });
        if (!items.length) return;
        lines.push("- **" + g.title + "**：" + items.map(function (it) {
          return it.label + "（`" + it.page + (it.arg ? "?" + it.arg : "") + "`）";
        }).join("、"));
      });
      const noPage = [];
      groups.forEach(function (g) {
        (g.items || []).forEach(function (it) { if (!it.page && it.label) noPage.push(it.label); });
      });
      if (noPage.length) lines.push("- 还没做的入口（点了不会动）：" + noPage.join("、"));
      lines.push("");
      lines.push("切页是在**同一个壳**里换中间那块 `<iframe>`，不是整页跳转 —— 所以左栏不会闪、也不会丢状态。");
      lines.push("跨页的数据交接走 `st_agent_task`：别的页把任务写好再跳过来，我这边读它。");
      return { ok: true, title: "应用地图", lines: lines };
    },
  },
  {
    id: "sys-data-truth", layer: "system", always: true, kind: "read",
    role: ["teacher", "student"],
    name: "数据边界",
    desc: "哪些数字是真的（本机记录）、哪些是预置示例、存在哪里、什么时候会丢",
    when: "涉及「这数据哪来的」「准不准」「会不会上传」「怎么没了」时",
    keys: ["数据", "真的", "假的", "演示", "来源", "哪来的", "上传", "隐私", "准不准", "丢了", "清空"],
    steps: [{ name: "读本机存档的实际条数", arg: "source=localStorage" }],
    run: function (p, ctx) {
      const n = function (x) { return typeof x !== "undefined" && x ? x.length : 0; };
      const beh = (typeof BEHAVIOR !== "undefined") ? BEHAVIOR : [];
      const seedN = (typeof behaviorSeedCount === "function") ? behaviorSeedCount(beh) : 0;
      const lines = [
        "这个应用**没有服务器**，所有数据都在你**这台浏览器**里。所以能不能信，取决于它是怎么来的：",
        "",
        "**能信（本机真实记录）**",
        "- 课程 " + n(typeof COURSES !== "undefined" ? COURSES : []) + " 门、班级 " +
          n(typeof CLASSES !== "undefined" ? CLASSES : []) + " 个（`st_courses` / 内置）",
        "- 学生选课 " + n(typeof ENROLLED !== "undefined" ? ENROLLED : []) + " 条（`st_enroll`，按账号分桶）",
        "- 学习行为 " + beh.length + " 条（`st_behavior`，来自页面上的真实动作）",
        n(typeof LESSONS !== "undefined" ? LESSONS : []) ? "- 课时教案 " + n(LESSONS) + " 份、实训活动 " +
          n(ACTIVITIES || []) + " 条" : "- 实训活动 " + n(typeof ACTIVITIES !== "undefined" ? ACTIVITIES : []) + " 条",
        "",
        "**是预置的（不是真发生的）**",
        seedN ? "- 学习行为里有 " + seedN + " 条是预置示例记录" : "- 你这台机器上目前没有预置示例记录",
        "- 课表、待办、班级成绩这类没接教务系统的页面，内容也是示例",
        "",
        "**会丢的情况**：换浏览器 / 换端口 / 换机器 → 数据不跟着走；隐私模式、或「设置 → 清空本机数据」都会清掉。",
        "展示时请固定用同一个地址打开（例如 `http://127.0.0.1:8123/`），换端口等于换了个浏览器。",
      ];
      return { ok: true, title: "数据边界", lines: lines };
    },
  },
  {
    id: "sys-confirm-gate", layer: "system", always: true, kind: "write",
    role: ["teacher"],
    name: "改前确认",
    desc: "发布 / 删除 / 推送 / 覆盖类动作一律先停下来问一次；授权关掉时只给建议不动手",
    when: "动作链里出现发布、删除、推送、覆盖、批量修改时（这道闸负责插确认步）",
    keys: ["发布", "删除", "推送", "覆盖", "权限", "确认", "撤销", "批量"],
    steps: [
      { name: "识别写操作", arg: "scan=动作链里的 write 类技能" },
      { name: "等待确认", arg: "action=publish_or_delete", wait: true },
      { name: "执行或降级为建议", arg: "depends=授权开关" },
    ],
    run: function (p, ctx) {
      const w = (ctx.chain || []).filter(function (s) { return s.kind === "write"; });
      const lines = [
        "**" + w.length + " 个会改动的动作**" + (w.length ? "：" + w.map(function (s) { return s.name; }).join("、") : "（这次没有）"),
        "",
        "规则是死的，不用你记：凡是会改动数据的动作，我**一定先停下来问一次**，你点头才做。",
        ctx.allowWrite === false
          ? "⚠️ 现在「操作授权」是**关**的，所以上面这些我只给建议、不会真的动手。"
          : "现在「操作授权」是**开**的，但确认步仍然保留（授权是「允许你动手」，不是「替你点头」）。",
      ];
      return { ok: true, title: "改前确认", lines: lines };
    },
  },
];

/* ------------------------------------------------------------
   ② 群组层：某个班 / 某门课 / 某类场景
   ------------------------------------------------------------
   · 场景技能是**固定**的（写死的流程经验）
   · 「某个班」「某门课」是**派生**的（从 CLASSES / COURSES / ENROLLED）
     —— 用户要的正是这一层：分组粒度 = 他实际的班与课，不是我们编的分类
   ============================================================ */

var GROUP_SCENES = [
  {
    id: "grp-lesson-cycle", layer: "group", kind: "read", role: ["teacher"],
    name: "备课—上课—反思—改教案",
    desc: "一条完整的备课链：大纲 → 课时教案 → 上课 → 写反思 → 出改进",
    when: "用户说「备这节课」「改改教案」「上完了想改」时",
    keys: ["备课", "教案", "上课", "反思", "课时", "大纲", "改进", "这节课"],
    steps: [
      { name: "定位课程与章节", arg: "source=SYLLABUS" },
      { name: "读课时教案当前内容", arg: "source=LESSONS" },
      { name: "读这节课的反思记录", arg: "source=lessonReflects" },
      { name: "出草案或改进建议", arg: "mode=draft|improve" },
    ],
  },
  {
    id: "grp-exam-cycle", layer: "group", kind: "read", role: ["teacher"],
    name: "出题—组卷—讲评",
    desc: "圈章节、定题量与难度、成卷、课后讲评这一条链",
    when: "用户说「出题」「组卷」「讲评」「作业」时",
    keys: ["出题", "组卷", "卷子", "讲评", "作业", "考试", "题目", "难度"],
    steps: [
      { name: "圈定章节范围", arg: "source=大纲章节" },
      { name: "读该范围的知识点", arg: "source=章节 points" },
      { name: "列题位与难度分布", arg: "count=按你说的" },
      { name: "等待确认", arg: "action=publish_exam", wait: true },
    ],
  },
  {
    id: "grp-at-risk", layer: "group", kind: "read", role: ["teacher"],
    name: "学困生跟进",
    desc: "从本机行为记录里找出「反复问却一直没过」的人，给他排一条补的路线",
    when: "用户说「补差」「谁跟不上」「个别辅导」「跟进」时",
    keys: ["补差", "学困", "落后", "跟不上", "跟进", "个别", "辅导", "谁最弱"],
    steps: [
      { name: "读本机学生名单", arg: "source=localStudentAccounts" },
      { name: "读各自的行为记录", arg: "source=st_behavior:student:*" },
      { name: "定位反复受阻的话题", arg: "rule=反复问且没标懂了" },
      { name: "排版补的路线", arg: "mode=path" },
    ],
  },
  {
    id: "grp-class-mgmt", layer: "group", kind: "read", role: ["teacher"],
    name: "班级日常",
    desc: "看谁在课里、发邀请码、找还没进来的同学",
    when: "用户说「谁在课里」「邀请码」「班级」时",
    keys: ["班级", "名单", "邀请码", "谁在课", "成员", "同学"],
    steps: [
      { name: "读在课学生", arg: "source=enrolledStudentsOf" },
      { name: "算还没加入的", arg: "source=studentsNotInCourse" },
      { name: "取本课邀请码", arg: "source=joinCodeOf" },
    ],
  },
  {
    id: "grp-self-study", layer: "group", kind: "read", role: ["student"],
    name: "自学循环",
    desc: "读课件 → 提问 → 标「懂了」→ 回头补没过的那几个",
    when: "用户说「怎么学」「从哪开始」「我该学什么」时",
    keys: ["怎么学", "学什么", "从哪开始", "计划", "补", "复习", "不懂", "学不会"],
    steps: [
      { name: "读我的行为记录", arg: "source=st_behavior" },
      { name: "分「已经懂了」与「反复卡住」", arg: "rule=got vs 反复问未标懂" },
      { name: "按先修关系排顺序", arg: "source=TOPIC_PREREQ" },
    ],
  },
  {
    id: "grp-exam-prep", layer: "group", kind: "read", role: ["student"],
    name: "备考冲刺",
    desc: "把「反复卡住」的话题排成一份限时清单，配自测",
    when: "用户说「要考试了」「冲刺」「复习计划」时",
    keys: ["考试", "冲刺", "复习", "备考", "周考", "期末"],
    steps: [
      { name: "读我的薄弱话题", arg: "rule=反复问且没标懂了" },
      { name: "按次数排优先级", arg: "sort=count desc" },
      { name: "每项配一次自测", arg: "mode=quiz" },
    ],
  },
  {
    id: "grp-training", layer: "group", kind: "read", role: ["student"],
    name: "实训与探究",
    desc: "实训活动是「给路径不给答案」的：按引导骨架一步步走，走出新方向可以自己标出来",
    when: "用户说「实训」「探究」「项目」时",
    keys: ["实训", "探究", "项目", "活动", "创造"],
    steps: [
      { name: "读已发布的实训活动", arg: "source=ACTIVITIES" },
      { name: "取这条活动的引导骨架", arg: "source=skeleton.stages" },
      { name: "标出下一步该动手做什么", arg: "mode=next-step" },
    ],
  },
];

/**
 * 群组层技能 = 场景技能 + **从真实数据派生的**班 / 课技能。
 * 教师 → 每个班级一条、每门课一条；学生 → 他加入的每个课堂一条。
 */
function groupSkills(role) {
  const r = role === "student" ? "student" : "teacher";
  const scenes = GROUP_SCENES.filter(function (s) { return (s.role || []).indexOf(r) >= 0; });
  const out = scenes.slice();

  if (r === "teacher") {
    (typeof CLASSES !== "undefined" ? CLASSES : []).forEach(function (c) {
      out.push({
        id: "grp-class-" + c.id, layer: "group", kind: "read", role: ["teacher"],
        groupKey: c.id, groupType: "class",
        name: c.label,
        desc: c.major + " · " + c.grade + " · 关联课程「" + c.course + "」",
        when: "用户提到「" + c.label + "」或「" + c.id + "」时",
        keys: [c.label, c.id, c.label.replace(/\s/g, "")],
        steps: [
          { name: "读这个班的关联课程", arg: "course=" + c.course },
          { name: "读本机在课学生", arg: "rule=本机账号 × 各自选课" },
          { name: "汇总这个班的薄弱话题", arg: "rule=反复问且没标懂了" },
        ],
        run: function (p, ctx) {
          const course = (typeof COURSES !== "undefined" ? COURSES : [])
            .filter(function (x) { return x.name === c.course; })[0] || null;
          const inCourse = course && typeof enrolledStudentsOf === "function"
            ? enrolledStudentsOf(course.id) : [];
          const localAll = typeof localStudentAccounts === "function" ? localStudentAccounts() : [];
          const lines = [
            "**" + c.label + "**（" + c.major + " · " + c.grade + "）",
            "- 关联课程：" + (course ? course.name + "（" + (course.code || course.id) + "）" : c.course + "（本机还没建这门课）"),
            "- 本机在这门课里的学生：**" + inCourse.length + "** 人" +
              (inCourse.length ? "（" + inCourse.slice(0, 5).map(function (s) { return s.name; }).join("、") +
                (inCourse.length > 5 ? " 等" : "") + "）" : ""),
            "- 本机学生账号合计：" + localAll.length + " 个",
            "",
            "⚠️ 班级的**在册名单与成绩**需要教务系统，本版没有这个来源 —— 所以上面只列「本机真能查到的」人数，不按班级编数字。",
          ];
          return { ok: true, title: c.label, lines: lines };
        },
      });
    });
    (typeof COURSES !== "undefined" ? COURSES : []).forEach(function (c) {
      out.push({
        id: "grp-course-" + c.id, layer: "group", kind: "read", role: ["teacher"],
        groupKey: c.id, groupType: "course",
        name: c.name,
        desc: (c.code ? c.code + " · " : "") + (c.term || "") + " 的教学约定",
        when: "用户提到「" + c.name + "」时",
        keys: [c.name, c.code || "", c.id],
        steps: [
          { name: "读这门课的大纲与课时教案", arg: "course=" + c.id },
          { name: "读在课学生与他们的行为记录", arg: "rule=本机 × 选课" },
        ],
        run: function (p, ctx) {
          const inCourse = typeof enrolledStudentsOf === "function" ? enrolledStudentsOf(c.id) : [];
          const syl = (typeof syllabusOf === "function") ? syllabusOf(c.id) : null;
          const chapters = (syl && typeof syllabusChapters === "function") ? syllabusChapters(syl) : [];
          const lines = [
            "**" + c.name + "**" + (c.term ? "（" + c.term + "）" : ""),
            "- 邀请码：`" + (typeof joinCodeOf === "function" ? joinCodeOf(c) : "—") + "`",
            "- 大纲章节：" + (chapters.length ? chapters.length + " 章（" + chapters.map(function (x) { return x.title; }).join("、") + "）" : "还没写大纲"),
            "- 在课学生：" + inCourse.length + " 人（本机真实记录）",
          ];
          return { ok: true, title: c.name, lines: lines };
        },
      });
    });
  } else {
    (typeof ENROLLED !== "undefined" ? ENROLLED : []).forEach(function (e) {
      const nm = (typeof studentCourseName === "function") ? studentCourseName(e.courseId) : e.name;
      out.push({
        id: "grp-course-" + e.courseId, layer: "group", kind: "read", role: ["student"],
        groupKey: e.courseId, groupType: "course",
        name: nm + " 课堂",
        desc: "我加入的课堂" + (e.code ? " · " + e.code : "") + (e.by ? " · " + e.by + " 的课" : ""),
        when: "用户提到「" + nm + "」时",
        keys: [nm, e.code || "", e.courseId],
        steps: [
          { name: "读我在这个课堂的记录", arg: "course=" + e.courseId },
          { name: "分「懂了」与「卡住」", arg: "rule=got vs 反复问未标懂" },
        ],
        run: function (p, ctx) {
          const list = typeof behaviorInCourse === "function"
            ? behaviorInCourse(behaviorOf(currentUserKey()), e.courseId) : [];
          const prof = behaviorProfile(list, Date.now());
          const lines = [
            "**" + nm + " 课堂**",
            "- 我在这里的记录：" + prof.total + " 条，覆盖 " + prof.activeDays + " 天",
            "- 已经标过「懂了」：" + (prof.known.length ? prof.known.map(function (k) { return k.topic + "（" + k.got + "）"; }).join("、") : "还没有"),
            "- 反复卡住：" + (prof.gaps.length ? prof.gaps.map(function (g) { return g.topic + "（问过 " + g.count + " 次）"; }).join("、") : "没有"),
          ];
          return { ok: true, title: nm + " 课堂", lines: lines };
        },
      });
    });
  }
  return out;
}

/* ------------------------------------------------------------
   ③ 原子层：最细的一件活
   ------------------------------------------------------------
   凡是「能算出结果」的都写成确定性函数（见文件末尾的 runSkill）——
   校对、时长加总、差异摘要、文本转表格，这些不需要模型，也不该假装模型想过了。
   ============================================================ */

var ATOMIC_SKILLS = [
  {
    id: "atom-text-to-table", layer: "atomic", kind: "read", role: ["teacher"],
    name: "文本转表格",
    desc: "把粘过来的课表（任意排版的文字）转成能直接导入的标准格式",
    when: "用户粘了一段课表，说要转格式 / 导入课表时",
    keys: ["课表", "转格式", "转换", "导入", "排课", "节次", "教室"],
    steps: [
      { name: "逐行识别星期与节次", arg: "rule=星期X + 第N-M节" },
      { name: "切分课程 / 教室 / 班级", arg: "sep=逗号或空格或斜杠" },
      { name: "按标准格式输出", arg: "format=星期,节次,课程,教室,班级" },
    ],
  },
  {
    id: "atom-proofread", layer: "atomic", kind: "read", role: ["teacher", "student"],
    name: "校对",
    desc: "查重复标点、中英标点混用、多余空格、术语不统一、空字段",
    when: "用户说「校对」「检查一下有没有错」「看看格式」时",
    keys: ["校对", "检查", "错别字", "标点", "格式", "通顺", "术语"],
    steps: [
      { name: "扫标点与空白", arg: "rule=重复标点 / 多余空格" },
      { name: "对照术语表", arg: "rule=同一文本里两种叫法并存" },
      { name: "列问题清单", arg: "mode=位置 + 建议" },
    ],
  },
  {
    id: "atom-lesson-check", layer: "atomic", kind: "read", role: ["teacher"],
    name: "教案自查",
    desc: "课时时长加总对不对、六个小节有没有漏、重点与难点是不是重了",
    when: "用户说「教案有没有问题」「自查」「帮我看看哪不对」时",
    keys: ["自查", "教案", "时长", "分钟", "漏", "完整", "检查"],
    steps: [
      { name: "解析教案六个小节", arg: "source=Markdown 结构" },
      { name: "加总课堂流程时长", arg: "compare=课时长度" },
      { name: "比对重点与难点", arg: "rule=重复即提示" },
    ],
  },
  {
    id: "atom-lesson-draft", layer: "atomic", kind: "read", role: ["teacher"],
    name: "起草教案",
    desc: "按章节信息起草一份课时教案（六个标准小节）",
    when: "用户说「起草教案」「帮我写这节课」时",
    keys: ["起草", "写教案", "备课", "生成教案", "课时教案"],
    steps: [
      { name: "读章节与课时信息", arg: "source=SYLLABUS" },
      { name: "列六个小节骨架", arg: "goals/keyPoints/hardPoints/steps/homework/note" },
      { name: "需要成文的段落交给模型", arg: "requires=apiKey" },
    ],
  },
  {
    id: "atom-lesson-improve", layer: "atomic", kind: "read", role: ["teacher"],
    name: "教案改进",
    desc: "结合你上完课写的反思，给 2–3 条能直接替换文字的建议",
    when: "用户说「改改教案」「上完了想改进」时",
    keys: ["改进", "优化", "建议", "反思", "改一下", "效果不好"],
    steps: [
      { name: "读教案与最近一次反思", arg: "source=lessonReflects" },
      { name: "先用规则查硬问题", arg: "rule=时长 / 空字段 / 重复" },
      { name: "需要写成文字的建议交给模型", arg: "requires=apiKey" },
    ],
  },
  {
    id: "atom-diff-explain", layer: "atomic", kind: "read", role: ["teacher"],
    name: "版本差异解读",
    desc: "客观说清两个版本改了什么（教案 / 大纲都适用），不评价好坏",
    when: "用户说「这两版差在哪」「解释这个改动」时",
    keys: ["差异", "diff", "版本", "改了什么", "对比", "两版"],
    steps: [
      { name: "解析差异清单", arg: "source=+/- 行" },
      { name: "按小节归纳", arg: "mode=新增/删除/改写" },
      { name: "只陈述，不评价", arg: "rule=客观" },
    ],
  },
  {
    id: "atom-outline-order", layer: "atomic", kind: "read", role: ["teacher"],
    name: "大纲编排",
    desc: "查章节跳号、课时数与计划是否对得上、有没有空标题",
    when: "用户说「大纲」「章节顺序」「编排」时",
    keys: ["大纲", "章节", "顺序", "编排", "跳号", "课时数"],
    steps: [
      { name: "读当前大纲版本", arg: "source=syllabusChapters" },
      { name: "查编号连不连得上", arg: "rule=跳号即提示" },
      { name: "比对计划课时与已写教案", arg: "rule=差额提示" },
    ],
  },
  {
    id: "atom-gen-quiz", layer: "atomic", kind: "write", role: ["teacher"],
    name: "出题",
    desc: "按范围列题位与难度分布，成卷与发布仍在「出题与组卷」页审核",
    when: "用户说「出题」「来几道题」时",
    keys: ["出题", "道题", "一道题", "几道题", "来几道", "题目", "自测题", "练习题", "做题", "考考"],
    steps: [
      { name: "圈定范围与题量", arg: "source=你说的话" },
      { name: "列题位与考点来源", arg: "mode=题位表" },
      { name: "等待确认", arg: "action=publish_exam", wait: true },
      { name: "到出题页逐题审核", arg: "target=exam.html" },
    ],
  },
  {
    id: "atom-rubric", layer: "atomic", kind: "read", role: ["teacher"],
    name: "评分标准",
    desc: "按这节课的重点与难点，出一份分档的评分维度表",
    when: "用户说「评分标准」「rubric」「怎么判分」时",
    keys: ["评分", "标准", "rubric", "判分", "打分", "给分"],
    steps: [
      { name: "取教学重点与难点", arg: "source=教案" },
      { name: "排分档维度", arg: "levels=优秀/合格/待改进" },
    ],
  },
  {
    id: "atom-diagnose", layer: "atomic", kind: "read", role: ["student"],
    name: "定位薄弱",
    desc: "从你本机的提问与批注里，找出反复卡住的话题",
    when: "用户说「我哪块最弱」「哪里不行」时",
    keys: ["最弱", "薄弱", "不行", "哪里不会", "卡住", "学不懂"],
    steps: [
      { name: "读我的行为记录", arg: "source=st_behavior" },
      { name: "算反复受阻的话题", arg: "rule=问 ≥2 次且没标懂了" },
      { name: "排优先级", arg: "sort=次数" },
    ],
  },
  {
    id: "atom-analogy", layer: "atomic", kind: "read", role: ["student"],
    name: "类比讲解",
    desc: "从你已经懂的话题类比到你想懂的那个，一步步铺过去",
    when: "用户说「换个方式讲」「用我懂的类比」「听不明白」时",
    keys: ["类比", "换个方式", "讲不懂", "听不懂", "用我懂的", "举个例子", "再讲一遍"],
    steps: [
      { name: "读我的画像与已知话题", arg: "source=persona + st_behavior" },
      { name: "找先修关系", arg: "source=TOPIC_PREREQ" },
      { name: "按先修链逐段铺", arg: "mode=从会到想会" },
    ],
  },
  {
    id: "atom-gen-exercise", layer: "atomic", kind: "read", role: ["student"],
    name: "生成自测",
    desc: "按你卡住的话题出一道自测，答完当场记进行为记录",
    when: "用户说「考考我」「来道题」「自测」时",
    keys: ["自测", "考考我", "来道题", "练习一下", "测一测"],
    steps: [
      { name: "选题材", arg: "source=薄弱话题优先" },
      { name: "出题并给判定点", arg: "mode=单题" },
      { name: "答完记进行为记录", arg: "source=logBehavior(quiz)" },
    ],
  },
];

/* ------------------------------------------------------------
   取技能 / 路由
   ============================================================ */

/** 全部技能（含派生的群组层） */
function allSkills(role) {
  return SYSTEM_SKILLS.concat(groupSkills(role), ATOMIC_SKILLS);
}

/**
 * 按角色取技能（**已按角色过滤**）。
 * 🔴 学生端拿到的必须全是 `kind: "read"` —— 教师端的发布/删除类技能一条都不许漏进去。
 *    验证器就是拿这个函数断言「学生端没有写操作」的。
 */
function roleSkills(role) {
  const r = role === "student" ? "student" : "teacher";
  return allSkills(r).filter(function (s) { return (s.role || []).indexOf(r) >= 0; });
}

/** 按 id 找技能；找不到返回 null */
function skillOf(id, role) {
  return allSkills(role).filter(function (s) { return s.id === id; })[0] || null;
}

/**
 * 命中打分：命中的关键词**字符总长**（不是命中个数）——
 * 「课表」比「表」值钱，「校对」比「对」值钱（与实训路径库同一套打分口径）。
 */
function skillScore(sk, q) {
  return (sk.keys || []).reduce(function (n, k) {
    const key = String(k || "").toLowerCase();
    return n + (key && q.indexOf(key) >= 0 ? key.length : 0);
  }, 0);
}

/**
 * 路由：一句话 → 该挂哪些技能。
 * · 系统层 **always** 全挂（怎么用这个应用，任何话题都可能要）
 * · 群组层：命中的排前面，**没命中就给"当前上下文"的那条**（当前课程 / 当前班级）——
 *   用户没点名也要知道自己在哪个班、哪门课的语境里
 * · 原子层：命中才挂（一件细活，没提就别挂）
 * 返回 { system, group, atomic, chain }；每条都带 `hit`（命中了哪些词）便于界面解释。
 */
function routeSkills(text, opts) {
  const o = opts || {};
  const role = o.role === "student" ? "student" : "teacher";
  const q = String(text == null ? "" : text).toLowerCase().trim();

  const mark = function (sk) {
    const sk2 = Object.assign({}, sk);
    sk2.hit = (sk.keys || []).filter(function (k) {
      return k && q.indexOf(String(k).toLowerCase()) >= 0;
    });
    sk2.score = skillScore(sk, q);
    return sk2;
  };

  // 🔴 只从**开着的**技能里挑（`activeSkills` = roleSkills 再过一道开关）。
  //    被关掉的技能不是"删掉"了：它还在左栏那棵树里，随时能打开（见 skillEnabled）。
  const pool = activeSkills(role);
  const byLayer = function (L) { return pool.filter(function (s) { return s.layer === L; }); };

  const system = byLayer("system").map(mark);

  const groups = byLayer("group").map(mark).filter(function (s) { return s.score > 0; })
    .sort(function (a, b) { return b.score - a.score || (a.id < b.id ? -1 : 1); })
    .slice(0, 2);

  // 群组层兜底：没点名也要挂"你正处的语境"
  if (!groups.length) {
    const ctxKey = role === "student"
      ? (typeof ENROLLED !== "undefined" && ENROLLED[0] ? ENROLLED[0].courseId : "")
      : (o.courseId || (typeof COURSES !== "undefined" && COURSES[0] ? COURSES[0].id : ""));
    const ctxSkill = byLayer("group").filter(function (s) {
      return s.groupType === "course" && s.groupKey === ctxKey;
    })[0];
    if (ctxSkill) {
      const m = mark(ctxSkill);
      m.fallback = true;                 // 界面据此写"按当前课堂/班级选中"
      groups.push(m);
    }
  }

  const atomic = byLayer("atomic").map(mark).filter(function (s) { return s.score > 0; })
    .sort(function (a, b) { return b.score - a.score || (a.id < b.id ? -1 : 1); })
    .slice(0, 3);

  // 本来会命中、却被你关掉的（界面要能解释"这次为什么没挂它"）—— 不含系统层，它不靠命中
  const offHit = roleSkills(role).filter(function (s) {
    return !skillEnabled(s.id) && s.layer !== "system" && skillScore(s, q) > 0;
  }).map(function (s) { return { id: s.id, name: s.name, layer: s.layer }; });

  const chain = system.concat(groups, atomic);
  return {
    role: role, query: q, system: system, group: groups, atomic: atomic, chain: chain,
    offHit: offHit, offCount: disabledSkillCount(role),
  };
}

/** 这条链里有没有"会改动"的技能（教师端据此决定要不要插确认步） */
function chainHasWrite(chain) {
  return (chain || []).some(function (s) { return s.kind === "write"; });
}

/* ------------------------------------------------------------
   ④ 解析与检查 —— 能算出来的就别交给模型
   ------------------------------------------------------------
   这些全是纯函数：输入一段文本（或一个结构化 payload），输出确定的结果。
   好处有两个：页面渲染只是"把结果排出来"；验证器可以直接喂样例断言结果。
   ============================================================ */

/** 术语表：同一份文本里两种叫法并存的，提示统一（只提示，不擅自改） */
var TERM_PAIRS = [
  ["快排", "快速排序"], ["最短路径", "最短路"], ["哈希", "散列"],
  ["二叉树", "二元树"], ["遍历", "周游"], ["时间复杂度", "时间开销"],
];

/** 星期与节次的识别（中文课表的两种常见写法都认） */
var RE_DAY = /(周[一二三四五六日天]|星期[一二三四五六日天])/;
var RE_SEC = /第\s*\d+(?:\s*[-–~至]\s*\d+)?\s*节/;

/**
 * 把任意排版的课表文字，尽量解析成「星期,节次,课程,教室,班级」。
 * 🔴 认不出来的行**原样留下**（放进 `bad`），不猜、不丢 ——
 *    猜错一行课表比拒答一行代价大得多。
 */
function parseScheduleText(text) {
  const raw = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
  const lines = raw.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
  const rows = [], grid = [], bad = [];
  lines.forEach(function (l) {
    // 制表符 / 多空格分隔的二维表：整行留下，交给页面上原有的二维表导入
    if (l.indexOf("\t") >= 0 || /\s{2,}/.test(l)) { grid.push(l.split(/\t|\s{2,}/).map(function (s) { return s.trim(); })); return; }
    const d = RE_DAY.exec(l), s = RE_SEC.exec(l);
    if (!d || !s) { bad.push(l); return; }
    const rest = l.replace(d[0], " ").replace(s[0], " ")
      .replace(/^[,，、;；\s]+/, "").trim();
    const parts = rest.split(/[,，、;；\/\s]+/).filter(Boolean);
    rows.push({
      day: d[0].replace("星期", "周"),
      section: s[0].replace(/\s+/g, ""),
      course: parts[0] || "",
      room: parts[1] || "",
      klass: parts[2] || "",
      from: l,
    });
  });
  return { rows: rows, grid: grid, bad: bad, total: lines.length };
}

/** 解析教案的 Markdown（结构就是 lesson.html 的 lessonToText 产出的那六个小节） */
function parseLessonText(md) {
  const lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
  const out = { title: "", course: "", minutes: 0, goals: "", keyPoints: [], hardPoints: [], steps: [], homework: "", note: "", sections: [] };
  let cur = "";
  lines.forEach(function (l) {
    const h1 = /^#\s+(.*)$/.exec(l);
    const h2 = /^##\s+(.*)$/.exec(l);
    if (h1) { if (!out.title) out.title = h1[1].trim(); return; }
    if (h2) { cur = h2[1].trim(); out.sections.push(cur); return; }
    const m = /^课程：(.*?)　?课时长度：\s*(\d+)\s*分钟/.exec(l.trim());
    if (m) { out.course = m[1].trim(); out.minutes = Number(m[2]) || 0; return; }
    const t = l.trim();
    if (!t) return;
    if (cur === "教学目标") out.goals += (out.goals ? "\n" : "") + t;
    else if (cur === "教学重点") { if (t.indexOf("- ") === 0) out.keyPoints.push(t.slice(2).trim()); }
    else if (cur === "教学难点") out.hardPoints.push(t.replace(/^-\s*/, "").trim());
    else if (cur === "课堂流程") {
      const sm = /^-\s*(.*?)(?:（(\d+)\s*分钟）)?：\s*(.*)$/.exec(t);
      if (sm) out.steps.push({ t: sm[1].trim(), min: sm[2] ? Number(sm[2]) : 0, d: sm[3].trim() });
    }
    else if (cur === "作业布置") out.homework += (out.homework ? "\n" : "") + t;
    else if (cur === "学情提示") out.note += (out.note ? "\n" : "") + t;
  });
  return out;
}

/** 教案自查：能确定判断的先查掉，剩下的才轮到模型 */
function lintLesson(les) {
  const L = les || {};
  const issues = [];
  const blank = function (x) { return !x || /^（?\s*(未填写|无|待补充)\s*）?$/.test(String(x).trim()); };
  const sum = (L.steps || []).reduce(function (n, s) { return n + (Number(s.min) || 0); }, 0);
  const noMin = (L.steps || []).filter(function (s) { return !Number(s.min); });

  if (L.minutes && sum && Math.abs(sum - L.minutes) > 2) {
    issues.push({
      level: "warn", where: "课堂流程",
      text: "各步时长加起来是 " + sum + " 分钟，与课时长度 " + L.minutes + " 分钟差 " + (sum - L.minutes) + " 分钟",
    });
  }
  if (noMin.length) {
    issues.push({ level: "info", where: "课堂流程", text: "有 " + noMin.length + " 步没写时长：" + noMin.map(function (s) { return s.t || "（未命名）"; }).join("、") });
  }
  const need = [["教学目标", L.goals], ["教学重点", (L.keyPoints || []).join("")], ["教学难点", (L.hardPoints || []).join("")],
                ["课堂流程", (L.steps || []).length ? "有" : ""], ["作业布置", L.homework], ["学情提示", L.note]];
  need.forEach(function (pair) {
    if (blank(pair[1])) issues.push({ level: "warn", where: pair[0], text: "这一节还是空的" });
  });
  const dup = (L.keyPoints || []).filter(function (k) {
    return (L.hardPoints || []).some(function (h) { return h && (h === k || h.indexOf(k) >= 0 || k.indexOf(h) >= 0); });
  });
  if (dup.length) issues.push({ level: "info", where: "教学重点/难点", text: "这两节有重合：" + dup.join("、") + "（难点通常应是「学生为什么卡」，不是再写一遍重点）" });
  if ((L.steps || []).length && (L.steps || []).length < 3) {
    issues.push({ level: "info", where: "课堂流程", text: "只有 " + L.steps.length + " 步，一堂课的流程通常会更细" });
  }
  return { issues: issues, sum: sum, minutes: L.minutes || 0 };
}

/** 通用的文字校对（标题、教案、任意粘贴进来的段落都能用） */
function lintText(text) {
  const src = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const out = [];
  lines.forEach(function (l, i) {
    const n = i + 1;
    const dupP = /([。，、；：！？])\1+/.exec(l) || /([,.;:!?])\1+/.exec(l);
    if (dupP) out.push({ level: "warn", line: n, text: "重复标点「" + dupP[0] + "」" });
    const sp = /  +/.exec(l);
    if (sp) out.push({ level: "info", line: n, text: "连续空格（中文里通常不需要）" });
    if (/\s$/.test(l)) out.push({ level: "info", line: n, text: "行尾有多余空格" });
    if (/[，。；：]/.test(l) && /[,;:]/.test(l.replace(/[A-Za-z]|\d/g, ""))) {
      out.push({ level: "info", line: n, text: "这一行里中文标点和英文标点混用了，建议统一" });
    }
    if (/（\s*(未填写|无|待补充)\s*）|^\s*$/.test(l) && /待补充|未填写/.test(l)) {
      out.push({ level: "info", line: n, text: "有「（待补充）」占位 —— 交出去之前记得补上" });
    }
  });
  TERM_PAIRS.forEach(function (pair) {
    if (src.indexOf(pair[0]) >= 0 && src.indexOf(pair[1]) >= 0) {
      out.push({ level: "info", line: 0, text: "同一份里「" + pair[0] + "」和「" + pair[1] + "」都出现了，建议统一成一种" });
    }
  });
  return out;
}

/** 解析 diff（lesson.html 的 diffToText 产出的结构） */
function parseDiffText(md) {
  const lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
  const groups = [];
  let cur = null;
  lines.forEach(function (l) {
    const h = /^##\s+(.*)$/.exec(l);
    if (h) { cur = { field: h[1].trim(), add: 0, del: 0, chg: 0, keep: 0, samples: [] }; groups.push(cur); return; }
    if (!cur) return;
    const t = l;
    if (/^\+\s/.test(t)) { cur.add++; if (cur.samples.length < 2) cur.samples.push("新增：" + t.slice(2).trim()); }
    else if (/^-\s/.test(t)) { cur.del++; if (cur.samples.length < 2) cur.samples.push("删除：" + t.slice(2).trim()); }
    else if (/^\s\s\S/.test(t)) { cur.keep++; }
    else if (t.trim()) { cur.chg++; if (cur.samples.length < 2) cur.samples.push("改写：" + t.trim()); }
  });
  return groups.filter(function (g) { return g.add || g.del || g.chg; });
}

/* ------------------------------------------------------------
   ⑤ 各技能的确定性执行器
   ------------------------------------------------------------
   返回统一形状：`{ ok, title, lines[], note?, steps? }` —— 页面只负责排。
   🔴 需要模型才能做的（把骨架写成成文的教案 / 题目正文 / 改进建议的话术），
      一律**如实说明需要 API Key**，并退化成一个真能用的骨架，不假装已经生成。
   ============================================================ */

/** 本机有没有配 API Key（纯静态站的 AI 能力全靠它） */
function hasApiKey() {
  // 自定义接口可能不需要 Key（本地服务），所以先问「是不是已经能用了」
  try { if (llmReady()) return true; } catch (_) {}
  // 🔴 走 readKeyValue 兼容两种落库方式（见它的说明）—— 别再裸读
  const k = (typeof STORE_KEY !== "undefined" && STORE_KEY.apiKey) ? STORE_KEY.apiKey : "st_api_key";
  return !!String(readKeyValue(k)).trim();
}

/** 没有 Key 时统一的那句话（每处都要说，别让用户以为"AI 已经做完了"） */
function noKeyNote() {
  return "这部分需要模型成文：到「设置 → 模型与 API Key」填上自己的 Key，我会直接把成稿给你；" +
    "现在先给你一份**结构完整的骨架**，可以照着填。";
}

/* ------------------------------------------------------------
   🔴 第 57 轮：把「需要模型成文」的技能真的接到模型上
   ------------------------------------------------------------
   此前这几个技能只给规则骨架，note 里写「配了 Key 我可以…」—— 但**没有任何一处真的调用模型**。
   现在补齐这条链路：接了模型就**当场生成**；没接模型照旧给骨架并如实说明。
   铁律不变：未接模型**绝不返回假内容** —— `aiRunner()` 直接返回 null，调用方回落骨架。
   ============================================================ */

/** 把模型返回的 Markdown 拆成行数组 —— 与 `renderLines()` 的输入形状一致 */
function mdLines(raw) {
  return String(raw == null ? "" : raw).replace(/\r\n?/g, "\n").split("\n");
}

/**
 * 调一次模型并映射成技能结果形状 `{ok, title, lines, note}`。
 * 🔴 未接模型（没选服务商 / 没填 Key）→ 返回 **null**，调用方回落规则骨架并说明原因。
 * @param {string} system 系统提示词（交接任务带的 `prompt` 优先于内置）
 * @param {string} user   用户内容（为空则不浪费调用）
 * @param {(raw:string, r:object) => object} mapFn 把模型输出映射成技能结果
 */
function aiRunner(system, user, mapFn, opt) {
  if (typeof llmReady !== "function" || !llmReady()) return null;
  if (!String(user || "").trim()) return null;
  return llmChat(system, user, opt || {}).then(function (r) {
    if (!r.ok) return { ok: false, error: r.error + (r.hint ? "　" + r.hint : "") };
    try { return mapFn(String(r.raw || ""), r); }
    catch (e) { return { ok: false, error: "模型返回的内容没法用：" + e.message }; }
  });
}

/** 四个「要成文」的技能共用的系统提示词（交接任务带了 `prompt` 就用它） */
var AI_SYS = {
  "lesson-draft":
    "你是高校教师的备课助手。据我给的章节信息起草**一份课时教案**，用 Markdown 输出，" +
    "含六个小节：教学目标 / 教学重点（列表）/ 教学难点 / 课堂流程（每步写成「标题（分钟）：说明」）/ 作业布置 / 学情提示。" +
    "要求：紧扣本章知识点，课时长度按我给的信息；不要编造教材里没有的内容；信息不足处写「（待补充）」而不是臆测。",
  "lesson-improve":
    "你是高校教学改进顾问。据我给的教案与课后反思，给出 **2–3 条具体可执行的改进建议**，" +
    "每条说清「改哪个小节 → 改成什么 → 为什么」，用 Markdown 列表输出。" +
    "建议要落到能直接替换的文字上；反思信息不足就直说，不要编造。",
  "diff-explain":
    "下面是我给的两个版本的内容差异（+ 为新增、- 为删除）。" +
    "请用 2–4 句话**客观**解读：这一版主要改了什么、可能的教学意图是什么。不要评价好坏。",
  "schedule-parse":
    "你是课表格式转换助手。把我给你的课表内容转成标准格式，**只输出结果，不要解释**。\n" +
    "格式一（逐行，每行一节课）：星期,节次,课程,教室,班级\n" +
    "例：周一,第1-2节,数据结构与算法,6A-301,计科2301\n" +
    "格式二（二维表，制表符分隔）：首行是星期表头；之后每行第一格是节次名；" +
    "单元格内写「课程/教室/班级」，用斜杠分隔，缺失可省略。\n" +
    "认不出来的行原样保留，不要猜。",
};

var SKILL_RUNNERS = {
  /* ---------- 课表：文本转标准格式 ---------- */
  "atom-text-to-table": function (p, ctx) {
    const parsed = parseScheduleText(p.text || "");
    const lines = [];
    if (!parsed.total) {
      return { ok: true, title: "文本转表格", lines: ["你还没有粘课表内容 —— 把教务系统里那段课表原样贴进来就行，什么排版都行。"] };
    }
    lines.push("从 " + parsed.total + " 行里认出 **" + parsed.rows.length + " 节课**" +
      (parsed.grid.length ? "、" + parsed.grid.length + " 行二维表" : "") +
      (parsed.bad.length ? "，" + parsed.bad.length + " 行没认出来" : "") + "。");
    if (parsed.rows.length) {
      const byDay = {};
      parsed.rows.forEach(function (r) { byDay[r.day] = (byDay[r.day] || 0) + 1; });
      lines.push("分布：" + Object.keys(byDay).map(function (d) { return d + " " + byDay[d] + " 节"; }).join(" · "));
      lines.push("");
      lines.push("**格式一（逐行，可直接导入）**");
      lines.push("```text");
      parsed.rows.forEach(function (r) {
        lines.push([r.day, r.section, r.course, r.room, r.klass].join(","));
      });
      lines.push("```");
      const lack = parsed.rows.filter(function (r) { return !r.room || !r.klass; });
      if (lack.length) lines.push("⚠️ 有 " + lack.length + " 节课缺教室或班级 —— 导入时那一栏留空即可，我没有替你补。");
    }
    if (parsed.grid.length) {
      lines.push("");
      lines.push("**识别为二维表的部分**（制表符/多空格分隔，保持原样）：");
      lines.push("```text");
      parsed.grid.slice(0, 8).forEach(function (row) { lines.push(row.join("\t")); });
      lines.push("```");
    }
    if (parsed.bad.length) {
      lines.push("");
      lines.push("**这几行我没认出来**（缺星期或缺节次）—— 原样列在下面，你改一改再粘一次：");
      lines.push("```text");
      parsed.bad.slice(0, 8).forEach(function (l) { lines.push(l); });
      lines.push("```");
    }
    const ruleResult = {
      ok: true, title: "文本转表格", lines: lines,
      note: "规则解析只做**有把握的**转换：认不出来的行我没有猜。",
    };
    // 🔴 有搞不定的行（或整段没认出来）且接了模型 → 交给模型转格式（「让 AI 帮你转」的正解）
    if (parsed.bad.length || (!parsed.rows.length && !parsed.grid.length)) {
      const ai = aiRunner(
        (p.prompt && String(p.prompt).trim()) || AI_SYS["schedule-parse"],
        String(p.text || "") + (parsed.bad.length
          ? "\n\n（以下几行规则没认出来，请重点处理）\n" + parsed.bad.join("\n") : ""),
        function (raw) {
          return {
            ok: true, title: "课表解析（模型）", lines: mdLines(raw),
            note: "上面是模型转出来的标准格式。⚠️ 课表猜错的代价高 —— 点「回到课表页导入」之后、" +
              "确认导入之前，请自己核一遍。",
          };
        });
      if (ai) return ai;
    }
    return ruleResult;
  },

  /* ---------- 校对 ---------- */
  "atom-proofread": function (p) {
    const text = p.text || p.lesson || "";
    const hits = lintText(text);
    const lines = [];
    if (!String(text).trim()) return { ok: true, title: "校对", lines: ["没有拿到要校对的内容。"] };
    const nWarn = hits.filter(function (h) { return h.level === "warn"; }).length;
    lines.push("扫了 " + String(text).split("\n").length + " 行，发现 **" + hits.length + " 处**" +
      (nWarn ? "（其中 " + nWarn + " 处建议改）" : "") + "。");
    if (!hits.length) return { ok: true, title: "校对", lines: lines.concat(["标点、空格、术语都没查出问题。"]) };
    lines.push("");
    hits.slice(0, 14).forEach(function (h) {
      lines.push("- " + (h.line ? "第 " + h.line + " 行：" : "全文：") + h.text);
    });
    if (hits.length > 14) lines.push("- …还有 " + (hits.length - 14) + " 处");
    return {
      ok: true, title: "校对", lines: lines,
      note: "规则只能查形式问题（标点、空格、术语一致）。**语句是否通顺、表达是否准确**要看内容，配了 Key 我可以逐句过一遍。",
    };
  },

  /* ---------- 教案自查 ---------- */
  "atom-lesson-check": function (p) {
    const les = parseLessonText(p.text || "");
    const r = lintLesson(les);
    const lines = ["解析出 " + (les.sections.length || 0) + " 个小节：" +
      (les.sections.join(" / ") || "（没识别到 —— 教案正文里应该有 ## 教学目标 这类标题）")];
    if (les.title) lines[0] = "**" + les.title + "**　" + lines[0];
    lines.push("");
    if (!r.issues.length) lines.push("逐项查过：时长对得上、六个小节都在、重点与难点没重复。");
    else r.issues.forEach(function (i) { lines.push("- [" + (i.level === "warn" ? "建议改" : "提示") + "] **" + i.where + "**：" + i.text); });
    if (r.minutes) lines.push("", "（课堂流程合计 " + r.sum + " 分钟 / 课时长度 " + r.minutes + " 分钟）");
    return { ok: true, title: "教案自查", lines: lines };
  },

  /* ---------- 起草教案：无 Key 给真骨架 ---------- */
  "atom-lesson-draft": function (p, ctx) {
    const hours = p.hours || "";
    const points = String(p.points || "").trim();
    const chTitle = p.chapterTitle || p.chapterId || "（未指定章节）";
    const lines = [
      "给「**" + chTitle + "**」起一份课时教案" + (hours ? "（计划 " + hours + " 课时）" : "") + "。",
      "",
      "六个小节我按标准结构搭好了：",
      "```markdown",
      "# " + chTitle + " · 课时教案",
      "课程：（待补充）　课时长度：" + (hours ? "（按你的课时安排）" : "（待补充）") + " 分钟",
      "",
      "## 教学目标",
      points ? "（依据本章知识点：" + points + " —— 需要写成 2–3 条可检验的目标）" : "（待补充）",
      "",
      "## 教学重点", "- （待补充）", "",
      "## 教学难点", "（待补充）", "",
      "## 课堂流程",
      "- 导入（5 分钟）：（用一个具体问题引出本章的矛盾点）",
      "- 讲解（20 分钟）：（把重点拆成 2–3 步，每步配一个例子）",
      "- 练习（12 分钟）：（针对难点设计一道人人要动手的题）",
      "- 小结（3 分钟）：（让学生自己说一遍今天解决了什么）",
      "",
      "## 作业布置", "（待补充）", "",
      "## 学情提示", "（待补充）",
      "```",
      "",
      "⚠️ 上面**只有结构是我的**：导入/讲解/练习/小结的分段是通用骨架，具体内容一个字都没替你编。",
    ];
    const skeleton = {
      ok: true, title: "起草教案", lines: lines, note: noKeyNote(),
    };
    const ai = aiRunner(
      (p.prompt && String(p.prompt).trim()) || AI_SYS["lesson-draft"],
      [
        "课程章节：" + chTitle,
        hours ? "计划课时：" + hours : "",
        points ? "本章核心知识点：" + points : "",
        "",
        "请按六个小节的结构写一份完整的课时教案。",
      ].filter(Boolean).join("\n"),
      function (raw) {
        return {
          ok: true, title: "起草教案（模型生成）", lines: mdLines(raw),
          note: "上面是模型按标准结构写出来的完整教案。⚠️ 请核对知识点与课时安排后再存进课时教案。",
        };
      });
    return ai || skeleton;
  },

  /* ---------- 教案改进：先给硬问题，成文建议需要 Key ---------- */
  "atom-lesson-improve": function (p) {
    const les = parseLessonText(p.text || "");
    const r = lintLesson(les);
    const refl = p.reflect || {};
    const lines = ["先按规则把**能确定的问题**挑出来（这部分不需要模型）："];
    if (r.issues.length) r.issues.forEach(function (i) { lines.push("- **" + i.where + "**：" + i.text); });
    else lines.push("- 时长、小节完整性、重点难点重复 —— 都没查出问题。");
    lines.push("");
    if (refl.saw || refl.todo) {
      lines.push("你这次课后的反思：");
      if (refl.saw) lines.push("- 看到的：" + refl.saw);
      if (refl.todo) lines.push("- 想改的：" + refl.todo);
      lines.push("");
    } else {
      lines.push("这节课还没有反思记录 —— 建议先在课时教案里写两句「课堂观察 / 下次改进」，" +
        "有了它，改进建议才有的放矢（不然只能给通用建议）。");
      lines.push("");
    }
    lines.push("**建议落到哪几处**（先定位，再改文字）：");
    const spots = [];
    if (!String(les.homework || "").trim() || /待补充|未填写/.test(String(les.homework))) spots.push("作业布置 —— 现在是空的，先定「练什么」");
    if (r.minutes && r.sum && Math.abs(r.sum - r.minutes) > 2) spots.push("课堂流程 —— 时长分配与课时长度不匹配，先调时间再调内容");
    if (!(les.steps || []).length || les.steps.length < 3) spots.push("课堂流程 —— 步骤太粗，建议拆到 4–6 步");
    if (!spots.length) spots.push("教学目标 —— 可写成更可检验的行为动词（说明/推导/实现…）");
    spots.forEach(function (s, i) { lines.push((i + 1) + ". " + s); });
    const ruleResult = { ok: true, title: "教案改进", lines: lines, note: noKeyNote() };
    const reflBlock = (refl && (refl.saw || refl.todo))
      ? "\n\n## 我上完这节课后的反思\n课堂观察：" + (refl.saw || "（无）") +
        "\n下次改进：" + (refl.todo || "（无）")
      : "";
    const ai = aiRunner(
      (p.prompt && String(p.prompt).trim()) || AI_SYS["lesson-improve"],
      String(p.text || "") + reflBlock,
      function (raw) {
        return {
          ok: true, title: "教案改进（模型建议）", lines: mdLines(raw),
          note: "上面是模型按你的反思给出的改进建议。采纳后作为新版本提交，原版本仍留在版本历史里。",
        };
      });
    return ai || ruleResult;
  },

  /* ---------- 版本差异解读 ---------- */
  "atom-diff-explain": function (p) {
    const groups = parseDiffText(p.text || "");
    const lines = [];
    if (!groups.length) {
      return { ok: true, title: "版本差异解读", lines: ["这两版之间**没有实质性差异**（看到的都是相同的行）。"] };
    }
    const totalAdd = groups.reduce(function (n, g) { return n + g.add; }, 0);
    const totalDel = groups.reduce(function (n, g) { return n + g.del; }, 0);
    const totalChg = groups.reduce(function (n, g) { return n + g.chg; }, 0);
    lines.push("这两版涉及 **" + groups.length + " 个小节**：新增 " + totalAdd + " 行、删除 " + totalDel +
      " 行" + (totalChg ? "、改写 " + totalChg + " 处" : "") + "。");
    lines.push("");
    groups.forEach(function (g) {
      const bits = [];
      if (g.add) bits.push("新增 " + g.add);
      if (g.del) bits.push("删除 " + g.del);
      if (g.chg) bits.push("改写 " + g.chg);
      lines.push("- **" + g.field + "**：" + bits.join(" · "));
      g.samples.forEach(function (s) { lines.push("  - " + s); });
    });
    const ruleResult = {
      ok: true, title: "版本差异解读", lines: lines,
      note: "这里只做**客观归纳**（哪一节动了、动了几行）。",
    };
    const ai = aiRunner(
      (p.prompt && String(p.prompt).trim()) || AI_SYS["diff-explain"],
      String(p.text || ""),
      function (raw) {
        return {
          ok: true, title: "版本差异解读（模型）", lines: mdLines(raw),
          note: "上面是模型对这次改动的解读 —— 仅供参考，教学意图以你自己为准。",
        };
      });
    return ai || ruleResult;
  },

  /* ---------- 大纲编排 ---------- */
  "atom-outline-order": function (p, ctx) {
    const courseId = p.courseId || ctx.courseId || "";
    const syl = (typeof syllabusOf === "function") ? syllabusOf(courseId) : null;
    const chapters = (syl && typeof syllabusChapters === "function") ? syllabusChapters(syl) : [];
    const lines = [];
    if (!chapters.length) {
      return { ok: true, title: "大纲编排", lines: ["这门课还没有大纲 —— 到「教案」页先加两章，我再来帮你查顺序。"] };
    }
    lines.push("「" + ((typeof courseName === "function") ? courseName(courseId) : courseId) + "」大纲共 **" +
      chapters.length + " 章**。");
    lines.push("");
    const nums = [];
    chapters.forEach(function (c, i) {
      const m = /第\s*(\d+)\s*章/.exec(c.title || "");
      nums.push(m ? Number(m[1]) : 0);
      const ls = (typeof lessonsOfChapter === "function") ? lessonsOfChapter(c) : [];
      const gap = c.hours && ls.length < Number(c.hours);
      lines.push("- " + (i + 1) + ". **" + (c.title || "（未命名章节）") + "**" +
        (c.hours ? "　计划 " + c.hours + " 课时" : "") +
        "　已写教案 " + ls.length + " 份" +
        (gap ? " ⚠️ 还差 " + (Number(c.hours) - ls.length) + " 份" : ""));
    });
    const bad = [];
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] && nums[i - 1] && nums[i] !== nums[i - 1] + 1) bad.push("第 " + nums[i - 1] + " 章 → 第 " + nums[i] + " 章");
    }
    const unnamed = chapters.filter(function (c) { return !String(c.title || "").trim(); }).length;
    lines.push("");
    if (!bad.length && !unnamed) lines.push("章节编号是连续的，没有空标题。");
    else {
      if (bad.length) lines.push("⚠️ 编号不连续：" + bad.join("、") + "（中间断了，学生会以为漏发了一章）");
      if (unnamed) lines.push("⚠️ 有 " + unnamed + " 章没有标题");
    }
    return { ok: true, title: "大纲编排", lines: lines };
  },

  /* ---------- 出题（题位表） ---------- */
  "atom-gen-quiz": function (p) {
    const points = String(p.points || "").split(/[、,，;；]\s*/).filter(Boolean);
    const n = Number(p.count) || 8;
    // 🔴 题型从 EXAM_QTYPES 取 —— 与「出题与组卷」页同一份来源，别再在这里写死一张表
    const quizTypes = (typeof EXAM_QTYPES !== "undefined" && EXAM_QTYPES.length)
      ? EXAM_QTYPES.map(function (t) { return t.label; })
      : ["单选", "多选", "填空", "简答"];
    const lines = ["按你说的量（**" + n + " 题**）先排一张**题位表** —— 题目正文要么你自己出，要么配 Key 让我出：",
      "", "| # | 题型 | 考点来源 | 难度 |", "|---|---|---|---|"];
    for (let i = 1; i <= Math.min(n, 12); i++) {
      const src = points.length ? points[(i - 1) % points.length] : "（先圈章节，我才能定考点）";
      const type = quizTypes[(i - 1) % quizTypes.length];
      const diff = i <= n * 0.4 ? "基础" : (i <= n * 0.8 ? "中等" : "综合");
      lines.push("| " + i + " | " + type + " | " + src + " | " + diff + " |");
    }
    lines.push("", "难度按「基础 40% / 中等 40% / 综合 20%」铺 —— 这个配比是我按常见教学节奏给的默认值，你可以直接让我改。");
    return {
      ok: true, title: "出题", lines: lines,
      note: "🔴 我**不会**直接把卷子发出去：成卷与发布都在「出题与组卷」页，那里要你逐题审核。" +
        (hasApiKey() ? "" : " " + noKeyNote()),
    };
  },

  /* ---------- 评分标准 ---------- */
  "atom-rubric": function (p) {
    const les = parseLessonText(p.text || "");
    const dims = [];
    (les.keyPoints || []).slice(0, 3).forEach(function (k) { dims.push(k); });
    (les.hardPoints || []).slice(0, 2).forEach(function (h) { dims.push(h); });
    if (!dims.length) dims.push("概念是否说清", "步骤是否完整", "结论是否正确");
    const lines = ["按这节课的重点与难点（" + dims.length + " 个来源）排一张分档表：", "",
      "| 维度 | 优秀 | 合格 | 待改进 |", "|---|---|---|---|"];
    dims.forEach(function (d) {
      lines.push("| " + d + " | 能自己说清并能举例 | 照着板书能复述 | 说不清，需要重讲 |");
    });
    lines.push("", "分档的**措辞**是通用模板 —— 我可以按你的课改成更具体的判分点。");
    return { ok: true, title: "评分标准", lines: lines, note: hasApiKey() ? "" : noKeyNote() };
  },

  /* ---------- 定位薄弱（学生端） ---------- */
  "atom-diagnose": function (p, ctx) {
    const list = (typeof BEHAVIOR !== "undefined") ? BEHAVIOR : [];
    const prof = behaviorProfile(list, Date.now());
    const lines = [];
    if (!prof.total) {
      return { ok: true, title: "定位薄弱", lines: ["还没有你的学习记录 —— 去「AI 答疑」问一句，或者去课件页写条批注，我立刻就能看出你在哪卡住。"] };
    }
    lines.push("你在这里的学习记录共 **" + prof.total + " 条**，覆盖 " + prof.activeDays + " 天。");
    lines.push("");
    if (prof.gaps.length) {
      lines.push("**反复卡住的**（问过 ≥2 次，却从没标「懂了」）：");
      prof.gaps.slice(0, 5).forEach(function (g, i) {
        lines.push((i + 1) + ". **" + g.topic + "** —— 问过 " + g.count + " 次");
      });
    } else {
      lines.push("**没有反复卡住的话题** —— 你问过的最后都标了「懂了」。");
    }
    lines.push("");
    lines.push("**已经懂的**（你标过「懂了」的）：" +
      (prof.known.length ? prof.known.map(function (k) { return k.topic + "（" + k.got + " 次）"; }).join("、") : "还没有"));
    return {
      ok: true, title: "定位薄弱", lines: lines,
      note: "这是从**你自己的动作**里算的（问了几次、有没有标懂了），不是考试分数，也没有猜你的水平。",
    };
  },

  /* ---------- 类比讲解：从他会的到他想会的 ---------- */
  "atom-analogy": function (p, ctx) {
    const list = (typeof BEHAVIOR !== "undefined") ? BEHAVIOR : [];
    const prof = behaviorProfile(list, Date.now());
    const path = learningPath(prof, 3);
    const lines = [];
    if (!prof.total) {
      return { ok: true, title: "类比讲解", lines: ["我还不认识你的知识面 —— 先问我几个问题（比如「快排为什么最坏是 O(n²)」），" +
        "我就能看出你哪些已经会了，再用你熟的东西去类比新的。"] };
    }
    lines.push("**我会这么讲**（依据你自己的 " + prof.total + " 条记录）：");
    lines.push("");
    lines.push("先按你的偏好定讲法：" + personaFitLine(prof));
    lines.push("");
    if (!path.length) {
      lines.push("你暂时没有「反复卡住」的话题 —— 有的话，我会按下面这种方式，**从你已经懂的推到你想懂的**。");
    } else {
      path.forEach(function (x, i) {
        lines.push((i + 1) + ". **" + x.topic + "**（你问过 " + x.count + " 次）");
        lines.push("   路线：" + x.chain.join(" → "));
        lines.push("   为什么这样排：" + x.from);
        if (x.bridge) lines.push("   类比桥：" + x.bridge);
        else lines.push("   类比桥：这条桥我还没预置（本版类比桥是预置的，正式版由模型现场找）");
      });
    }
    lines.push("");
    lines.push("想从哪一个开始，说一声我就按第一条路线讲 —— 每讲一步会停下来确认一次。");
    return {
      ok: true, title: "类比讲解", lines: lines,
      note: "「从他会到他想会」不是一句口号：**先修关系**是固定的（`TOPIC_PREREQ`），" +
        "「你已经懂了哪个」来自你自己的标记 —— 所以顺序是能解释的，不是我随口排的。",
    };
  },

  /* ---------- 生成自测（用他自己问过的问题出题） ---------- */
  "atom-gen-exercise": function (p, ctx) {
    const list = (typeof BEHAVIOR !== "undefined") ? BEHAVIOR : [];
    const prof = behaviorProfile(list, Date.now());
    const target = prof.gaps[0] || (prof.known[0] ? { topic: prof.known[0].topic, count: prof.known[0].asks } : null);
    if (!target) {
      return { ok: true, title: "生成自测", lines: ["还出不了题 —— 你得先问过我几个问题，我才知道你该练什么。"] };
    }
    const asked = [];
    list.forEach(function (e) {
      if (e.topic !== target.topic || (e.kind !== "ask" && e.kind !== "reteach")) return;
      const q = String(e.label || "").trim();
      if (q && asked.indexOf(q) < 0) asked.push(q);      // 问过 3 次也只出一道题
    });
    const lines = [
      "练这个：**" + target.topic + "**（你问过 " + target.count + " 次，还没标过「懂了」）。",
      "",
      "题就出在**你自己问过的问题**上 —— 不背笔记，用自己的话答：",
      "",
    ];
    (asked.length ? asked.slice(0, 3) : ["（你还没就这个话题提过具体问题）"]).forEach(function (q, i) {
      lines.push((i + 1) + ". " + q);
    });
    lines.push("");
    lines.push("答完之后，如果你觉得通了，回「AI 答疑」点一下「✓ 懂了」—— 那会记进你的学习记录，" +
      "我也会据此把它从「该补的」里挪走。");
    return {
      ok: true, title: "生成自测", lines: lines,
      note: "题面取自你**自己提过的原话**，所以不存在「我替你编了一道题」。要答案要点的话，去「AI 答疑」问同一句。",
    };
  },

  /* ---------- 群组层：学困生跟进（教师端） ---------- */
  "grp-at-risk": function (p, ctx) {
    const local = (typeof localStudentAccounts === "function") ? localStudentAccounts() : [];
    if (!local.length) {
      return { ok: true, title: "学困生跟进", lines: ["本机还没有学生账号 —— 学生用邀请码加入课堂后，我才能看到他们的学习记录。"] };
    }
    const lines = ["本机共 " + local.length + " 个学生账号，逐个看他们的行为记录：", ""];
    const rows = local.map(function (s) {
      const beh = (typeof behaviorOf === "function") ? behaviorOf(s.key) : [];
      const prof = behaviorProfile(beh, Date.now());
      return { name: s.name, total: prof.total, gaps: prof.gaps, known: prof.known };
    }).sort(function (a, b) { return b.gaps.length - a.gaps.length || b.total - a.total; });
    rows.forEach(function (r) {
      lines.push("- **" + r.name + "**：" + r.total + " 条记录" +
        (r.gaps.length ? "，卡在 " + r.gaps.slice(0, 3).map(function (g) { return g.topic + "（" + g.count + "）"; }).join("、")
          : "，没有反复卡住的话题") +
        (r.known.length ? "；已懂 " + r.known.slice(0, 3).map(function (k) { return k.topic; }).join("、") : ""));
    });
    lines.push("");
    lines.push("⚠️ 排序依据是「**反复问却没标懂了**」的话题数，不是成绩 —— 本版没有成绩数据，也不编。");
    lines.push("要跟进谁，把名字给我，我按他的已懂话题排一条补的路线（跟学生端同一套先修关系）。");
    return { ok: true, title: "学困生跟进", lines: lines };
  },

  /* ---------- 群组层：班级日常（教师端） ---------- */
  "grp-class-mgmt": function (p, ctx) {
    const c = (typeof COURSES !== "undefined" ? COURSES : []).filter(function (x) {
      return x.id === (p.courseId || ctx.courseId) ;
    })[0] || (typeof COURSES !== "undefined" ? COURSES[0] : null);
    if (!c) return { ok: true, title: "班级日常", lines: ["本机还没有课程 —— 先在左栏「我的课程 ＋」建一门。"] };
    const inCourse = (typeof enrolledStudentsOf === "function") ? enrolledStudentsOf(c.id) : [];
    const not = (typeof studentsNotInCourse === "function") ? studentsNotInCourse(c.id) : [];
    const lines = [
      "**" + c.name + "**",
      "- 邀请码：`" + ((typeof joinCodeOf === "function") ? joinCodeOf(c) : "—") + "`（学生端「我的课程 ＋」输入就能进）",
      "- 已加入（本机真实记录）：" + inCourse.length + " 人" +
        (inCourse.length ? " —— " + inCourse.map(function (s) { return s.name; }).join("、") : ""),
      "- 还没加入：" + (not.length ? not.map(function (s) { return s.name; }).join("、") + "（把码发给他们）" : "没有"),
    ];
    return { ok: true, title: "班级日常", lines: lines };
  },
};

/**
 * 跑一个技能。
 * 优先用技能自带的 `run`（系统层那几条），否则查 SKILL_RUNNERS（原子层/群组层的细活）。
 * 返回统一形状；失败时 `ok:false` + `error`（页面负责显示，不要静默）。
 */
function runSkill(id, payload, ctx) {
  const o = ctx || {};
  const sk = skillOf(id, o.role);
  if (!sk) return { ok: false, error: "没有这个技能：" + id };
  let r = null;
  if (typeof sk.run === "function") r = sk.run(payload || {}, o);
  else if (SKILL_RUNNERS[id]) r = SKILL_RUNNERS[id](payload || {}, o);
  if (!r) return { ok: false, error: "「" + sk.name + "」还没实现执行逻辑" };
  r.skillId = id; r.skillName = sk.name; r.kind = sk.kind;
  return r;
}

/**
 * 把一条技能链跑成「动作链」：每一步都记下来源技能，写操作还要过确认闸。
 * 学生端的技能全是只读 —— 所以这里**不产生任何 publish_/delete_ 动作**（有断言盯着）。
 */
function planFromChain(chain, ctx) {
  const o = ctx || {};
  const steps = [];
  (chain || []).forEach(function (sk) {
    // 🔴 闸门技能（sys-confirm-gate）自己的步骤**不进动作链** —— 它是"什么时候该插确认"
    //    这条规则本身，不是一次要做的事。它的 steps 只是给人看的说明（技能卡里会展开）。
    //    不排除的话，任何一次对话都会卡在它的「等待确认」上（第 35 轮踩到：解析课表也停在确认）。
    if (sk.id === "sys-confirm-gate") return;
    (sk.steps || []).forEach(function (st) {
      steps.push({
        skill: sk.id, layer: sk.layer, kind: sk.kind,
        name: st.name, arg: st.arg || "", wait: !!st.wait,
      });
    });
  });
  // 写操作必须有确认步 —— 🔴 教师端硬规则（验证器断言）。闸门自己不算"写操作"。
  const writes = (chain || []).filter(function (s) {
    return s.kind === "write" && s.id !== "sys-confirm-gate";
  });
  if (writes.length && !steps.some(function (s) { return s.wait; })) {
    steps.push({ skill: "sys-confirm-gate", layer: "system", kind: "write", name: "等待确认", arg: "action=publish_or_delete", wait: true });
  }
  if (o.allowWrite === false) steps.forEach(function (s) { if (s.kind === "write") s.downgraded = true; });
  return steps;
}

/* ============================================================
   动作执行层（第 55 轮）
   ------------------------------------------------------------
   背景：技能链原来只是"把流程说一遍" —— 点「确认执行」只把节点标成 ✓，
   **不动任何数据**（`runSteps` 里那两行 `classList.add("ok")`）。
   这一层把那一下接到真实数据层上。

   🔴 三条硬规矩：
    1. **能真执行的真执行**（调数据层函数，把真实结果返回给界面）；
    2. 🔴 **缺具体对象 / 缺授权 → 如实拒绝**（`{ok:false, reason}`）—— 绝不假装成功；
    3. 写技能只有教师端那两条（`kind:"write"` 全表可数），学生端走不到这里。
   ============================================================ */

/** 从等待步的 `arg`（形如 `action=publish_exam`）里取出动作名 */
function agentStepAction(step) {
  const m = String((step && step.arg) || "").match(/action=([A-Za-z_]+)/);
  return m ? m[1] : "";
}

/**
 * 执行一个等待中的写动作。
 * @returns {ok:true, detail, goto?} —— `detail` 是**真实结果**（做了什么、影响了几个人）
 *          {ok:false, reason, goto?} —— `reason` 是**为什么现在做不了**
 */
function runAgentStep(step, ctx) {
  const o = ctx || {};
  const action = agentStepAction(step);
  const exams = (typeof EXAMS !== "undefined" && Array.isArray(EXAMS)) ? EXAMS : [];

  if (action === "publish_exam") {
    // 只认「有一道以上已采纳、且还没发布过」的卷子 —— 空卷发出去是事故
    const ready = exams.filter(function (e) {
      return e && examStats(e).accepted && e.status !== "published";
    });
    if (!ready.length) {
      const hasPublished = exams.some(function (e) { return e && examStats(e).accepted; });
      return {
        ok: false,
        reason: hasPublished
          ? "本机组好的卷子都已经发过了 —— 要再发一次，去「出题与组卷」页重新选班级"
          : "还没有组好的卷子（至少要有一道「已采纳」的题）—— 先去出题页组卷",
        goto: "exam.html",
      };
    }

    const exam = ready[0];
    // 发给谁：这门课**在课学生**（🔴 用 enrolledStudentsOf 的 key，不能用裸账号名）
    const who = (typeof enrolledStudentsOf === "function")
      ? enrolledStudentsOf(exam.courseId).map(function (s) { return s.key; })
      : [];
    if (!who.length) {
      return {
        ok: false,
        reason: "这门课还没有学生加入 —— 先把邀请码发出去，或在「课程成员」里看看",
        goto: "class.html?course=" + encodeURIComponent(exam.courseId || ""),
      };
    }

    const r = publishExam(exam.id, who);
    if (!r.ok) return { ok: false, reason: r.error, goto: "exam.html" };
    return {
      ok: true,
      detail: "已把「" + exam.title + "」发给本课 " + who.length + " 位学生（这次新发 " + r.added + " 人）",
      goto: "exam.html",
    };
  }

  // 其它写动作：现在没有能安全落地的具体对象 —— 如实说，不装
  return {
    ok: false,
    reason: "这一步没有可自动执行的具体对象 —— 到对应页面里点一下才算数（这里只给建议）",
  };
}

/* ============================================================
   画像（persona）—— 「怎么讲他才听得懂」
   ------------------------------------------------------------
   参考 DeepTutor 的 PERSONA.md：**每轮都要注入**，因为它必须从第一个字开始影响语气
   （跟"按需挂载"的 skill 相反）。所以这里只放**讲法**，不放流程。

   数据从哪来 —— 这是本项目的优势：第 34 轮已经有一份真实的行为日志了。
     · 已经懂了 ← 标过「懂了」的话题（`got`）
     · 反复卡住 ← 反复问（提问 + 重讲 ≥ 2 次）却从没标过「懂了」的话题
     · 讲法偏好 ← 看代码 / 展开推导 / 请求重讲 / 标懂了 各自占提问的比例
   全部是**他自己动作的统计**，不是模型猜的"学习风格"。

   🔴 「从他会到他想会」靠 `TOPIC_PREREQ`（先修关系）+ 他标记过的「懂了」：
      先修已标懂 → 从那切入；没标懂 → 先把先修补上。顺序**能解释**，不是随口排的。
      ⚠️ 类比的那句话（`TOPIC_ANALOGY`）本版是**预置**的，没预置就如实说
      「这条桥还没预置，正式版由模型现场找」—— 与实训路径库同一个口径。
   ============================================================ */

var PERSONA_KEY = "st_persona";

/** 基础画像：一个新手第一次进来就能用的讲法默认值（不是"空"） */
function basePersona() {
  return {
    version: 1,
    voice: "先给结论，再讲为什么",
    step: "一次只推进一步，确认了再往下",
    formats: ["短列表", "具体例子"],
    avoid: ["长段落"],
    lang: "口语；术语第一次出现时补一句中文解释",
    known: [],        // 磨出来的：已经懂了的话题
    gaps: [],         // 磨出来的：反复卡住的话题
    log: [],          // 磨合记录（每一条都写清依据多少条行为、改了什么）
    fittedAt: 0,
    fittedFrom: 0,
  };
}

function normStrArr(x, fallback) {
  if (!Array.isArray(x)) return fallback.slice();
  const out = x.map(function (s) { return String(s == null ? "" : s).trim(); }).filter(Boolean);
  return out.length ? out : fallback.slice();
}

function normalizePersona(p) {
  const base = basePersona();
  const o = (p && typeof p === "object") ? p : {};
  return {
    version: Number(o.version) || 1,
    voice: String(o.voice || base.voice).trim() || base.voice,
    step: String(o.step || base.step).trim() || base.step,
    formats: normStrArr(o.formats, base.formats),
    avoid: normStrArr(o.avoid, base.avoid),
    lang: String(o.lang || base.lang).trim() || base.lang,
    known: Array.isArray(o.known) ? o.known.map(String).filter(Boolean).slice(0, 8) : [],
    gaps: Array.isArray(o.gaps) ? o.gaps.map(String).filter(Boolean).slice(0, 8) : [],
    log: Array.isArray(o.log) ? o.log.filter(function (x) {
      return x && Number(x.at) > 0 && Array.isArray(x.changes);
    }).slice(0, 8).map(function (x) {
      return { at: Number(x.at), from: Number(x.from) || 0, changes: x.changes.map(String).slice(0, 6) };
    }) : [],
    fittedAt: Number(o.fittedAt) || 0,
    fittedFrom: Number(o.fittedFrom) || 0,
  };
}

function personaKeyOf(u) { return u ? PERSONA_KEY + ":" + String(u) : PERSONA_KEY; }
function personaStoreKey() { return personaKeyOf(currentUserKey()); }

/** 读**某个账号**的画像（教师端将来要看某个学生的画像就走这里） */
function personaOf(roleUser) {
  const u = String(roleUser || "").trim();
  if (!u) return basePersona();
  try {
    const raw = window.localStorage.getItem(personaKeyOf(u));
    if (raw) {
      const p = normalizePersona(JSON.parse(raw));
      // ⚠️ 画像没有"空"这一说：基础画像永远在，磨合结果可能还是空的
      return p;
    }
  } catch (_) { /* 存档坏了 → 退回基础画像 */ }
  return basePersona();
}

function loadPersona() {
  const key = personaStoreKey();
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) return normalizePersona(JSON.parse(raw));
  } catch (_) { /* 隐私模式 / file:// */ }
  return basePersona();
}

function savePersona() {
  try { window.localStorage.setItem(personaStoreKey(), JSON.stringify(MY_PERSONA)); }
  catch (_) { /* 存不下就算了，界面照常能用 */ }
}

/** 清空当前账号的磨合结果（回到基础画像） */
function clearPersona() {
  MY_PERSONA = basePersona();
  try { window.localStorage.setItem(personaStoreKey(), JSON.stringify(MY_PERSONA)); } catch (_) { }
  return MY_PERSONA;
}

var MY_PERSONA = loadPersona();

/* ------------------------------------------------------------
   先修关系 + 类比桥
   ------------------------------------------------------------
   `TOPIC_PREREQ` 数组按「**远 → 近**」写（越靠后越接近目标）。
   ============================================================ */
var TOPIC_PREREQ = {
  "线性表": [],
  "排序": ["线性表"],
  "查找": ["线性表"],
  "树": ["线性表"],
  "图": ["树", "线性表"],
  "复杂度": ["排序", "线性表"],
  "进程与线程": [],
};

/** 类比桥：从 A 讲到 B 的一句"接口"（本版预置；没有就如实说没有） */
var TOPIC_ANALOGY = {
  "线性表>排序": "都是同一条线上的元素在动 —— 排序只是把它们按大小重排一遍位置",
  "线性表>查找": "还是那条线，只是不再从头一个个看，而是想办法把「位置」直接算出来",
  "线性表>树": "从一对一扩到一对多：线性表每个元素只有一个后继，树可以有多个孩子",
  "树>图": "树是「不会绕回来的图」；把树推向图只多出一件事 —— 你得记住自己来过哪儿",
  "线性表>复杂度": "先数一遍「遍历这张表用了几步」，这就是复杂度的起点",
  "排序>复杂度": "先数一数排序里那两层循环各跑多少次，再把「数次数」推广到别的算法",
};
function analogyBridge(from, to) {
  return String(TOPIC_ANALOGY[String(from) + ">" + String(to)] || "");
}

/* ------------------------------------------------------------
   从行为里读出来的三个东西：会的 / 不会的 / 讲法偏好
   ============================================================ */

/** 一个人（一串行为日志）的画像数据。纯函数：时间从参数进来。 */
function behaviorProfile(list, now) {
  const arr = Array.isArray(list) ? list : [];
  const base = Number(now) || Date.now();
  const got = {}, asked = {}, noted = {};
  arr.forEach(function (e) {
    const t = String(e.topic || TOPIC_NONE);
    if (!t || t === TOPIC_NONE) return;
    if (e.kind === "got") got[t] = (got[t] || 0) + 1;
    if (e.kind === "ask" || e.kind === "reteach") asked[t] = (asked[t] || 0) + 1;
    if (e.kind === "note") noted[t] = (noted[t] || 0) + 1;
  });
  const known = Object.keys(got).map(function (t) {
    return { topic: t, got: got[t], asks: asked[t] || 0, notes: noted[t] || 0 };
  }).sort(function (a, b) { return b.got - a.got || (a.topic < b.topic ? -1 : 1); });

  const sum = behaviorSummary(arr, base);
  return {
    total: sum.total, activeDays: sum.activeDays, streak: sum.streak, week: sum.week,
    lastAt: sum.lastAt, seedCount: sum.seedCount, byKind: sum.byKind,
    known: known,
    gaps: behaviorWeakTopics(arr, 0),
    topics: behaviorByTopic(arr, 6),
    traits: behaviorTraits(arr, base),
  };
}

/**
 * 「从他会的到他想会的」：把"反复卡住的话题"逐个配上一条路线。
 * · 先修里**已经标过懂了**的，取最深的一级作为切入点（一路把已懂的也铺进来）
 * · 先修一个都没标懂 → 从最靠前的先修起步，并说明"先把先修补上"
 * · 没有预设先修 → 直接从它自己开始
 * `bridge` 是类比的那句话（可能为空，页面要如实说"没预置"）。
 */
function learningPath(prof, limit) {
  const p = prof || behaviorProfile((typeof BEHAVIOR !== "undefined" ? BEHAVIOR : []), Date.now());
  const knownMap = {};
  (p.known || []).forEach(function (k) { knownMap[k.topic] = k; });

  const out = (p.gaps || []).map(function (g) {
    const pre = TOPIC_PREREQ[g.topic] || [];
    const chain = [];
    let entry = "", from = "", bridge = "";
    const knownPre = pre.filter(function (t) { return knownMap[t]; });
    if (knownPre.length) {
      entry = knownPre[0];                                  // 数组远→近，第一个就是已懂的里最基础的
      const deeper = (TOPIC_PREREQ[entry] || []).filter(function (t) { return knownMap[t]; })[0];
      if (deeper) chain.push(deeper);
      chain.push(entry);
      from = "「" + entry + "」你已经标过「懂了」（" + knownMap[entry].got + " 次）—— 从它切进去";
      bridge = analogyBridge(entry, g.topic);
    } else if (pre.length) {
      const first = pre[0];
      chain.push(first);
      from = "先修「" + first + "」你还没标过懂 —— 建议先把「" + first + "」补上，再回到「" + g.topic + "」";
      bridge = "";
    } else {
      from = "「" + g.topic + "」没有预设先修，可以直接从它自己开始";
      bridge = "";
    }
    chain.push(g.topic);
    return {
      topic: g.topic, count: g.count, chain: chain,
      entry: entry, from: from, bridge: bridge,
      bridgeOk: !!bridge,
    };
  }).sort(function (a, b) {
    // 有类比桥的排前面（能讲得进），其次按问的次数
    if ((b.bridgeOk ? 1 : 0) !== (a.bridgeOk ? 1 : 0)) return (b.bridgeOk ? 1 : 0) - (a.bridgeOk ? 1 : 0);
    return b.count - a.count || (a.topic < b.topic ? -1 : 1);
  });
  return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * 磨合：把「行为里读出来的东西」并进画像，**并留下一条可核的记录**。
 * 只做四类有依据的调整（看代码多 → 加代码讲法；推导多 → 加推导；老要重讲 → 换例子；
 * 标懂了少 → 步子调小）。依据不足就不动 —— 不许为了"显得懂你"瞎调。
 */
function fitPersona(now) {
  const base = Number(now) || Date.now();
  const list = (typeof BEHAVIOR !== "undefined") ? BEHAVIOR : [];
  const prof = behaviorProfile(list, base);
  const p = MY_PERSONA;
  const changes = [];
  const addTo = function (arr, v) { if (arr.indexOf(v) < 0) { arr.push(v); return true; } return false; };

  const byKind = {};
  prof.traits.forEach(function (t) { byKind[t.kind] = t; });
  const askN = (byKind.ask && byKind.ask.base) || 0;
  const ratio = function (k) { return askN ? ((byKind[k] ? byKind[k].count : 0) / askN) : 0; };
  const pct = function (r) { return Math.round(r * 100) + "%"; };

  if (askN >= 3 && ratio("code") >= 0.3 && addTo(p.formats, "可直接运行的代码片段")) {
    changes.push("「看代码示例」占提问的 " + pct(ratio("code")) + " → 常用讲法里加上代码片段");
  }
  if (askN >= 3 && ratio("deeper") >= 0.3 && addTo(p.formats, "推导过程")) {
    changes.push("「展开推导」占 " + pct(ratio("deeper")) + " → 先给过程再给结论");
  }
  if (askN >= 3 && ratio("reteach") >= 0.3 && addTo(p.avoid, "只换措辞、不换例子地重讲")) {
    changes.push("「再讲一遍」占 " + pct(ratio("reteach")) + " → 重讲必须换一个例子，不能只换说法");
  }
  if (askN >= 3 && ratio("got") < 0.2) {
    const smaller = "一次只推进一步，每一步都停下来确认";
    if (p.step !== smaller) { p.step = smaller; changes.push("标「懂了」的比例只有 " + pct(ratio("got")) + " → 把步子调小"); }
  }

  const kn = prof.known.slice(0, 4).map(function (k) { return k.topic; });
  const gp = prof.gaps.slice(0, 4).map(function (g) { return g.topic; });
  if (kn.join("|") !== p.known.join("|")) {
    changes.push("「已经懂的」更新为：" + (kn.join("、") || "（暂无）"));
    p.known = kn;
  }
  if (gp.join("|") !== p.gaps.join("|")) {
    changes.push("「反复卡住的」更新为：" + (gp.join("、") || "（暂无）"));
    p.gaps = gp;
  }

  p.fittedAt = base;
  p.fittedFrom = prof.total;
  if (changes.length) {
    p.log.unshift({ at: base, from: prof.total, changes: changes });
    p.log = p.log.slice(0, 8);
  }
  savePersona();
  return { persona: p, profile: prof, changes: changes };
}

/** 一句话讲法（被「类比讲解」技能引用，也用在画像卡顶部） */
function personaFitLine(prof) {
  const p = prof || behaviorProfile((typeof BEHAVIOR !== "undefined" ? BEHAVIOR : []), Date.now());
  const byKind = {};
  p.traits.forEach(function (t) { byKind[t.kind] = t; });
  const askN = (byKind.ask && byKind.ask.base) || 0;
  const parts = [];
  if (askN) {
    const r = function (k) { return (byKind[k] ? byKind[k].count : 0) / askN; };
    if (r("code") >= 0.3) parts.push("多给代码示例");
    if (r("deeper") >= 0.3) parts.push("把推导过程写出来");
    if (r("reteach") >= 0.3) parts.push("重讲时换例子，不是换措辞");
    if (r("got") < 0.2) parts.push("步子再小一点，每步确认");
    if (r("note") >= 0.3) parts.push("每段留一句可以抄下来的小结");
  }
  const known = p.known.slice(0, 3).map(function (k) { return k.topic; });
  if (known.length) parts.push("用你已经懂的「" + known.join("、") + "」做类比");
  return parts.length ? parts.join("；") : "按默认讲法：先结论、后理由，一次一步，配具体例子";
}

/**
 * 「怎么讲他听得懂」的简报 —— 这是 persona 该注入的东西（每轮都带）。
 * 页面把它渲染成卡片；接了真模型之后，这一段就是 system prompt 里 persona 那部分。
 */
function personaBrief(prof) {
  const p = (typeof MY_PERSONA !== "undefined") ? MY_PERSONA : basePersona();
  const r = prof || behaviorProfile((typeof BEHAVIOR !== "undefined" ? BEHAVIOR : []), Date.now());
  const path = learningPath(r, 3);
  const lines = [
    "- 开口：" + p.voice,
    "- 步子：" + p.step,
    "- 常用：" + p.formats.join("｜"),
    "- 避免：" + p.avoid.join("｜"),
    "- 语言：" + p.lang,
    "- 已经懂了：" + (r.known.length ? r.known.map(function (k) { return k.topic + "（" + k.got + "）"; }).join("、") : "（还没有标记过「懂了」）"),
    "- 反复卡住：" + (r.gaps.length ? r.gaps.map(function (g) { return g.topic + "×" + g.count; }).join("、") : "（没有反复卡住的）"),
    "- 切入顺序：" + (path.length ? path.map(function (x) { return x.chain.join("→"); }).join("；") : "（暂无待补话题）"),
  ];
  return lines;
}

/* ============================================================
   技能开关与自定义分组 —— 左栏那棵技能树的**数据**（第 36 轮）
   ------------------------------------------------------------
   左栏把三层技能画成一棵可勾选的树：勾上＝以后会挂，取消＝关掉。这层管那棵树。

     · `st_skills` / `st_skills:<角色>:<账号>` —— 与 COURSES / ENROLLED / BEHAVIOR 同一套分桶规矩
     · `off`    被**关掉**的技能 id（只记关掉的，默认全开 —— 新加的技能自动是开着的）
     · `groups` 用户自建的分组（**只存技能 id 的引用，不移动技能**）
     · `closed` 树上被折叠起来的层 / 分组（刷新后位置感不变）

   🔴 **「改前确认」这道闸不许关**（`SKILL_LOCKED`）：它是教师端写操作的唯一拦截点，
      做成可配置就等于"把刹车做成选配"。界面上显示为锁定，`setSkillEnabled` 直接拒绝并说明原因。

   🔴 **关掉只影响"以后挂不挂"，不动历史**：已经跑过的对话、动作链都不改。
      而 `roleSkills()`（全量视图）**不看开关** —— 关掉不等于删除，左栏里那一行还得在，
      否则用户会以为技能没了、再也开不回来。
   ============================================================ */

var SKILL_STATE_KEY = "st_skills";

/** 锁定的技能：不许关（关掉安全底线 = 把刹车做成选配） */
var SKILL_LOCKED = {
  "sys-confirm-gate": "教师端写操作的唯一拦截点，关掉它发布/删除就没有确认步了",
};

function skillStateStoreKey() {
  const u = currentUserKey();
  return u ? SKILL_STATE_KEY + ":" + u : SKILL_STATE_KEY;
}

/** 跨角色找一个技能（状态层用：学生端独有的技能用 teacher 视角是找不到的） */
function skillAnyRole(id) {
  return allSkills("teacher").concat(allSkills("student"))
    .filter(function (s) { return s.id === id; })[0] || null;
}

/** 规整状态 —— 坏存档不能让整页白屏（与 COURSES / ENROLLED 同一要求） */
function normalizeSkillState(raw) {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  const off = {};
  if (o.off && typeof o.off === "object") {
    Object.keys(o.off).forEach(function (k) {
      // 🔴 锁定的技能即使存档里写着"关了"，读回来也强制打开（存档也可能是手改的）
      if (o.off[k] && !SKILL_LOCKED[k]) off[k] = 1;
    });
  }
  const groups = (Array.isArray(o.groups) ? o.groups : [])
    .filter(function (g) { return g && typeof g === "object" && String(g.name || "").trim(); })
    .map(function (g, i) {
      return {
        id: String(g.id || "g" + (i + 1)).trim() || "g" + (i + 1),
        name: String(g.name).trim().slice(0, 20),
        skills: (Array.isArray(g.skills) ? g.skills : []).map(String).filter(Boolean),
      };
    });
  const closed = {};
  if (o.closed && typeof o.closed === "object") {
    Object.keys(o.closed).forEach(function (k) { if (o.closed[k]) closed[k] = 1; });
  }
  return { version: 1, off: off, groups: groups, closed: closed };
}

function loadSkillState() {
  try {
    const raw = window.localStorage.getItem(skillStateStoreKey());
    if (raw) return normalizeSkillState(JSON.parse(raw));
  } catch (_) { /* 隐私模式 / file:// —— 退化为内存态 */ }
  return normalizeSkillState(null);
}

function saveSkillState() {
  try { window.localStorage.setItem(skillStateStoreKey(), JSON.stringify(SKILL_STATE)); }
  catch (_) { /* 存不下就算了，界面照常能用 */ }
}

var SKILL_STATE = loadSkillState();

/* ---------------- 开关 ---------------- */

/** 这条技能锁不锁（锁定的不许关，见 SKILL_LOCKED） */
function skillLocked(id) { return !!SKILL_LOCKED[id]; }
/** 关不掉的理由（界面要显示出来）；不锁返回空串 */
function skillLockReason(id) { return SKILL_LOCKED[id] || ""; }

/** 这条技能现在是开着的吗（默认开） */
function skillEnabled(id) {
  if (SKILL_LOCKED[id]) return true;
  return !(SKILL_STATE.off && SKILL_STATE.off[id]);
}

/**
 * 开关一条技能。
 * 锁定 / 不存在的 id → `{ok:false, error}` —— **不静默失败**，界面要把原因说出来。
 */
function setSkillEnabled(id, on) {
  const sk = skillAnyRole(id);
  if (!sk) return { ok: false, error: "没有这个技能：" + id };
  if (SKILL_LOCKED[id]) {
    return { ok: false, error: "「" + sk.name + "」是锁定的，不能关 —— " + SKILL_LOCKED[id] };
  }
  if (on) delete SKILL_STATE.off[id];
  else SKILL_STATE.off[id] = 1;
  saveSkillState();
  return { ok: true, skill: sk, enabled: !!on };
}

function toggleSkillEnabled(id) { return setSkillEnabled(id, !skillEnabled(id)); }

/** 被关掉的技能条数（界面上的计数文案用） */
function disabledSkillCount(role) {
  const list = (role === "student" || role === "teacher") ? roleSkills(role) : allSkills();
  return list.filter(function (s) { return !skillEnabled(s.id); }).length;
}

/**
 * 按角色取**真会挂载**的技能 —— 路由用的就是它。
 * `roleSkills` 是**全量视图**（不看开关），两个别混：前者给路由，后者给左栏那棵树。
 */
function activeSkills(role) {
  return roleSkills(role).filter(function (s) { return skillEnabled(s.id); });
}

/** 全部恢复默认：技能全开 + 清空自建分组 + 折叠状态复位 */
function resetSkillState() {
  SKILL_STATE = normalizeSkillState(null);
  saveSkillState();
  return SKILL_STATE;
}

/* ---------------- 自定义分组（左栏的「我的分组」） ---------------- */

/**
 * 自建分组 = 一个**视图**：只存技能 id 的引用，不移动技能、不改它在三层里的位置。
 * 所以删掉分组只是"少了个视图"，技能还在原层里 —— 界面上必须把这句说清楚。
 */
function skillGroups() {
  if (!Array.isArray(SKILL_STATE.groups)) SKILL_STATE.groups = [];
  return SKILL_STATE.groups;
}

/** 新分组 id：g1 / g2…（从现有最大者往后排，不与被删过的撞号） */
function nextSkillGroupId() {
  let max = 0;
  skillGroups().forEach(function (g) {
    const m = /^g(\d+)$/.exec(g.id || "");
    if (m) max = Math.max(max, Number(m[1]));
  });
  return "g" + (max + 1);
}

function skillGroupOf(gid) {
  return skillGroups().filter(function (g) { return g.id === gid; })[0] || null;
}

/** 新建分组。名字必填、不许重名（不静默建一个"未命名"出来） */
function createSkillGroup(name) {
  const nm = String(name == null ? "" : name).trim().slice(0, 20);
  if (!nm) return { ok: false, error: "分组得有个名字" };
  if (skillGroups().some(function (g) { return g.name === nm; })) {
    return { ok: false, error: "已经有一个叫「" + nm + "」的分组了" };
  }
  const g = { id: nextSkillGroupId(), name: nm, skills: [] };
  skillGroups().push(g);
  saveSkillState();
  return { ok: true, group: g };
}

function renameSkillGroup(gid, name) {
  const g = skillGroupOf(gid);
  if (!g) return { ok: false, error: "找不到这个分组" };
  const nm = String(name == null ? "" : name).trim().slice(0, 20);
  if (!nm) return { ok: false, error: "分组名不能为空" };
  if (skillGroups().some(function (x) { return x.id !== gid && x.name === nm; })) {
    return { ok: false, error: "已经有一个叫「" + nm + "」的分组了" };
  }
  g.name = nm;
  saveSkillState();
  return { ok: true, group: g };
}

/**
 * 删分组 —— **只删这个视图，不删技能**（技能还在三层里，开关状态一个都不动）。
 * 界面上要先把这句说清楚，见 `skillGroupAssetCount`。
 */
function deleteSkillGroup(gid) {
  const g = skillGroupOf(gid);
  if (!g) return { ok: false, error: "找不到这个分组" };
  const removed = g.skills.length;
  SKILL_STATE.groups = skillGroups().filter(function (x) { return x.id !== gid; });
  saveSkillState();
  return { ok: true, removed: removed, group: g };
}

/** 这条技能被收进了哪些分组（一条技能可以在多个分组里） */
function groupsOfSkill(sid) {
  return skillGroups().filter(function (g) { return g.skills.indexOf(sid) >= 0; });
}

/** 收进分组 / 从分组移出 —— 都幂等（重复点不产生重复项） */
function addSkillToGroup(gid, sid) {
  const g = skillGroupOf(gid);
  if (!g) return { ok: false, error: "找不到这个分组" };
  if (!skillAnyRole(sid)) return { ok: false, error: "没有这个技能：" + sid };
  if (g.skills.indexOf(sid) < 0) g.skills.push(sid);
  saveSkillState();
  return { ok: true, group: g };
}

function removeSkillFromGroup(gid, sid) {
  const g = skillGroupOf(gid);
  if (!g) return { ok: false, error: "找不到这个分组" };
  g.skills = g.skills.filter(function (x) { return x !== sid; });
  saveSkillState();
  return { ok: true, group: g };
}

/** 删分组前先数清楚里面有几条 —— 与 courseAssetCount / activityAssetCount 同一用意 */
function skillGroupAssetCount(gid) {
  const g = skillGroupOf(gid);
  if (!g) return { skills: 0 };
  return { skills: g.skills.filter(function (sid) { return !!skillAnyRole(sid); }).length };
}

/** 层 / 分组折叠状态（持久化，刷新后还长原样） */
function skillClosed(key) { return !!(SKILL_STATE.closed && SKILL_STATE.closed[key]); }
function toggleSkillClosed(key) {
  if (!SKILL_STATE.closed) SKILL_STATE.closed = {};
  if (SKILL_STATE.closed[key]) delete SKILL_STATE.closed[key];
  else SKILL_STATE.closed[key] = 1;
  saveSkillState();
  return skillClosed(key);
}

/* ============================================================
   工作台 —— 「临时工作台」那一层（第 37 轮）
   ------------------------------------------------------------
   灵感出处：`docs/IDEAS.md` 灵感 01 的**层 3**。用户 9/29 的原话就在这里：
     「也可以像 workbuddy 一样做临时工作台……各个领域都有自己的东西，
       我们永远做不完，但是这样就可以了。」

   核心洞察是**功能发散、容器收敛**：与其把每个领域的功能都做一遍，
   不如给一个**容器**，让使用者按需在里面生成东西。这一层就是这个容器。

   形态（2026-09-29 就定了）：**卡片容器 + 一句话新建** ——
     · 卡片容器：每张卡片 = 一次产出的**结果快照**
     · 一句话新建：写一句话 → 走**同一套三层技能库** → 落成一张卡片

   🔴 **卡片存的是「快照」，不是「配方」**：
      存当时算出来的 `secs`（结构化结果），**不是**"那句话 + 技能 id"。
      理由：技能库是会变的（能关技能、能改输入、能换课程），只存配方的话，
      过两天打开同一张卡片会算出**不一样的东西** —— 那就不是"我当时看到的那份"了。
      产物就该是产物。

   🔴 **生成走同一套技能库，不另写一套**：
      工作台的"新建"就是 `routeSkills` → `runSkillChain`，与 AI 助手页**同一条管线**。
      好处两个：① 工作台能干的事**自动等于**技能库里的技能，不用两边维护；
      ② 用户在左栏把某条技能关掉，工作台里也就生成不出那类东西 ——
         于是**三层技能库成了整个应用的「能力总开关」**。

   ⚠️ 对 LLM 的诚实口径（答辩要讲）：工作台**不生成可执行程序**，
      而是「把自然语言意图转成结构化的结果数据」，再由前端渲染成界面。
      能算的（转表格 / 自查 / 差异 / 薄弱定位）当场算；真要成文的给骨架 + 如实说要 Key。

   ⚠️ 按账号分桶（`st_workbench:<角色>:<账号>`）；**空数组是有效存档**。
      卡片是用户自己攒的 → **到上限宁可拒绝新建，也不悄悄丢最旧的**（与行为日志的取舍相反：
      日志是流水，丢最旧的无所谓；卡片是产物，丢一张就是真丢了）。
   ============================================================ */

var WORKBENCH_KEY = "st_workbench";
/** 上限：到顶之后**拒绝新建并说清**，不静默淘汰 */
var WORKBENCH_MAX = 80;

/** 卡片类型 —— 唯一来源，界面文案从这里取 */
var CARD_KIND = {
  note:   { key: "note",   label: "文本",   icon: "▤" },
  lesson: { key: "lesson", label: "教案",   icon: "▦" },
  quiz:   { key: "quiz",   label: "题目",   icon: "◈" },
  table:  { key: "table",  label: "表格",   icon: "▥" },
  diff:   { key: "diff",   label: "差异",   icon: "±" },
  plan:   { key: "plan",   label: "计划",   icon: "▷" },
  check:  { key: "check",  label: "检查",   icon: "✓" },
};
function cardKind(k) { return CARD_KIND[k] || CARD_KIND.note; }
function cardKindKeys() { return ["note", "lesson", "quiz", "table", "diff", "plan", "check"]; }

/**
 * 技能 id → 卡片类型。
 * 🔴 新加技能时顺手在这里登记一行；**没登记的落到 `note`**（不许抛错 ——
 *    技能是数据派生的，群组层那条「计科 2301 班」就没有固定 id）。
 */
var SKILL_CARD_KIND = {
  "atom-text-to-table": "table",
  "atom-proofread": "check",
  "atom-lesson-check": "check",
  "atom-lesson-draft": "lesson",
  "atom-lesson-improve": "lesson",
  "atom-diff-explain": "diff",
  "atom-outline-order": "plan",
  "atom-gen-quiz": "quiz",
  "atom-rubric": "table",
  "atom-diagnose": "plan",
  "atom-analogy": "note",
  "atom-gen-exercise": "quiz",
  "grp-lesson-cycle": "lesson",
  "grp-exam-cycle": "quiz",
  "grp-at-risk": "plan",
  "grp-self-study": "plan",
  "grp-exam-prep": "plan",
  "grp-class-mgmt": "table",
  "grp-training": "plan",
  "sys-app-map": "note",
  "sys-data-truth": "note",
};
function cardKindOfSkill(skillId) { return SKILL_CARD_KIND[skillId] || "note"; }

/* ---------------- 规整 / 读 / 写 ---------------- */

let CARD_SEQ = 0;
function newCardId() { CARD_SEQ += 1; return "wc" + Date.now().toString(36) + "-" + CARD_SEQ; }

/** 一段结果：`{ title, lines }`；lines 是 Markdown 行（页面用 mdToHtml 渲染） */
function normCardSec(s, i) {
  const o = (s && typeof s === "object") ? s : {};
  return {
    title: String(o.title || "结果 " + (i + 1)).trim() || "结果 " + (i + 1),
    lines: (Array.isArray(o.lines) ? o.lines : []).map(function (x) {
      return typeof x === "string" ? x : String(x == null ? "" : x);
    }),
  };
}

/**
 * 规整一张卡片：没有 secs、又没有标题的丢掉（坏存档不能白屏）。
 * `secs` 允许为空数组（比如只记了一句话还没生成）—— 但那种卡片一律叫「未命名卡片」。
 */
function normCard(c, i) {
  const o = (c && typeof c === "object") ? c : {};
  const secs = (Array.isArray(o.secs) ? o.secs : []).map(normCardSec);
  const title = String(o.title || "").trim();
  if (!secs.length && !title) return null;
  const kind = CARD_KIND[o.kind] ? o.kind : "note";
  return {
    id: String(o.id || "wc-" + (i + 1)).trim() || "wc-" + (i + 1),
    title: (title || "未命名卡片").slice(0, 40),
    kind: kind,
    from: String(o.from || "").trim(),
    fromId: String(o.fromId || "").trim(),
    role: o.role === "student" ? "student" : "teacher",
    courseId: String(o.courseId || "").trim(),
    input: String(o.input || "").trim().slice(0, 200),
    secs: secs,
    notes: (Array.isArray(o.notes) ? o.notes : []).map(function (x) { return String(x || ""); }).filter(Boolean),
    createdAt: Number(o.createdAt) || 0,
    updatedAt: Number(o.updatedAt) || Number(o.createdAt) || 0,
  };
}

function normalizeCards(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  list.forEach(function (c, i) { const x = normCard(c, i); if (x) out.push(x); });
  return out;
}

/**
 * 当前角色：先看登录写入的 `st_current_user`，再看壳/登录页写的 `st_role` cookie。
 * ⚠️ 别写成"看 NAV[role] 里有没有某项" —— 那是**菜单**，不是身份。
 */
function currentRoleOf() {
  const u = (typeof currentUserKey === "function") ? String(currentUserKey() || "") : "";
  if (u.indexOf("student:") === 0) return "student";
  if (u.indexOf("teacher:") === 0) return "teacher";
  try {
    const c = (document.cookie.match(/(?:^|;\s*)st_role=([^;]+)/) || [])[1];
    if (c === "student" || c === "teacher") return c;
  } catch (_) { /* 没有 cookie 就按教师端算 */ }
  return "teacher";
}

/** 当前账号的工作台存档键（与 courseStoreKey / activityStoreKey 同一套路） */
function workbenchStoreKey() {
  const u = currentUserKey();
  return u ? WORKBENCH_KEY + ":" + u : WORKBENCH_KEY;
}

function loadCards() {
  const key = workbenchStoreKey();
  const user = currentUserKey();
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const ok = normalizeCards(JSON.parse(raw));
      if (ok) return ok;                 // ⚠️ 空数组也算有效（删光卡片不该复活预置数据）
    }
  } catch (_) { /* 隐私模式 / file:// —— 退化为内存态 */ }

  if (key !== WORKBENCH_KEY) {
    const migrated = migrateLegacyStore(WORKBENCH_KEY, key, normalizeCards, null);
    if (migrated) return migrated;
  }

  // 预置账号给两张示例卡片（好让"工作台是什么"一眼看得见）；自注册账号从**空的**开始
  // ⚠️ 预置卡片要**按角色**给 —— 学生端拿到"第 7 章教案自查"这种教师产物，只会一脸问号
  return (!user || isSeedAccount(user)) ? normalizeCards(seedCards(currentRoleOf())) : [];
}

function saveCards() {
  try { window.localStorage.setItem(workbenchStoreKey(), JSON.stringify(WORKBENCH)); }
  catch (_) { /* 存不下就算了，界面照常能用 */ }
}

var WORKBENCH = loadCards();

function cardOf(id) {
  return (WORKBENCH || []).filter(function (c) { return c.id === id; })[0] || null;
}

/** 新卡片 id：wc-1 / wc-2…（从现有最大者往后排，不与删过的撞号） */
function nextCardId() {
  let max = 0;
  (WORKBENCH || []).forEach(function (c) {
    const m = /^wc-(\d+)$/.exec(c.id || "");
    if (m) max = Math.max(max, Number(m[1]));
  });
  return "wc-" + (max + 1);
}

/**
 * 把一次技能执行的结果收成一张卡片（**存快照**）。
 * `runs` 就是 `runSkillChain` 的返回值；`meta.fromId` 用来定类型与来源。
 */
function cardFromRun(input, runs, meta) {
  const o = meta || {};
  const text = String(input || "").trim();
  const secs = (runs && runs.secs) || [];
  // 🔴 来源标签只认**主技能的名字**。不能拿 `secs[0].title` —— 群组层那条
  //    "你当前的课"经常排在第一段，于是卡片上会写「来自 数据结构与算法」，
  //    用户根本看不出"这张卡片是谁做的"（第 37 轮打印时发现的）。
  const mainSkill = o.fromId ? skillAnyRole(o.fromId) : null;
  const fromName = String(o.fromName || "").trim() || (mainSkill && mainSkill.name) ||
    (secs[0] && secs[0].title) || "";
  // 标题优先用**用户自己那句话**（那是他记得住的东西），没有才退回技能名
  const title = (text || fromName || "未命名卡片").slice(0, 40);
  const now = Number(o.now) || Date.now();
  return {
    id: nextCardId(),
    title: title,
    kind: cardKindOfSkill(o.fromId || ""),
    from: fromName,
    fromId: String(o.fromId || ""),
    role: o.role === "student" ? "student" : "teacher",
    courseId: String(o.courseId || ""),
    input: text.slice(0, 200),
    secs: secs.map(normCardSec),
    notes: ((runs && runs.notes) || []).map(String).filter(Boolean),
    createdAt: now,
    updatedAt: now,
  };
}

/** 新建卡片。`data` 可以是 `cardFromRun` 的结果，也可以是手写的 `{ title, secs }` */
function createCard(data) {
  if (!WORKBENCH) WORKBENCH = [];
  if (WORKBENCH.length >= WORKBENCH_MAX) {
    return { ok: false, error: "工作台最多放 " + WORKBENCH_MAX + " 张卡片。先删掉几张再建 —— 我不会替你丢东西。" };
  }
  const d = (data && typeof data === "object") ? data : {};
  const now = Number(d.now) || Date.now();
  const card = normCard({
    id: nextCardId(),
    title: d.title || d.input || "",
    kind: d.kind,
    from: d.from, fromId: d.fromId,
    role: d.role, courseId: d.courseId,
    input: d.input, secs: d.secs, notes: d.notes,
    createdAt: now, updatedAt: now,
  }, WORKBENCH.length);
  if (!card) return { ok: false, error: "这张卡片没有内容" };
  WORKBENCH.push(card);
  saveCards();
  return { ok: true, card: card };
}

/** 改名 / 改归属（只传要改的字段） */
function updateCard(id, patch) {
  const c = cardOf(id);
  if (!c) return { ok: false, error: "找不到这张卡片" };
  const p = patch || {};
  if ("title" in p) {
    const t = String(p.title || "").trim();
    if (!t) return { ok: false, error: "卡片标题不能为空" };
    c.title = t.slice(0, 40);
  }
  if ("kind" in p && CARD_KIND[p.kind]) c.kind = p.kind;
  if ("courseId" in p) c.courseId = String(p.courseId || "").trim();
  c.updatedAt = Number(p.now) || Date.now();
  saveCards();
  return { ok: true, card: c };
}

function deleteCard(id) {
  const i = (WORKBENCH || []).findIndex(function (c) { return c.id === id; });
  if (i < 0) return { ok: false, error: "找不到这张卡片" };
  const card = WORKBENCH[i];
  WORKBENCH.splice(i, 1);
  saveCards();
  return { ok: true, card: card };
}

/** 复制一份（标题加「副本」）—— 想在原结果上改一版时用，别动原件 */
function duplicateCard(id) {
  const c = cardOf(id);
  if (!c) return { ok: false, error: "找不到这张卡片" };
  const copy = JSON.parse(JSON.stringify(c));
  copy.title = (c.title + "（副本）").slice(0, 40);
  return createCard(copy);
}

/** 清空工作台（设置页的「清空本机数据」也走这里） */
function clearCards() {
  WORKBENCH = [];
  saveCards();
  return WORKBENCH;
}

function cardsOfKind(kind) {
  return (WORKBENCH || []).filter(function (c) { return c.kind === kind; });
}

/** 各类卡片各有多少张（筛选条上的计数） */
function cardKindCounts() {
  const out = {};
  cardKindKeys().forEach(function (k) { out[k] = 0; });
  (WORKBENCH || []).forEach(function (c) { out[c.kind] = (out[c.kind] || 0) + 1; });
  return out;
}

/** 卡片 → Markdown（「导出」按钮用；也是"这张卡片到底有什么"的忠实文本） */
function cardToMarkdown(card) {
  const c = card || {};
  const lines = ["# " + (c.title || "未命名卡片"), ""];
  const meta = [];
  if (c.from) meta.push("来源技能：" + c.from);
  if (c.input) meta.push("当时说的是：" + c.input);
  if (c.createdAt) meta.push("生成时间：" + fmtStamp(c.createdAt));
  if (meta.length) lines.push("> " + meta.join("  \n> "), "");
  (c.secs || []).forEach(function (s) {
    lines.push("## " + s.title, "");
    (s.lines || []).forEach(function (l) { lines.push(l); });
    lines.push("");
  });
  if ((c.notes || []).length) {
    lines.push("---", "");
    c.notes.forEach(function (n) { lines.push("> " + n); });
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}$/, "\n");
}

/** 时间戳 → `2026-10-05 22:30`（导出与卡片上都用这个格式，别各写一份） */
function fmtStamp(at) {
  const d = new Date(Number(at) || 0);
  if (!d.getTime()) return "未记录";
  const two = function (n) { return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) +
    " " + two(d.getHours()) + ":" + two(d.getMinutes());
}

/* ---------------- 预置卡片（只给预置示例账号） ---------------- */

/**
 * ⚠️ 做成**函数**（时间相对"现在"现算），与 `rawSeedBehavior()` 同一约定；
 * 且 `seedCardAt()` 必须**夹到过去**（否则上午打开 demo 会显示"刚刚"，第 34 轮踩过）。
 */
function seedCardAt(daysAgo, hhmm) {
  const d = new Date(Date.now() - daysAgo * DAY_MS);
  const hm = String(hhmm || "20:00").split(":");
  d.setHours(Number(hm[0]) || 0, Number(hm[1]) || 0, 0, 0);
  return Math.min(d.getTime(), Date.now() - 6 * 60 * 1000);
}

function seedCards(role) {
  if (role === "student") return seedStudentCards();
  const t1 = seedCardAt(3, "20:40");
  const t2 = seedCardAt(1, "19:20");
  return [
    {
      id: "wc-seed-1", title: "把下学期的课表转成能导入的格式", kind: "table",
      from: "文本转表格", fromId: "atom-text-to-table", role: "teacher", courseId: "ds",
      input: "把下学期的课表转成能导入的格式",
      secs: [{
        title: "文本转表格",
        lines: [
          "认出来 **3** 行，另有 **1** 行认不出来（**原样留着，我没猜**）：",
          "",
          "| 星期 | 节次 | 课程 | 教室 | 班级 |",
          "| --- | --- | --- | --- | --- |",
          "| 周一 | 第1-2节 | 数据结构与算法 | 6A-301 | 计科2301 |",
          "| 周二 | 第3-4节 | 操作系统 | 6B-105 | 计科2301 |",
          "| 周三 | 第5-6节 | 数据结构与算法 | 6A-301 | 计科2301 |",
          "",
          "**认不出来（原样保留）**",
          "- `这一行缺少节次`",
          "",
          "把上面这段粘回「课表与事项」页的导入框就能用。",
        ],
      }],
      notes: ["表格是我**逐行解析**出来的，不是模型猜的，所以每一格都能对回原文。"],
      createdAt: t1, updatedAt: t1,
    },
    {
      id: "wc-seed-2", title: "第 7 章教案自查一下", kind: "check",
      from: "教案自查", fromId: "atom-lesson-check", role: "teacher", courseId: "ds",
      input: "第 7 章教案自查一下",
      secs: [{
        title: "教案自查",
        lines: [
          "查了 **1** 份课时教案，发现 **2** 处要改：",
          "",
          "| 位置 | 问题 | 建议 |",
          "| --- | --- | --- |",
          "| 环节时长 | 加起来 33 分钟，课时是 45 分钟 | 不是错，但**差 12 分钟**要有个说法 |",
          "| 重点 / 难点 | 两句写的是同一件事 | 难点通常该写「学生为什么卡」 |",
          "",
          "这两处都是**能算出来的**（时长加总、字段比对），不是我读出来的感想。",
        ],
      }],
      notes: ["「教学意图写得好不好」那类判断我这儿做不了 —— 需要模型，也要你自己拿主意。"],
      createdAt: t2, updatedAt: t2,
    },
  ];
}
/* ============================================================
   技能执行：把一条链跑成结果（第 37 轮从 agent 两页收上来）
   ------------------------------------------------------------
   🔴 **唯一实现**：AI 助手两页与工作台都调这两个函数。
      以前 agent.html / agent-student.html 各写了一份 `runSkills`，两份逻辑一模一样 ——
      工作台再抄第三份就一定会歪。
   ============================================================ */

/**
 * 从一条技能链里挑出「真该跑」的 id。
 * 🔴 系统层默认只挂不跑（「应用地图 / 数据边界」那几篇说明不该把结果卡撑爆）——
 *    除非它自己被命中，或者这次一条能跑的都没有（那就给一份「我能干什么」当兜底）。
 */
function runnableIds(route) {
  const runnable = ((route && route.chain) || []).filter(function (s) {
    return typeof s.run === "function" || !!SKILL_RUNNERS[s.id];
  });
  let ids = runnable.filter(function (s) {
    return s.layer !== "system" || (s.hit || []).length > 0;
  }).map(function (s) { return s.id; });
  if (!ids.length) ids = runnable.map(function (s) { return s.id; });
  return ids;
}

/**
 * 一次执行里的「**主技能**」—— 用来定卡片类型与来源标签。
 * 优先级：**原子层命中的** > 原子层 > 群组层命中的 > 群组层 > 第一条。
 * ⚠️ 群组层那些"按你当前的课选中"的兜底项**不能当来源** ——
 *    拿它做标签，卡片上会写着「数据结构与算法」，而用户看不懂"这张卡片是谁做的"。
 */
function primarySkillId(route, ids) {
  const role = (route && route.role) === "student" ? "student" : "teacher";
  const list = (ids || []).map(function (id) { return skillOf(id, role) || skillAnyRole(id); }).filter(Boolean);
  const hit = function (s) { return (s.hit || []).length > 0; };
  const pick = list.filter(function (s) { return s.layer === "atomic" && hit(s); })[0]
    || list.filter(function (s) { return s.layer === "atomic"; })[0]
    || list.filter(function (s) { return s.layer === "group" && hit(s); })[0]
    || list.filter(function (s) { return s.layer === "group"; })[0]
    || list[0];
  return pick ? pick.id : "";
}

/** 跑一串技能 → `{ secs, notes, executed }`（与页面渲染需要的形状一致） */
function runSkillChain(ids, payload, ctx) {
  const o = ctx || {};
  const secs = [], notes = [], executed = [];
  const items = (ids || []).map(function (id) { return { id: id, sk: skillOf(id, o.role) }; })
    .filter(function (x) { return !!x.sk; });

  function apply(sk, r) {
    if (!r || !r.ok) {
      notes.push("「" + sk.name + "」没跑起来：" + ((r && r.error) || "未知原因"));
      return;
    }
    executed.push(sk.name);
    secs.push({ title: r.title || sk.name, lines: r.lines || [] });
    if (r.note) notes.push(r.note);
  }

  // ⚠️ 语气按角色分：学生端原来那句更贴（"这件事我会这么走…"），别一律用教师端口吻
  function stubFlow(sk) {
    const flow = (sk.steps || []).map(function (x) { return x.name; }).join(" → ");
    return { title: sk.name, lines: [o.role === "student"
      ? "这件事我会这么走：" + flow + "。想让我具体做，说清楚要哪一块。"
      : "「" + sk.name + "」这条技能的流程我记着：" + flow + "。要我具体做，把材料或目标说清楚一点。"] };
  }

  // 🔴 第 57 轮：技能可能返回 Promise（接了模型、要真去生成的那几个）→ 顺序串行执行。
  //    只要链里出现一个异步的，整体就返回 Promise；全是同步技能时照旧返回同步对象，
  //    老的同步调用方（以及桩化验证器）无需改动。
  function step(i) {
    if (i >= items.length) return null;
    const sk = items[i].sk, id = items[i].id;
    const canRun = typeof sk.run === "function" || !!SKILL_RUNNERS[id];
    if (!canRun) { secs.push(stubFlow(sk)); return step(i + 1); }
    const r = runSkill(id, payload, o);
    if (r && typeof r.then === "function") {
      return r.then(function (res) { apply(sk, res); }).then(function () { return step(i + 1); });
    }
    apply(sk, r);
    return step(i + 1);
  }

  const tail = step(0);
  const out = { secs: secs, notes: notes, executed: executed };
  return (tail && tail.then) ? tail.then(function () { return out; }) : out;
}

/**
 * 学生端的示例卡片 —— ⚠️ 与教师端**不是同一批**：
 * 教师端是"备课产物"，学生端是"我自己这摊事"，混着给会很出戏。
 */
function seedStudentCards() {
  const t1 = seedCardAt(2, "21:10");
  const t2 = seedCardAt(1, "19:40");
  return [
    {
      id: "wc-seed-s1", title: "我该从哪儿开始学", kind: "plan",
      from: "自学循环", fromId: "grp-self-study", role: "student", courseId: "ds",
      input: "我该从哪儿开始学",
      secs: [{
        title: "自学循环",
        lines: [
          "按你**自己的记录**排的（标过「懂了」的才算会，反复问又没标懂的就是还没通）：",
          "",
          "| 顺序 | 话题 | 凭什么这么排 |",
          "| --- | --- | --- |",
          "| 1 | 树 | 你已经标过「懂了」—— 从这儿切进去 |",
          "| 2 | 图 | 问过 2 次、还没标懂；它就是「不会绕回来的树」 |",
          "",
          "先啃第 2 个：**树 → 图只多出一件事** —— 你得记住自己来过哪儿。",
        ],
      }],
      notes: ["顺序能解释，不是我随口排的：先修关系是固定的，\"你会哪个\"来自你自己标的「懂了」。"],
      createdAt: t1, updatedAt: t1,
    },
    {
      id: "wc-seed-s2", title: "给我出几道自测题", kind: "quiz",
      from: "生成自测", fromId: "atom-gen-exercise", role: "student", courseId: "ds",
      input: "给我出几道自测题",
      secs: [{
        title: "生成自测",
        lines: [
          "题目**只有一道正文是模型写的**，其余都是我按你问过的问题整理的 —— 没配 Key 时如实给骨架。",
          "",
          "**围绕你反复卡住的那个话题：「图」（问过 2 次）**",
          "- 自测 1：Dijkstra 为什么不能有负权边？先把你自己问过的那句话再答一遍",
          "- 自测 2：把「树 → 图」这个类比补完 —— 图比树多出来的那一件事，具体多在哪一步？",
          "- 自测 3：换你出题给我：关于「图」，你觉得最容易被问倒的是什么？",
        ],
      }],
      notes: ["自测题按**你自己问过的原话**生成，不另编一套题库。答完再标一次「懂了」，画像就会跟着变。"],
      createdAt: t2, updatedAt: t2,
    },
  ];
}


/* ============================================================
   模拟器（第 38 轮）—— 一句话 → LLM 现场写一个可交互的小页面 → 下发学生
   ------------------------------------------------------------
   这是灵感 01「层 3」的**真正形态**：不是"收纳 AI 的答复"，而是
   **让 AI 现做一个能动手玩的小工具**（化学老师要的分子级反应模拟、
   物理老师要的电路搭建、数学老师要的函数图像探索……）。

   🔴 三条硬规矩
   1. **生成的是「单文件 HTML」**，在一个 sandbox iframe 里跑 ——
      `sandbox="allow-scripts"`（**不给 allow-same-origin**）：
      生成的代码拿不到父页面的 DOM / localStorage / Cookie，
      就算模型写歪了也伤不到应用本体。
   2. **不许假装生成了**：没有 Key / 请求失败 / 返回的不是 HTML，
      一律**如实说**，并给出可操作的下一步（去设置填 Key）。绝不静默塞个假货。
   3. **代码要能被老师看懂再发**：生成后先进「预览」，老师能**真的操作**，
      确认没问题才「下发给学生」—— 不给"一键直发"。

   ⚠️ 按账号分桶（`st_sims:<角色>:<账号>`）；与工作台卡片分开存：
      卡片是"读的东西"，模拟器是"要跑的东西"，混在一起界面没法做。
   ============================================================ */

var SIM_KEY = "st_sim";
/** 模拟器上限：到顶**拒绝新建并说清**，不静默淘汰 */
var SIM_MAX = 40;

/** 生成中的状态：界面据此显示进度，别让用户对着空白等 */
var SIM_STATUS = {
  idle:    { key: "idle",    label: "待生成" },
  working: { key: "working", label: "生成中" },
  ready:   { key: "ready",   label: "可试玩" },
  failed:  { key: "failed",  label: "生成失败" },
};

/** 服务商配置 —— 🔴 唯一来源，设置页与调用层都从这里取 */
var LLM_PROVIDERS = {
  demo: {
    key: "demo", label: "未接模型", endpoint: "", model: "",
    note: "不联网，用预置样例讲清流程",
  },
  deepseek: {
    key: "deepseek", label: "DeepSeek",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
    keyHint: "sk-…", docs: "platform.deepseek.com",
  },
  qwen: {
    key: "qwen", label: "通义千问",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen-plus",
    keyHint: "sk-…", docs: "bailian.console.aliyun.com",
  },
  zhipu: {
    key: "zhipu", label: "智谱 GLM",
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4-flash",
    keyHint: "…", docs: "open.bigmodel.cn",
  },
  // 用户自己部署 / 自建网关 / 中转站：地址与模型名都在设置页填（OpenAI 兼容）
  custom: {
    key: "custom", label: "自定义接口",
    endpoint: "", model: "",
    keyHint: "可留空（本地服务）", docs: "",
    note: "填你自己的 OpenAI 兼容地址与模型名；本地服务通常不需要 Key",
  },
};
var LLM_PROVIDER_FALLBACK = "demo";

/**
 * 把用户填的接口地址归一成可直接 POST 的 /chat/completions 地址。
 * 三种填法都认（减少"填了地址还是连不上"这类事故）：
 *   · https://host/v1/chat/completions → 原样
 *   · https://host/v1                  → 补 /chat/completions
 *   · https://host                     → 补 /v1/chat/completions
 */
function normalizeLlmEndpoint(raw) {
  var u = String(raw == null ? "" : raw).trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) {
    // 只填域名也接受：本机地址默认 http（Ollama / vLLM 通常没证书），其余默认 https
    var isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(u);
    u = (isLocal ? "http://" : "https://") + u;
  }
  u = u.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v\d+$/i.test(u)) return u + "/chat/completions";
  return u + "/v1/chat/completions";
}

/**
 * 读一个**字符串型**凭据（API Key 这类）。
 * ------------------------------------------------------------
 * 🔴 必须兼容两种落库方式 —— 这是端到端走查抓出来的真坑：
 *   · `LS.set()` / `store.set()` 会 `JSON.stringify` → 存的是 `"sk-xxx"`（带引号）；
 *   · 而设置页的 `#apiKey` / `#searchKey` 直接 `localStorage.setItem(k, v)` → 存的是裸 `sk-xxx`；
 *   · `LS.get()` 内部 `JSON.parse("sk-xxx")` 抛错 → 被 catch 吞掉 → 返回**空串**。
 *   症状：用户填了 Key、「测试连接」也通过（那处是裸读），可回到出题 / 课件重讲 / 工作台，
 *        仍然一律说「还没接模型」—— 因为 `llmReady()` 一直读成空。
 *   所以这里统一：能 JSON.parse 成字符串就用解析结果，否则按裸串用。
 */
function readKeyValue(k) {
  var raw = "";
  try { raw = window.localStorage.getItem(k) || ""; } catch (_) { return ""; }
  if (!raw) return "";
  try {
    var v = JSON.parse(raw);
    return (typeof v === "string") ? v : raw;
  } catch (_) { return raw; }
}

/** 当前配置（页面与设置页共用同一份键） */
function llmConfig() {
  var provider = LLM_PROVIDER_FALLBACK;
  // ⚠️ 不经过 LS：nav.js 可能被单独加载（没有 core.js 就没有 LS / STORE_KEY）。
  //    这里直接读 localStorage 并兼容「JSON 串 / 裸串」两种落库方式。
  try {
    var pKey = (typeof STORE_KEY !== "undefined" && STORE_KEY.provider) ? STORE_KEY.provider : "st_provider";
    var rawP = window.localStorage.getItem(pKey);
    var p = rawP;
    if (rawP) { try { var jp = JSON.parse(rawP); if (typeof jp === "string") p = jp; } catch (_) {} }
    if (p && LLM_PROVIDERS[p]) provider = p;
  } catch (_) {}
  // 🔴 用 readKeyValue 而不是 LS.get：设置页是**裸串**写的，JSON.parse 会失败。
  //    ⚠️ 外面这层 try/catch 不能省：nav.js 可能被单独加载（没有 core.js 就没有 STORE_KEY），
  //       求值 `STORE_KEY.apiKey` 会抛错 —— 那样 llmReady() 会**炸**而不是安静地返回 false。
  var key = "";
  try { key = readKeyValue(STORE_KEY.apiKey); } catch (_) {}

  var cfg = LLM_PROVIDERS[provider] || LLM_PROVIDERS.demo;
  // 自定义接口：地址与模型名不在常量表里，从设置页的存档读。
  // 🔴 必须复制一份再改 —— 别把 LLM_PROVIDERS.custom 本体改脏了（下次读就串味）。
  if (provider === "custom") {
    cfg = Object.assign({}, cfg);
    // ⚠️ 键名用字面量兜底：nav.js 可能被单独加载（此时没有 core.js 的 STORE_KEY）——
    //    和 hasApiKey() 同一个写法，别让「改个服务商」把整条链路抛错。
    var epKey = (typeof STORE_KEY !== "undefined" && STORE_KEY.customEndpoint) ? STORE_KEY.customEndpoint : "st_custom_endpoint";
    var mdKey = (typeof STORE_KEY !== "undefined" && STORE_KEY.customModel) ? STORE_KEY.customModel : "st_custom_model";
    try {
      cfg.endpoint = normalizeLlmEndpoint(readKeyValue(epKey));
      cfg.model = String(readKeyValue(mdKey) || "").trim();
    } catch (_) {}
  }
  return { provider: provider, key: key, cfg: cfg };
}

/** 能不能真调模型 —— 界面据此决定「生成」是可用还是给引导 */
function llmReady() {
  var c = llmConfig();
  if (c.provider === "demo" || !c.cfg || !c.cfg.endpoint) return false;
  // 自定义接口：只要有地址 + 模型名就算可用 —— 本地服务（Ollama 等）通常不要 Key
  if (c.provider === "custom") return !!c.cfg.model;
  return !!c.key;
}

function llmStatusText() {
  var c = llmConfig();
  if (c.provider === "demo") return "还没有接入模型 —— 去「设置 → 模型接入」选服务商并填 Key，就能真的生成";
  if (c.provider === "custom") {
    if (!c.cfg.endpoint) return "选了「自定义接口」但还没填接口地址 —— 去「设置 → 模型接入」填上";
    if (!c.cfg.model) return "自定义接口还缺模型名 —— 去「设置 → 模型接入」填上";
    return "已接入自定义接口（" + c.cfg.model + "），可以现场生成";
  }
  if (!c.key) return "选了 " + c.cfg.label + " 但还没填 API Key —— 去「设置 → 模型接入」填上";
  return "已接入 " + c.cfg.label + "（" + c.cfg.model + "），可以现场生成";
}


/* ---------------- 联网搜索（猜想验证用） ---------------- */

/**
 * 搜索 API 配置 —— 与 LLM 分开：LLM 负责「综合判断」，搜索 API 负责「上网找证据」。
 * 纯静态站没有后端转发，只能选支持浏览器直调（CORS）的搜索服务。
 * Tavily / Brave 都允许从浏览器 fetch，且有不绑卡的免费额度。
 */
var WEB_SEARCH_PROVIDERS = {
  none:  { key: "none",  label: "未配置", endpoint: "", method: "POST", note: "不联网，用预置示例" },
  tavily: {
    key: "tavily", label: "Tavily",
    endpoint: "https://api.tavily.com/search", method: "POST",
    auth: "bearer", keyHint: "tvly-…", docs: "tavily.com",
    note: "面向 AI 的检索，直接返回可喂给模型的摘要",
  },
  brave: {
    key: "brave", label: "Brave Search",
    endpoint: "https://api.search.brave.com/res/v1/web/search", method: "GET",
    auth: "subscription", keyHint: "BSA…", docs: "brave.com/search/api",
    note: "独立搜索索引，返回标题 / 链接 / 摘要",
  },
};

/** 当前搜索配置（设置页与调用层共用同一份键） */
function searchConfig() {
  var provider = "none";
  // ⚠️ 同上：不用 LS（nav.js 可能单独加载），并兼容 JSON 串 / 裸串
  try {
    var spKey = (typeof STORE_KEY !== "undefined" && STORE_KEY.searchProvider) ? STORE_KEY.searchProvider : "st_search_provider";
    var rawSp = window.localStorage.getItem(spKey);
    var sp = rawSp;
    if (rawSp) { try { var jsp = JSON.parse(rawSp); if (typeof jsp === "string") sp = jsp; } catch (_) {} }
    if (sp && WEB_SEARCH_PROVIDERS[sp]) provider = sp;
  } catch (_) {}
  // 🔴 同上：设置页的搜索 Key 也是裸串写的；同样保留 try/catch（nav.js 可能单独加载）
  var key = "";
  try { key = readKeyValue(STORE_KEY.searchKey); } catch (_) {}
  return { provider: provider, key: key, cfg: WEB_SEARCH_PROVIDERS[provider] || WEB_SEARCH_PROVIDERS.none };
}

/** 能不能真上网搜 —— 界面据此决定是「联网验证」还是「预置示例」 */
function searchReady() {
  var c = searchConfig();
  return !!(c.provider !== "none" && c.key && c.cfg && c.cfg.endpoint);
}

/**
 * 上网搜一次，返回规整后的结果：`Promise<{ok, results?:[{title,url,snippet}], n?, error?, hint?, demo?}>`。
 * 🔴 未配置如实拒绝（`demo:true`），**绝不返回假结果**。
 */
function webSearch(query) {
  var q = String(query || "").trim();
  var c = searchConfig();
  if (!q) return Promise.resolve({ ok: false, error: "先写一句想验证的猜想" });
  if (c.provider === "none" || !c.key) {
    return Promise.resolve({
      ok: false, demo: true,
      error: "还没配置联网搜索 —— 去「设置 → 联网搜索」选一个服务商并填 Key。",
      hint: "没配搜索也可以：如果接入了模型，会退回到「基于模型知识」验证（不联网）。",
    });
  }

  var cfg = c.cfg;
  var req;
  if (cfg.method === "GET") {
    var url = cfg.endpoint + "?q=" + encodeURIComponent(q) + "&count=5";
    req = fetch(url, { headers: { "Accept": "application/json", "X-Subscription-Token": c.key } });
  } else {
    req = fetch(cfg.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + c.key },
      body: JSON.stringify({ query: q, max_results: 5, search_depth: "basic" }),
    });
  }

  return req.then(function (res) {
    if (!res.ok) {
      return res.text().then(function (t) {
        var msg = "搜索请求被拒（HTTP " + res.status + "）";
        if (res.status === 401 || res.status === 403) msg += " —— Key 可能不对，或没开通搜索";
        else if (res.status === 429) msg += " —— 免费额度用完了";
        return { ok: false, error: msg + "。" + String(t || "").slice(0, 160) };
      });
    }
    return res.json().then(function (j) {
      var results = normalizeSearchResults(j, cfg.key);
      if (!results.length) return { ok: false, error: "搜索没返回任何结果，换个说法再试" };
      return { ok: true, results: results, n: results.length };
    });
  }).catch(function (err) {
    var m = String((err && err.message) || err);
    var hint = /Failed to fetch|NetworkError|load failed/i.test(m)
      ? "这次搜索没能发出去。若是浏览器拦了 CORS，换另一个搜索服务商（Tavily ↔ Brave）再试。"
      : "";
    return { ok: false, error: "搜索失败：" + m, hint: hint };
  });
}

/** 把两家返回的异构结构归一成 {title,url,snippet}，最多 5 条 */
function normalizeSearchResults(j, provider) {
  var out = [];
  try {
    var raw;
    if (provider === "tavily") raw = (j && j.results) || [];
    else if (provider === "brave") raw = (j && j.web && j.web.results) || [];
    else raw = (j && (j.results || j.data)) || [];
    raw.forEach(function (r) {
      if (!r) return;
      var title = String(r.title || "").trim();
      var url = String(r.url || "").trim();
      var snippet = String(r.content || r.description || r.snippet || "").trim();
      if (!url) return;
      out.push({ title: title || url, url: url, snippet: snippet });
    });
  } catch (_) {}
  return out.slice(0, 5);
}


/* ---------------- 提示词：让模型吐一个「工作台」 ---------------- */

/**
 * 工作台的系统提示词（第 41 轮）。
 * ------------------------------------------------------------
 * 与「教学模拟」那套提示词的区别只有一个：**产物是给人用的管理面板，不是给学生玩的交互玩具**。
 * （教学模拟已按用户要求整体移除，现在是**唯一**的生成提示词。）
 * 用户原话：「不是让你做个我已经有的工作台，我是让你做个让 ai 生产工作台」
 *   —— 工作台页的核心交互 = 说清想要什么 → AI 现场写一个 → 打开就能用。
 *
 * 🔴 三条与教学模拟不同的硬要求（生成的工作台要真能用）：
 *   1. **数据要存得住**：用 `localStorage` 自己存（键统一 `wstool:` 前缀），
 *      刷新不丢 —— 工作台不能"一刷新就回到空白"。
 *   2. **要能动手**：新增 / 勾选 / 删除 / 改状态至少一套，
 *      只有展示没有操作的只是一个报表，不是工作台。
 *   3. **统计与图表自己算**：KPI 数、占比条、趋势图（SVG 手绘），
 *      让用户一眼看出"现在什么情况"。
 */
function wsSystemPrompt(subject) {
  return [
    "你是一个「工作台」生成器 —— 用户会用自然语言说清他想要一个什么样的管理面板，你把它做出来。",
    "产物是一个**单文件 HTML**，功能上要像一个能天天用的小工具（记账、清单、看板、台账……），而不是一张静态报表。",
    "",
    "## 硬性要求",
    "1. 只输出 HTML 代码本身，从 <!DOCTYPE html> 开始到 </html> 结束。",
    "2. 全部内联（样式写在 <style>，逻辑写在 <script>）—— **禁止任何外部请求**：",
    "   不引 CDN、不加载字体图片；要用图就自己用 SVG / Canvas 画。",
    "3. 中文界面；字号不小于 13px；在 1100×700 的窗口里能用，窄到 360px 也不能错位。",
    "4. 控件要**真能用**：至少包含「新增一条 / 勾选完成 / 删除 / 改状态」这样的操作闭环。",
    "5. 要有**统计区**：几个关键数字（如总数、完成数、逾期数）+ 一个占比条或趋势图（SVG 手绘），",
    "   让用户扫一眼就知道现在什么情况。",
    "6. 数据用 `localStorage` 存住（键名统一以 `wstool:` 开头，如 `wstool:items`），",
    "   页面加载时读回、每次改动就写回 —— **刷新页面数据不能丢**。",
    "7. 顶部写清这个工作台是干什么的（一句话）+ 当前数据概览。",
    "",
    "## 设计",
    "- 配色克制、留白舒服，用系统字体栈；不要花哨动画。",
    "- 空数据时给一句友好的引导（如「还没有记录，点右上角新增一条」），不要留一片空白。",
    "- 删除这类不可逆操作要二次确认。",
    subject ? ("- 这个工作台的使用场景：" + subject) : "",
    "",
    "现在开始。只输出 HTML，不要任何解释、不要 markdown 围栏。",
  ].filter(Boolean).join("\n");
}

function wsUserPrompt(goal, subject) {
  var lines = ["我想要一个这样的工作台：", "", goal];
  if (subject && String(subject).trim()) lines.push("", "场景 / 学科：" + String(subject).trim());
  return lines.join("\n");
}

/* ---------------- 从模型返回里抠出 HTML ---------------- */

/**
 * 模型经常不听话：套 markdown 围栏、加前后缀、甚至写一段解释再说"代码如下"。
 * 这里尽最大努力把 HTML 抠出来；**抠不出来就如实说**，不要硬塞。
 */
function extractHtml(raw) {
  var s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  // ① 有围栏就先取围栏里的（取第一个 html 围栏，没有就取第一个围栏）
  var fence = s.match(/```(?:html|HTML)?\s*\n([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // ② 从 <!DOCTYPE 或 <html 开始截
  var i = s.search(/<!DOCTYPE\s+html/i);
  if (i < 0) i = s.search(/<html[\s>]/i);
  if (i > 0) s = s.slice(i).trim();
  // ③ 截到最后一个 </html>
  var j = s.toLowerCase().lastIndexOf("</html>");
  if (j >= 0) s = s.slice(0, j + 7).trim();
  return s;
}

/** 生成结果的体检 —— 不合格宁可拒绝，也别把半成品发给学生 */
function validateSimHtml(html) {
  var h = String(html || "");
  if (!h) return { ok: false, error: "没拿到任何内容" };
  if (!/<!DOCTYPE\s+html/i.test(h) && !/<html[\s>]/i.test(h)) {
    return { ok: false, error: "返回的不是一个 HTML 页面" };
  }
  if (!/<body[\s>]/i.test(h)) return { ok: false, error: "HTML 里没有 <body>" };
  if (!/<\/html>\s*$/i.test(h)) return { ok: false, error: "HTML 不完整（结尾被截断了）" };
  if (h.length < 400) return { ok: false, error: "内容太短（" + h.length + " 字符），不像一个能用的模拟" };
  // 外部请求是硬伤：沙箱里本来就跑不通，留着只会让模拟"看起来坏了"
  var ext = h.match(/https?:\/\/[^\s"')]+/g) || [];
  var banned = ext.filter(function (u) { return !/^https?:\/\/(www\.)?w3\.org\//i.test(u); });
  if (banned.length) {
    return { ok: false, error: "里面有外部请求（" + banned[0].slice(0, 60) + "…），沙箱里加载不出来。让它改用 SVG / Canvas 画。" };
  }
  return { ok: true };
}

/* ---------------- 真调模型 ---------------- */

/**
 * **通用**的一次模型调用（OpenAI 兼容接口）。工作台与出题共用这一条链路。
 * 🔴 三条铁律都在这里：
 *   ① **未接模型或无 Key 时如实拒绝**（`demo:true`）—— **绝不返回任何假内容**；
 *   ② 失败要给**可操作的下一步**（`hint`）；
 *   ③ **不在这里做内容校验** —— HTML 与 JSON 的规矩不一样，交给各自的调用方。
 * 返回 `Promise<{ok, raw?, model?, provider?, error?, hint?, demo?}>`。
 */
function llmChat(system, user, opt) {
  var o = opt || {};
  var c = llmConfig();

  var ready = false;
  try { ready = llmReady(); } catch (_) {}
  if (!ready) {
    var why;
    if (c.provider === "demo") {
      why = "还没接入模型，不会真去写代码。去「设置 → 模型接入」选一个服务商（或填自己的接口地址）并填上 API Key。";
    } else if (c.provider === "custom") {
      why = !c.cfg.endpoint
        ? "选了「自定义接口」但还没填接口地址 —— 去「设置 → 模型接入」填上。"
        : "自定义接口还缺模型名 —— 去「设置 → 模型接入」填上（例如 gpt-4o-mini / qwen2.5:7b）。";
    } else {
      why = "选了 " + c.cfg.label + " 但还没填 API Key。去「设置 → 模型接入」填上。";
    }
    return Promise.resolve({
      ok: false, demo: true,
      error: why,
      hint: "填好后回到这里再点一次，它会真的现场写出来。",
    });
  }
  if (!c.cfg.endpoint) return Promise.resolve({ ok: false, error: "这个服务商没有配置调用地址" });

  var body = {
    model: c.cfg.model,
    messages: [
      { role: "system", content: String(system || "") },
      { role: "user", content: String(user || "") },
    ],
    temperature: o.temperature == null ? 0.4 : o.temperature,
    max_tokens: o.maxTokens || 8000,
    stream: false,
  };

  // 自定义接口可能没有 Key（本地服务）→ 这时不发明 Authorization 头
  var headers = { "Content-Type": "application/json" };
  if (c.key) headers["Authorization"] = "Bearer " + c.key;

  return fetch(c.cfg.endpoint, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(body),
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (t) {
        var msg = "请求被拒（HTTP " + res.status + "）";
        if (res.status === 401 || res.status === 403) msg += " —— Key 可能不对，或被服务商限制了";
        else if (res.status === 429) msg += " —— 请求太频繁或额度用完了";
        else if (res.status >= 500) msg += " —— 服务商那边出错了，等会儿再试";
        return { ok: false, error: msg + "。" + String(t || "").slice(0, 200) };
      });
    }
    return res.json().then(function (j) {
      var raw = "";
      try { raw = j.choices[0].message.content || ""; } catch (_) {}
      if (!raw) return { ok: false, error: "返回里没有内容（可能被内容策略拦了，换个说法试试）" };
      return { ok: true, raw: raw, model: c.cfg.model, provider: c.provider };
    });
  }).catch(function (err) {
    var m = String((err && err.message) || err);
    var hint = /Failed to fetch|NetworkError|load failed/i.test(m)
      ? "这次请求没能发出去。如果是浏览器拦的 CORS，换 DeepSeek / 通义 / 智谱 这类支持直调的厂商，或确认自建接口允许跨域（Access-Control-Allow-Origin）；也确认下网络与地址是否可达。"
      : "";
    return { ok: false, error: "调用失败：" + m, hint: hint };
  });
}

/**
 * 生成一个工作台的 HTML（第 43 轮起只做工作台 —— 教学模拟已整体移除）。
 * 🔴 返回 Promise<{ok, html?, error?}>；**任何失败都如实返回**，页面负责显示。
 * ⚠️ 未接模型由 `llmChat` 直接挡掉 —— 不返回任何假 HTML。
 */
function generateSimHtml(goal, opt) {
  var text = String(goal || "").trim();
  var o = (opt && typeof opt === "object") ? opt : {};
  if (!text) return Promise.resolve({ ok: false, error: "先说一句你要什么工作台" });

  return llmChat(wsSystemPrompt(o.subject), wsUserPrompt(text, o.subject)).then(function (r) {
    if (!r.ok) return r;
    var html = extractHtml(r.raw);
    var v = validateSimHtml(html);
    if (!v.ok) return { ok: false, error: "生成的内容没法用：" + v.error, raw: r.raw };
    return { ok: true, html: html, model: r.model, provider: r.provider };
  });
}

/* ---------------- 模拟器存储（按账号分桶） ---------------- */

function simStoreKey() {
  var u = "";
  try { u = (typeof currentUserKey === "function") ? currentUserKey() : ""; } catch (_) {}
  if (u) return SIM_KEY + ":" + u;
  return SIM_KEY;
}

var SIM_SEQ = 0;
function nextSimId() {
  SIM_SEQ += 1;
  return "sim-" + Date.now().toString(36) + "-" + SIM_SEQ;
}

/** 形状归一 —— 存档可能被手改，缺什么补什么，枚举字段一律兜底 */
function normalizeSims(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(function (s) { return s && typeof s === "object" && s.html; }).map(function (s) {
    var st = (s.status && SIM_STATUS[s.status]) ? s.status : "ready";
    return {
      id: String(s.id || nextSimId()),
      title: String(s.title || "未命名模拟"),
      goal: String(s.goal || ""),
      subject: String(s.subject || ""),
      // 用途：workbench = AI 造的工作台；sim = 教学模拟。老记录没有这个字段 → 当 sim
      kind: s.kind === "workbench" ? "workbench" : "sim",
      html: String(s.html),
      status: st,
      provider: String(s.provider || ""),
      model: String(s.model || ""),
      createdBy: String(s.createdBy || ""),
      createdAt: Number(s.createdAt) || Date.now(),
      // 下发记录：老师发给了谁（空数组 = 还没发）
      sentTo: Array.isArray(s.sentTo) ? s.sentTo.filter(function (x) { return x && x.who; }).map(function (x) {
        return { who: String(x.who), at: Number(x.at) || Date.now() };
      }) : [],
      // 学生的使用反馈
      feedback: Array.isArray(s.feedback) ? s.feedback.filter(function (f) { return f && f.who; }).map(function (f) {
        return {
          who: String(f.who), at: Number(f.at) || Date.now(),
          observed: String(f.observed || ""),
          status: (f.status === "done" || f.status === "trying") ? f.status : "trying",
        };
      }) : [],
    };
  });
}

/**
 * 预置种子工作台 —— 一个**真能用**的作业提交跟踪面板（第 41 轮）。
 * 🔴 它必须真的能勾、能加、能删、能算提交率。
 *    展示时点开就是"AI 造出来的工作台长这样"，不能是一张静态图
 *    （第 37 轮"点了没反应"的教训）。
 */
var SEED_WORKBENCH_HW = {
  id: "wb-seed-1",
  title: "作业提交跟踪",
  goal: "带一门课，想看谁交了、谁还没交，一眼知道还差几个人。",
  subject: "教学事务",
  kind: "workbench",
  status: "ready",
  provider: "sample",
  model: "",
  createdAt: Date.now() - 5400e3,
  html: [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>作业提交跟踪</title><style>',
    ':root{--bg:#0f1115;--card:#161a20;--bd:#262b33;--tx:#e8eaed;--mut:#9aa0a6;--pr:#5b9dff;--ok:#3ecf8e;--wn:#f0b429}',
    '*{box-sizing:border-box}body{margin:0;font:14px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif;background:var(--bg);color:var(--tx);padding:18px}',
    'h1{margin:0 0 2px;font-size:17px}.sub{color:var(--mut);font-size:12.5px;margin-bottom:14px}',
    '.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}',
    '.st{background:var(--card);border:1px solid var(--bd);border-radius:11px;padding:11px 13px}',
    '.st .n{font-size:23px;font-weight:600;font-variant-numeric:tabular-nums}.st .l{color:var(--mut);font-size:12px}',
    '.bar{height:7px;background:var(--card);border:1px solid var(--bd);border-radius:99px;overflow:hidden;margin-bottom:16px}',
    '.bar i{display:block;height:100%;background:var(--ok);transition:width .3s}',
    '.add{display:flex;gap:8px;margin-bottom:12px}',
    'input{flex:1 1 auto;background:var(--bg);border:1px solid var(--bd);color:var(--tx);border-radius:9px;padding:9px 11px;font:inherit;font-size:13px}',
    'button{background:var(--pr);color:#fff;border:0;border-radius:9px;padding:9px 15px;font:inherit;font-size:13px;cursor:pointer}',
    '.row{display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:9px 12px;margin-bottom:7px}',
    '.row.done{opacity:.55}.row.done .nm{text-decoration:line-through}',
    '.nm{flex:1 1 auto}.tag{font-size:11.5px;padding:1px 8px;border-radius:99px;background:rgba(240,180,41,.15);color:var(--wn)}',
    '.row.done .tag{background:rgba(62,207,142,.15);color:var(--ok)}',
    '.ib{border:0;background:transparent;color:var(--mut);cursor:pointer;font-size:15px;padding:0 3px}.ib:hover{color:var(--tx)}',
    '.empty{text-align:center;color:var(--mut);font-size:13px;padding:26px;border:1px dashed var(--bd);border-radius:11px}',
    '@media(max-width:520px){.stats{grid-template-columns:repeat(2,1fr)}}',
    '</style></head><body>',
    '<h1>作业提交跟踪</h1><div class="sub">勾一下就记下谁交了 —— 数据存在本机，刷新不丢。</div>',
    '<div class="stats"><div class="st"><div class="n" id="sAll">0</div><div class="l">总人数</div></div>',
    '<div class="st"><div class="n" id="sDone">0</div><div class="l">已交</div></div>',
    '<div class="st"><div class="n" id="sLeft">0</div><div class="l">未交</div></div>',
    '<div class="st"><div class="n" id="sRate">0%</div><div class="l">提交率</div></div></div>',
    '<div class="bar"><i id="bar" style="width:0"></i></div>',
    '<div class="add"><input id="nm" placeholder="输入学生姓名，回车加入"><button id="add">加入</button></div>',
    '<div id="list"></div>',
    '<script>',
    'var KEY="wstool:hw",items=[];',
    'try{items=JSON.parse(localStorage.getItem(KEY)||"[]")||[]}catch(e){items=[]}',
    'if(!items.length){items=[{n:"李思",d:true},{n:"王五",d:false},{n:"赵六",d:false},{n:"孙七",d:true}]}',
    'function save(){try{localStorage.setItem(KEY,JSON.stringify(items))}catch(e){}}',
    'function render(){',
    '  var all=items.length,done=items.filter(function(x){return x.d}).length,left=all-done;',
    '  document.getElementById("sAll").textContent=all;',
    '  document.getElementById("sDone").textContent=done;',
    '  document.getElementById("sLeft").textContent=left;',
    '  document.getElementById("sRate").textContent=(all?Math.round(done/all*100):0)+"%";',
    '  document.getElementById("bar").style.width=(all?done/all*100:0)+"%";',
    '  var box=document.getElementById("list");box.innerHTML="";',
    '  if(!items.length){var e=document.createElement("div");e.className="empty";e.textContent="还没有学生，上面加一个";box.appendChild(e);return}',
    '  items.forEach(function(it,i){',
    '    var r=document.createElement("div");r.className="row"+(it.d?" done":"");',
    '    var cb=document.createElement("span");cb.className="ib";cb.textContent=it.d?"\\u2611":"\\u2610";',
    '    cb.onclick=function(){it.d=!it.d;save();render()};',
    '    var nm=document.createElement("span");nm.className="nm";nm.textContent=it.n;',
    '    var tg=document.createElement("span");tg.className="tag";tg.textContent=it.d?"已交":"未交";',
    '    var del=document.createElement("button");del.className="ib";del.textContent="\\u2715";',
    '    del.onclick=function(){items.splice(i,1);save();render()};',
    '    r.appendChild(cb);r.appendChild(nm);r.appendChild(tg);r.appendChild(del);box.appendChild(r);',
    '  });',
    '}',
    'document.getElementById("add").onclick=function(){',
    '  var v=document.getElementById("nm").value.trim();if(!v)return;',
    '  items.push({n:v,d:false});document.getElementById("nm").value="";save();render();',
    '};',
    'document.getElementById("nm").addEventListener("keydown",function(e){if(e.key==="Enter")document.getElementById("add").click()});',
    'render();',
    '<\\/script></body></html>',
  ].join(""),
};

/**
 * 预置种子：一个**真能用**的工作台（作业提交跟踪）。
 * 🔴 两端都给、且**带下发记录**：教师端看到"我造的"，学生端通过跨桶读到"老师发来的"，
 *    同一份（同 id → 去重）—— 纯静态没有真服务端，这是让"下发 → 学生能用"
 *    这条闭环一个人就能走完的最近近似。
 */
function seedApps() {
  return [Object.assign({}, SEED_WORKBENCH_HW, {
    createdBy: "teacher:teacher",
    sentTo: [{ who: "student:student", at: Date.now() - 5400e3 }],
  })];
}

/**
 * 🔴 `loadSims` / `saveSims` **不许用 `LS`**（第 42 轮修的一个真 bug）：
 * `LS` 定义在 `core.js`，而这两个函数里有一个在 nav.js **顶层**跑（`var SIMS = loadSims()`）——
 * 那时 core.js 还没加载，`LS` 在 TDZ → 抛错被 catch 吞掉 → **存档永远读不回来，每次打开都回到种子**
 * （第 38 轮起就这么坏着，一直没被发现，因为没人测过"存过之后再打开"）。
 * 一律直接用 `window.localStorage`，并自己处理编码（见 `readSimBucket`）。
 */
function loadSims() {
  const key = simStoreKey();
  const user = (typeof currentUserKey === "function") ? currentUserKey() : "";

  const saved = readSimBucket(key);
  if (saved) return saved;               // ⚠️ 空数组也算有效（删光模拟不该复活预置数据）

  // 预置账号给一个真能玩的模拟；自注册账号从**空的**开始
  return (!user || isSeedAccount(user)) ? normalizeSims(seedApps()) : [];
}

function saveSims() {
  try { window.localStorage.setItem(simStoreKey(), JSON.stringify(SIMS)); } catch (_) {}
}

var SIMS = loadSims();

function simOf(id) {
  for (var i = 0; i < SIMS.length; i++) if (SIMS[i].id === id) return SIMS[i];
  return null;
}

/**
 * 按用途挑（第 41 轮）：`"workbench"` = AI 造的工作台；`"sim"` = 教学模拟。
 * 两者共用同一个存储桶（都是"AI 生成的页面"），靠 `kind` 字段分开显示。
 * 老记录没有 kind → 当教学模拟。
 */
function appsOfKind(list, kind) {
  var k = kind === "workbench" ? "workbench" : "sim";
  return (list || []).filter(function (s) {
    return (s && s.kind === "workbench" ? "workbench" : "sim") === k;
  });
}

function createSim(data) {
  var d = data || {};
  var title = String(d.title || d.goal || "").trim();
  if (!title) return { ok: false, error: "给这个模拟起个名字（或者写清楚要模拟什么）" };
  if (SIMS.length >= SIM_MAX) {
    return { ok: false, error: "模拟器到上限了（" + SIM_MAX + " 个）。先删掉几个 —— 我不会替你丢东西。" };
  }
  var html = String(d.html || "");
  var v = validateSimHtml(html);
  if (!v.ok) return { ok: false, error: v.error };

  var now = Date.now();
  var sim = {
    id: nextSimId(),
    title: title.length > 40 ? title.slice(0, 40) : title,
    goal: String(d.goal || title),
    subject: String(d.subject || ""),
    kind: d.kind === "workbench" ? "workbench" : "sim",
    html: html,
    status: "ready",
    provider: String(d.provider || ""),
    model: String(d.model || ""),
    createdBy: (typeof currentUserKey === "function") ? currentUserKey() : "",
    createdAt: now,
    sentTo: [],
    feedback: [],
  };
  SIMS.unshift(sim);
  saveSims();
  return { ok: true, sim: sim };
}

function updateSim(id, patch) {
  var s = simOf(id);
  if (!s) return { ok: false, error: "找不到这个模拟" };
  if (patch && patch.title != null) {
    var t = String(patch.title).trim();
    if (!t) return { ok: false, error: "名字不能空着" };
    s.title = t.length > 40 ? t.slice(0, 40) : t;
  }
  saveSims();
  return { ok: true, sim: s };
}

function deleteSim(id) {
  var i = -1;
  for (var k = 0; k < SIMS.length; k++) if (SIMS[k].id === id) { i = k; break; }
  if (i < 0) return { ok: false, error: "找不到这个模拟" };
  var s = SIMS[i];
  var sent = s.sentTo.length;
  SIMS.splice(i, 1);
  saveSims();
  return { ok: true, sentCount: sent };
}

/** 删之前先把影响数清楚（和删课程、删活动同一个道理） */
function simAssetCount(id) {
  var s = simOf(id);
  if (!s) return "这个模拟已经不在了";
  var parts = [];
  if (s.sentTo.length) parts.push("已经发给 " + s.sentTo.length + " 位学生");
  if (s.feedback.length) parts.push("收到 " + s.feedback.length + " 条使用反馈");
  return parts.length ? parts.join("，") : "还没发出去过";
}

/* ---------------- 下发 ---------------- */

/**
 * 下发给一批学生。
 * 🔴 同一人重复发**不重复记账**（改时间戳），不然学生端会看到好几个一模一样的。
 */
function sendSimTo(id, whoList) {
  var s = simOf(id);
  if (!s) return { ok: false, error: "找不到这个模拟" };
  var list = (whoList || []).map(function (w) { return String(w || "").trim(); }).filter(Boolean);
  if (!list.length) return { ok: false, error: "先选要发给谁" };
  var now = Date.now(), added = 0, updated = 0;
  list.forEach(function (who) {
    var hit = null;
    for (var i = 0; i < s.sentTo.length; i++) if (s.sentTo[i].who === who) { hit = s.sentTo[i]; break; }
    if (hit) { hit.at = now; updated++; }
    else { s.sentTo.push({ who: who, at: now }); added++; }
  });
  saveSims();
  return { ok: true, added: added, updated: updated, total: s.sentTo.length };
}

/**
 * 「发给我的」—— 🔴 必须**跨账号桶**读（第 42 轮修的一个真 bug）。
 *
 * 第 38 轮只查当前账号自己的 `SIMS`：老师在 `teacher:teacher` 桶里下发，
 * 学生 `student:xxx` 打开时读的是**自己的**桶 → **根本看不到**，下发形同虚设
 * （当时靠"种子里就带下发记录"糊过去，真机上下发是假的）。
 *
 * 这里照 `courseArchives()` 的思路：**由账号库 `st_accounts` 推出各账号的桶键，逐个读**
 * （不用枚举 localStorage 的键 —— `length`/`key(i)` 在隐私模式与桩环境里不一定给）。
 * 🔴 按 `id` 去重：同一份可能在多个桶里都存着（种子两端各一份）。
 */
/**
 * 本机各账号的某个存储桶键（含全局桶与当前账号桶），去重。
 * 🔴 由账号库 `st_accounts` **推出**键名，不许枚举 `localStorage.key(i)`
 *    —— 隐私模式与桩环境里 `length` / `key(i)` 不一定给（照 `courseArchives()` 的思路）。
 * `currentKey`：当前账号桶的键（可能与其他写法不同，一并带上）。
 */
function bucketKeys(baseKey, currentKey) {
  var keys = [baseKey];
  try {
    var list = JSON.parse(window.localStorage.getItem(ACCOUNT_KEY) || "[]");
    (Array.isArray(list) ? list : []).forEach(function (a) {
      if (a && a.role && a.user) {
        var base = a.role + ":" + String(a.user);
        keys.push(baseKey + ":" + base);
        keys.push(baseKey + ":" + base.toLowerCase());
      }
    });
  } catch (_) { /* 账号库读不出来 → 至少还有全局桶 */ }
  if (currentKey) keys.push(currentKey);
  var seen = {}, out = [];
  keys.forEach(function (k) { if (k && !seen[k]) { seen[k] = 1; out.push(k); } });
  return out;
}

/**
 * 读一个桶。**唯一的读桶实现**，两个坑都在这里：
 *  ① 🔴 **不能用 `LS`** —— 它定义在 `core.js`（后加载），而 `loadSims()` / `loadExams()` 在
 *     nav.js **顶层**跑，那时 `LS` 还在 TDZ → 抛错被 catch 吞掉 → **存档永远读不回来**。
 *  ② 🔴 **要兼容两种编码**：老档是**双重编码**（`JSON.stringify` 之后又被 stringify 了一次），
 *     新写法是单层。都认，才能既读回老档、又不再制造新坑。
 *     ⚠️ 只 `JSON.parse` 一次的话，双重编码会解析出**字符串**，normalize 拿到非数组 → 全丢（踩过）。
 */
function readBucket(baseKey, key, normalize) {
  try {
    var raw = window.localStorage.getItem(key);
    if (!raw) return null;
    var v = JSON.parse(raw);
    if (typeof v === "string") v = JSON.parse(v);   // 老档的双重编码
    return normalize(v);
  } catch (_) { return null; }
}

/** 模拟器 / 工作台桶的薄封装（保留旧名，行为不变） */
function readSimBucket(key) { return readBucket(SIM_KEY, key, normalizeSims); }

/** 本机各账号的模拟桶键（含全局桶与当前账号桶），去重 */
function simBucketKeys() {
  return bucketKeys(SIM_KEY, (typeof simStoreKey === "function") ? simStoreKey() : "");
}

function simsForStudent(who) {
  var w = String(who || "").trim().toLowerCase();
  if (!w) return [];

  var seen = {}, out = [];
  var take = function (arr) {
    (arr || []).forEach(function (s) {
      if (!s || !s.id || seen[s.id]) return;
      var hit = (s.sentTo || []).some(function (x) {
        return String((x && x.who) || "").toLowerCase() === w;
      });
      if (hit) { seen[s.id] = 1; out.push(s); }
    });
  };
  take(SIMS);                                  // 先看内存里最新的（可能刚发完还没落盘到别的键）
  simBucketKeys().forEach(function (k) { take(readSimBucket(k)); });
  return out;
}

/**
 * 找一条记录：先本桶（内存里最新），再各账号桶。
 * 学生端打开"老师发来的那份"时用 —— 它不在学生的桶里，`simOf()` 取不到。
 */
function simOfAnywhere(id) {
  var s = simOf(id);
  if (s) return s;
  var target = String(id || "");
  var hit = null;
  simBucketKeys().forEach(function (k) {
    if (hit) return;
    var list = readSimBucket(k);
    (list || []).forEach(function (x) { if (!hit && x.id === target) hit = x; });
  });
  return hit;
}

/**
 * 在**记录所在的桶**上改（可能不是我自己的桶）。
 * 学生给"老师发来的模拟"写反馈时用 —— 反馈要落到老师那份记录上，老师才看得到。
 * ⚠️ 纯静态单机：同一时刻只有一个账号在操作，所以"写别人的桶"不会撞车；
 *    真多端同时编辑本来也不是这套方案能解决的（站点没有服务端）。
 */
function simWriteTo(id, fn) {
  var s = simOf(id);
  if (s) { fn(s); saveSims(); return { ok: true }; }
  var target = String(id || "");
  var keys = simBucketKeys();
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var list = readSimBucket(k);
    if (!list) continue;
    var hit = null;
    for (var j = 0; j < list.length; j++) if (list[j].id === target) { hit = list[j]; break; }
    if (!hit) continue;
    fn(hit);
    // 写回与 `saveSims()` **同一种编码**（单层），`readSimBucket` 两种都认
    try { window.localStorage.setItem(k, JSON.stringify(list)); } catch (_) { /* 写不进去就算了，调用方如实报错 */ }
    return { ok: true };
  }
  return { ok: false, error: "找不到这个模拟" };
}

/* ============================================================
   出题与组卷（exam）—— 唯一来源
   ------------------------------------------------------------
   教师端「出题与组卷」页（`exam.html`）：
     圈章节范围（来自**真实教案大纲** `SYLLABUS`）→ AI 出题 → 逐题审核 → 组卷 → 发布到班级
   学生端「我的作业」页（`homework.html`）：跨账号桶读老师发来的卷子。

   🔴 四条硬规矩
   1. **章节范围来自 `syllabusOf(course).chapters`** —— 不许在页面里自己再写一份章节表
      （老版 `exam.html` 就是写死 4 章的静态壳）
   2. **出题真接模型**（`generateExamQuestions`）；未接模型时**如实拒绝**，
      绝不拼一份假题冒充 AI 出的（可另给「示例题」入口，但必须**明确标注是预置示例**）
   3. 🔴 **成卷不自动发布**：至少要有一道「已采纳」才允许发，且发布是**另一个动作**
   4. 🔴 发给学生的记录**不重复记账**；学生端**跨账号桶**读（与工作台下发同一套规矩）
   ============================================================ */

var EXAM_KEY = "st_exam";
/** 试卷上限：到顶**拒绝新建并说清**，不静默淘汰 */
var EXAM_MAX = 60;

/** 题型（模型返回的 type 不在这张表里 → 兜底成 short） */
var EXAM_TYPES = {
  single: { key: "single", label: "单选" },
  multi:  { key: "multi",  label: "多选" },
  blank:  { key: "blank",  label: "填空" },
  short:  { key: "short",  label: "简答" },
};

/**
 * 🔴 出题时可选的题型（页面按这张表画勾选项）。
 * 用户明确要的四种：**选择（单选）/ 多选 / 填空 / 简答** —— 全部默认勾上。
 * ⚠️ 不做编程题（用户 2026-10-07 明确要求）—— 别再加回来。
 */
var EXAM_QTYPES = [
  { key: "single", label: "单选", on: true },
  { key: "multi",  label: "多选", on: true },
  { key: "blank",  label: "填空", on: true },
  { key: "short",  label: "简答", on: true },
];

/** 出题题型配置的合法范围（存档被手改过也不怕） */
function examPickTypes(raw) {
  var list = Array.isArray(raw) ? raw.filter(function (k) { return !!EXAM_TYPES[k]; }) : [];
  return list.length ? list : EXAM_QTYPES.filter(function (t) { return t.on; }).map(function (t) { return t.key; });
}

function examTypeLabel(k) { return (EXAM_TYPES[k] || {}).label || String(k || ""); }

/** 难度 */
var EXAM_DIFF = {
  basic: { key: "basic", label: "基础" },
  mid:   { key: "mid",   label: "中等" },
  hard:  { key: "hard",  label: "综合" },
};

/** 一道题的审核状态 —— 🔴 出题后**一律 pending**，采纳与否是老师的动作 */
var EXAM_QSTATE = {
  pending:  { key: "pending",  label: "待审" },
  accepted: { key: "accepted", label: "已采纳" },
  flagged:  { key: "flagged",  label: "待确认" },
  dropped:  { key: "dropped",  label: "已弃用" },
};

/** 整卷状态 */
var EXAM_STATE = {
  draft:     { key: "draft",     label: "草稿" },
  published: { key: "published", label: "已发布" },
};

/** 难度档 → 出题时的配比提示（默认按常见教学节奏） */
var EXAM_DIFF_PLAN = {
  basic: "基础为主（基础 6 : 中等 3 : 综合 1）",
  mid:   "均衡（基础 4 : 中等 4 : 综合 2）",
  hard:  "偏难（基础 2 : 中等 4 : 综合 4）",
};

function examStoreKey() {
  var u = "";
  try { u = (typeof currentUserKey === "function") ? currentUserKey() : ""; } catch (_) {}
  return u ? EXAM_KEY + ":" + u : EXAM_KEY;
}

var EXAM_SEQ = 0;
function nextExamId() {
  EXAM_SEQ += 1;
  return "exam-" + Date.now().toString(36) + "-" + EXAM_SEQ;
}

/**
 * 选择题答案 → `"ABD"`（大写、去重、按字母升序）。
 * 🔴 多选必须归一：模型可能给 `"DBA"` / `"A、B、D"` / `"abd"`，
 *    不排好序，"答全才给分"的判定就会乱。
 * 顺带把**指向不存在选项**的字母丢掉（4 个选项只能答 A–D）。
 */
function normalizeAnswerLetters(s, optCount) {
  var seen = {}, out = [];
  String(s == null ? "" : s).toUpperCase().replace(/[^A-Z]/g, "").split("").forEach(function (ch) {
    var idx = ch.charCodeAt(0) - 65;
    if (optCount && idx >= optCount) return;
    if (!seen[ch]) { seen[ch] = 1; out.push(ch); }
  });
  return out.sort().join("");
}

/**
 * 一道题的形状归一（模型返回的东西一个字都不能信）。
 * 🔴 两种题型各有自己的"形状"，在这里一并收拾：
 *    · **多选**：答案统一成字母升序去重（见 `normalizeAnswerLetters`）
 *    · **填空**：支持**多空** —— 既认 `blanks: []`，也认 `answer: "甲||乙"` 这种写法；
 *      归一后 `blanks` 恒为数组（单空就是长度 1），页面按它数"共 N 空"
 */
function normalizeExamQuestion(q, i) {
  var d = (q && typeof q === "object") ? q : {};
  var opts = Array.isArray(d.options) ? d.options.map(function (x) { return String(x); }).filter(Boolean) : [];
  var type = EXAM_TYPES[d.type] ? d.type : (opts.length ? "single" : "short");
  var answer = String(d.answer || "").trim();

  // 选择题的答案一律归一成大写字母：多选排好序（ABD），单选只留一个
  if (type === "multi") answer = normalizeAnswerLetters(answer, opts.length);
  else if (type === "single") answer = normalizeAnswerLetters(answer, opts.length).slice(0, 1);

  var blanks = [];
  if (type === "blank") {
    var rawB = Array.isArray(d.blanks) ? d.blanks : String(answer || "").split("||");
    blanks = rawB.map(function (x) { return String(x == null ? "" : x).trim(); })
                 .filter(function (x) { return x !== ""; });
    if (!blanks.length && answer) blanks = [answer];
  }

  return {
    id: "q" + ((Number(i) || 0) + 1),
    type: type,
    diff: EXAM_DIFF[d.diff] ? d.diff : "mid",
    point: String(d.point || "").trim(),
    text: String(d.text || "").trim(),
    options: type === "blank" ? [] : opts,     // 填空题不该带选项，带了一律丢掉
    answer: answer,
    blanks: blanks,
    key: String(d.key || "").trim(),
    state: EXAM_QSTATE[d.state] ? d.state : "pending",
    warn: String(d.warn || "").trim(),
  };
}

/**
 * 🔴 把模型给的题型**校正到老师勾选的范围里**。
 * 老师勾了"只要单选 / 多选 / 填空"，模型却回一道简答 —— 不能就这么进卷子。
 * 规则：
 *   · 题型本来就在勾选范围 → 不动
 *   · 不在 → 按**内容**推断最接近的（有选项 → 单选/多选；没选项 → 填空）
 *   · 推断出来仍不在范围 → 保留原题型，但**挂一条质检提示**（老师一眼看到，可「换一题」）
 * 🔴 **不静默改**：只要改了题型，必留提示。返回 `{ type, warn }`。
 */
function coerceExamQuestionType(q, allowed) {
  var list = Array.isArray(allowed) ? allowed.filter(function (k) { return !!EXAM_TYPES[k]; }) : [];
  if (!list.length) return { type: q.type, warn: "" };
  if (list.indexOf(q.type) >= 0) return { type: q.type, warn: "" };

  var guess = "";
  if (q.options && q.options.length) {
    var letters = String(q.answer || "").replace(/[^A-Za-z]/g, "");
    if (letters.length > 1) guess = list.indexOf("multi") >= 0 ? "multi" : (list.indexOf("single") >= 0 ? "single" : "");
    else guess = list.indexOf("single") >= 0 ? "single" : (list.indexOf("multi") >= 0 ? "multi" : "");
  } else {
    guess = list.indexOf("blank") >= 0 ? "blank" : "";
  }
  if (!guess) {
    return {
      type: q.type,
      warn: "质检提示：这道题是「" + examTypeLabel(q.type) + "」，不在你勾选的题型里 —— 建议点「换一题」。",
    };
  }
  return {
    type: guess,
    warn: "质检提示：模型给的是「" + examTypeLabel(q.type) + "」，已按「" + examTypeLabel(guess) +
          "」收进卷子 —— 觉得不合适就点「换一题」。",
  };
}

/** 卷的形状归一 —— 存档可能被手改，缺什么补什么 */
function normalizeExams(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(function (e) { return e && typeof e === "object"; }).map(function (e) {
    var qs = Array.isArray(e.questions) ? e.questions.map(normalizeExamQuestion) : [];
    return {
      id: String(e.id || nextExamId()),
      title: String(e.title || "未命名试卷"),
      courseId: String(e.courseId || ""),
      courseName: String(e.courseName || ""),
      chapters: Array.isArray(e.chapters) ? e.chapters.filter(Boolean).map(function (c) {
        return { id: String((c && c.id) || ""), title: String((c && c.title) || c || "") };
      }) : [],
      config: {
        count: Number(e.config && e.config.count) || qs.length,
        difficulty: (e.config && EXAM_DIFF[e.config.difficulty]) ? e.config.difficulty : "mid",
      },
      questions: qs,
      paper: {
        totalScore: Number(e.paper && e.paper.totalScore) || 100,
        duration: Number(e.paper && e.paper.duration) || 90,
      },
      status: EXAM_STATE[e.status] ? e.status : "draft",
      // 出题来源：ai = 模型现场出的；sample = 预置示例（界面上必须如实标出来）
      source: e.source === "sample" ? "sample" : "ai",
      createdBy: String(e.createdBy || ""),
      createdAt: Number(e.createdAt) || Date.now(),
      updatedAt: Number(e.updatedAt) || Number(e.createdAt) || Date.now(),
      publishedAt: Number(e.publishedAt) || 0,
      publishedTo: Array.isArray(e.publishedTo) ? e.publishedTo.filter(function (x) { return x && x.who; }).map(function (x) {
        return { who: String(x.who), at: Number(x.at) || Date.now() };
      }) : [],
    };
  });
}

/**
 * 预置种子：一份**真能走完整流程**的草稿卷（覆盖第 6-7 章，含一道「待确认」的质检题）。
 * 🔴 它是**预置示例**（`source:"sample"`）—— 不是 AI 现场出的，
 *    界面上必须如实标出来，别拿它冒充"已接入模型"。旧版 exam.html 那 4 道写死的题就是这个问题。
 */
var SEED_EXAM_DS = {
  id: "exam-seed-1",
  title: "第 6-7 章 · 阶段测验",
  courseId: "ds",
  courseName: "数据结构与算法",
  // 🔴 章节 id 必须与**真实教案大纲**（`SEED_SYLLABUS.ds.chapters`）一致 ——
  //    不一致的话，打开这一页时按 id 还原勾选就会还原成 0 章（踩过）。
  chapters: [
    { id: "ds-c6", title: "第 6 章 · 图" },
    { id: "ds-c7", title: "第 7 章 · 排序" },
  ],
  config: { count: 4, difficulty: "mid", types: ["single", "multi", "blank"] },
  questions: [
    {
      type: "single", diff: "basic", point: "二叉树的遍历",
      text: "下列哪种遍历组合可以唯一确定一棵二叉树？",
      options: ["A　前序 + 后序", "B　前序 + 中序", "C　层序", "D　后序 + 层序"],
      answer: "B",
      key: "前序确定根，中序划分左右子树。前序 + 后序无法区分「只有左孩子」与「只有右孩子」的情况。",
      state: "accepted",
    },
    {
      type: "multi", diff: "mid", point: "排序算法的稳定性",
      text: "下列排序算法中，哪些是稳定的？（多选，答全才给分）",
      options: ["A　冒泡排序", "B　快速排序", "C　归并排序", "D　直接插入排序"],
      answer: "ACD",
      key: "稳定的核心是「相等元素的相对次序不变」。快速排序在划分时会跨区间交换，不稳定；堆排序同样不稳定。",
      state: "accepted",
    },
    {
      type: "blank", diff: "mid", point: "图的存储结构",
      text: "有 n 个顶点、e 条边的无向图：用邻接矩阵存储需要 ___ 个存储单元；用邻接表存储需要 ___ 个结点（不含顶点表）。",
      answer: "n²||2e",
      blanks: ["n²", "2e"],
      key: "邻接矩阵与顶点数有关、与边数无关，所以是 n²；无向图每条边在邻接表里被存两次，所以是 2e。",
      state: "accepted",
    },
    {
      type: "single", diff: "mid", point: "最短路径",
      text: "关于 Dijkstra 算法，下列说法正确的是：",
      options: ["A　可以处理负权边", "B　不能处理负权边，需改用 Bellman-Ford", "C　只适用于有向图", "D　必须用邻接矩阵实现"],
      answer: "B",
      key: "Dijkstra 基于贪心，负权边会破坏「已确定的最短路不会再被改短」这一前提。",
      state: "pending",
      warn: "质检提示：这道题的「改用 Bellman-Ford」超出本章讲到的算法，建议确认是否已讲过。",
    },
  ],
  paper: { totalScore: 100, duration: 90 },
  status: "draft",
  source: "sample",
  createdBy: "teacher:teacher",
  createdAt: Date.now() - 3600e3,
  updatedAt: Date.now() - 3600e3,
  publishedAt: 0,
  publishedTo: [],
};

function seedExams() { return [SEED_EXAM_DS]; }

/**
 * 🔴 `loadExams` / `saveExams` **不许用 `LS`** —— 它定义在 `core.js`（后加载），
 * 而这行是 nav.js **顶层**执行的；那时 `LS` 在 TDZ → 抛错被吞 → 存档永远读不回来。
 * 一律 `window.localStorage` + `readBucket`（兼容双重编码）。
 */
function loadExams() {
  const key = examStoreKey();
  const user = (typeof currentUserKey === "function") ? currentUserKey() : "";
  const saved = readBucket(EXAM_KEY, key, normalizeExams);
  if (saved) return saved;              // ⚠️ 空数组也算有效（删光不复活预置数据）
  return (!user || isSeedAccount(user)) ? normalizeExams(seedExams()) : [];
}

function saveExams() {
  try { window.localStorage.setItem(examStoreKey(), JSON.stringify(EXAMS)); } catch (_) {}
}

var EXAMS = loadExams();

function examOf(id) {
  for (var i = 0; i < EXAMS.length; i++) if (EXAMS[i].id === id) return EXAMS[i];
  return null;
}

function examBucketKeys() { return bucketKeys(EXAM_KEY, examStoreKey()); }
function readExamBucket(key) { return readBucket(EXAM_KEY, key, normalizeExams); }

/** 找一份试卷：先本桶内存、再各账号桶（学生打开「老师发来的那份」必须用它） */
function examOfAnywhere(id) {
  var e = examOf(id);
  if (e) return e;
  var target = String(id || "");
  var hit = null;
  examBucketKeys().forEach(function (k) {
    if (hit) return;
    var list = readExamBucket(k);
    (list || []).forEach(function (x) { if (!hit && x.id === target) hit = x; });
  });
  return hit;
}

/* ---------------- 统计（页面只读这个，不自己算） ---------------- */

function examStats(e) {
  var qs = (e && e.questions) || [];
  var by = { pending: 0, accepted: 0, flagged: 0, dropped: 0 };
  qs.forEach(function (q) { if (by[q.state] != null) by[q.state] += 1; });
  return {
    total: qs.length,
    pending: by.pending, accepted: by.accepted, flagged: by.flagged, dropped: by.dropped,
    totalScore: (e && e.paper && Number(e.paper.totalScore)) || 0,
    duration: (e && e.paper && Number(e.paper.duration)) || 0,
    sentCount: (e && e.publishedTo && e.publishedTo.length) || 0,
  };
}

/* ---------------- 增删改 ---------------- */

function createExam(data) {
  var d = data || {};
  if (EXAMS.length >= EXAM_MAX) {
    return { ok: false, error: "试卷到上限了（" + EXAM_MAX + " 份）。先删掉几份 —— 我不会替你丢东西。" };
  }
  var qs = Array.isArray(d.questions) ? d.questions.map(normalizeExamQuestion) : [];
  if (!qs.length) return { ok: false, error: "一道题都没有，先出题再建卷" };
  var now = Date.now();
  var title = String(d.title || "").trim() || "未命名试卷";
  var e = {
    id: nextExamId(),
    title: title.length > 40 ? title.slice(0, 40) : title,
    courseId: String(d.courseId || ""),
    courseName: String(d.courseName || ""),
    chapters: (Array.isArray(d.chapters) ? d.chapters : []).filter(Boolean).map(function (c) {
      return { id: String((c && c.id) || ""), title: String((c && c.title) || "") };
    }),
    config: {
      count: Number(d.config && d.config.count) || qs.length,
      difficulty: (d.config && EXAM_DIFF[d.config.difficulty]) ? d.config.difficulty : "mid",
    },
    questions: qs,
    paper: {
      totalScore: Number(d.paper && d.paper.totalScore) || 100,
      duration: Number(d.paper && d.paper.duration) || 90,
    },
    status: "draft",
    source: d.source === "sample" ? "sample" : "ai",
    createdBy: (typeof currentUserKey === "function") ? currentUserKey() : "",
    createdAt: now, updatedAt: now, publishedAt: 0,
    publishedTo: [],
  };
  EXAMS.unshift(e);
  saveExams();
  return { ok: true, exam: e };
}

function updateExam(id, patch) {
  var e = examOf(id);
  if (!e) return { ok: false, error: "找不到这份试卷" };
  var p = patch || {};
  if (p.title != null) {
    var t = String(p.title).trim();
    if (!t) return { ok: false, error: "卷子名字不能空着" };
    e.title = t.length > 40 ? t.slice(0, 40) : t;
  }
  if (p.paper) {
    if (p.paper.totalScore != null) {
      var s = Number(p.paper.totalScore);
      if (!(s > 0)) return { ok: false, error: "总分要大于 0" };
      e.paper.totalScore = Math.min(500, Math.round(s));
    }
    if (p.paper.duration != null) {
      var m = Number(p.paper.duration);
      if (!(m > 0)) return { ok: false, error: "时长要大于 0" };
      e.paper.duration = Math.min(600, Math.round(m));
    }
  }
  e.updatedAt = Date.now();
  saveExams();
  return { ok: true, exam: e };
}

function deleteExam(id) {
  var i = -1;
  for (var k = 0; k < EXAMS.length; k++) if (EXAMS[k].id === id) { i = k; break; }
  if (i < 0) return { ok: false, error: "找不到这份试卷" };
  var sent = EXAMS[i].publishedTo.length;
  EXAMS.splice(i, 1);
  saveExams();
  return { ok: true, sentCount: sent };
}

/** 删之前把影响数清楚（同删课程 / 删活动 / 删工作台的规矩） */
function examAssetCount(id) {
  var e = examOf(id);
  if (!e) return "这份试卷已经不在了";
  var parts = ["已采纳 " + examStats(e).accepted + " 题"];
  if (e.publishedTo.length) parts.unshift("已经发给 " + e.publishedTo.length + " 位学生");
  return parts.join("，");
}

/* ---------------- 逐题审核 ---------------- */

function examQuestionAt(examId, i) {
  var e = examOf(examId);
  if (!e) return null;
  var idx = Number(i);
  if (!(idx >= 0) || idx >= e.questions.length) return null;
  return e.questions[idx];
}

function setQuestionState(examId, i, state) {
  var q = examQuestionAt(examId, i);
  if (!q) return { ok: false, error: "找不到这道题" };
  if (!EXAM_QSTATE[state]) return { ok: false, error: "不认识的状态" };
  q.state = state;
  examOf(examId).updatedAt = Date.now();
  saveExams();
  return { ok: true, question: q };
}

function updateQuestion(examId, i, patch) {
  var q = examQuestionAt(examId, i);
  if (!q) return { ok: false, error: "找不到这道题" };
  var p = patch || {};
  var keepState = q.state;
  if (p.text != null) {
    var t = String(p.text).trim();
    if (!t) return { ok: false, error: "题干不能空着" };
    q.text = t;
  }
  if (p.options != null) {
    q.options = (Array.isArray(p.options) ? p.options : String(p.options).split("\n"))
      .map(function (x) { return String(x).trim(); }).filter(Boolean);
    if (q.type === "blank") q.options = [];     // 填空题不该有选项
  }
  if (p.answer != null) q.answer = String(p.answer).trim();
  if (p.key != null) q.key = String(p.key).trim();
  if (p.point != null) q.point = String(p.point).trim();

  /* 🔴 改完按题型**再归一一次**：多选的答案要重排字母、填空题要重算 `blanks`
     —— 不归一的话，手改完答案"形状"就歪了（多选写成 "DBA"、填空多空串不起来）。 */
  var n = normalizeExamQuestion(q, i);
  Object.keys(n).forEach(function (k) { q[k] = n[k]; });
  q.state = EXAM_QSTATE[keepState] ? keepState : "pending";   // 归一里 state 会兜底成 pending，这里保持原状态

  examOf(examId).updatedAt = Date.now();
  saveExams();
  return { ok: true, question: q };
}

/** 换一题：**保持位置**替换成新的一题 */
function replaceQuestion(examId, i, next) {
  var e = examOf(examId);
  if (!e) return { ok: false, error: "找不到这份试卷" };
  var idx = Number(i);
  if (!(idx >= 0) || idx >= e.questions.length) return { ok: false, error: "找不到这道题" };
  e.questions[idx] = normalizeExamQuestion(next, idx);
  e.updatedAt = Date.now();
  saveExams();
  return { ok: true, question: e.questions[idx] };
}

/**
 * 手工加一道题（老师自己出的，或 AI 出的不满意、自己补一道）。
 * 🔴 题干不能空（空题干进卷子就是废题）；加进去**一律 `pending`**，不自动采纳。
 * `at` 可选：插到第几位；不传就追加到末尾。
 */
function addQuestion(examId, q, at) {
  var e = examOf(examId);
  if (!e) return { ok: false, error: "找不到这份试卷" };
  var nq = normalizeExamQuestion(q || {}, 0);
  if (!nq.text) return { ok: false, error: "题干不能空着" };
  nq.state = "pending";
  nq.id = "q" + Date.now().toString(36).slice(-5);   // 手工加的题 id 不与「按序号生成」的重名
  var idx = (at == null) ? e.questions.length : Math.max(0, Math.min(e.questions.length, Number(at) || 0));
  e.questions.splice(idx, 0, nq);
  e.updatedAt = Date.now();
  saveExams();
  return { ok: true, question: nq, index: idx };
}

/**
 * 真删一道题（**不是「弃用」**）—— 弃用是"留着但不进卷子"，这个是移出列表。
 * 删光是允许的（页面给空态），只是那时发布会被拒（一道都没采纳发不出去）。
 */
function removeQuestion(examId, i) {
  var e = examOf(examId);
  if (!e) return { ok: false, error: "找不到这份试卷" };
  var idx = Number(i);
  if (!(idx >= 0) || idx >= e.questions.length) return { ok: false, error: "找不到这道题" };
  var gone = e.questions.splice(idx, 1)[0];
  e.updatedAt = Date.now();
  saveExams();
  return { ok: true, removed: gone };
}

/* ---------------- 组卷 / 发布 ---------------- */

/**
 * 发布到一批学生。
 * 🔴 一道「已采纳」都没有 → **拒绝**（空卷发出去是事故，不是"方便"）。
 * 🔴 同一人重复发**不重复记账**（只改时间戳），否则学生端会看到好几份一模一样的。
 */
function publishExam(id, whoList) {
  var e = examOf(id);
  if (!e) return { ok: false, error: "找不到这份试卷" };
  if (!examStats(e).accepted) return { ok: false, error: "一道题都还没采纳 —— 先逐题审核，再发布" };
  var list = (whoList || []).map(function (w) { return String(w || "").trim(); }).filter(Boolean);
  if (!list.length) return { ok: false, error: "先选要发给谁" };
  var now = Date.now(), added = 0, updated = 0;
  list.forEach(function (who) {
    var hit = null;
    for (var i = 0; i < e.publishedTo.length; i++) if (e.publishedTo[i].who === who) { hit = e.publishedTo[i]; break; }
    if (hit) { hit.at = now; updated++; }
    else { e.publishedTo.push({ who: who, at: now }); added++; }
  });
  e.status = "published";
  e.publishedAt = now;
  e.updatedAt = now;
  saveExams();
  return { ok: true, added: added, updated: updated, total: e.publishedTo.length };
}

function recallExamFrom(id, who) {
  var e = examOf(id);
  if (!e) return { ok: false, error: "找不到这份试卷" };
  var before = e.publishedTo.length;
  e.publishedTo = e.publishedTo.filter(function (x) { return x.who !== who; });
  if (e.publishedTo.length === before) return { ok: false, error: "本来就没发给这位学生" };
  if (!e.publishedTo.length) e.status = "draft";   // 全撤回了 → 退回草稿
  e.updatedAt = Date.now();
  saveExams();
  return { ok: true, total: e.publishedTo.length };
}

/**
 * 学生收到的卷子 —— 🔴 **跨账号桶**读（记录在**老师**的桶里，学生自己的桶里没有），
 * 按 `id` 去重。与工作台下发同一套规矩（见 §16）。
 */
function examsForStudent(who) {
  var w = String(who || "").trim().toLowerCase();
  if (!w) return [];
  var seen = {}, out = [];
  var take = function (arr) {
    (arr || []).forEach(function (e) {
      if (!e || !e.id || seen[e.id]) return;
      if (e.status !== "published") return;
      var hit = (e.publishedTo || []).some(function (x) {
        return String((x && x.who) || "").toLowerCase() === w;
      });
      if (hit) { seen[e.id] = 1; out.push(e); }
    });
  };
  take(EXAMS);
  examBucketKeys().forEach(function (k) { take(readExamBucket(k)); });
  return out;
}

/** 学生端「我的作业」的份数（老师发来的总数，页面统计读它） */
function examCountOf(who) { return examsForStudent(who).length; }

/**
 * 还没交的卷子数 —— 「我的作业」徽标读它（第 55 轮改的口径）。
 * 🔴 原来徽标显示的是"老师发来的总份数"：全交完了徽标还挂在那儿，
 *    看起来像"还有 3 份没做"。改成**未交份数**才对得上这一栏的含义。
 */
function unsubmittedExamCount(who) {
  const w = String(who || "").trim();
  if (!w) return 0;
  const done = {};
  examAnsOfStudent(w).forEach(function (a) { if (a && a.examId) done[a.examId] = 1; });
  return examsForStudent(w).filter(function (e) { return e && !done[e.id]; }).length;
}

/**
 * 学生端「我的作业」的菜单徽标 —— **现算**，不写死。
 * 与 `refreshActivityNav()` 同一套路；两个都必须等数据层加载完再调（见文件末尾）。
 * 口径：**未交的份数**；全都交齐了就不挂徽标（干净，也说明"没有待办"）。
 */
function refreshExamNav() {
  const item = findStudentNavItem("hw");
  if (!item) return 0;
  const u = (typeof currentUserKey === "function") ? currentUserKey() : "";
  const todo = u ? unsubmittedExamCount(u) : 0;
  if (todo) item.badge = todo + " 份未交"; else delete item.badge;
  return todo;
}

/* ============================================================
   作业作答与提交（第 48 轮）
   ------------------------------------------------------------
   学生端「我的作业」在线作答 → 提交；老师端「学生管理」看谁交了、客观题得几分。
   🔴 两条硬规矩
   1. 提交记录存**学生自己的桶**（`st_exam_ans:<角色>:<账号>`）—— 记录跟着产生它的人走；
      老师端**跨桶读**（与"下发工作台 / 学生读老师发的卷"同一套，见 §16 / §17）。
   2. ⚠️ **本架构下答案无法真正对学生隐藏**（纯静态，卷子记录里就带着 `answer`）——
      所以这里的即时判分是"给学习用的反馈"，**不是防作弊的考试系统**；界面上必须如实说明。
   ============================================================ */

var EXAM_ANS_KEY = "st_exam_ans";
var EXAM_ANS_MAX = 200;          // 每账号最多留 200 份提交（只留最新的）

/** 填空比对：去掉所有空白再比（中文无所谓大小写） */
function normBlankText(s) {
  return String(s == null ? "" : s).replace(/\s+/g, "").trim();
}

/**
 * 判**一道**题 → `{ graded, answered, ok }`。
 * · 单选 / 多选 / 填空 → 自动判（`graded:true`）
 * · 简答 → **待批**（`graded:false`）—— 不假装机器能判主观题
 * ⚠️ 多选「答全才给分」：归一成字母升序后**全等**才算对（少选、多选都算错）。
 */
function gradeOneQuestion(q, ansRaw) {
  var type = (q && q.type) || "short";
  if (type === "short") {
    return { graded: false, answered: !!String(ansRaw == null ? "" : ansRaw).trim(), ok: false };
  }
  var optCount = (q.options || []).length;
  if (type === "single" || type === "multi") {
    var got = normalizeAnswerLetters(Array.isArray(ansRaw) ? ansRaw.join("") : ansRaw, optCount);
    var want = normalizeAnswerLetters(q.answer || "", optCount);
    return { graded: true, answered: !!got, ok: !!want && got === want };
  }
  if (type === "blank") {
    var wantB = (q.blanks && q.blanks.length) ? q.blanks : [q.answer || ""];
    var gotB = (Array.isArray(ansRaw) ? ansRaw : [ansRaw]).map(normBlankText);
    var any = gotB.some(function (x) { return x !== ""; });
    var allOk = wantB.length > 0 && wantB.every(function (w, i) { return normBlankText(w) === (gotB[i] || ""); });
    return { graded: true, answered: any, ok: any && allOk };
  }
  return { graded: false, answered: false, ok: false };
}

/**
 * 判**一整份**卷。分值按**每题等分**（`totalScore / 题数`）。
 * 🔴 只报「客观题得分」，**不折算成卷面分** —— 简答还没批，折算出来是误导。
 */
function gradeExamPaper(exam, answers) {
  var qs = ((exam && exam.questions) || []).filter(function (q) { return q.state === "accepted"; });
  var ans = (answers && typeof answers === "object") ? answers : {};
  var total = (exam && exam.paper && Number(exam.paper.totalScore)) || 100;
  var per = qs.length ? Math.round(total / qs.length) : 0;
  var got = 0, objTotal = 0, pending = 0, answered = 0;
  var perQ = [];
  qs.forEach(function (q) {
    var r = gradeOneQuestion(q, ans[q.id]);
    if (r.answered) answered += 1;
    if (r.graded) { objTotal += per; if (r.ok) got += per; } else { pending += 1; }
    perQ.push({ id: q.id, type: q.type, graded: r.graded, ok: !!r.ok, answered: !!r.answered });
  });
  return {
    questions: qs.length, answered: answered,
    objectiveGot: got, objectiveTotal: objTotal, pending: pending,
    perScore: per, perQuestion: perQ,
  };
}

/** 一份提交记录的形状归一（存档被手改过也不怕） */
function normalizeExamAns(a) {
  var o = (a && typeof a === "object") ? a : {};
  var src = (o.answers && typeof o.answers === "object") ? o.answers : {};
  var ans = {};
  Object.keys(src).forEach(function (k) {
    var v = src[k];
    ans[k] = Array.isArray(v)
      ? v.map(function (x) { return String(x == null ? "" : x); })
      : String(v == null ? "" : v);
  });
  return {
    examId: String(o.examId || ""),
    examTitle: String(o.examTitle || ""),
    courseId: String(o.courseId || ""),
    answers: ans,
    submittedAt: Number(o.submittedAt) || 0,
    attempts: Math.max(1, Number(o.attempts) || 1),
    objectiveGot: Number(o.objectiveGot) || 0,
    objectiveTotal: Number(o.objectiveTotal) || 0,
    pending: Number(o.pending) || 0,
    seed: !!o.seed,
  };
}

function normalizeExamAnsList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeExamAns).filter(function (x) { return x.examId; }).slice(0, EXAM_ANS_MAX);
}

function examAnsKeyOf(u) { return u ? EXAM_ANS_KEY + ":" + String(u) : EXAM_ANS_KEY; }
function examAnsStoreKey() { return examAnsKeyOf(currentUserKey()); }
function readExamAnsBucket(key) { return readBucket(EXAM_ANS_KEY, key, normalizeExamAnsList); }

/**
 * 预置学生的示例提交 —— 🔴 **用真判分算分**（题目一改分数自动跟着变，不写死数字）。
 * 多选题故意少选一个 → 正好演示「答全才给分」。
 */
function seedExamAnswers() {
  var exam = normalizeExams([SEED_EXAM_DS])[0];
  var answers = { q1: "B", q2: "AC", q3: ["n²", "2e"] };
  var g = gradeExamPaper(exam, answers);
  return [normalizeExamAns({
    examId: exam.id, examTitle: exam.title, courseId: exam.courseId,
    answers: answers, submittedAt: Date.now() - 2 * 3600e3, attempts: 1,
    objectiveGot: g.objectiveGot, objectiveTotal: g.objectiveTotal, pending: g.pending,
    seed: true,
  })];
}

/** 🔴 顶层读存档一律 `window.localStorage`（`LS` 在 core.js，此时还在 TDZ） */
function loadExamAns() {
  var got = readExamAnsBucket(examAnsStoreKey());
  if (got) return got;                   // ⚠️ 空数组也算有效（删光不复活预置数据）
  var u = (typeof currentUserKey === "function") ? currentUserKey() : "";
  return (!u || isSeedAccount(u)) ? seedExamAnswers() : [];
}
function saveExamAns() {
  try { window.localStorage.setItem(examAnsStoreKey(), JSON.stringify(EXAM_ANS)); } catch (_) {}
}

var EXAM_ANS = loadExamAns();

function examAnsBucketKeys() { return bucketKeys(EXAM_ANS_KEY, examAnsStoreKey()); }

/** 我（当前账号）交的 */
function myExamAns() { return EXAM_ANS; }
function myExamAnsOf(examId) {
  var id = String(examId || "");
  for (var i = 0; i < EXAM_ANS.length; i++) if (EXAM_ANS[i].examId === id) return EXAM_ANS[i];
  return null;
}

/**
 * 🔴 **跨桶读**某个学生交的（记录在**他自己**的桶里，老师端用）。
 * ⚠️ 预置学生没写过存档 → 回落种子，否则老师端会一片空、而学生自己明明看得到。
 */
function examAnsOfStudent(who) {
  var w = String(who || "").trim();
  if (!w) return [];
  var got = readExamAnsBucket(examAnsKeyOf(w));
  if (got) return got;
  return isSeedAccount(w) ? seedExamAnswers() : [];
}

/** 某份卷子：谁交了。`whoList` 每项可以是 `{key}` 或裸 key 字符串 */
function submittedOfExam(examId, whoList) {
  var id = String(examId || "");
  var out = {};
  (whoList || []).forEach(function (w) {
    var key = String((w && w.key) || w || "");
    if (!key) return;
    var list = examAnsOfStudent(key);
    for (var i = 0; i < list.length; i++) if (list[i].examId === id) { out[key] = list[i]; break; }
  });
  return out;
}

/** 提交（或**重新提交**）：同一份卷覆盖上一次，`attempts` 累加 */
function submitExamAnswer(exam, answers) {
  if (!exam || !exam.id) return { ok: false, error: "找不到这份卷子" };
  var g = gradeExamPaper(exam, answers);
  if (!g.answered) return { ok: false, error: "一道题都没答 —— 先写点东西再交" };
  var now = Date.now();
  var hit = myExamAnsOf(exam.id);
  var rec = normalizeExamAns({
    examId: exam.id, examTitle: exam.title, courseId: exam.courseId,
    answers: answers, submittedAt: now, attempts: hit ? (hit.attempts + 1) : 1,
    objectiveGot: g.objectiveGot, objectiveTotal: g.objectiveTotal, pending: g.pending,
  });
  if (hit) {
    for (var i = 0; i < EXAM_ANS.length; i++) if (EXAM_ANS[i].examId === exam.id) EXAM_ANS[i] = rec;
  } else {
    EXAM_ANS.unshift(rec);
  }
  if (EXAM_ANS.length > EXAM_ANS_MAX) EXAM_ANS = EXAM_ANS.slice(0, EXAM_ANS_MAX);
  saveExamAns();
  return { ok: true, record: rec, grade: g };
}

/* ============================================================
   学习活跃（「学生管理」的"考勤"口径，第 48 轮）
   ------------------------------------------------------------
   🔴 本机**没有**课堂考勤数据（没有教务系统、也没做签到）——
      所以这里的"考勤"是**学习活跃**：他这些天有没有学习动作（来自 `st_behavior`）。
      界面上必须写清这是"学习活跃"、**不是课堂点名**，不冒充后者。
   ============================================================ */

/** 最近 n 天的活跃情况（从早到晚）：`[{ at, count, active }]` */
function recentActiveDays(list, now, n) {
  var days = Math.max(1, Number(n) || 7);
  var base = Number(now) || Date.now();
  var today = dayStart(base);
  var map = {};
  (Array.isArray(list) ? list : []).forEach(function (e) {
    var d = dayStart(e.at);
    map[d] = (map[d] || 0) + 1;
  });
  var out = [];
  for (var i = days - 1; i >= 0; i--) {
    var d = today - i * DAY_MS;
    out.push({ at: d, count: map[d] || 0, active: !!map[d] });
  }
  return out;
}

/** 沉默天数：距最后一次活动过了几天；**完全没有记录返回 -1**（页面要分开显示） */
function silentDays(list, now) {
  var arr = Array.isArray(list) ? list : [];
  if (!arr.length) return -1;
  var last = 0;
  arr.forEach(function (e) { if (e.at > last) last = e.at; });
  var today = dayStart(Number(now) || Date.now());
  return Math.max(0, Math.round((today - dayStart(last)) / DAY_MS));
}

/** 一个学生的「活跃概览」——学生管理页只读它，不自己算 */
function activeSummaryOf(list, now, days) {
  var sum = behaviorSummary(list, now);
  return {
    total: sum.total,
    activeDays: sum.activeDays,
    streak: sum.streak,
    week: sum.week,
    lastAt: sum.lastAt,
    silent: silentDays(list, now),
    seedCount: sum.seedCount,
    recent: recentActiveDays(list, now, days || 7),
  };
}

/**
 * 老师端的「学生总册」：本机每个学生 + 他的活跃 + 作业应交/已交。
 * 🔴 数据全部来自真实来源（账号库 / 选课桶 / 行为桶 / 提交桶），查不到就是空，**不编**。
 */
function studentOverview(now) {
  var base = Number(now) || Date.now();
  return localStudentAccounts().map(function (s) {
    var beh = (typeof behaviorOf === "function") ? behaviorOf(s.key) : [];
    var courses = (typeof coursesOfStudent === "function") ? coursesOfStudent(s.key) : [];
    var due = (typeof examsForStudent === "function") ? examsForStudent(s.key) : [];
    var ans = examAnsOfStudent(s.key);
    var doneMap = {};
    ans.forEach(function (a) { doneMap[a.examId] = a; });
    var done = due.filter(function (e) { return !!doneMap[e.id]; });
    return {
      key: s.key, user: s.user, name: s.name, createdAt: s.createdAt,
      courses: courses, courseCount: courses.length,
      active: activeSummaryOf(beh, base, 7),
      dueCount: due.length, doneCount: done.length,
      due: due, answers: ans,
    };
  });
}

/* ---------------- AI 出题 ---------------- */

/**
 * 从模型返回里抠出 JSON —— 模型经常套围栏、写一段前言再说"结果如下"。
 * **抠不出来就返回 null**，交给调用方如实报错，不硬塞半成品。
 */
function extractJson(raw) {
  var s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  var fence = s.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  var a = s.search(/[\[{]/);
  if (a > 0) s = s.slice(a);
  var lastB = Math.max(s.lastIndexOf("]"), s.lastIndexOf("}"));
  if (lastB >= 0) s = s.slice(0, lastB + 1);
  try { return JSON.parse(s); } catch (_) { return null; }
}

/**
 * 出题的系统提示词。
 * 🔴 硬约束写死在这里：**只输出 JSON 数组**、字段固定、**答案与解析必须给**
 *    （老师要逐题把关，没有解析的题审不动）、**不许超出给定章节范围**。
 */
function examSystemPrompt() {
  return [
    "你是一位高校计算机专业课程的出题老师。用户会给你**章节范围**、**题量**与**难度分布**，你据此出题。",
    "",
    "## 输出格式（🔴 必须严格遵守）",
    "只输出一个 **JSON 数组**，不要任何解释、不要 markdown 围栏。数组每一项形如：",
    '{ "type":"single|multi|blank|short", "diff":"basic|mid|hard", "point":"知识点",',
    '  "text":"题干", "options":["A …","B …"], "answer":"参考答案", "key":"解析" }',
    '（`type` 只能是 single / multi / blank / short 这四种 —— 🔴 **不出编程题**。）',
    "",
    "## 硬性要求",
    "1. `text` 是完整题干本身，**不要**在里面写题号。",
    "2. `options` 只有选择题（single / multi）才给，且**每条自带 A/B/C/D 前缀**；其他题型给空数组。",
    "3. `answer` 的写法按题型走（**写错格式这道题就废了**）：",
    "   · 单选（single）：给 4 个选项，`answer` 是**一个字母**，如 \"B\"。",
    "   · 多选（multi）：给 4 个选项，`answer` 是**两个或以上字母、必须按字母升序**，如 \"ABD\"。",
    "   · 填空（blank）：不给选项；题干里每个空写 **三个下划线 `___`**；",
    "     `answer` 按**空的先后顺序**用 `||` 分隔，如 \"邻接矩阵||邻接表\"（单空就直接写答案，不加 `||`）。",
    "   · 简答（short）：`answer` 给要点（可分行）。",
    "4. `key` 是**给老师看的解析**：为什么这么答、容易错在哪。",
    "5. `point` 写这道题考的知识点，必须来自用户给的章节范围。",
    "6. 🔴 **不许超出给定的章节范围出题**；范围里没有的知识点不要编。",
    "7. 难度按用户给的配比铺开，题目之间不要重复考同一个点。",
  ].join("\n");
}

function examUserPrompt(scope, cfg) {
  var c = cfg || {};
  var chs = (scope && scope.chapters) || [];
  var lines = ["请按下面的要求出题：", ""];
  lines.push("课程：" + String((scope && scope.courseName) || "（未指定）"));
  lines.push("章节范围：");
  chs.forEach(function (ch, i) {
    var pts = (ch && ch.points && ch.points.length) ? "（知识点：" + ch.points.join(" / ") + "）" : "";
    lines.push("  " + (i + 1) + ". " + String((ch && ch.title) || ch) + pts);
  });
  lines.push("");
  lines.push("题量：" + (Number(c.count) || 8) + " 题");

  // 🔴 题型是老师勾的：只出这几种，一种都不许混进来
  var types = examPickTypes(c.types);
  lines.push("题型：**只出这几种** —— " + types.map(examTypeLabel).join(" / "));
  var tips = [];
  if (types.indexOf("single") >= 0) tips.push("单选 = 4 个选项 + 单个字母答案");
  if (types.indexOf("multi") >= 0) tips.push("多选 = 4 个选项 + 2 个以上字母（升序，如 ABD）");
  if (types.indexOf("blank") >= 0) tips.push("填空 = 不给选项，题干里用 ___ 表示空，多空的答案用 || 按顺序分开");
  if (tips.length) lines.push("（" + tips.join("；") + "）");
  if (types.length > 1) {
    lines.push("这几种题型**都要出到**，数量大致均匀，别全是一种。");
  }
  lines.push("");
  lines.push("难度分布：" + (EXAM_DIFF_PLAN[c.difficulty] || EXAM_DIFF_PLAN.mid));
  lines.push("");
  lines.push("🔴 再次强调：只输出 JSON 数组，第一行就是 [，最后一行就是 ]。");
  return lines.join("\n");
}

/**
 * 出题。返回 `Promise<{ok, questions?, types?, error?, hint?, demo?}>`。
 * 🔴 返回的题目**一律 `pending`**（等老师逐题审核），**不会自己变成"已采纳"**。
 * 🔴 `cfg.types` 是老师勾的题型（默认 单选 / 多选 / 填空）：模型写歪了会被校正回这个范围，
 *    校正过的题**必带质检提示**（不静默改）。
 */
function generateExamQuestions(scope, cfg) {
  var c = cfg || {};
  var count = Math.max(1, Math.min(30, Math.round(Number(c.count) || 8)));
  var types = examPickTypes(c.types);

  return llmChat(examSystemPrompt(), examUserPrompt(scope, Object.assign({}, c, { types: types })),
                 { temperature: 0.6, maxTokens: 8000 })
    .then(function (r) {
      if (!r.ok) return r;
      var arr = extractJson(r.raw);
      if (!Array.isArray(arr) || !arr.length) {
        return { ok: false, error: "模型没返回能用的题目 JSON（格式跑了或被拦了），换个说法再试一次。", raw: r.raw };
      }
      var qs = arr.slice(0, count).map(normalizeExamQuestion).filter(function (q) { return q.text; });
      if (!qs.length) return { ok: false, error: "返回的题目里没有题干，没法用。", raw: r.raw };
      qs.forEach(function (q) {
        q.state = "pending";                            // 🔴 一律待审
        var fix = coerceExamQuestionType(q, types);     // 🔴 题型校正到勾选范围
        if (fix.type !== q.type) q.type = fix.type;
        if (fix.warn && !q.warn) q.warn = fix.warn;
      });
      return { ok: true, questions: qs, types: types, model: r.model, provider: r.provider };
    });
}

/* ============================================================
   课件（courseware）—— 唯一来源
   ------------------------------------------------------------
   教师端「发布课件作业」页（`courseware.html`）：
     选课程 + 圈章节 → 写 / 传正文 → 实时看切出几段 → 发布到班级（可撤回）
   学生端「课件阅读」页（`reader.html`）：
     跨账号桶读老师发来的课件，按**同一套分段规则**渲染成可批注段落。

   🔴 四条硬规矩
   1. **分段规则只有一处实现**（`cwSections`）—— 页面按它渲染、批注按段号关联；
      两边各写一份迟早对不上（段号错位 = 批注张冠李戴）
   2. 🔴 **上传的文件是不可信输入**：`cwTextFromHtml` 必须**剥掉 script / style**，
      否则把老师传上来的 HTML 原样塞进页面就是 XSS
   3. 🔴 **草稿不许被学生读到**（`cwsForStudent` 只认 `published`）；发布是**另一个动作**
   4. 🔴 发给学生的记录**不重复记账**；学生端**跨账号桶**读（与工作台 / 试卷同一套规矩）
   ============================================================ */

var CW_KEY = "st_courseware";
/** 课件上限：到顶**拒绝新建并说清**，不静默淘汰 */
var CW_MAX = 80;

var CW_STATE = {
  draft:     { key: "draft",     label: "草稿" },
  published: { key: "published", label: "已发布" },
};

/** 正文来源（界面上要如实标出来） */
var CW_SOURCE = {
  write:  { key: "write",  label: "页面上写的" },
  upload: { key: "upload", label: "上传的文件" },
  sample: { key: "sample", label: "预置示例" },
};

function cwStoreKey() {
  var u = "";
  try { u = (typeof currentUserKey === "function") ? currentUserKey() : ""; } catch (_) {}
  return u ? CW_KEY + ":" + u : CW_KEY;
}

var CW_SEQ = 0;
function nextCwId() {
  CW_SEQ += 1;
  return "cw-" + Date.now().toString(36) + "-" + CW_SEQ;
}

/**
 * 正文 → 可批注段落。**唯一的分段实现**。
 * 规则：**空行分段**（与 Markdown 的习惯一致），段内单换行保留。
 */
function cwSections(cw) {
  var body = (cw && typeof cw === "object") ? String(cw.body || "") : String(cw == null ? "" : cw);
  return body.split(/\n[ \t\u3000]*\n+/)
    .map(function (x) { return x.trim(); })
    .filter(Boolean);
}

/**
 * 上传的 HTML → 干净的 Markdown 文本。
 * 🔴 `script` / `style` / `head` **整块丢掉**，其余标签剥掉、只留文本 + 基本排版
 *    —— 老师传上来的文件是不可信输入，原样塞进页面就是 XSS。
 * 🔴 实体解码放**最后**：先解 `&amp;` 会把 `&amp;lt;` 二次解码成 `<`。
 */
function cwTextFromHtml(raw) {
  var s = String(raw == null ? "" : raw);
  if (!s.trim()) return "";
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style\s*>/gi, "");
  s = s.replace(/<head[\s\S]*?<\/head\s*>/gi, "");
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1\s*>/gi, function (_, n, t) {
    return "\n\n" + new Array(Number(n) + 1).join("#") + " " + t + "\n\n";
  });
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li\s*>/gi, function (_, t) { return "\n- " + t; });
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|article|tr|ul|ol|blockquote|table|h[1-6])\s*>/gi, "\n\n");
  s = s.replace(/<[^>]*>/g, "");
  s = s.replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
       .replace(/&quot;/gi, "\"").replace(/&#39;/g, "'").replace(/&amp;/gi, "&");
  s = s.split("\n").map(function (l) { return l.replace(/[ \t\u3000]+/g, " ").trim(); }).join("\n");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/** 课件的形状归一 —— 存档可能被手改，缺什么补什么 */
function normalizeCw(raw) {
  var o = (raw && typeof raw === "object") ? raw : {};
  return {
    id: String(o.id || nextCwId()),
    title: String(o.title || "未命名课件").trim() || "未命名课件",
    courseId: String(o.courseId || ""),
    courseName: String(o.courseName || ""),
    chapters: Array.isArray(o.chapters) ? o.chapters.filter(Boolean).map(function (c) {
      return { id: String((c && c.id) || ""), title: String((c && c.title) || c || "") };
    }) : [],
    body: String(o.body || ""),
    source: CW_SOURCE[o.source] ? o.source : "write",
    status: CW_STATE[o.status] ? o.status : "draft",
    createdBy: String(o.createdBy || ""),
    createdAt: Number(o.createdAt) || Date.now(),
    updatedAt: Number(o.updatedAt) || Number(o.createdAt) || Date.now(),
    publishedAt: Number(o.publishedAt) || 0,
    publishedTo: Array.isArray(o.publishedTo) ? o.publishedTo.filter(function (x) { return x && x.who; }).map(function (x) {
      return { who: String(x.who), at: Number(x.at) || Date.now() };
    }) : [],
  };
}

function normalizeCws(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(function (e) { return e && typeof e === "object"; }).map(normalizeCw);
}

/**
 * 🔴 第 54 轮：**删掉了预置种子课件**（原 `SEED_CW_QS` / `seedCws()`）。
 *    用户明确要求「彻底不要预置示例」—— 学生端只显示**老师真发来的**课件，
 *    没有就显示空态，不拿内置的「7.2 快排复杂度」冒充老师发的内容。
 *    （旧存档里若有 `cw-seed-1`，`normalizeCws` 照常读出来 —— 那是真存档，不主动删。）
 */

/**
 * 🔴 `loadCws` / `saveCws` **不许用 `LS`** —— 它定义在 `core.js`（后加载），
 * 而这行是 nav.js **顶层**执行的；那时 `LS` 在 TDZ → 抛错被吞 → 存档永远读不回来。
 * 一律 `window.localStorage` + `readBucket`（兼容老档的双重编码）。
 */
function loadCws() {
  const key = cwStoreKey();
  const saved = readBucket(CW_KEY, key, normalizeCws);
  if (saved) return saved;              // ⚠️ 空数组也算有效（删光不复活）
  return [];                            // 没有存档 → 空（不再给预置种子）
}

function saveCws() {
  try { window.localStorage.setItem(cwStoreKey(), JSON.stringify(CWS)); } catch (_) {}
}

var CWS = loadCws();

function cwOf(id) {
  for (var i = 0; i < CWS.length; i++) if (CWS[i].id === id) return CWS[i];
  return null;
}

function cwBucketKeys() { return bucketKeys(CW_KEY, cwStoreKey()); }
function readCwBucket(key) { return readBucket(CW_KEY, key, normalizeCws); }

/* ---------------- 统计（页面只读这个，不自己算） ---------------- */

function cwStats(c) {
  var secs = cwSections(c);
  var chars = secs.join("").length;
  return {
    sections: secs.length,
    chars: chars,
    // 中文朗读约 300 字/分钟 —— 只用来给个量级，别当精确值
    minutes: chars ? Math.max(1, Math.round(chars / 300)) : 0,
    sentCount: (c && c.publishedTo && c.publishedTo.length) || 0,
    published: !!(c && c.status === "published"),
  };
}

/* ---------------- 增删改 ---------------- */

function createCw(data) {
  var d = data || {};
  if (CWS.length >= CW_MAX) {
    return { ok: false, error: "课件到上限了（" + CW_MAX + " 份）。先删掉几份 —— 我不会替你丢东西。" };
  }
  var body = String(d.body || "").trim();
  if (!body) return { ok: false, error: "正文还是空的 —— 写点什么，或者传一个文件上来" };
  var now = Date.now();
  var title = String(d.title || "").trim() || "未命名课件";
  var cw = {
    id: nextCwId(),
    title: title.length > 60 ? title.slice(0, 60) : title,
    courseId: String(d.courseId || ""),
    courseName: String(d.courseName || ""),
    chapters: (Array.isArray(d.chapters) ? d.chapters : []).filter(Boolean).map(function (c) {
      return { id: String((c && c.id) || ""), title: String((c && c.title) || "") };
    }),
    body: body,
    source: CW_SOURCE[d.source] ? d.source : "write",
    status: "draft",
    createdBy: (typeof currentUserKey === "function") ? currentUserKey() : "",
    createdAt: now, updatedAt: now, publishedAt: 0,
    publishedTo: [],
  };
  CWS.unshift(cw);
  saveCws();
  return { ok: true, cw: cw };
}

function updateCw(id, patch) {
  var cw = cwOf(id);
  if (!cw) return { ok: false, error: "找不到这份课件" };
  var p = patch || {};
  if (p.title != null) {
    var t = String(p.title).trim();
    if (!t) return { ok: false, error: "课件名字不能空着" };
    cw.title = t.length > 60 ? t.slice(0, 60) : t;
  }
  if (p.body != null) {
    var b = String(p.body).trim();
    if (!b) return { ok: false, error: "正文不能清空 —— 空课件发出去学生什么也看不到" };
    cw.body = b;
  }
  if (p.chapters != null) {
    cw.chapters = (Array.isArray(p.chapters) ? p.chapters : []).filter(Boolean).map(function (c) {
      return { id: String((c && c.id) || ""), title: String((c && c.title) || "") };
    });
  }
  if (p.courseId != null) cw.courseId = String(p.courseId);
  if (p.courseName != null) cw.courseName = String(p.courseName);
  if (p.source != null && CW_SOURCE[p.source]) cw.source = p.source;
  cw.updatedAt = Date.now();
  saveCws();
  return { ok: true, cw: cw };
}

function deleteCw(id) {
  var i = -1;
  for (var k = 0; k < CWS.length; k++) if (CWS[k].id === id) { i = k; break; }
  if (i < 0) return { ok: false, error: "找不到这份课件" };
  var sent = CWS[i].publishedTo.length;
  CWS.splice(i, 1);
  saveCws();
  return { ok: true, sentCount: sent };
}

/** 删之前把影响数清楚（同删课程 / 删试卷 / 删工作台的规矩） */
function cwAssetCount(id) {
  var c = cwOf(id);
  if (!c) return "这份课件已经不在了";
  var st = cwStats(c);
  var parts = ["正文 " + st.sections + " 段、约 " + st.chars + " 字"];
  if (st.sentCount) parts.unshift("已经发给 " + st.sentCount + " 位学生");
  return parts.join("，");
}

/* ---------------- 发布 / 撤回 ---------------- */

/**
 * 发布到一批学生。
 * 🔴 正文为空 → **拒绝**（空课件发出去是事故，不是"方便"）。
 * 🔴 同一人重复发**不重复记账**（只改时间戳），否则学生端会看到好几份一模一样的。
 */
function publishCw(id, whoList) {
  var cw = cwOf(id);
  if (!cw) return { ok: false, error: "找不到这份课件" };
  if (!cwSections(cw).length) return { ok: false, error: "正文是空的 —— 先写点内容再发布" };
  var list = (whoList || []).map(function (w) { return String(w || "").trim(); }).filter(Boolean);
  if (!list.length) return { ok: false, error: "先选要发给谁" };
  var now = Date.now(), added = 0, updated = 0;
  list.forEach(function (who) {
    var hit = null;
    for (var i = 0; i < cw.publishedTo.length; i++) if (cw.publishedTo[i].who === who) { hit = cw.publishedTo[i]; break; }
    if (hit) { hit.at = now; updated++; }
    else { cw.publishedTo.push({ who: who, at: now }); added++; }
  });
  cw.status = "published";
  cw.publishedAt = now;
  cw.updatedAt = now;
  saveCws();
  return { ok: true, added: added, updated: updated, total: cw.publishedTo.length };
}

function recallCwFrom(id, who) {
  var cw = cwOf(id);
  if (!cw) return { ok: false, error: "找不到这份课件" };
  var before = cw.publishedTo.length;
  cw.publishedTo = cw.publishedTo.filter(function (x) { return x.who !== who; });
  if (cw.publishedTo.length === before) return { ok: false, error: "本来就没发给这位学生" };
  if (!cw.publishedTo.length) cw.status = "draft";   // 全撤回了 → 退回草稿
  cw.updatedAt = Date.now();
  saveCws();
  return { ok: true, total: cw.publishedTo.length };
}

/**
 * 学生收到的课件 —— 🔴 **跨账号桶**读（记录在**老师**的桶里，学生自己的桶里没有），
 * 按 `id` 去重。🔴 **只认 `published`**：草稿一律不给学生看。
 *
 * 第二个参数 `courseId`（可选）：只取**这门课**的课件 —— 学生端「课件阅读」按课程筛选时用。
 *
 * 🔴 第 54 轮：**不再给种子课件**（用户明确要求「彻底不要预置示例」）。
 *    学生桶里没有老师发的 → 老老实实返回空，页面显示空态，不拿预置内容冒充老师发的。
 */
function cwsForStudent(who, courseId) {
  var w = String(who || "").trim().toLowerCase();
  if (!w) return [];
  var wantCourse = String(courseId || "").trim();
  var seen = {}, out = [];
  var take = function (arr) {
    (arr || []).forEach(function (c) {
      if (!c || !c.id || seen[c.id]) return;
      if (c.status !== "published") return;
      if (wantCourse && String(c.courseId || "") !== wantCourse) return;
      var hit = (c.publishedTo || []).some(function (x) {
        return String((x && x.who) || "").toLowerCase() === w;
      });
      if (hit) { seen[c.id] = 1; out.push(c); }
    });
  };
  take(CWS);                                             // 先看内存里最新的
  cwBucketKeys().forEach(function (k) { take(readCwBucket(k)); });
  return out;
}

/** 学生端「课件阅读」的份数（页面读它）；可选按课程过滤 */
function cwCountOf(who, courseId) { return cwsForStudent(who, courseId).length; }

/**
 * 学生能读到的课件**涉及哪些课程** —— 学生端「课件阅读」的课程选择器用它。
 * 🔴 只列**学生已加入**的课程（`ENROLLED`）里、**真有发来课件**的那些 ——
 *    没加入的课不该出现；加入了但老师还没发课件的课，用空态提示，而不是列出空课程。
 * 返回 `[{ courseId, name, count }]`，按课件数降序。
 */
function cwCoursesForStudent(who) {
  var list = cwsForStudent(who);
  var seen = {};
  var rows = [];
  list.forEach(function (c) {
    var id = String(c.courseId || "");
    if (!id || seen[id]) return;
    seen[id] = 1;
    rows.push({
      courseId: id,
      name: (typeof studentCourseName === "function" ? studentCourseName(id) : "") || c.courseName || id,
      count: 0,
    });
  });
  rows.forEach(function (r) {
    r.count = list.filter(function (c) { return String(c.courseId || "") === r.courseId; }).length;
  });
  rows.sort(function (a, b) { return b.count - a.count; });
  return rows;
}

/* 🔴 学生端「我的作业」的徽标要**现算**，而且必须在 `EXAMS` 加载完之后才调 ——
   `var EXAMS = loadExams()` 在上面，此刻已经就位（侧栏渲染在 nav.js 之后）。 */
refreshExamNav();

/* 学生端「实训」徽标同理（进行中的实训数），数据层已就位再算 */
refreshStudentTrainingNav();
