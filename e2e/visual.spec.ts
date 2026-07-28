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
  await page.getByRole('tab', { name: '物理', exact: true }).click()
  await expect(page.getByLabel('质量')).toBeVisible()
  await expect(page).toHaveScreenshot('selected-body.png', { animations: 'disabled' })
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
  await page.getByRole('button', { name: '添加曲线' }).click()
  await page
    .getByRole('group', { name: '添加曲线' })
    .getByRole('button', { name: '确认添加' })
    .click()
  await page.getByRole('button', { name: '单步' }).click()
  await page.getByRole('button', { name: '单步' }).click()
  await expect(page.getByRole('img', { name: '物理量时间曲线图' })).toBeVisible()
  await expect(page).toHaveScreenshot('complex-chart.png', { animations: 'disabled' })
})

test('窄窗口视觉基线', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 720 })
  await page.goto('/')
  await expect(page.getByText('编辑模式', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveScreenshot('narrow-editor.png', { animations: 'disabled' })
})
