import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

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

  await page.getByRole('button', { name: '选择与移动（V）' }).click()
  await page.mouse.move(center.x - 100, center.y - 40)
  await page.mouse.down()
  await page.mouse.move(center.x - 50, center.y - 40, { steps: 6 })
  await expect(page.getByLabel('位置 X')).toHaveValue('-0.5')
  await page.mouse.up()

  await page.getByRole('button', { name: '旋转（R）' }).click()
  await page.mouse.move(center.x - 20, center.y - 40)
  await page.mouse.down()
  await page.mouse.move(center.x - 50, center.y - 70, { steps: 6 })
  await expect(page.getByLabel('角度')).toHaveValue('90')
  await page.mouse.up()

  const zoomReadout = page.getByRole('main').getByText(/px\/m/)
  await expect(zoomReadout).toHaveText('100 px/m')
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
  await drag(center.x - 180, center.y + 150, center.x + 180, center.y + 150)
  await expect(page.locator('button').filter({ hasText: '贝塞尔地面 2' })).toBeVisible()
  await page.getByLabel('控制点 1 Y').fill('2')
  await page.getByLabel('控制点 1 Y').press('Enter')
  await expect(page.getByLabel('控制点 1 Y')).toHaveValue('2')

  await page.getByRole('button', { name: '物体工具（O）' }).click()
  const bodyPreset = page.getByRole('region', { name: '当前工具选项' }).getByRole('combobox')
  await bodyPreset.selectOption('particle')
  await page.mouse.click(center.x - 80, center.y - 80)
  await expect(page.locator('button').filter({ hasText: '质点 1' })).toBeVisible()
  await bodyPreset.selectOption('block')
  await drag(center.x + 80, center.y - 80, center.x + 120, center.y - 40)
  await expect(page.locator('button').filter({ hasText: '物块 2' })).toBeVisible()
  await expect(page.getByLabel('质量')).toHaveValue('1')
})

test('可以创建阶段 3 的点电荷、场和三种连接器', async ({ page }) => {
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
  await options.getByRole('combobox').selectOption('pointCharge')
  await page.mouse.click(center.x - 100, center.y - 40)
  await options.getByRole('combobox').selectOption('ball')
  await page.mouse.click(center.x + 100, center.y - 40)
  await expect(layerEntity('点电荷 1')).toBeVisible()
  await layerEntity('点电荷 1').click()
  await expect.poll(async () => Number(await page.getByLabel('电荷量').inputValue())).toBe(1e-6)

  await page.getByRole('button', { name: '连接工具（L）' }).click()
  await options.getByRole('combobox').selectOption('rod')
  await page.mouse.click(center.x - 100, center.y - 40)
  await page.mouse.click(center.x + 100, center.y - 40)
  await expect(layerEntity('杆 1')).toBeVisible()
  await expect(page.getByLabel('杆长')).toHaveValue('2')

  await options.getByRole('combobox').selectOption('spring')
  await page.mouse.click(center.x - 100, center.y - 40)
  await page.mouse.click(center.x + 100, center.y - 40)
  await expect(layerEntity('弹簧 2')).toBeVisible()
  await expect(page.getByLabel('劲度系数')).toHaveValue('20')

  await page.getByRole('button', { name: '场工具（F）' }).click()
  await options.getByRole('combobox').first().selectOption('uniformElectric')
  await drag(center.x - 220, center.y - 150, center.x + 220, center.y + 80)
  await expect(layerEntity('电场 1')).toBeVisible()
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

test('场工具可以创建圆形、多边形和无限范围', async ({ page }) => {
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
  await expect(page.getByLabel('图层和属性').getByText('圆形', { exact: true })).toBeVisible()

  await range.selectOption('polygon')
  await page.mouse.move(center.x, center.y)
  await page.mouse.down()
  await page.mouse.move(center.x + 70, center.y, { steps: 4 })
  await page.mouse.up()
  await expect(page.getByLabel('图层和属性').getByText('多边形', { exact: true })).toBeVisible()

  await range.selectOption('infinite')
  await page.mouse.click(center.x + 160, center.y)
  await expect(page.getByLabel('图层和属性').getByText('无限范围', { exact: true })).toBeVisible()
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
