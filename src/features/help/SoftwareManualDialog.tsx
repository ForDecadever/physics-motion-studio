import { toolDefinitions } from '../toolbar/toolDefinitions'
import styles from '../../app/App.module.css'

interface SoftwareManualDialogProps {
  onClose: () => void
}

const manualPdfUrl = `${import.meta.env.BASE_URL}docs/Motion-Studio-1.6.1-Manual-zh-CN.pdf`

const toolInstructions: Partial<Record<(typeof toolDefinitions)[number]['id'], string>> = {
  select: '单击选择，拖动物体或多选整体；Shift 多选，Alt 临时关闭吸附。',
  rotate: '拖动旋转手柄；布尔结果会作为一个整体旋转。',
  scale: '拖四角等比缩放，拖四边仅沿对应的 X 或 Y 方向缩放。',
  hand: '拖动画布平移视图；编辑时也可按住空格临时使用。',
  zoom: '在画布上拖动缩放视图，滚轮也可围绕鼠标位置缩放。',
  ground: '拖动创建直线、圆弧或贝塞尔地面；属性中可开启传送带并设置方向、速度。',
  groundJoint: '依次选择两段地面的端点，建立平滑连接或直接接缝。',
  body: '拖动创建小球或物块；矩形从起始角拖到对角，物体颜色可在属性中修改。',
  field: '创建重力场、电场或磁场；电场 X/Y 分量可分别输入包含 t 的表达式。',
  connector: '依次选择两个端点创建绳、杆或弹簧；空白处可作为自由端。',
  particleSource: '创建点源或线源；点源可设置角度范围与个/度密度，两种源均可开启定时连续发射。',
  force: '先点击受力物体，再拖出方向；力的大小和以度表示的方向都可输入包含 t 的表达式。',
  marker: '按住并拖动在画布上书写；一笔作为一条可撤销、可保存的记号。',
  ruler: '依次选择两个点，显示两点坐标和距离。',
  protractor: '依次选择第一边点、顶点、第二边点，显示夹角。',
  forceMeter: '点击物体上的一点，实时显示重力、场力、外加力及约束/接触合力。',
}

export function SoftwareManualDialog({ onClose }: SoftwareManualDialogProps) {
  return (
    <div className={styles.modalBackdrop}>
      <section
        className={`${styles.modal} ${styles.manualModal}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="software-manual-title"
      >
        <header className={styles.manualHeader}>
          <div>
            <h2 id="software-manual-title">Motion Studio 软件说明</h2>
            <p>二维物理场景的创建、模拟、测量与导出指南</p>
          </div>
          <span>场景格式 21</span>
        </header>

        <div className={styles.manualContent}>
          <section>
            <h3>快速开始</h3>
            <ol>
              <li>从左侧工具栏选择工具，在中央画布拖动或依次点击来创建对象。</li>
              <li>在右侧场景面板选择对象，在属性面板修改几何、材料和物理参数。</li>
              <li>点击底栏播放按钮运行模拟；暂停或重置后可继续编辑物理对象。</li>
              <li>测量工具可在模拟运行中使用，记号、直尺和量角器会随场景文件保存。</li>
              <li>通过“文件”保存场景、导出图表 CSV 或 GIF；坏文件不会覆盖当前场景。</li>
            </ol>
          </section>

          <section>
            <h3>工具说明</h3>
            <div className={styles.manualToolGrid}>
              {toolDefinitions.map(({ id, label, shortcut, icon: Icon }) => (
                <article key={id}>
                  <Icon size={16} aria-hidden="true" />
                  <div>
                    <h4>
                      {label} <kbd>{shortcut}</kbd>
                    </h4>
                    <p>{toolInstructions[id]}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section>
            <h3>公式、变量与单位</h3>
            <ul>
              <li>场景内部统一使用米、秒、千克、弧度、牛顿、库仑和特斯拉。</li>
              <li>“编辑 → 全局变量”可定义 a、b 等符号；场景数值属性可输入 3a、a/10、sin(a)。</li>
              <li>公式输入仍保留上下箭头与键盘步进；单位和当前解析值不会遮挡公式。</li>
              <li>时变场和力额外支持时间变量 t，例如 10*sin(t)；非法或非有限结果会被拒绝。</li>
              <li>世界坐标 X 向右、Y 向上；力方向以 X 轴正向为 0°，逆时针为正。</li>
            </ul>
          </section>

          <section>
            <h3>编辑、运行与记录</h3>
            <ul>
              <li>Ctrl+Z / Ctrl+Y 撤销和重做，Ctrl+C / Ctrl+V 复制和粘贴，Delete 删除。</li>
              <li>P 播放或暂停，句点单步，Shift+R 重置；编辑输入框时快捷键不会抢占输入。</li>
              <li>模拟运行中物理结构会锁定，但选择、视图和四种测量工具仍可使用。</li>
              <li>“编辑 → 设置”管理吸附和新建对象默认值；设置保存在本机，不修改当前场景。</li>
              <li>图表和 GIF 采样属于运行记录，不写进场景存档；可从“模拟”清空记录。</li>
              <li>连续粒子只显示当前位置；GIF 按稳定粒子 ID 记录出生和到期，不设粒子数量上限。</li>
            </ul>
          </section>

          <section>
            <h3>物理口径与限制</h3>
            <ul>
              <li>模拟采用 1/120 s 固定步长；播放倍速通过增加固定步数量实现。</li>
              <li>
                测力计的重力、场力和外加力按当前模型直接分项，其余显示为接触、连接器和约束合力。
              </li>
              <li>布尔结果共享解析边界；交集、差集可保留来源，也可解散为独立结果。</li>
              <li>数值模拟存在离散误差。本软件适合教学和常规模拟，科研用途应另做独立验证。</li>
            </ul>
          </section>

          <section>
            <h3>常见问题</h3>
            <dl className={styles.manualFaq}>
              <dt>对象为什么不能拖动？</dt>
              <dd>先暂停模拟，并检查场景面板中的锁定状态；测量工具不受运行锁定影响。</dd>
              <dt>输入公式后没有生效？</dt>
              <dd>按 Enter 或离开输入框提交。变量必须先定义，公式只能使用受支持的运算和函数。</dd>
              <dt>为什么隐藏对象后仍参与运动？</dt>
              <dd>“可见”只控制显示；是否参与模拟由“启用模拟”单独控制。</dd>
              <dt>如何临时精确放置？</dt>
              <dd>拖动时按住 Alt 可临时关闭吸附，也可在顶栏关闭网格、墙面或物块吸附。</dd>
            </dl>
          </section>
        </div>

        <div className={styles.modalActions}>
          <a
            className={`${styles.modalActionLink} ${styles.modalActionPrimary}`}
            href={manualPdfUrl}
            target="_blank"
            rel="noreferrer"
          >
            打开完整 PDF
          </a>
          <a className={styles.modalActionLink} href={manualPdfUrl} download>
            下载完整 PDF
          </a>
          <button type="button" autoFocus onClick={onClose}>
            关闭
          </button>
        </div>
      </section>
    </div>
  )
}
