# Yeux 学习秘书

前端采用 macOS 风格的材质与层次：导航轻透，学习内容稳定清晰。沙丁鱼仍是 48px 高的小标识，界面的重点是学习与操作。

## 2026-10-03 调整

原界面侧栏为实色，边线和选中块偏重，各个区域缺少材质差异。这次让侧栏与内容区组成连续窗口，使用磨砂背景、柔和高光与轻阴影区分层次。主内容保持不透明，功能入口、输入、待办分别处理，不给所有内容套相同的卡片。

导航仍是“今天 / 目标 / 资料”。首页保留“学习计划 / 学习答疑 / 整理材料 / 安排复盘”四个入口；图标使用低饱和色帮助区分用途，选中项同时具有边线与背景反馈。功能名、字段和动作保持明确，不增加装饰统计、假窗口按钮或新操作层级。

```text
┌─────────────┬────────────────────────────┐
│ 鱼 / yeux   │ 个人学习空间          日期 │
│ 今天        ├────────────────────────────┤
│ 目标        │ 学习工作台                 │
│ 资料        │ 计划  答疑  材料  复盘     │
│             │ 输入与主操作 │ 待办        │
│ 更多 / 账号 │              │ 常用入口    │
└─────────────┴────────────────────────────┘
```

左右独立漂浮面板容易增加割裂感，因此采用连续窗口。长页面仍使用正常文档滚动，侧栏留在视口内；手机收为顶部三项导航和单列内容。

| 设计项 | 浅色主题 |
| --- | --- |
| 画布 | 雾灰 `#E7EDF2` |
| 阅读区 | 纸面 `#FAFBFC` |
| 输入与面板 | 白色 `#FFFFFF` |
| 正文 | `#253342` |
| 次要文字 | `#606E7C` |
| 主操作 | 湖蓝 `#326C99` |
| 字体 | 系统 SF / PingFang；yeux 保留 Georgia，不请求外部字体 |
| 字级 | 28px 页面标题、16–17px 分组、14–15px 操作与正文 |
| 圆角 | 外壳 20px、面板 12–16px、控件 9–10px；点击区域至少 44px |

颜色收敛为共享 CSS 变量。深色主题使用独立石墨色阶，随系统切换；正文、表单、状态、设备页、菜单和登录页共用相同语义。磨砂采用 `backdrop-filter` 与 WebKit 前缀；不支持滤镜或系统要求减少透明度时回退为实色。菜单的底色比侧栏更实，避免透出内容干扰阅读。键盘焦点、减少动态效果和系统高对比模式均保留。

前端文案沿用功能名、字段名和明确动作，不用问句作为操作提示。生成的练习题和用户内容保留原文。示例只填入输入框，不自动提交；各功能草稿独立暂存。登录仍使用既有 Cookie 认证，密码管理器与显示密码继续可用。

## 验证

本轮使用 macos-design 和 frontend-design，不引入新样式库，不修改业务接口。验证结果见 SPEC 中“界面材质与可读性”一节；截图使用合成数据，与个人学习记录分开保存。

## Logo

文件：`apps/web/public/sardina-secretary.png`。由内置 image_gen 生成，使用 handdraw **#097 · Yuru-Surreal Minimal Everyday Cartoon** 编号参考图。参考图只用于线条和视觉语言，不复制原图角色或情节；参考图本身不随仓库发布。画面为圆眼镜沙丁鱼、记事本和笔。

以下中文为实际生成提示词，英文是对应的可复制版本，可用于其他图像 AI；最终绘制由所使用的模型决定。

### 中文提示词

```text
风格名称：#097 · Yuru-Surreal Minimal Everyday Cartoon。参考作者/风格名称：のなか海 / Yuru-Surreal Minimal Everyday Cartoon。主题：为个人学习助手画一条戴眼镜的 sardina 沙丁鱼 Logo，结合秘书元素：鱼鳍抱着一本小记事本和一支笔。核心风格特征：ゆるシュール、极简人物、反逻辑日常；脸部与服装主动做减法，依靠清楚轮廓、眼口和少量关键形状建立人物辨识度。所附图片仅用于参考画风。只提取参考图的风格特征，例如线条、笔触、媒介、材质、色彩倾向和整体视觉语言；不要使用、复制或延续参考图中的任何主体、人物、动物、服装、道具、动作、姿态、场景、背景、构图、布局、文字或故事。最终画面内容完全以用户提供的主题为准。
```

### English prompt

```text
Style name: #097 · Yuru-Surreal Minimal Everyday Cartoon. Reference author/style name: のなか海 / Yuru-Surreal Minimal Everyday Cartoon. Theme: a sardina wearing glasses as the logo for a personal learning assistant, with secretary elements: fins holding a small notebook and a pen. Core style traits: gentle surrealism, minimal characters and illogical everyday situations; simplify facial and clothing details, using clear outlines, eyes, a mouth and a few essential shapes to establish character identity. Use the attached image only as a style reference. Extract only its stylistic qualities, such as linework, brushwork, medium, material texture, color tendencies, and overall visual language. Do not use, copy, or carry over any subject, person, animal, clothing, prop, action, pose, setting, background, composition, layout, text, or story from the reference image. The user's written theme is the sole source for the image content.
```

在本机重新使用提示词时附上 handdraw 的 `images/individual/001-200/097.webp`。本次生成传入的完整路径为 `/Users/zfu/.codex/skills/handdraw-style-prompter/images/individual/001-200/097.webp`；其他机器使用各自安装路径。
