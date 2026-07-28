import { expect, test } from '@playwright/test'
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
  await expect(page.getByText('属性', { exact: true })).toBeVisible()
  await expect(page.getByText('物理量—时间', { exact: true })).toBeVisible()
  await expect(page.getByText('阶段 4', { exact: true })).toBeVisible()
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
  await expect(page.getByText('请选择第二个物体', { exact: true })).toBeVisible()
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
  const bodyPreset = page.getByRole('region', { name: '当前工具选项' }).getByRole('combobox')
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

test('图层对象可以独立隐藏、删除并通过撤销恢复依赖关系', async ({ page }) => {
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
  await expect(page.getByLabel('A 锚点 X')).toHaveValue('1')

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

test('可以记录两个物体的多条曲线并导出含单位的 CSV', async ({ page }) => {
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

  await page.getByRole('button', { name: '添加曲线' }).click()
  let form = page.getByRole('group', { name: '添加曲线' })
  await form.getByRole('combobox').nth(0).selectOption({ label: '小球 1' })
  await form.getByRole('combobox').nth(1).selectOption('positionY')
  await form.getByRole('button', { name: '确认添加' }).click()

  await page.getByRole('button', { name: '添加曲线' }).click()
  form = page.getByRole('group', { name: '添加曲线' })
  await form.getByRole('combobox').nth(0).selectOption({ label: '小球 2' })
  await form.getByRole('combobox').nth(1).selectOption('speed')
  await form.getByRole('button', { name: '确认添加' }).click()
  await expect(page.getByText('2 条曲线', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '单步' }).click()
  await page.getByRole('button', { name: '单步' }).click()
  await expect(page.getByRole('img', { name: '物理量时间曲线图' })).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 CSV' }).click()
  const download = await downloadPromise
  const downloadPath = await download.path()
  expect(downloadPath).not.toBeNull()
  if (!downloadPath) return
  const csv = await readFile(downloadPath, 'utf8')
  expect(csv).toContain('模拟时间 t (s)')
  expect(csv).toContain('小球 1 · y (m)')
  expect(csv).toContain('小球 2 · |v| (m/s)')
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
  await expect(page.getByLabel('图层和属性').getByText('圆形', { exact: true })).toBeVisible()
  await page.getByLabel('圆心角').fill('90')
  await page.getByLabel('圆心角').press('Enter')
  await expect(page.getByLabel('图层和属性').getByText('扇形', { exact: true })).toBeVisible()

  await range.selectOption('freeform')
  await page.mouse.click(center.x - 20, center.y - 40)
  await page.mouse.click(center.x + 80, center.y - 20)
  await page.mouse.click(center.x + 50, center.y + 70)
  await page.keyboard.press('Enter')
  await expect(
    page.getByLabel('图层和属性').getByText('钢笔自由形状', { exact: true }),
  ).toBeVisible()

  await range.selectOption('infinite')
  await page.mouse.click(center.x + 160, center.y)
  await expect(page.getByLabel('图层和属性').getByText('无限范围', { exact: true })).toBeVisible()
})

test('菜单会自动收起，工具悬停 0.5 秒显示分类悬浮窗', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 })
  await page.goto('/')
  const fileMenu = page.getByText('文件', { exact: true })
  await fileMenu.click()
  await expect(page.getByRole('menuitem', { name: '新建场景' })).toBeVisible()
  await page.mouse.move(600, 300)
  await expect(page.getByRole('menuitem', { name: '新建场景' })).toBeHidden()

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
  await expect(wallSnap).toHaveAttribute('aria-pressed', 'false')
  await wallSnap.click()
  await expect(wallSnap).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(center.x, center.y + 88)
  await openInspectorTab(page, '变换')
  await expect(page.getByLabel('位置 Y')).toHaveValue('-4.5')
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
  await expect(page.getByText('有未保存更改', { exact: true })).toBeVisible()
})

test('旧版场景可以打开迁移，坏文件不会覆盖当前文档', async ({ page }) => {
  await page.goto('/')
  const fileInput = page.locator('input[type="file"]')
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
  await expect(page.getByRole('banner').getByText('旧版迁移场景', { exact: true })).toBeVisible()
  await expect(page.getByText('旧图层', { exact: true })).toBeVisible()

  await fileInput.setInputFiles({
    name: 'broken.motion.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{not-json'),
  })
  await expect(page.getByText('文件不是有效的 JSON 场景。', { exact: true })).toBeVisible()
  await expect(page.getByRole('banner').getByText('旧版迁移场景', { exact: true })).toBeVisible()
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
