import {
  Box,
  GitMerge,
  Hand,
  Link2,
  Magnet,
  MousePointer2,
  RotateCw,
  Scaling,
  Sparkles,
  Spline,
  ZoomIn,
  type LucideIcon,
} from 'lucide-react'

import type { EditorTool } from '../../stores/editorStore'

export interface ToolDefinition {
  id: EditorTool
  label: string
  shortcut: string
  icon: LucideIcon
  startsGroup?: boolean
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
  { id: 'particleSource', label: '粒子源工具', shortcut: 'P', icon: Sparkles },
]

export function getToolDefinition(tool: EditorTool): ToolDefinition {
  return toolDefinitions.find((definition) => definition.id === tool) ?? toolDefinitions[0]!
}
