import { describe, expect, it } from 'vitest'

import { createBooleanLayer } from '../../scene/model/layerFactories'
import { sceneContentPaintOrder } from './sceneContentOrder'

describe('统一场景内容绘制顺序', () => {
  it('根数组首项最后绘制并位于画布最前方', () => {
    const boolean = createBooleanLayer('union', '布尔加法')
    expect(
      sceneContentPaintOrder([
        { kind: 'entity', entityId: 'front-body' },
        boolean,
        { kind: 'entity', entityId: 'back-ground' },
      ]),
    ).toEqual(['back-ground', boolean.resultId, 'front-body'])
  })
})
