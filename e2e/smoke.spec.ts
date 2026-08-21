import { expect, test } from '@playwright/test'
import { decompressFrames, parseGIF } from 'gifuct-js'
import { readFile } from 'node:fs/promises'

async function openInspectorTab(
  page: import('@playwright/test').Page,
  name: '基本' | '变换' | '几何' | '物理' | '初始状态' | '高级',
) {
  await page.getByRole('tab', { name, exact: true }).click()
}

test('显示编辑器的主要区域', async ({ page }) => {
  await page.goto('/')

  await expect(page).toHaveTitle('Motion Studio')
  await expect(page.getByRole('banner')).toContainText('文件')
  await expect(page.getByRole('main')).toContainText('二维场景')
  await expect(
    page.getByRole('main').getByRole('application', { name: '可交互的二维物理画布' }),
  ).toBeVisible()
  await expect(page.getByRole('region', { name: '属性面板' })).toBeVisible()
  const sceneTree = page.getByRole('region', { name: '场景树' })
  await expect(sceneTree).toHaveAttribute('data-embedded', 'true')
  const sceneTreeFillRatio = await sceneTree.evaluate((panel) => {
    const content = panel.firstElementChild
    return content
      ? content.getBoundingClientRect().height / panel.getBoundingClientRect().height
      : 0
  })
  expect(sceneTreeFillRatio).toBeGreaterThan(0.9)
  await expect(page.getByText('多坐标系图像区', { exact: true })).toBeVisible()
  await expect(page.getByLabel('应用菜单')).toBeVisible()
  await expect(page.getByLabel('Motion Studio')).toHaveCount(0)
})

test('可以冻结已有记录并导出运动 GIF', async ({ page }) => {
  test.setTimeout(60_000)
  const pageErrors: Error[] = []
  page.on('pageerror', (error) => pageErrors.push(error))
  await page.setViewportSize({ width: 1166, height: 613 })
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(center.x, center.y - 60)
  await page.getByRole('button', { name: '场工具（F）' }).click()
  await page.mouse.move(center.x - 180, center.y - 160)
  await page.mouse.down()
  await page.mouse.move(center.x + 180, center.y + 140, { steps: 6 })
  await page.mouse.up()

  const playButton = page.getByRole('button', { name: '播放' })
  await expect(playButton).toBeEnabled({ timeout: 15_000 })
  await playButton.click()
  await expect(page.getByText('模拟运行中', { exact: true })).toBeVisible()
  await page.waitForTimeout(450)

  await page.getByText('文件', { exact: true }).click()
  await page.getByRole('menuitem', { name: '导出动图 GIF' }).click()
  const dialog = page.getByRole('dialog', { name: '导出运动 GIF' })
  await expect(dialog).toBeVisible()
  await expect(page.getByText('模拟已暂停', { exact: true })).toBeVisible()
  await page.keyboard.press('p')
  await expect(page.getByText('模拟已暂停', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel('GIF 导出开始时间')).toBeVisible()
  await expect(dialog.getByLabel('GIF 导出结束时间')).toBeVisible()
  await expect(dialog.getByRole('group', { name: 'GIF 时间轴' })).toBeVisible()
  const trimStart = dialog.getByLabel('GIF 导出开始时间')
  const trimEnd = dialog.getByLabel('GIF 导出结束时间')
  const historyStart = Number(await trimStart.getAttribute('min'))
  const historyEnd = Number(await trimEnd.getAttribute('max'))
  const sampleStep = Number(await trimStart.getAttribute('step'))
  const requestedStart =
    historyStart + Math.floor(((historyEnd - historyStart) * 0.25) / sampleStep) * sampleStep
  const trimStartBox = await trimStart.boundingBox()
  expect(trimStartBox).not.toBeNull()
  if (trimStartBox) {
    await page.mouse.move(trimStartBox.x + 7, trimStartBox.y + trimStartBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(
      trimStartBox.x +
        ((requestedStart - historyStart) / (historyEnd - historyStart)) * trimStartBox.width,
      trimStartBox.y + trimStartBox.height / 2,
      { steps: 6 },
    )
    await page.mouse.up()
  }
  expect(Number(await trimStart.inputValue())).toBeGreaterThan(historyStart)
  expect(Number(await dialog.getByLabel('GIF 预览时间').inputValue())).toBeGreaterThanOrEqual(
    Number(await trimStart.inputValue()),
  )
  expect(
    Number(await dialog.getByTestId('gif-timeline-control').getAttribute('data-trim-start')),
  ).toBeGreaterThan(0)
  const playhead = dialog.getByLabel('GIF 预览时间')
  await playhead.focus()
  await page.keyboard.press('ArrowRight')
  expect(Number(await playhead.inputValue())).toBeGreaterThan(Number(await trimStart.inputValue()))
  await page.keyboard.press('Home')
  expect(Number(await playhead.inputValue())).toBeCloseTo(Number(await trimStart.inputValue()), 3)
  const selectedTrackBox = await dialog.getByTestId('gif-timeline-selection').boundingBox()
  const timelineBox = await dialog.getByTestId('gif-timeline-control').boundingBox()
  expect(selectedTrackBox).not.toBeNull()
  expect(timelineBox).not.toBeNull()
  if (selectedTrackBox && timelineBox) expect(selectedTrackBox.x).toBeGreaterThan(timelineBox.x)

  const fpsSelect = dialog.getByLabel('GIF 每秒帧数')
  await expect(fpsSelect).toBeVisible()
  await fpsSelect.selectOption('custom')
  await dialog.getByLabel('自定义 FPS').fill('17')
  await expect(dialog.getByLabel('自定义 FPS')).toHaveValue('17')
  await fpsSelect.selectOption('15')

  const resolutionSelect = dialog.getByLabel('常用分辨率')
  const exportCanvas = dialog.getByRole('img', { name: 'GIF 导出预览' })
  for (const [value, width, height] of [
    ['960x540', 960, 540],
    ['1280x720', 1280, 720],
    ['1920x1080', 1920, 1080],
    ['1080x1080', 1080, 1080],
  ] as const) {
    await resolutionSelect.selectOption(value)
    await expect(exportCanvas).toHaveAttribute('width', String(width))
    await expect(exportCanvas).toHaveAttribute('height', String(height))
  }
  await resolutionSelect.selectOption('custom')
  await dialog.getByLabel('锁定宽高比例').uncheck()
  await dialog.getByLabel('宽度', { exact: true }).fill('800')
  await dialog.getByLabel('高度', { exact: true }).fill('450')
  await expect(exportCanvas).toHaveAttribute('width', '800')
  await expect(exportCanvas).toHaveAttribute('height', '450')
  await resolutionSelect.selectOption('640x360')

  const viewportBox = await dialog.getByTestId('gif-preview-viewport').boundingBox()
  const exportFrameBox = await dialog.getByTestId('gif-export-frame').boundingBox()
  expect(viewportBox).not.toBeNull()
  expect(exportFrameBox).not.toBeNull()
  if (viewportBox && exportFrameBox) {
    expect(exportFrameBox.x - viewportBox.x).toBeGreaterThanOrEqual(22)
    expect(exportFrameBox.y - viewportBox.y).toBeGreaterThanOrEqual(22)
    expect(
      viewportBox.x + viewportBox.width - exportFrameBox.x - exportFrameBox.width,
    ).toBeGreaterThanOrEqual(22)
    expect(
      viewportBox.y + viewportBox.height - exportFrameBox.y - exportFrameBox.height,
    ).toBeGreaterThanOrEqual(22)
  }

  await expect(dialog.getByLabel('小球 1 轨迹')).toBeEnabled()
  const guideFieldsetBox = await dialog.getByTestId('gif-guide-fieldset').boundingBox()
  const guideTableBox = await dialog.getByTestId('gif-guide-table').boundingBox()
  expect(guideFieldsetBox).not.toBeNull()
  expect(guideTableBox?.height).toBeGreaterThanOrEqual(230)
  if (guideFieldsetBox && guideTableBox) {
    expect(guideTableBox.y).toBeGreaterThan(guideFieldsetBox.y)
    expect(guideTableBox.y + guideTableBox.height).toBeLessThan(
      guideFieldsetBox.y + guideFieldsetBox.height,
    )
  }
  const guideCheckboxBox = await dialog.getByLabel('小球 1 轨迹').boundingBox()
  const guideHitAreaBox = await dialog.getByLabel('小球 1 轨迹').locator('xpath=..').boundingBox()
  expect(guideCheckboxBox?.height).toBeGreaterThanOrEqual(24)
  expect(guideHitAreaBox?.height).toBeGreaterThanOrEqual(36)
  await dialog.getByLabel('小球 1 轨迹').check()
  const colorBox = await dialog.getByLabel('背景颜色').boundingBox()
  const colorTextBox = await dialog.getByText('背景颜色', { exact: true }).boundingBox()
  expect(colorBox).not.toBeNull()
  expect(colorTextBox).not.toBeNull()
  if (colorBox && colorTextBox) expect(colorBox.x).toBeLessThan(colorTextBox.x)

  await dialog.getByLabel('GIF 成片倍速').selectOption('2')
  const loadSummary = dialog.getByRole('region', { name: '导出负载' })
  const sourceDuration = Number.parseFloat(await loadSummary.locator('strong').nth(0).innerText())
  const outputDuration = Number.parseFloat(await loadSummary.locator('strong').nth(1).innerText())
  const expectedFrameCount = Number.parseInt(
    (await loadSummary.locator('strong').nth(2).innerText()).replaceAll(',', ''),
    10,
  )
  expect(Math.abs(outputDuration - sourceDuration / 2)).toBeLessThanOrEqual(0.011)
  expect(pageErrors).toEqual([])
  await expect(
    dialog.getByRole('region', { name: 'GIF 预览和时间范围' }).getByText('640 × 360'),
  ).toBeVisible()

  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
  await dialog.getByRole('button', { name: '导出 GIF' }).click()
  await expect(dialog.getByText(/正在准备颜色|正在渲染并编码/)).toBeVisible()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^motion-studio-\d{8}-\d{6}\.gif$/)
  const path = await download.path()
  expect(path).not.toBeNull()
  if (path) {
    const bytes = await readFile(path)
    expect(bytes.subarray(0, 6).toString('ascii')).toBe('GIF89a')
    expect(bytes.length).toBeGreaterThan(100)
    const arrayBuffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(arrayBuffer).set(bytes)
    const parsed = parseGIF(arrayBuffer)
    expect(parsed.lsd).toMatchObject({ width: 640, height: 360 })
    const frames = decompressFrames(parsed, true)
    expect(frames).toHaveLength(expectedFrameCount)
    expect(frames.length).toBeGreaterThan(1)
    const totalDelay = frames.reduce((total, frame) => total + frame.delay, 0)
    expect(Math.abs(totalDelay - outputDuration * 1000)).toBeLessThanOrEqual(1000 / 15 + 10)
  }
  await expect(dialog).toHaveCount(0)
})

test('没有运动记录时会说明原因并禁用 GIF 导出', async ({ page }) => {
  await page.goto('/')
  await page.getByText('文件', { exact: true }).click()
  await page.getByRole('menuitem', { name: '导出动图 GIF' }).click()
  const dialog = page.getByRole('dialog', { name: '导出运动 GIF' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/还没有足够的运动记录/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: '导出 GIF' })).toBeDisabled()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)
})

test('可以创建、连接并撤销编辑实体', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const layerEntity = (name: string) => page.locator('button').filter({ hasText: name })
  const drag = async (startX: number, startY: number, endX: number, endY: number) => {
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 6 })
    await page.mouse.up()
  }

  await page.getByRole('button', { name: '地面工具（G）' }).click()
  await drag(center.x - 220, center.y + 150, center.x + 220, center.y + 150)
  await expect(layerEntity('直线地面 1')).toBeVisible()

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(center.x - 100, center.y - 40)
  await page.mouse.click(center.x + 100, center.y - 40)
  await expect(layerEntity('小球 1')).toBeVisible()
  await expect(layerEntity('小球 2')).toBeVisible()

  await page.getByRole('button', { name: '场工具（F）' }).click()
  await drag(center.x - 250, center.y - 170, center.x + 250, center.y + 50)
  await expect(layerEntity('重力场 1')).toBeVisible()

  await page.getByRole('button', { name: '连接工具（L）' }).click()
  await page.mouse.click(center.x - 100, center.y - 40)
  await expect(page.getByText('请选择第二个端点', { exact: true })).toBeVisible()
  await page.mouse.click(center.x + 100, center.y - 40)
  await expect(layerEntity('绳 1')).toBeVisible()

  await page.keyboard.press('Control+z')
  await expect(layerEntity('绳 1')).toHaveCount(0)
  await page.keyboard.press('Control+y')
  await expect(layerEntity('绳 1')).toBeVisible()

  await layerEntity('小球 1').click()
  await openInspectorTab(page, '变换')
  await page.getByRole('button', { name: '选择与移动（V）' }).click()
  await page.mouse.move(center.x - 100, center.y - 40)
  await page.mouse.down()
  await page.mouse.move(center.x - 50, center.y - 40, { steps: 6 })
  await expect(page.getByLabel('位置 X')).toHaveValue('-2')
  await page.mouse.up()

  await page.getByRole('button', { name: '旋转（R）' }).click()
  await page.mouse.move(center.x - 30, center.y - 40)
  await page.mouse.down()
  await page.mouse.move(center.x - 40, center.y - 50, { steps: 6 })
  await expect(page.getByLabel('角度')).toHaveValue('90')
  await page.mouse.up()

  const zoomReadout = page.getByRole('main').getByText(/px\/m/)
  await expect(zoomReadout).toHaveText('20 px/m')
  await page.mouse.move(center.x, center.y)
  await page.mouse.wheel(0, -240)
  await expect(zoomReadout).not.toHaveText('100 px/m')

  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  await expect(layerEntity('小球 1 副本')).toBeVisible()
})

test('对象缩放工具支持实时预览、吸附、多选和撤销重做', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const scaleTool = page.getByRole('button', { name: '对象缩放（S）' })
  const bodyTool = page.getByRole('button', { name: '物体工具（O）' })
  const entityButton = (name: string) => page.getByRole('button', { name, exact: true })

  await bodyTool.click()
  await page.mouse.click(center.x, center.y)
  await openInspectorTab(page, '几何')
  const radius = page.getByLabel('半径')
  await expect(radius).toHaveValue('0.5')

  await page.keyboard.press('s')
  await expect(scaleTool).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByText('拖动四角手柄等比缩放 · Alt 临时关闭吸附')).toBeVisible()

  const startHandle = { x: center.x + 15, y: center.y - 15 }
  const targetHandle = { x: center.x + 25, y: center.y - 25 }
  await page.mouse.move(startHandle.x, startHandle.y)
  await page.mouse.down()
  await page.mouse.move(targetHandle.x, targetHandle.y, { steps: 5 })
  await expect(radius).toHaveValue('0.58333')
  await page.mouse.up()

  await page.keyboard.press('Control+z')
  await expect(radius).toHaveValue('0.5')

  await page.keyboard.down('Alt')
  await page.mouse.move(startHandle.x, startHandle.y)
  await page.mouse.down()
  await page.mouse.move(targetHandle.x, targetHandle.y, { steps: 5 })
  await expect.poll(async () => Number(await radius.inputValue())).toBeGreaterThan(0.5)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await entityButton('小球 1').click()
  await openInspectorTab(page, '几何')
  await expect(radius).toHaveValue('0.5')

  await page.keyboard.down('Alt')
  await page.mouse.move(startHandle.x, startHandle.y)
  await page.mouse.down()
  await page.mouse.move(center.x + 30, center.y - 30, { steps: 5 })
  await expect.poll(async () => Number(await radius.inputValue())).toBeGreaterThan(0.5)
  await page.mouse.up()
  const committedRadius = await radius.inputValue()
  await page.keyboard.up('Alt')
  await page.keyboard.press('Control+z')
  await expect(radius).toHaveValue('0.5')
  await page.keyboard.press('Control+y')
  await expect(radius).toHaveValue(committedRadius)
  await page.keyboard.press('Control+z')

  await bodyTool.click()
  await page.mouse.click(center.x + 80, center.y)
  await page.keyboard.press('s')
  await page.keyboard.down('Shift')
  await page.mouse.click(center.x, center.y)
  await page.keyboard.up('Shift')
  await expect(page.getByText('2 个实体已选择', { exact: true })).toBeVisible()

  const groupHandle = { x: center.x + 95, y: center.y - 15 }
  const groupTarget = { x: center.x + 150, y: center.y - 30 }
  await page.keyboard.down('Alt')
  await page.mouse.move(groupHandle.x, groupHandle.y)
  await page.mouse.down()
  await page.mouse.move(groupTarget.x, groupTarget.y, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up('Alt')

  await entityButton('小球 1').click()
  await openInspectorTab(page, '变换')
  await expect.poll(async () => Number(await page.getByLabel('位置 X').inputValue())).not.toBe(0)
  const scaledFirstX = await page.getByLabel('位置 X').inputValue()
  await openInspectorTab(page, '几何')
  const firstScaledRadius = await radius.inputValue()
  expect(Number(firstScaledRadius)).toBeGreaterThan(0.5)
  await entityButton('小球 2').click()
  await openInspectorTab(page, '变换')
  await expect
    .poll(async () => Number(await page.getByLabel('位置 X').inputValue()))
    .toBeGreaterThan(4)
  const scaledSecondX = await page.getByLabel('位置 X').inputValue()

  await page.keyboard.press('Control+z')
  await expect(page.getByLabel('位置 X')).toHaveValue('4')
  await page.keyboard.press('Control+y')
  await expect(page.getByLabel('位置 X')).toHaveValue(scaledSecondX)

  const playButton = page.getByRole('button', { name: '播放' })
  await expect(playButton).toBeEnabled({ timeout: 15_000 })
  await playButton.click()
  await expect(scaleTool).toBeDisabled()
  await page.getByRole('button', { name: '重置' }).click()

  await entityButton('小球 2').click()
  await page.getByRole('button', { name: '隐藏对象 小球 2' }).click()
  await expect(page.getByText('当前选择不可缩放', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '显示对象 小球 2' }).click()
  await expect(page.getByText('拖动四角手柄等比缩放 · Alt 临时关闭吸附')).toBeVisible()

  await page.getByRole('button', { name: '锁定对象 小球 2' }).click()
  await expect(page.getByText('当前选择不可缩放', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '解锁对象 小球 2' }).click()

  await page.getByRole('button', { name: '连接工具（L）' }).click()
  await page.mouse.click(center.x + Number(scaledFirstX) * 20, center.y)
  await page.mouse.click(center.x + Number(scaledSecondX) * 20, center.y)
  await expect(entityButton('绳 1')).toBeVisible()
  await entityButton('小球 1').click()
  await page.keyboard.down('Shift')
  await entityButton('绳 1').click()
  await page.keyboard.up('Shift')
  await page.keyboard.press('s')
  await expect(page.getByText('2 个实体已选择', { exact: true })).toBeVisible()
  await expect(page.getByText('拖动四角手柄等比缩放 · Alt 临时关闭吸附')).toBeVisible()

  await page.getByRole('button', { name: '场工具（F）' }).click()
  await page.getByLabel('场范围形状').selectOption('infinite')
  await page.mouse.click(center.x, center.y - 100)
  await page.keyboard.press('s')
  await expect(page.getByText('当前选择不可缩放', { exact: true })).toBeVisible()
})

test('物理 Worker 可以播放、暂停、单步和重置', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const drag = async (startX: number, startY: number, endX: number, endY: number) => {
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 6 })
    await page.mouse.up()
  }

  await page.getByRole('button', { name: '地面工具（G）' }).click()
  await drag(center.x - 220, center.y + 150, center.x + 220, center.y + 150)
  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(center.x, center.y - 60)
  await page.getByRole('button', { name: '场工具（F）' }).click()
  await drag(center.x - 250, center.y - 180, center.x + 250, center.y + 180)
  await page.locator('button').filter({ hasText: '小球 1' }).click()
  await openInspectorTab(page, '变换')

  const playback = page.getByRole('region', { name: '模拟播放控制' })
  const timeOutput = playback.locator('output')
  const playButton = page.getByRole('button', { name: '播放' })
  const positionY = page.getByLabel('位置 Y')
  const initialPositionY = await positionY.inputValue()
  await expect(playButton).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByText('编辑模式', { exact: true })).toBeVisible()
  await playButton.click()
  await expect(page.getByText('模拟运行中', { exact: true })).toBeVisible()
  await expect(timeOutput).not.toHaveText('0.000 s')
  await expect.poll(() => positionY.inputValue()).not.toBe(initialPositionY)
  await expect(page.getByRole('region', { name: '运动矢量图例' })).toContainText('合外力')

  await page.getByRole('button', { name: '暂停' }).click()
  await expect(page.getByText('模拟已暂停', { exact: true })).toBeVisible()
  const pausedTime = await timeOutput.textContent()
  await page.getByRole('button', { name: '单步' }).click()
  await expect(timeOutput).not.toHaveText(pausedTime ?? '')

  await page.getByRole('button', { name: '重置' }).click()
  await expect(page.getByText('编辑模式', { exact: true })).toBeVisible()
  await expect(page.getByText('0.000 s', { exact: true })).toBeVisible()
  await expect(positionY).toHaveValue(initialPositionY)

  await page.keyboard.press('p')
  await expect(page.getByText('模拟运行中', { exact: true })).toBeVisible()
  await page.keyboard.press('p')
  await expect(page.getByText('模拟已暂停', { exact: true })).toBeVisible()
})

test('可以从工具选项创建阶段 2 的曲面和物体类型', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const drag = async (startX: number, startY: number, endX: number, endY: number) => {
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 6 })
    await page.mouse.up()
  }

  await page.getByRole('button', { name: '地面工具（G）' }).click()
  await page.getByLabel('形状').selectOption('arc')
  await drag(center.x - 180, center.y + 80, center.x + 180, center.y + 80)
  await expect(page.locator('button').filter({ hasText: '圆弧地面 1' })).toBeVisible()
  await page.getByLabel('形状').selectOption('cubicBezier')
  await page.mouse.click(center.x - 120, center.y + 80)
  await page.mouse.click(center.x + 120, center.y + 80)
  await expect(page.locator('button').filter({ hasText: '贝塞尔地面 2' })).toBeVisible()
  await openInspectorTab(page, '几何')
  const controlY = page.getByLabel('控制点 1 Y')
  const beforeControlY = await controlY.inputValue()
  await page.getByRole('button', { name: '选择与移动（V）' }).click()
  await drag(center.x - 40, center.y + 147, center.x - 40, center.y + 117)
  await expect.poll(() => controlY.inputValue()).not.toBe(beforeControlY)

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  const bodyPreset = page.getByLabel('物体', { exact: true })
  await bodyPreset.selectOption('ball')
  await page.mouse.click(center.x - 80, center.y - 80)
  await expect(page.locator('button').filter({ hasText: '小球 1' })).toBeVisible()
  await openInspectorTab(page, '几何')
  await expect(page.getByText('形状与尺寸', { exact: true })).toBeVisible()
  await openInspectorTab(page, '物理')
  await expect(page.getByLabel('参与碰撞')).toBeChecked()
  await expect(page.getByLabel('电荷量')).toHaveValue('0')
  await expect(page.getByLabel('摩擦系数')).toHaveValue('0')
  await expect(page.getByLabel('弹性系数')).toHaveValue('0')
  await expect(page.getByText('质量与电荷', { exact: true })).toBeVisible()
  await expect(page.getByText('接触材质', { exact: true })).toBeVisible()
  await page.getByLabel('参与碰撞').uncheck()
  await openInspectorTab(page, '基本')
  await expect(page.getByText(/蓝色·碰撞关/)).toBeVisible()
  await openInspectorTab(page, '物理')
  await page.getByLabel('参与碰撞').check()
  await bodyPreset.selectOption('block')
  await drag(center.x + 80, center.y - 80, center.x + 120, center.y - 40)
  await expect(page.locator('button').filter({ hasText: '物块 2' })).toBeVisible()
  await expect(page.getByLabel('质量')).toHaveValue('1')
})

test('属性标签可键盘切换，且切换对象前会提交旧对象的数值草稿', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  await page.getByRole('button', { name: '地面工具（G）' }).click()
  await page.mouse.move(center.x - 180, center.y + 150)
  await page.mouse.down()
  await page.mouse.move(center.x + 180, center.y + 150)
  await page.mouse.up()
  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(center.x - 100, center.y - 40)
  await page.mouse.click(center.x + 100, center.y - 40)
  await page.getByRole('button', { name: '选择与移动（V）' }).click()
  await page.mouse.click(center.x - 100, center.y - 40)

  const physicsTab = page.getByRole('tab', { name: '物理', exact: true })
  await physicsTab.click()
  await expect(physicsTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('开启旋转')).toBeChecked()
  await openInspectorTab(page, '初始状态')
  await page.getByLabel('初角速度').fill('2.5')
  await page.getByLabel('初角速度').press('Enter')
  await openInspectorTab(page, '物理')
  await page.getByLabel('开启旋转').uncheck()
  await openInspectorTab(page, '初始状态')
  await expect(page.getByLabel('初角速度')).toBeDisabled()
  await expect(page.getByLabel('初角速度')).toHaveValue('2.5')
  await expect(page.getByText(/模拟会按 0 rad\/s 处理/)).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(page.getByLabel('初角速度')).toBeEnabled()
  await expect(page.getByLabel('初角速度')).toHaveValue('2.5')
  await page.keyboard.press('Control+y')
  await expect(page.getByLabel('初角速度')).toBeDisabled()
  await page.keyboard.press('Control+z')
  await openInspectorTab(page, '物理')
  await expect(page.getByLabel('开启旋转')).toBeChecked()
  await page.getByLabel('质量').fill('2.5')

  await page.mouse.click(center.x + 100, center.y - 40)
  await expect(page.getByRole('tab', { name: '物理', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByLabel('质量')).toHaveValue('1')

  await page.mouse.click(center.x - 100, center.y - 40)
  await expect(page.getByLabel('质量')).toHaveValue('2.5')
  await page.keyboard.press('Control+z')
  await expect(page.getByLabel('质量')).toHaveValue('1')

  await physicsTab.click()
  await physicsTab.press('Home')
  await expect(page.getByRole('tab', { name: '基本', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.getByRole('tab', { name: '基本', exact: true }).press('End')
  await expect(page.getByRole('tab', { name: '高级', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )

  await openInspectorTab(page, '初始状态')
  await page.getByRole('button', { name: '小球 2', exact: true }).click()
  await expect(page.getByRole('tab', { name: '初始状态', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.getByRole('button', { name: '直线地面 1', exact: true }).click()
  await expect(page.getByRole('tab', { name: '基本', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )

  await page.getByRole('button', { name: '小球 1', exact: true }).click()
  await openInspectorTab(page, '物理')
  await page.getByLabel('质量').fill('3')
  await page.getByLabel('质量').press('Escape')
  await expect(page.getByLabel('质量')).toHaveValue('1')
  await page.getByLabel('质量').fill('-1')
  await page.getByRole('button', { name: '小球 2', exact: true }).click()
  await page.getByRole('button', { name: '小球 1', exact: true }).click()
  await expect(page.getByLabel('质量')).toHaveValue('1')
})

test('场景对象可以独立隐藏、删除并通过撤销恢复依赖关系', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(center.x - 100, center.y - 40)
  await page.mouse.click(center.x + 100, center.y - 40)
  await page.getByRole('button', { name: '连接工具（L）' }).click()
  await page
    .getByRole('region', { name: '当前工具选项' })
    .getByRole('combobox')
    .selectOption('spring')
  await page.mouse.click(center.x - 100, center.y - 40)
  await page.mouse.click(center.x + 100, center.y - 40)

  const firstBody = page.getByRole('button', { name: '小球 1', exact: true })
  const secondBody = page.getByRole('button', { name: '小球 2', exact: true })
  const spring = page.getByRole('button', { name: '弹簧 1', exact: true })
  const hideFirst = page.getByRole('button', { name: '隐藏对象 小球 1' })
  await hideFirst.click()
  await expect(firstBody).toBeVisible()
  const showFirst = page.getByRole('button', { name: '显示对象 小球 1' })
  await expect(showFirst).toBeVisible()
  await showFirst.click()

  await page.getByRole('button', { name: '删除对象 小球 1' }).click()
  await expect(firstBody).toHaveCount(0)
  await expect(spring).toHaveCount(0)
  await expect(secondBody).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(page.getByRole('button', { name: '小球 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '弹簧 1', exact: true })).toBeVisible()

  await expect(page.getByRole('button', { name: '播放' })).toBeEnabled({ timeout: 15_000 })
  await page.getByRole('button', { name: '播放' }).click()
  await expect(page.getByRole('button', { name: '隐藏对象 小球 1' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '删除对象 小球 1' })).toBeDisabled()
})

test('场景对象可重命名，复制完整端点时会带上连接关系', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(center.x - 100, center.y - 40)
  await page.mouse.click(center.x + 100, center.y - 40)
  await page.getByRole('button', { name: '连接工具（L）' }).click()
  await page
    .getByRole('region', { name: '当前工具选项' })
    .getByRole('combobox')
    .selectOption('spring')
  await page.mouse.click(center.x - 100, center.y - 40)
  await page.mouse.click(center.x + 100, center.y - 40)

  await expect(page.getByRole('button', { name: '重命名对象 小球 1' })).toHaveCount(0)
  await page.getByRole('button', { name: '小球 1', exact: true }).dblclick()
  const bodyName = page.getByRole('textbox', { name: '重命名 小球 1' })
  await bodyName.fill('左侧小球')
  await bodyName.press('Enter')
  await expect(page.getByRole('button', { name: '左侧小球', exact: true })).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(page.getByRole('button', { name: '小球 1', exact: true })).toBeVisible()

  await page.getByRole('button', { name: '小球 1', exact: true }).dblclick()
  const doubleClickName = page.getByRole('textbox', { name: '重命名 小球 1' })
  await doubleClickName.fill('')
  await doubleClickName.press('Enter')
  await expect(page.getByRole('button', { name: '小球 1', exact: true })).toBeVisible()

  const first = page.getByRole('button', { name: '小球 1', exact: true })
  const second = page.getByRole('button', { name: '小球 2', exact: true })
  await first.click()
  await second.click({ modifiers: ['Shift'] })
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')

  await expect(page.getByRole('button', { name: '小球 1 副本', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '小球 2 副本', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '弹簧 1 副本', exact: true })).toBeVisible()
})

test('可创建、删除恢复、交换、编辑并复制布尔节点', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const scenePanel = page.getByRole('region', { name: '场景面板' })
  const inspector = page.getByRole('region', { name: '属性面板' })

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page
    .getByRole('region', { name: '当前工具选项' })
    .getByRole('combobox')
    .selectOption('block')
  await page.mouse.click(center.x - 20, center.y)
  await page.mouse.click(center.x + 20, center.y)
  const upper = page.getByRole('button', { name: '物块 1', exact: true })
  const lower = page.getByRole('button', { name: '物块 2', exact: true })
  await expect(page.getByRole('button', { name: '上移', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '下移', exact: true })).toHaveCount(0)
  await upper.locator('..').dragTo(lower.locator('..'), { targetPosition: { x: 20, y: 24 } })
  await expect
    .poll(() => scenePanel.getByRole('button', { name: /^物块 [12]$/ }).allTextContents())
    .toEqual(['物块 2', '物块 1'])
  await page.keyboard.press('Control+z')
  await expect
    .poll(() => scenePanel.getByRole('button', { name: /^物块 [12]$/ }).allTextContents())
    .toEqual(['物块 1', '物块 2'])
  await upper.click()
  await lower.click({ modifiers: ['Shift'] })

  await page.getByRole('button', { name: '布尔组合', exact: true }).click()
  const booleanNode = page.getByRole('button', { name: '布尔加法', exact: true })
  await expect(booleanNode).toBeVisible()
  await expect(inspector).toContainText('布尔加法')
  await expect(inspector.getByText('有效', { exact: true })).toBeVisible()

  await page.keyboard.press('Backspace')
  await expect(booleanNode).toHaveCount(0)
  await expect(upper).toHaveCount(0)
  await expect(lower).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(booleanNode).toBeVisible()
  await expect(upper).toBeVisible()
  await expect(lower).toBeVisible()
  await booleanNode.click()

  await openInspectorTab(page, '物理')
  await expect(inspector.getByText('总质量', { exact: true })).toBeVisible()
  await expect(inspector.getByText('摩擦系数', { exact: true })).toBeVisible()
  await expect(inspector.getByText('弹性系数', { exact: true })).toBeVisible()
  await inspector.getByLabel('摩擦系数').fill('0.4')
  await inspector.getByLabel('摩擦系数').press('Enter')
  await expect(inspector.getByText('整体统一', { exact: true }).first()).toBeVisible()
  await openInspectorTab(page, '变换')
  await expect(inspector.getByLabel('位置 X')).toBeEditable()
  await expect(inspector.getByLabel('角度')).toBeEditable()
  const originalBooleanX = Number(await inspector.getByLabel('位置 X').inputValue())
  await inspector.getByLabel('位置 X').fill(String(originalBooleanX + 1))
  await inspector.getByLabel('位置 X').press('Enter')
  await expect(inspector.getByLabel('位置 X')).toHaveValue(String(originalBooleanX + 1))
  await inspector.getByLabel('角度').fill('30')
  await inspector.getByLabel('角度').press('Enter')
  await expect(inspector.getByLabel('角度')).toHaveValue('30')
  await openInspectorTab(page, '初始状态')
  await expect(inspector.getByLabel('初速度 X')).toBeEditable()
  await expect(inspector.getByLabel('初角速度')).toBeEditable()
  await inspector.getByLabel('初速度 X').fill('1.25')
  await inspector.getByLabel('初速度 X').press('Enter')
  await expect(inspector.getByText('结果整体', { exact: true }).first()).toBeVisible()
  await openInspectorTab(page, '基本')
  await inspector.getByRole('combobox').selectOption('difference')
  await expect(inspector.getByRole('combobox')).toHaveValue('difference')

  const swap = page.getByRole('button', { name: '交换输入' })
  await swap.focus()
  await page.keyboard.press('Enter')
  await expect(booleanNode).toBeVisible()

  await page.getByRole('button', { name: '移出布尔组合' }).first().click()
  await expect(inspector.getByText('已停用', { exact: true })).toBeVisible()
  await lower.click()
  await scenePanel.getByRole('button', { name: '添加当前所选对象' }).click()
  await booleanNode.click()
  await expect(inspector.getByText('有效', { exact: true })).toBeVisible()

  await upper.click()
  await openInspectorTab(page, '变换')
  await expect(inspector.getByLabel('位置 X')).toBeEditable()
  await expect(inspector.getByLabel('角度')).toHaveValue('30')
  await booleanNode.click()
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  await expect(page.getByRole('button', { name: '布尔加法 副本', exact: true })).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(page.getByRole('button', { name: '布尔加法 副本', exact: true })).toHaveCount(0)

  await booleanNode.click()
  await page.getByRole('button', { name: '解散布尔组合 布尔加法' }).click()
  await expect(booleanNode).toHaveCount(0)
  await expect(upper).toBeVisible()
  await expect(lower).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(booleanNode).toBeVisible()
})

test('布尔结果移动和旋转在松开鼠标前实时更新画布', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const bodyPreset = page.getByLabel('物体', { exact: true })

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await bodyPreset.selectOption('block')
  await page.mouse.click(center.x - 20, center.y)
  await page.mouse.click(center.x + 20, center.y)
  await page.getByRole('button', { name: '物块 1', exact: true }).click()
  await page.getByRole('button', { name: '物块 2', exact: true }).click({ modifiers: ['Shift'] })
  await page.getByRole('button', { name: '布尔组合', exact: true }).click()

  await page.getByRole('button', { name: '选择与移动（V）' }).click()
  const beforeMove = await canvas.screenshot()
  await page.mouse.move(center.x, center.y)
  await page.mouse.down()
  await page.mouse.move(center.x + 60, center.y - 20, { steps: 6 })
  const duringMove = await canvas.screenshot()
  expect(duringMove.equals(beforeMove)).toBe(false)
  await page.mouse.up()

  await page.getByRole('button', { name: '布尔加法', exact: true }).click()
  await page.getByRole('button', { name: '旋转（R）' }).click()
  const beforeRotate = await canvas.screenshot()
  await page.mouse.move(center.x + 80, center.y - 20)
  await page.mouse.down()
  await page.mouse.move(center.x + 60, center.y - 80, { steps: 6 })
  const duringRotate = await canvas.screenshot()
  expect(duringRotate.equals(beforeRotate)).toBe(false)
  await page.mouse.up()
})

test('普通物体与多个布尔结果混选后可作为一个组拖动和撤销', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const bodyPreset = page.getByLabel('物体', { exact: true })
  const inspector = page.getByRole('region', { name: '属性面板' })
  const readX = async (name: string) => {
    await page.getByRole('button', { name, exact: true }).click()
    await openInspectorTab(page, '变换')
    return Number(await inspector.getByLabel('位置 X').inputValue())
  }

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await bodyPreset.selectOption('block')
  for (const offset of [-100, -60, 60, 100]) {
    await page.mouse.click(center.x + offset, center.y)
  }
  await bodyPreset.selectOption('ball')
  await page.mouse.click(center.x + 180, center.y)

  await page.getByRole('button', { name: '物块 1', exact: true }).click()
  await page.getByRole('button', { name: '物块 2', exact: true }).click({ modifiers: ['Shift'] })
  await page.getByRole('button', { name: '布尔组合', exact: true }).click()
  await page.getByRole('button', { name: '物块 3', exact: true }).click()
  await page.getByRole('button', { name: '物块 4', exact: true }).click({ modifiers: ['Shift'] })
  await page.getByRole('button', { name: '布尔组合', exact: true }).click()

  const beforeFirst = await readX('物块 1')
  const beforeSecond = await readX('物块 3')
  const beforeBall = await readX('小球 5')
  const booleanRows = page.getByRole('button', { name: '布尔加法', exact: true })
  await booleanRows.nth(0).click()
  await booleanRows.nth(1).click({ modifiers: ['Shift'] })
  await page.getByRole('button', { name: '小球 5', exact: true }).click({ modifiers: ['Shift'] })

  await page.getByRole('button', { name: '选择与移动（V）' }).click()
  await page.keyboard.down('Alt')
  await page.mouse.move(center.x + 180, center.y)
  await page.mouse.down()
  await page.mouse.move(center.x + 220, center.y - 20, { steps: 8 })
  await page.mouse.up()
  await page.keyboard.up('Alt')

  expect(await readX('物块 1')).toBeCloseTo(beforeFirst + 2, 6)
  expect(await readX('物块 3')).toBeCloseTo(beforeSecond + 2, 6)
  expect(await readX('小球 5')).toBeCloseTo(beforeBall + 2, 6)
  await page.keyboard.press('Control+z')
  expect(await readX('物块 1')).toBeCloseTo(beforeFirst, 6)
  expect(await readX('物块 3')).toBeCloseTo(beforeSecond, 6)
  expect(await readX('小球 5')).toBeCloseTo(beforeBall, 6)
})

test('框选可选中布尔结果且缩放只能从四角控制柄开始', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const bodyPreset = page.getByLabel('物体', { exact: true })

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await bodyPreset.selectOption('block')
  await page.mouse.click(center.x - 20, center.y)
  await page.mouse.click(center.x + 20, center.y)
  await page.getByRole('button', { name: '物块 1', exact: true }).click()
  await page.getByRole('button', { name: '物块 2', exact: true }).click({ modifiers: ['Shift'] })
  await page.getByRole('button', { name: '布尔组合' }).click()

  await page.getByRole('button', { name: '选择与移动（V）' }).click()
  await page.keyboard.press('Escape')
  await page.mouse.move(center.x - 45, center.y - 30)
  await page.mouse.down()
  await page.mouse.move(center.x + 45, center.y + 30, { steps: 5 })
  await page.mouse.up()
  await expect(page.getByRole('region', { name: '属性面板' })).toContainText('布尔加法')

  await page.getByRole('button', { name: '对象缩放（S）' }).click()
  await page.mouse.move(center.x, center.y)
  await page.mouse.down()
  await page.mouse.move(center.x + 10, center.y + 5, { steps: 4 })
  await page.mouse.up()
  await page.getByRole('button', { name: '物块 1', exact: true }).click()
  await openInspectorTab(page, '变换')
  await expect(page.getByLabel('位置 X')).toHaveValue('-1')
  await page.getByRole('button', { name: '布尔加法', exact: true }).click()
  await page.getByRole('button', { name: '对象缩放（S）' }).click()

  const beforeHandleDrag = await canvas.screenshot()
  await page.mouse.move(center.x + 30, center.y - 10)
  await page.mouse.down()
  await page.mouse.move(center.x + 50, center.y - 20, { steps: 5 })
  const duringHandleDrag = await canvas.screenshot()
  expect(duringHandleDrag.equals(beforeHandleDrag)).toBe(false)
  await page.mouse.up()

  await page.getByRole('button', { name: '物块 1', exact: true }).click()
  await openInspectorTab(page, '变换')
  const scaledX = await page.getByLabel('位置 X').inputValue()
  expect(Number(scaledX)).not.toBe(-1)
  await page.keyboard.press('Control+z')
  await expect(page.getByLabel('位置 X')).toHaveValue('-1')
})

test('空差集立即给出上方减下方原因并可交换为孔洞', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const bodyPreset = page.getByLabel('物体', { exact: true })
  const inspector = page.getByRole('region', { name: '属性面板' })

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await bodyPreset.selectOption('block')
  await page.mouse.click(center.x, center.y)
  await openInspectorTab(page, '几何')
  await inspector.getByRole('spinbutton', { name: '宽度 m' }).fill('1')
  await inspector.getByRole('spinbutton', { name: '宽度 m' }).press('Enter')
  await inspector.getByRole('spinbutton', { name: '高度 m' }).fill('1')
  await inspector.getByRole('spinbutton', { name: '高度 m' }).press('Enter')
  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(center.x, center.y)
  await openInspectorTab(page, '几何')
  await inspector.getByRole('spinbutton', { name: '宽度 m' }).fill('4')
  await inspector.getByRole('spinbutton', { name: '宽度 m' }).press('Enter')
  await inspector.getByRole('spinbutton', { name: '高度 m' }).fill('4')
  await inspector.getByRole('spinbutton', { name: '高度 m' }).press('Enter')

  await page.getByRole('button', { name: '物块 1', exact: true }).click()
  await page.getByRole('button', { name: '物块 2', exact: true }).click({ modifiers: ['Shift'] })
  await page.getByRole('button', { name: '布尔组合' }).click()
  await inspector.getByRole('combobox').selectOption('difference')
  await expect(
    inspector.getByText('上方输入已被下方完全覆盖；减法按上方减下方执行。', {
      exact: true,
    }),
  ).toBeVisible()
  await page.getByRole('button', { name: '交换输入' }).click()
  await expect(inspector.getByText('有效', { exact: true })).toBeVisible()
  await expect(
    inspector.getByText('上方输入已被下方完全覆盖；减法按上方减下方执行。', {
      exact: true,
    }),
  ).toHaveCount(0)
})

test('内切圆孔布尔体可播放、重置、编辑并自动恢复物理世界', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const bodyPreset = page.getByLabel('物体', { exact: true })
  const inspector = page.getByRole('region', { name: '属性面板' })
  const playButton = page.getByRole('button', { name: '播放' })

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await bodyPreset.selectOption('block')
  await page.mouse.click(center.x, center.y)
  await openInspectorTab(page, '几何')
  await page.getByRole('spinbutton', { name: '宽度 m' }).fill('1')
  await page.getByRole('spinbutton', { name: '宽度 m' }).press('Enter')
  await page.getByRole('spinbutton', { name: '高度 m' }).fill('1')
  await page.getByRole('spinbutton', { name: '高度 m' }).press('Enter')

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await bodyPreset.selectOption('ball')
  await page.mouse.click(center.x, center.y)
  await openInspectorTab(page, '几何')
  await page.getByRole('spinbutton', { name: '半径 m' }).fill('0.5')
  await page.getByRole('spinbutton', { name: '半径 m' }).press('Enter')

  await page.getByRole('button', { name: '物块 1', exact: true }).click()
  await page.getByRole('button', { name: '小球 2', exact: true }).click({ modifiers: ['Shift'] })
  await page.getByRole('button', { name: '布尔组合' }).click()
  await inspector.getByRole('combobox').selectOption('difference')
  await expect(inspector.getByRole('combobox')).toHaveValue('difference')

  await expect(playButton).toBeEnabled({ timeout: 15_000 })
  await playButton.click()
  await expect(page.getByText('模拟运行中', { exact: true })).toBeVisible()
  await page.waitForTimeout(150)
  await page.getByRole('button', { name: '暂停' }).click()
  await page.getByRole('button', { name: '重置' }).click()
  await expect(page.getByText('编辑模式', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '小球 2', exact: true }).click()
  await openInspectorTab(page, '变换')
  await page.getByLabel('位置 X').fill('0.1')
  await page.getByLabel('位置 X').press('Enter')
  await expect(playButton).toBeEnabled({ timeout: 15_000 })
  await playButton.click()
  await expect(page.getByText('模拟运行中', { exact: true })).toBeVisible()
  await expect(page.getByText('物理内核错误', { exact: true })).toHaveCount(0)
})

test('面板可以隐藏、浮动、缩放、重新停靠并恢复布局', async ({ page }) => {
  await page.goto('/')
  const workspace = page.getByRole('main', { name: '编辑工作区' })
  const workspaceBox = await workspace.boundingBox()
  expect(workspaceBox).not.toBeNull()
  if (!workspaceBox) return

  await page.getByText('视图', { exact: true }).click()
  await page.getByText('窗口', { exact: true }).hover()
  await page.getByRole('menuitemcheckbox', { name: '工具' }).click()
  await expect(page.getByRole('region', { name: '工具面板' })).toHaveCount(0)

  await page.getByText('视图', { exact: true }).click()
  await page.getByText('窗口', { exact: true }).hover()
  await page.getByRole('menuitemcheckbox', { name: '工具' }).click()
  await expect(page.getByRole('region', { name: '工具面板' })).toBeVisible()

  const layersPanel = page.getByRole('region', { name: '场景面板' })
  const dragHandle = page.getByRole('button', { name: '拖动场景面板' })
  const handleBox = await dragHandle.boundingBox()
  expect(handleBox).not.toBeNull()
  if (!handleBox) return
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    workspaceBox.x + workspaceBox.width / 2,
    workspaceBox.y + workspaceBox.height / 2,
    { steps: 8 },
  )
  await page.mouse.up()
  await expect(layersPanel).toHaveAttribute('data-mode', 'floating')

  const beforeResize = await layersPanel.boundingBox()
  expect(beforeResize).not.toBeNull()
  if (!beforeResize) return
  const resizeHandle = page.getByRole('separator', { name: '调整场景面板东南角' })
  const resizeBox = await resizeHandle.boundingBox()
  expect(resizeBox).not.toBeNull()
  if (!resizeBox) return
  await page.mouse.move(resizeBox.x + 2, resizeBox.y + 2)
  await page.mouse.down()
  await page.mouse.move(resizeBox.x + 82, resizeBox.y + 62, { steps: 6 })
  await page.mouse.up()
  const afterResize = await layersPanel.boundingBox()
  expect(afterResize?.width ?? 0).toBeGreaterThan(beforeResize.width + 50)

  await page.getByRole('button', { name: '关闭场景面板' }).click()
  await expect(layersPanel).toHaveCount(0)
  await page.getByText('视图', { exact: true }).click()
  await page.getByText('窗口', { exact: true }).hover()
  await page.getByRole('menuitemcheckbox', { name: '图层' }).click()
  await expect(page.getByRole('region', { name: '场景面板' })).toHaveAttribute(
    'data-mode',
    'floating',
  )

  const restoredHandle = page.getByRole('button', { name: '拖动场景面板' })
  const restoredHandleBox = await restoredHandle.boundingBox()
  expect(restoredHandleBox).not.toBeNull()
  if (!restoredHandleBox) return
  await page.mouse.move(
    restoredHandleBox.x + restoredHandleBox.width / 2,
    restoredHandleBox.y + restoredHandleBox.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(workspaceBox.x + 12, workspaceBox.y + 180, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByRole('region', { name: '场景面板' })).toHaveAttribute('data-edge', 'left')

  await page.reload()
  await expect(page.getByRole('region', { name: '场景面板' })).toHaveAttribute('data-edge', 'left')
  await page.getByText('视图', { exact: true }).click()
  await page.getByText('窗口', { exact: true }).hover()
  await page.getByRole('menuitem', { name: '恢复默认布局' }).click()
  await expect(page.getByRole('region', { name: '场景面板' })).toHaveAttribute('data-edge', 'right')
})

test('图像面板拉到最大高度时不会覆盖播放栏，工具悬浮选项仍可点击', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 })
  await page.goto('/')
  const workspace = page.getByRole('main', { name: '编辑工作区' })
  const workspaceBox = await workspace.boundingBox()
  const bottomDivider = page.getByRole('separator', { name: '调整底部停靠区高度' })
  const dividerBox = await bottomDivider.boundingBox()
  expect(workspaceBox).not.toBeNull()
  expect(dividerBox).not.toBeNull()
  if (!workspaceBox || !dividerBox) return

  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 2)
  await page.mouse.down()
  await page.mouse.move(workspaceBox.x + workspaceBox.width / 2, workspaceBox.y + 4, {
    steps: 8,
  })
  await page.mouse.up()

  const chartBox = await page.getByRole('region', { name: '图像面板' }).boundingBox()
  const playBox = await page.getByRole('button', { name: '播放' }).boundingBox()
  expect(chartBox).not.toBeNull()
  expect(playBox).not.toBeNull()
  if (!chartBox || !playBox) return
  expect(chartBox.y + chartBox.height).toBeLessThanOrEqual(playBox.y)

  const connectorTool = page.getByRole('button', { name: '连接工具（L）' })
  await connectorTool.scrollIntoViewIfNeeded()
  await connectorTool.hover()
  const flyout = page.getByRole('menu', { name: '连接工具选项' })
  await expect(flyout).toBeVisible()
  await flyout.getByRole('menuitemradio', { name: '弹簧' }).click()
  await expect(connectorTool).toHaveAttribute('aria-pressed', 'true')
})

test('小球可以带电，并可创建场和三种连接器', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const drag = async (startX: number, startY: number, endX: number, endY: number) => {
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 6 })
    await page.mouse.up()
  }
  const options = page.getByRole('region', { name: '当前工具选项' })
  const layerEntity = (name: string) => page.locator('button').filter({ hasText: name })

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(center.x - 100, center.y - 40)
  await page.mouse.click(center.x + 100, center.y - 40)
  await expect(layerEntity('小球 1')).toBeVisible()
  await layerEntity('小球 1').click()
  await openInspectorTab(page, '物理')
  await expect.poll(async () => Number(await page.getByLabel('电荷量').inputValue())).toBe(0)
  await openInspectorTab(page, '基本')
  await expect(page.getByText(/无电荷符号/)).toBeVisible()
  await openInspectorTab(page, '物理')
  await page.getByLabel('电荷量').fill('1')
  await page.getByLabel('电荷量').press('Enter')
  await openInspectorTab(page, '基本')
  await expect(page.getByText(/红色·碰撞开 · \+/)).toBeVisible()

  await page.getByRole('button', { name: '连接工具（L）' }).click()
  await options.getByRole('combobox').selectOption('rod')
  await page.mouse.click(center.x - 100, center.y - 40)
  await page.mouse.click(center.x + 100, center.y - 40)
  await expect(layerEntity('杆 1')).toBeVisible()
  await openInspectorTab(page, '物理')
  await expect(page.getByLabel('杆长')).toHaveValue('10')

  await page.getByRole('button', { name: '选择与移动（V）' }).click()
  await page.mouse.click(center.x, center.y - 40)
  await expect(page.getByLabel('杆长')).toBeVisible()
  await openInspectorTab(page, '几何')
  await drag(center.x - 100, center.y - 40, center.x - 80, center.y - 40)
  await expect(page.getByLabel('A 局部 X')).toHaveValue('0.5')

  await page.getByRole('button', { name: '连接工具（L）' }).click()
  await options.getByRole('combobox').selectOption('spring')
  await page.mouse.click(center.x - 100, center.y - 40)
  await page.mouse.click(center.x + 100, center.y - 40)
  await expect(layerEntity('弹簧 2')).toBeVisible()
  await openInspectorTab(page, '物理')
  await expect(page.getByLabel('劲度系数')).toHaveValue('20')
  await expect(page.getByLabel('阻尼系数')).toHaveValue('0')

  await page.getByRole('button', { name: '场工具（F）' }).click()
  await options.getByRole('combobox').first().selectOption('uniformElectric')
  await drag(center.x - 220, center.y - 150, center.x + 220, center.y + 80)
  await expect(layerEntity('电场 1')).toBeVisible()
  await openInspectorTab(page, '物理')
  await expect.poll(async () => Number(await page.getByLabel('电场强度 X').inputValue())).toBe(1e6)

  await options.getByRole('combobox').first().selectOption('uniformMagnetic')
  await drag(center.x - 180, center.y - 120, center.x + 180, center.y + 120)
  await expect(layerEntity('磁场 2')).toBeVisible()
  await expect(page.getByText('⊙ 出屏', { exact: true })).toBeVisible()
})

test('可以建立多个坐标系、编辑公式与线条样式并导出全部 CSV', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(center.x - 80, center.y - 40)
  await page.mouse.click(center.x + 80, center.y - 40)
  const firstBody = page.locator('button').filter({ hasText: '小球 1' })
  const secondBody = page.locator('button').filter({ hasText: '小球 2' })
  await firstBody.click()
  await secondBody.click({ modifiers: ['Shift'] })

  const firstChart = page.getByRole('article', { name: '坐标系 1' })
  await firstChart.getByRole('button', { name: '配置坐标系 1' }).click()
  await firstChart.getByRole('button', { name: '添加物体' }).click()
  let picker = firstChart.getByRole('group', { name: '向坐标系 1添加物体' })
  await expect(picker.getByLabel('小球 1')).toBeChecked()
  await expect(picker.getByLabel('小球 2')).toBeChecked()
  await picker.getByRole('button', { name: '确认添加' }).click()
  expect(await firstChart.getByLabel('小球 1线条颜色').inputValue()).not.toBe(
    await firstChart.getByLabel('小球 2线条颜色').inputValue(),
  )
  await firstChart.getByRole('button', { name: '添加别名' }).click()

  await firstChart.getByLabel('纵轴来源').selectOption('expression')
  const expression = firstChart.getByLabel('纵轴公式')
  await expression.fill('x/3+y*x')
  await expression.press('Enter')
  await expect(firstChart.getByText(/单位不同/)).toBeVisible()
  await expression.fill('@A.x+y')
  await expression.press('Enter')

  await firstChart.getByLabel('小球 1线条颜色').fill('#00ff88')
  await firstChart.getByLabel('小球 2线型').selectOption('dashed')
  const nameInput = firstChart.getByLabel('坐标系名称')
  await nameInput.fill('位置组合')
  await nameInput.press('Enter')

  await page.getByRole('button', { name: '新建坐标系' }).click()
  const secondChart = page.getByRole('article', { name: '坐标系 2' })
  await secondChart.getByRole('button', { name: '配置坐标系 2' }).click()
  await secondChart.getByRole('button', { name: '添加物体' }).click()
  picker = secondChart.getByRole('group', { name: '向坐标系 2添加物体' })
  await picker.getByRole('button', { name: '确认添加' }).click()
  await secondChart.getByLabel('纵轴物理量').selectOption('speed')
  await expect(page.getByText('2 个坐标系', { exact: true })).toBeVisible()
  await expect(page.getByText('4 条线', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '单步' }).click()
  await page.getByRole('button', { name: '单步' }).click()
  await expect(page.getByRole('img', { name: '位置组合图像' })).toBeVisible()
  await expect(page.getByRole('img', { name: '坐标系 2图像' })).toBeVisible()
  await expect(page.locator('output')).toHaveText('0.017 s')
  await page.getByRole('article', { name: '位置组合' }).getByLabel('小球 1线宽').fill('3')
  await expect(page.locator('output')).toHaveText('0.017 s')

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出全部' }).click()
  const download = await downloadPromise
  const downloadPath = await download.path()
  expect(downloadPath).not.toBeNull()
  if (!downloadPath) return
  const csv = await readFile(downloadPath, 'utf8')
  expect(csv).toContain('坐标系,物体,物体 ID,模拟时间 t (s)')
  expect(csv).toContain('位置组合,小球 1')
  expect(csv).toContain('坐标系 2,小球 2')
})

test('钢笔物块可创建凹形轮廓并拒绝自交草稿', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const bodyPreset = page.getByLabel('物体', { exact: true })

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await bodyPreset.selectOption('block')
  await page.getByLabel('物块形状').selectOption('freeform')
  for (const point of [
    { x: -70, y: -55 },
    { x: 70, y: -55 },
    { x: 15, y: 0 },
    { x: 70, y: 55 },
    { x: -70, y: 55 },
  ]) {
    await page.mouse.click(center.x + point.x, center.y + point.y)
  }
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '钢笔物块 1', exact: true })).toBeVisible()
  await openInspectorTab(page, '几何')
  await expect(page.getByRole('region', { name: '属性面板' })).toContainText('钢笔物块')

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.getByLabel('物块形状').selectOption('freeform')
  for (const point of [
    { x: 110, y: -55 },
    { x: 230, y: 55 },
    { x: 110, y: 55 },
    { x: 230, y: -55 },
  ]) {
    await page.mouse.click(center.x + point.x, center.y + point.y)
  }
  await page.keyboard.press('Enter')
  await expect(page.getByText(/钢笔物块轮廓不能自相交/)).toBeVisible()
  await expect(page.getByRole('button', { name: '钢笔物块 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '钢笔物块 2', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('物块顶部形状菜单可创建三种曲面预设和可调角度三角斜面', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  const bodyPreset = page.getByLabel('物体', { exact: true })
  await bodyPreset.selectOption('block')
  const shape = page.getByLabel('物块形状')
  const presets = [
    { value: 'quarterRamp', x: -240, y: -80 },
    { value: 'semicircleCutout', x: -80, y: -80 },
    { value: 'quarterCircleCutout', x: 80, y: -80 },
  ]
  for (const preset of presets) {
    await shape.selectOption(preset.value)
    await page.mouse.move(center.x + preset.x, center.y + preset.y)
    await page.mouse.down()
    await page.mouse.move(center.x + preset.x + 55, center.y + preset.y + 40, { steps: 4 })
    await page.mouse.up()
  }

  await shape.selectOption('triangle')
  await page.getByLabel('三角斜面底角').fill('45')
  await page.mouse.move(center.x + 180, center.y + 80)
  await page.mouse.down()
  await page.mouse.move(center.x + 250, center.y + 30, { steps: 4 })
  await page.mouse.up()

  for (const index of [1, 2, 3, 4]) {
    await expect(page.getByRole('button', { name: `物块 ${index}`, exact: true })).toBeVisible()
  }
  await openInspectorTab(page, '几何')
  await expect(page.getByRole('region', { name: '属性面板' })).toContainText('钢笔物块')
})

test('场工具可以创建扇形、钢笔自由形状和无限范围', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const range = page.getByLabel('场范围形状')

  await page.getByRole('button', { name: '场工具（F）' }).click()
  await range.selectOption('circle')
  await page.mouse.move(center.x - 140, center.y)
  await page.mouse.down()
  await page.mouse.move(center.x - 80, center.y, { steps: 4 })
  await page.mouse.up()
  await openInspectorTab(page, '几何')
  await expect(
    page.getByRole('region', { name: '属性面板' }).getByText('圆形', { exact: true }),
  ).toBeVisible()
  await page.getByLabel('圆心角').fill('90')
  await page.getByLabel('圆心角').press('Enter')
  await expect(
    page.getByRole('region', { name: '属性面板' }).getByText('扇形', { exact: true }),
  ).toBeVisible()

  await range.selectOption('freeform')
  await page.mouse.click(center.x - 20, center.y - 40)
  await page.mouse.click(center.x + 80, center.y - 20)
  await page.mouse.click(center.x + 50, center.y + 70)
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('region', { name: '属性面板' }).getByText('钢笔自由形状', { exact: true }),
  ).toBeVisible()

  await range.selectOption('infinite')
  await page.mouse.click(center.x + 160, center.y)
  await expect(
    page.getByRole('region', { name: '属性面板' }).getByText('无限范围', { exact: true }),
  ).toBeVisible()
})

test('菜单会自动收起，工具悬停 0.5 秒显示分类悬浮窗', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 })
  await page.goto('/')
  const fileMenu = page.getByText('文件', { exact: true })
  await fileMenu.click()
  await expect(page.getByRole('menuitem', { name: '新建场景' })).toBeVisible()
  await page.mouse.move(600, 300)
  await expect(page.getByRole('menuitem', { name: '新建场景' })).toBeHidden()

  await page.getByText('模拟', { exact: true }).click()
  await expect(page.getByRole('menuitem', { name: '单步' }).locator('svg')).toHaveClass(
    /lucide-skip-forward/,
  )
  await page.keyboard.press('Escape')

  const groundTool = page.getByRole('button', { name: '地面工具（G）' })
  await groundTool.hover()
  await page.waitForTimeout(550)
  await expect(page.getByRole('menu', { name: '地面工具选项' })).toBeVisible()
  await page.getByRole('menuitemradio', { name: '贝塞尔钢笔地面' }).click()
  await expect(page.getByLabel('形状')).toHaveValue('cubicBezier')

  const connectorTool = page.getByRole('button', { name: '连接工具（L）' })
  await connectorTool.hover()
  await page.waitForTimeout(550)
  const springOption = page.getByRole('menuitemradio', { name: '弹簧' })
  const springOptionBox = await springOption.boundingBox()
  expect(springOptionBox).not.toBeNull()
  if (!springOptionBox) return
  const topmostOption = await page.evaluate(
    ({ x, y }) =>
      document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>('[role="menuitemradio"]')
        ?.textContent?.trim(),
    {
      x: springOptionBox.x + springOptionBox.width / 2,
      y: springOptionBox.y + springOptionBox.height / 2,
    },
  )
  expect(topmostOption).toContain('弹簧')
  await springOption.click()
  await expect(
    page.getByRole('region', { name: '当前工具选项' }).getByRole('combobox'),
  ).toHaveValue('spring')
})

test('墙面吸附可开关，并让新建小球与地面相切', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  await page.getByRole('button', { name: '地面工具（G）' }).click()
  await page.mouse.move(center.x - 200, center.y + 100)
  await page.mouse.down()
  await page.mouse.move(center.x + 200, center.y + 100)
  await page.mouse.up()

  const wallSnap = page.getByRole('button', { name: /墙面吸附/ })
  await expect(wallSnap).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(center.x, center.y + 88)
  await openInspectorTab(page, '变换')
  await expect(page.getByLabel('位置 Y')).toHaveValue('-4.5')
})

test('布尔结果整体吸附墙面和物块，并支持绕过及撤销重做', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const bodyTool = page.getByRole('button', { name: '物体工具（O）' })
  const selectTool = page.getByRole('button', { name: '选择与移动（V）' })
  const bodyPreset = page.getByLabel('物体', { exact: true })
  const wallSnap = page.getByRole('button', { name: /墙面吸附/ })
  const drag = async (startX: number, startY: number, endX: number, endY: number) => {
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 6 })
    await page.mouse.up()
  }

  await page.getByRole('button', { name: '地面工具（G）' }).click()
  await drag(center.x - 200, center.y + 100, center.x + 200, center.y + 100)
  await expect(wallSnap).toHaveAttribute('aria-pressed', 'true')

  await bodyTool.click()
  await bodyPreset.selectOption('block')
  await page.mouse.click(center.x + 100, center.y)
  await page.mouse.click(center.x - 20, center.y)
  await page.mouse.click(center.x, center.y)
  await page.getByRole('button', { name: '物块 2', exact: true }).click()
  await page.getByRole('button', { name: '物块 3', exact: true }).click({ modifiers: ['Shift'] })
  await page.getByRole('button', { name: '布尔组合' }).click()

  await bodyTool.click()
  await bodyPreset.selectOption('ball')
  await page.mouse.click(center.x + 28, center.y)
  await page.getByRole('button', { name: '小球 4', exact: true }).click()
  await openInspectorTab(page, '变换')
  await expect(page.getByLabel('位置 X')).toHaveValue('1')
  await page.keyboard.press('Delete')

  await selectTool.click()
  await drag(center.x - 20, center.y, center.x + 70, center.y)
  await page.getByRole('button', { name: '物块 2', exact: true }).click()
  await openInspectorTab(page, '变换')
  await expect(page.getByLabel('位置 X')).toHaveValue('3')
  await page.keyboard.press('Control+z')
  await expect(page.getByLabel('位置 X')).toHaveValue('-1')
  await page.keyboard.press('Control+y')
  await expect(page.getByLabel('位置 X')).toHaveValue('3')

  await page.keyboard.press('Control+z')
  await page.getByRole('button', { name: '布尔加法', exact: true }).click()
  await drag(center.x - 20, center.y, center.x - 20, center.y + 80)
  await page.getByRole('button', { name: '物块 2', exact: true }).click()
  await openInspectorTab(page, '变换')
  await expect(page.getByLabel('位置 Y')).toHaveValue('-4.5')
  await page.keyboard.press('Control+z')
  await expect(page.getByLabel('位置 Y')).toHaveValue('0')

  await page.getByRole('button', { name: '布尔加法', exact: true }).click()
  await page.keyboard.down('Alt')
  await drag(center.x - 20, center.y, center.x - 20, center.y + 88)
  await page.keyboard.up('Alt')
  await page.getByRole('button', { name: '物块 2', exact: true }).click()
  await openInspectorTab(page, '变换')
  await expect(page.getByLabel('位置 Y')).toHaveValue('-4.4')

  await page.keyboard.press('Control+z')
  await wallSnap.click()
  await page.getByRole('button', { name: '布尔加法', exact: true }).click()
  await drag(center.x - 20, center.y, center.x - 20, center.y + 80)
  await page.getByRole('button', { name: '物块 2', exact: true }).click()
  await openInspectorTab(page, '变换')
  await expect(page.getByLabel('位置 Y')).toHaveValue('-4')
})

test('物块吸附默认开启并覆盖创建、移动、多选、Alt 与撤销重做', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const bodyTool = page.getByRole('button', { name: '物体工具（O）' })
  const selectTool = page.getByRole('button', { name: '选择与移动（V）' })
  const bodyPreset = page.getByLabel('物体', { exact: true })
  const blockSnap = page.getByRole('button', { name: /物块吸附/ })
  const entityButton = (name: string) => page.getByRole('button', { name, exact: true })
  const drag = async (startX: number, startY: number, endX: number, endY: number) => {
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 6 })
    await page.mouse.up()
  }

  await expect(blockSnap).toHaveAttribute('aria-pressed', 'true')
  await bodyTool.click()
  await bodyPreset.selectOption('block')
  await drag(center.x, center.y, center.x + 20, center.y + 20)
  await expect(entityButton('物块 1')).toBeVisible()

  await bodyPreset.selectOption('ball')
  await page.mouse.click(center.x + 36, center.y)
  await expect(entityButton('小球 2')).toBeVisible()
  await openInspectorTab(page, '变换')
  await expect(page.getByLabel('位置 X')).toHaveValue('1.5')

  await page.keyboard.press('Control+z')
  await expect(entityButton('小球 2')).toHaveCount(0)
  await page.keyboard.press('Control+y')
  await expect(entityButton('小球 2')).toBeVisible()

  await page.keyboard.down('Alt')
  await page.mouse.click(center.x + 36, center.y)
  await page.keyboard.up('Alt')
  await openInspectorTab(page, '变换')
  await expect(page.getByLabel('位置 X')).toHaveValue('1.8')

  await selectTool.click()
  await drag(center.x + 36, center.y, center.x + 42, center.y)
  await expect(page.getByLabel('位置 X')).toHaveValue('1.5')

  await page.keyboard.down('Alt')
  await drag(center.x + 30, center.y, center.x + 36, center.y)
  await page.keyboard.up('Alt')
  await expect(page.getByLabel('位置 X')).toHaveValue('1.8')

  await entityButton('小球 2').click()
  await page.keyboard.down('Shift')
  await entityButton('小球 3').click()
  await page.keyboard.up('Shift')
  await drag(center.x + 36, center.y, center.x + 42, center.y)
  await entityButton('小球 3').click()
  await openInspectorTab(page, '变换')
  await expect(page.getByLabel('位置 X')).toHaveValue('1.5')
  await entityButton('小球 2').click()
  await openInspectorTab(page, '变换')
  await expect(page.getByLabel('位置 X')).toHaveValue('1.2')
  await page.keyboard.press('Control+z')
  await expect(page.getByLabel('位置 X')).toHaveValue('1.5')

  await bodyTool.click()
  await blockSnap.click()
  await expect(blockSnap).toHaveAttribute('aria-pressed', 'false')
  await page.mouse.click(center.x + 36, center.y)
  await openInspectorTab(page, '变换')
  await expect(page.getByLabel('位置 X')).toHaveValue('2')

  await blockSnap.click()
  await bodyPreset.selectOption('block')
  await page.mouse.click(center.x + 40, center.y)
  await openInspectorTab(page, '变换')
  await expect(page.getByLabel('位置 X')).toHaveValue('1.5')
})

test('意外刷新后可以恢复 IndexedDB 自动草稿', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.locator('button').filter({ hasText: '小球 1' })).toBeVisible()
  await page.waitForTimeout(1100)
  page.once('dialog', (dialog) => void dialog.accept())
  await page.reload()

  await expect(page.getByRole('dialog', { name: '发现自动恢复草稿' })).toBeVisible()
  await page.getByRole('button', { name: '恢复草稿' }).click()
  await expect(page.locator('button').filter({ hasText: '小球 1' })).toBeVisible()
})

test('旧版场景会被拒绝，坏文件不会覆盖当前文档', async ({ page }) => {
  await page.goto('/')
  const fileInput = page.locator('input[type="file"]')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  await page.keyboard.press('o')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.getByRole('button', { name: '小球 1', exact: true })).toBeVisible()
  const oldScene = {
    schemaVersion: 1,
    appVersion: '0.3.0',
    metadata: {
      name: '旧版迁移场景',
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    },
    settings: {
      fixedTimeStep: 1 / 120,
      gridStep: 1,
      snapStep: 0.1,
      pairwiseElectrostatics: true,
    },
    layers: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: '旧图层',
        visible: true,
        locked: false,
      },
    ],
    entities: [],
  }

  await fileInput.setInputFiles({
    name: 'legacy.motion.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(oldScene)),
  })
  await expect(
    page.getByText('当前版本只接受格式 16，该场景使用格式 1。', { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: '小球 1', exact: true })).toBeVisible()

  await fileInput.setInputFiles({
    name: 'broken.motion.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{not-json'),
  })
  await expect(page.getByText('文件不是有效的 JSON 场景。', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '小球 1', exact: true })).toBeVisible()
})

test('地面连接点工具可依次连接相隔端点、显示预览并删除', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const drag = async (startX: number, endX: number) => {
    await page.mouse.move(startX, center.y)
    await page.mouse.down()
    await page.mouse.move(endX, center.y, { steps: 6 })
    await page.mouse.up()
  }

  await page.keyboard.press('g')
  await page.getByRole('button', { name: /自动连接地面/ }).click()
  await drag(center.x - 200, center.x)
  await page.mouse.move(center.x + 60, center.y - 60)
  await page.mouse.down()
  await page.mouse.move(center.x + 60, center.y - 260, { steps: 6 })
  await page.mouse.up()
  await expect(page.locator('button').filter({ hasText: '直线地面 2' })).toBeVisible()

  await page.keyboard.press('j')
  await expect(page.getByText('地面连接点工具', { exact: true })).toBeVisible()
  await page.mouse.click(center.x, center.y)
  await expect(page.getByText(/已选择第一个端点/)).toBeVisible()
  await page.mouse.move(center.x + 60, center.y - 60)
  await expect(page.getByText(/预览/)).toBeVisible()
  await page.mouse.click(center.x + 60, center.y - 60)

  const jointRow = page.locator('button').filter({ hasText: '地面连接点 1' })
  await expect(jointRow).toBeVisible()
  await openInspectorTab(page, '几何')
  await expect(page.getByText('几何有效；小球可沿圆滑过渡', { exact: true })).toBeVisible()
  await expect(page.getByText('4.24264 m', { exact: true })).toBeVisible()

  await page.keyboard.press('Delete')
  await expect(jointRow).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(page.locator('button').filter({ hasText: '地面连接点 1' })).toBeVisible()
})

test('地面连接点工具可用右键取消第一次端点选择', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  await page.keyboard.press('g')
  await page.mouse.move(center.x - 160, center.y)
  await page.mouse.down()
  await page.mouse.move(center.x, center.y, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.press('j')
  await page.mouse.click(center.x, center.y)
  await expect(page.getByText(/已选择第一个端点/)).toBeVisible()
  await page.mouse.click(center.x + 40, center.y + 40, { button: 'right' })
  await expect(page.getByText('依次点击两块地面的端点', { exact: true })).toBeVisible()
})

test('地面连接点工具拒绝 0° 并把 180° 端点连接为直线', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const drag = async (startX: number, startY: number, endX: number, endY: number) => {
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 6 })
    await page.mouse.up()
  }

  await page.keyboard.press('g')
  await page.getByRole('button', { name: /自动连接地面/ }).click()
  await drag(center.x - 200, center.y, center.x, center.y)
  await drag(center.x + 100, center.y + 60, center.x + 220, center.y + 60)
  await drag(center.x + 100, center.y - 60, center.x - 100, center.y - 60)

  await page.keyboard.press('j')
  await page.mouse.click(center.x, center.y)
  await page.mouse.move(center.x + 100, center.y + 60)
  await expect(page.getByText(/方向几乎重合/)).toBeVisible()
  await page.mouse.click(center.x + 100, center.y + 60)
  await expect(page.locator('button').filter({ hasText: '地面连接点' })).toHaveCount(0)

  await page.mouse.move(center.x + 100, center.y - 60)
  await expect(page.getByText('预览：将生成端点间直线连接。', { exact: true })).toBeVisible()
  await page.mouse.click(center.x + 100, center.y - 60)
  await expect(page.locator('button').filter({ hasText: '地面连接点 1' })).toBeVisible()
  await openInspectorTab(page, '几何')
  await expect(page.getByText('几何有效；使用直线退化连接', { exact: true })).toBeVisible()
  await expect(page.getByText('端点间直线', { exact: true })).toBeVisible()
})

test('新地面可自动连接端点，并与连接点一起撤销', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const drag = async (startX: number, startY: number, endX: number, endY: number) => {
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 6 })
    await page.mouse.up()
  }
  const layerEntity = (name: string) => page.locator('button').filter({ hasText: name })

  await page.getByRole('button', { name: '地面工具（G）' }).click()
  const autoJoint = page.getByRole('button', { name: /自动连接地面/ })
  await expect(autoJoint).toHaveAttribute('aria-pressed', 'true')
  await drag(center.x - 200, center.y, center.x, center.y)
  await drag(center.x + 6, center.y, center.x + 180, center.y - 100)

  await expect(layerEntity('直线地面 2')).toBeVisible()
  await expect(layerEntity('地面连接点 1')).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(layerEntity('直线地面 2')).toHaveCount(0)
  await expect(layerEntity('地面连接点 1')).toHaveCount(0)
  await page.keyboard.press('Control+y')
  await expect(layerEntity('直线地面 2')).toBeVisible()
  await expect(layerEntity('地面连接点 1')).toBeVisible()

  await layerEntity('地面连接点 1').click()
  await openInspectorTab(page, '几何')
  await page.getByLabel('手动长度').check()
  await expect(page.getByLabel('过渡长度')).toBeVisible()
  await page.getByLabel('过渡长度').fill('1')
  await page.getByLabel('过渡长度').press('Enter')
  await expect(page.getByLabel('过渡长度')).toHaveValue('1')
  await expect(page.getByLabel('翻转方向')).toHaveCount(0)

  await page.keyboard.down('Alt')
  await drag(center.x - 194, center.y, center.x - 300, center.y - 80)
  await page.keyboard.up('Alt')
  await expect(page.locator('button').filter({ hasText: '地面连接点' })).toHaveCount(1)

  await autoJoint.click()
  await expect(autoJoint).toHaveAttribute('aria-pressed', 'false')
})

test('弹簧空白点击创建自由端且隐藏无效碰撞属性', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(center.x - 100, center.y - 50)
  await page.getByRole('button', { name: '连接工具（L）' }).click()
  const options = page.getByRole('region', { name: '当前工具选项' })
  await options.getByRole('combobox').selectOption('spring')
  await page.mouse.click(center.x - 100, center.y - 50)
  await page.mouse.click(center.x + 120, center.y + 80)

  const spring = page.locator('button').filter({ hasText: '弹簧 1' })
  await expect(spring).toBeVisible()
  await spring.click()
  await page.getByRole('tab', { name: '物理', exact: true }).click()
  await expect(page.getByLabel('自由端接触半径')).toHaveValue('0.05')
  await expect(page.getByLabel('连接体质量')).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: '开启连接体碰撞' })).toHaveCount(0)
  await expect(page.getByLabel('摩擦系数')).toHaveCount(0)
  await expect(page.getByLabel('弹性系数')).toHaveCount(0)

  await page.getByRole('tab', { name: '几何', exact: true }).click()
  await expect(page.getByText('自由端点', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: '把弹簧 B 端点固定到当前位置' })).toBeVisible()
  const initialX = await page.getByLabel('B 初始 X').inputValue()
  const initialY = await page.getByLabel('B 初始 Y').inputValue()

  await page.getByRole('tab', { name: '物理', exact: true }).click()
  await page.getByLabel('弹簧原长').fill('8')
  await page.getByLabel('弹簧原长').press('Enter')
  await page.getByRole('tab', { name: '几何', exact: true }).click()
  await expect(page.getByLabel('B 初始 X')).toHaveValue(initialX)
  await expect(page.getByLabel('B 初始 Y')).toHaveValue(initialY)
})

test('绳碰撞开关原子调整最低质量并支持撤销', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(center.x - 100, center.y)
  await page.mouse.click(center.x + 100, center.y)
  await page.getByRole('button', { name: '连接工具（L）' }).click()
  await page
    .getByRole('region', { name: '当前工具选项' })
    .getByRole('combobox')
    .selectOption('rope')
  await page.mouse.click(center.x - 100, center.y)
  await page.mouse.click(center.x + 100, center.y)

  await page.getByRole('button', { name: '绳 1', exact: true }).click()
  await openInspectorTab(page, '物理')
  const collision = page.getByRole('checkbox', { name: '开启连接体碰撞' })
  const mass = page.getByLabel('连接体质量')
  await expect(collision).not.toBeChecked()
  await expect(mass).toHaveValue('0')
  await expect(mass).toBeDisabled()

  await collision.check()
  await expect(mass).toHaveValue('0.001')
  await expect(mass).toBeEnabled()
  await mass.fill('0.005')
  await mass.press('Enter')
  await collision.uncheck()
  await expect(mass).toHaveValue('0')
  await expect(mass).toBeDisabled()

  await page.keyboard.press('Control+z')
  await expect(collision).toBeChecked()
  await expect(mass).toHaveValue('0.005')
})

test('弹簧端点可独立解除、保持零质量并通过撤销恢复', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(center.x - 100, center.y)
  await page.mouse.click(center.x + 100, center.y)
  await page.getByRole('button', { name: '连接工具（L）' }).click()
  await page
    .getByRole('region', { name: '当前工具选项' })
    .getByRole('combobox')
    .selectOption('spring')
  await page.mouse.click(center.x - 100, center.y)
  await page.mouse.click(center.x + 100, center.y)

  await page.getByRole('button', { name: '弹簧 1', exact: true }).click()
  await openInspectorTab(page, '几何')
  await page.getByRole('button', { name: '解除弹簧 A 端点' }).click()
  await expect(page.getByText('自由端点', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: '把弹簧 A 端点固定到当前位置' })).toBeVisible()

  await openInspectorTab(page, '物理')
  await expect(page.getByLabel('自由端接触半径')).toHaveValue('0.05')
  await expect(page.getByLabel('连接体质量')).toHaveCount(0)
  await expect(page.getByLabel('摩擦系数')).toHaveCount(0)
  await expect(page.getByLabel('弹性系数')).toHaveCount(0)

  await page.keyboard.press('Control+z')
  await openInspectorTab(page, '几何')
  await expect(page.getByText('自由端点', { exact: true })).toHaveCount(0)

  await page.keyboard.press('Control+y')
  await expect(page.getByText('自由端点', { exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: '解除弹簧 B 端点' }).click()
  await expect(page.getByText('自由端点', { exact: true })).toHaveCount(2)
  await page.getByRole('button', { name: '把弹簧 A 端点固定到当前位置' }).click()
  await expect(page.getByText('自由端点', { exact: true })).toHaveCount(1)
})
