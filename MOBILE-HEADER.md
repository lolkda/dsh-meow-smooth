# 本分支的手机适配

基于 [Phant0Meow/dsh-meow-smooth](https://github.com/Phant0Meow/dsh-meow-smooth) 提交 `7a32ebd8e0976172a68b4845f69926600fd89783`（0.8.1）的独立维护分支，保留上游 MIT 许可。发布包使用 `@lolkda/meow-smooth`，不覆盖上游包。

## 与上游功能说明的主要差异

- 小于 768 CSS px 时，顶部标题、操作与标签分行，长项目可省略，避免整页横向溢出；768px 及以上保留桌面布局。
- 手机标题可点击打开侧栏，无普通标题时使用菜单按钮；不再显示原鲸鱼方块入口。
- 手机侧栏全屏展开；设置采用目录 → 内容 → 返回的单页导航。全局入口点击后收起侧栏。
- 不再注册额外插话/排队按钮，保留宿主原生发送、停止与附件入口。
- 移除手机 Enter 换行拦截、`enterkeyhint` 覆盖和旧版选图兜底槽。
- 移除输入框自动折叠/展开，输入高度交还宿主；其他输入增强仍保留。

这些规则针对现有 DSH 页面结构；CSS 使用 `:has()` 和媒体查询范围语法。不同宿主版本与真实移动设备仍需各自验证。此文档不代替当前版本的运行验收。

## 构建与检查

```sh
npm ci
npm run typecheck
npm run build
node --test scripts/verify-package.test.mjs
node scripts/verify-package.mjs
```

`Node.prototype.removeChild` 的诊断包装器先调用原生方法、再返回同一个子节点，保留原生异常传播及泛型返回类型。

## 可选浏览器回归

```sh
node scripts/test-header-mobile-wrap.mjs http://127.0.0.1:3080
node scripts/test-header-mobile-integration.mjs
```

浏览器脚本依赖 `MEOW_CDP`（通常为 `http://127.0.0.1:9222`）和已认证的 DSH 页面，不是离线 CI 单测。部分历史脚本仍带开发环境地址，使用前检查各脚本的参数或 `MEOW_BASE` 支持并指向自己的测试实例。不要直接对重要会话运行未知测试。

测试可能生成截图、UI 文本和安装配置备份；这些输出保存在被 Git 忽略的 `artifacts/` 或 `shots/`，不随公开仓库或 npm 包发布。历史本机验收记录不在公开文档中引用。

## 安装与切换

使用 README 中本分支安装命令。切换前保存当前 profile 的插件引用；本分支与上游共用插件功能和路由，不应同时启用。需要回到上游时，先移除本分支，再按需安装 `meow-smooth@0.8.1` 或其他指定上游版本。

安装后按宿主要求重启或刷新现有 GUI，并检查实际加载的资源；不能仅凭源码或 npm 发布成功认定运行实例已经更新。本发布流程不自动重启或替换正在运行的 DSH 插件。
