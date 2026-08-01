# 为 Motion Studio 做贡献

感谢你改进 Motion Studio。请优先提交小范围、可审查并带有验证证据的改动。

## 开发环境

- Windows 10/11；
- Node.js 22 或更新版本；
- pnpm 11.9；
- Rust stable 与 `x86_64-pc-windows-msvc` 目标；
- Tauri v2 的 Windows 构建依赖和 WebView2。

安装并启动 Web 版：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

启动桌面开发版：

```powershell
pnpm tauri dev
```

## 修改约定

- 保持场景文档、编辑器会话状态和物理运行时状态相互独立。
- 不在 UI 线程实现物理推进；固定外部步长仍为 `1/120 s`。
- 行为变化应增加或更新测试，物理修复必须包含能复现问题的长期或边界回归。
- 不执行场景文件中的代码，不扩大 Tauri 文件系统权限，不添加默认遥测或网络请求。
- 不提交密钥、Token、`.env`、缓存、构建产物、测试报告或本地工具。
- 增加依赖前请说明用途、产物体积和许可证；运行生产依赖许可证审计。

## 验证

提交前至少运行与改动直接相关的测试。全局、物理或桌面改动应运行：

```powershell
pnpm format:check
pnpm check
pnpm e2e
pnpm benchmark
cd src-tauri
cargo fmt --check
cargo test --locked
```

桌面打包改动还应回到仓库根目录运行：

```powershell
pnpm tauri build --target x86_64-pc-windows-msvc
```

物理固定步 P99 目标为 `<8.33 ms`。Windows 调度造成的单次离群应保留原结果并在隔离环境复测，不得通过放宽阈值或过滤结果掩盖。

## 提交与合并请求

- 使用清晰的 Conventional Commit 风格说明，例如 `fix: 稳定无阻尼弹簧长期能量`。
- 一个提交只解决一个可解释的问题。
- 合并请求说明应包含改了什么、为什么、用户影响、验证命令和已知限制。
- 若改变架构、物理模型、权限或存档格式，请同时更新 `PROJECT_SPEC.md` 和 `docs/adr/`。

提交贡献即表示你同意依据项目的 Apache-2.0 许可证提供该贡献。
