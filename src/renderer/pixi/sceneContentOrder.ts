import { sceneTreeItemTargetId } from '../../scene/model/booleanLayerGraph'
import type { EntityId, SceneTreeItem } from '../../scene/model/types'

/** Pixi 后绘制的内容位于前方，因此面板首项需要最后进入内容 Graphics。 */
export function sceneContentPaintOrder(rootItems: readonly SceneTreeItem[]): EntityId[] {
  return [...rootItems].reverse().map(sceneTreeItemTargetId)
}
