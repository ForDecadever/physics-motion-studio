# Motion Studio

一个采用专业图形编辑器布局的二维物理运动模拟工具。当前已完成 [PROJECT_SPEC.md](./PROJECT_SPEC.md) 中的阶段 2：刚体、地面、重力和播放内核。

## 当前已经具备

- React + TypeScript + Vite 工程和 Photoshop 风格编辑布局；
- PixiJS 二维画布、自适应米制网格、平移、缩放、选择、移动、旋转与吸附；
- 创建质点、小球、物块、直线地面、圆弧地面、贝塞尔地面和矩形重力场；
- 在右侧编辑位置、角度、尺寸、质量、初速度、初角速度、摩擦系数、弹性系数和 CCD；
- Rapier 2D 刚体碰撞在独立 Web Worker 中运行，不会阻塞界面；
- 固定 `1/120 s` 物理步长，以及播放、暂停、单步、倍速和重置；
- 圆弧和贝塞尔曲线自适应离散，支持单面或双面碰撞；
- 接触摩擦系数按 `sqrt(μ₁ × μ₂)` 合成，弹性系数取 `max(e₁, e₂)`；
- 新建、打开和下载 `.motion.json` 场景；
- ESLint、Prettier、TypeScript、Vitest 和 Playwright 检查流程。

物理验证方法与误差边界记录在 [docs/PHYSICS_VALIDATION.md](./docs/PHYSICS_VALIDATION.md)。电场、磁场、绳/杆/弹簧动力学和物理量曲线属于后续阶段；目前这些实体仍可绘制和保存，但不会参与计算。

## 第一次运行

打开 PowerShell，进入项目文件夹：

```powershell
cd "C:\Users\FD\Desktop\chengxu\题目可视化"
```

安装依赖：

```powershell
pnpm install
```

启动开发界面：

```powershell
pnpm dev
```

成功时会显示 `http://127.0.0.1:4173/`。终止服务器时按 `Ctrl+C`。

## 如何搭建第一个运动场景

1. 用“地面工具”拖出地面；
2. 用“物体工具”放置小球或物块；
3. 用“场工具”画出覆盖物体运动范围的重力场；
4. 选中物体，在右侧输入初速度等参数；
5. 点击底部播放按钮。模拟开始后编辑会锁定，点击重置回到 `0 s` 后可继续修改。

## 检查命令

完整检查：

```powershell
pnpm check
```

真实浏览器交互检查：

```powershell
pnpm e2e
```

成功时会看到全部测试通过。第一次在新电脑上运行浏览器检查前，需要先执行 `pnpm e2e:install`。

## 主要目录

```text
src/physics/core/        可独立测试的物理世界、曲线采样和场区域判断
src/physics/worker/      后台物理循环和主线程消息协议
src/physics/client/      界面与物理线程之间的控制器
src/features/            菜单、工具栏、画布、属性、播放和图表区域
src/scene/               场景数据、校验、迁移和实体工厂
src/stores/              文档、编辑器和运行时状态
docs/                    物理验证报告和架构决策记录
e2e/                     真实浏览器测试
```

## 下一阶段

阶段 3 将实现电场、磁场、绳、杆和弹簧的真实受力与约束，并继续扩充可编辑参数。
