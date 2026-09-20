# Agent 项目开发规范

> 使用中文和我对话

## 0. 核心

1. 技术：Nuxt + Drizzle + sqlite
2. 文件：本地
3. 部署：electron + 自动更新 + 下载 + 安装，webview 直接热更新

## 1. 协作方式

1. 每个独立任务完成并验证通过后进行一次 git commit，commit message 清晰说明修改内容。
2. 安装依赖、启动服务、git commit、push 等终端操作自行执行，无需等待确认。
3. 删除生产数据、破坏性数据库迁移、删除远程资源等不可逆操作必须先询问。
4. 需要我选择方案或确认产品行为时，及时询问，不自行猜测。
5. 提交前检查 `git diff`、`git status`，并运行相关检查。

## 2. 技术栈

无特别指定时：

* Web：`Nuxt` + `Vue` + `TypeScript`
* UI：`Nuxt UI`
* ORM：`Drizzle`
* 客户端 / 本地轻量应用：`SQLite`
* Icon：Carbon，https://icones.js.org/
* 普通动画：Motion for Vue，https://motion.dev/docs/vue-animation
* 高级动画：GSAP，https://gsap.com/

数据库原则：

* 无明确需求不增加其他数据库或基础设施。

## 3. 设计与代码

* 设计默认参考：https://design.yiheng.run/design-md/claude/DESIGN.md
* 项目已有组件库时优先复用。
* 界面保持简洁、现代、统一。
* 代码优先简单、清晰、易维护。
* 避免重复代码、过度抽象和无必要的重构。
* 无明确需求遵循 YAGNI。

## 4. 性能与用户体验

* 避免多余的网络请求和重复 API 请求。
* 合理使用缓存。
* 注意数据库查询效率。
* 加载、空状态、错误状态应有合理反馈。
* 不向用户暴露不必要的内部实现细节。


## 5. 环境与安全

* API Key、密码、Token 等敏感信息使用环境变量。
* `.env` 不提交 git，并提供 `.env.example`。
* 不在代码中硬编码密钥和生产配置。
* 不提交无关修改。
* 不随意修改或删除已有代码。
