import { expect, test } from '@playwright/test'

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
  await expect(page.getByText('阶段 2', { exact: true })).toBeVisible()
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

  await page.getByRole('button', { name: '暂停' }).click()
  await expect(page.getByText('模拟已暂停', { exact: true })).toBeVisible()
  const pausedTime = await timeOutput.textContent()
  await page.getByRole('button', { name: '单步' }).click()
  await expect(timeOutput).not.toHaveText(pausedTime ?? '')

  await page.getByRole('button', { name: '重置' }).click()
  await expect(page.getByText('编辑模式', { exact: true })).toBeVisible()
  await expect(page.getByText('0.000 s', { exact: true })).toBeVisible()
  await expect(positionY).toHaveValue(initialPositionY)
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
