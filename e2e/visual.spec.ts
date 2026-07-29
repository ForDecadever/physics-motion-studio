import { expect, test } from '@playwright/test'

async function canvasBox(page: import('@playwright/test').Page) {
  const canvas = page.getByRole('application', { name: '可交互的二维物理画布' })
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('画布没有可截图的尺寸')
  return box
}

test('空白编辑器视觉基线', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(page.getByText('编辑模式', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveScreenshot('empty-editor.png', { animations: 'disabled' })
})

test('选中物体视觉基线', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const box = await canvasBox(page)
  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.getByRole('button', { name: '对象缩放（S）' }).click()
  await page.getByRole('tab', { name: '物理', exact: true }).click()
  await expect(page.getByLabel('质量')).toBeVisible()
  await expect(page).toHaveScreenshot('selected-body.png', { animations: 'disabled' })
})

test('缩放后的地面保持固定显示厚度', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const box = await canvasBox(page)
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const drag = async (startX: number, startY: number, endX: number, endY: number) => {
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 6 })
    await page.mouse.up()
  }

  await page.getByRole('button', { name: '地面工具（G）' }).click()
  await drag(center.x - 100, center.y + 80, center.x + 100, center.y + 80)
  await drag(center.x - 100, center.y - 80, center.x + 100, center.y - 80)
  await page.getByRole('button', { name: '对象缩放（S）' }).click()
  await page.keyboard.down('Alt')
  await drag(center.x + 105, center.y - 85, center.x + 210, center.y - 90)
  await page.keyboard.up('Alt')

  await expect(page).toHaveScreenshot('scaled-ground-thickness.png', { animations: 'disabled' })
})

test('曲线地面、场、连接器和播放图表视觉基线', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const box = await canvasBox(page)
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const drag = async (startX: number, startY: number, endX: number, endY: number) => {
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 6 })
    await page.mouse.up()
  }

  await page.getByRole('button', { name: '地面工具（G）' }).click()
  await page.getByLabel('形状').selectOption('cubicBezier')
  await page.mouse.click(center.x - 260, center.y + 120)
  await page.mouse.click(center.x + 260, center.y + 120)
  await page.getByRole('button', { name: '物体工具（O）' }).click()
  await page.mouse.click(center.x - 90, center.y - 30)
  await page.mouse.click(center.x + 90, center.y - 30)
  await page.getByRole('button', { name: '场工具（F）' }).click()
  await drag(center.x - 240, center.y - 160, center.x + 240, center.y + 80)
  await page.getByRole('button', { name: '连接工具（L）' }).click()
  await page.mouse.click(center.x - 90, center.y - 30)
  await page.mouse.click(center.x + 90, center.y - 30)

  await page.locator('button').filter({ hasText: '小球 1' }).click()
  const chart = page.getByRole('article', { name: '坐标系 1' })
  await chart.getByRole('button', { name: '配置坐标系 1' }).click()
  await chart.getByRole('button', { name: '添加物体' }).click()
  await chart
    .getByRole('group', { name: '向坐标系 1添加物体' })
    .getByRole('button', { name: '确认添加' })
    .click()
  await page.getByRole('button', { name: '单步' }).click()
  await page.getByRole('button', { name: '单步' }).click()
  await expect(page.getByRole('img', { name: '坐标系 1图像' })).toBeVisible()
  await expect(page).toHaveScreenshot('complex-chart.png', { animations: 'disabled' })
})

test('窄窗口视觉基线', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 })
  await page.goto('/')
  await expect(page.getByText('编辑模式', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveScreenshot('narrow-editor.png', { animations: 'disabled' })
})

test('浮动与重新停靠面板视觉基线', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  const workspace = page.getByRole('main', { name: '编辑工作区' })
  const workspaceBox = await workspace.boundingBox()
  const dragHandle = page.getByRole('button', { name: '拖动图层面板' })
  const handleBox = await dragHandle.boundingBox()
  if (!workspaceBox || !handleBox) throw new Error('工作区或面板标题栏没有可拖动尺寸')

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    workspaceBox.x + workspaceBox.width / 2,
    workspaceBox.y + workspaceBox.height / 2,
    { steps: 8 },
  )
  await page.mouse.up()
  await expect(page.getByRole('region', { name: '图层面板' })).toHaveAttribute(
    'data-mode',
    'floating',
  )
  await expect(page).toHaveScreenshot('floating-panels.png', { animations: 'disabled' })

  const floatingHandleBox = await dragHandle.boundingBox()
  if (!floatingHandleBox) throw new Error('浮动面板标题栏没有可拖动尺寸')
  await page.mouse.move(
    floatingHandleBox.x + floatingHandleBox.width / 2,
    floatingHandleBox.y + floatingHandleBox.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(workspaceBox.x + 12, workspaceBox.y + 180, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByRole('region', { name: '图层面板' })).toHaveAttribute('data-edge', 'left')
  await expect(page).toHaveScreenshot('redocked-panels.png', { animations: 'disabled' })
})
