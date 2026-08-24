import {
  Box,
  GitMerge,
  Gauge,
  Hand,
  Link2,
  Magnet,
  MoveUpRight,
  MousePointer2,
  Pencil,
  Proportions,
  Ruler,
  RotateCw,
  Scaling,
  Sparkles,
  Spline,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react'

import type { EditorTool } from '../../stores/editorStore'

export const measurementToolIds = ['marker', 'ruler', 'protractor', 'forceMeter'] as const
export type ToolbarToolId = EditorTool | 'measurement'

export interface ToolDefinition {
  id: EditorTool
  label: string
  shortcut: string
  icon: LucideIcon
  startsGroup?: boolean
}

export interface ToolbarDefinition extends Omit<ToolDefinition, 'id'> {
  id: ToolbarToolId
}

export const toolDefinitions: ToolDefinition[] = [
  { id: 'select', label: '选择与移动', shortcut: 'V', icon: MousePointer2 },
  { id: 'rotate', label: '旋转', shortcut: 'R', icon: RotateCw },
  { id: 'scale', label: '对象缩放', shortcut: 'S', icon: Scaling },
  { id: 'hand', label: '抓手', shortcut: 'H', icon: Hand, startsGroup: true },
  { id: 'zoom', label: '画布缩放', shortcut: 'Z', icon: ZoomIn },
  { id: 'ground', label: '地面工具', shortcut: 'G', icon: Spline, startsGroup: true },
  { id: 'groundJoint', label: '地面连接点工具', shortcut: 'J', icon: GitMerge },
  { id: 'body', label: '物体工具', shortcut: 'O', icon: Box },
  { id: 'field', label: '场工具', shortcut: 'F', icon: Magnet },
  { id: 'connector', label: '连接工具', shortcut: 'L', icon: Link2 },
  { id: 'particleSource', label: '粒子源工具', shortcut: 'I', icon: Sparkles },
  { id: 'force', label: '力工具', shortcut: 'K', icon: MoveUpRight },
  { id: 'marker', label: '记号笔', shortcut: 'M', icon: Pencil, startsGroup: true },
  { id: 'ruler', label: '直尺', shortcut: 'U', icon: Ruler },
  { id: 'protractor', label: '量角器', shortcut: 'A', icon: Proportions },
  { id: 'forceMeter', label: '测力计', shortcut: 'D', icon: Gauge },
]

export const toolbarDefinitions: ToolbarDefinition[] = [
  ...toolDefinitions.filter(
    (definition) =>
      !measurementToolIds.includes(definition.id as (typeof measurementToolIds)[number]),
  ),
  { id: 'measurement', label: '测量工具', shortcut: 'M', icon: Ruler, startsGroup: true },
]

export function getToolDefinition(tool: EditorTool): ToolDefinition {
  return toolDefinitions.find((definition) => definition.id === tool) ?? toolDefinitions[0]!
}
