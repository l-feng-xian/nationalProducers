import { defineComponent, h } from 'vue'
import AppIcon from './AppIcon.vue'
import type { IconName } from './artwork'

function icon(name: IconName) {
  return defineComponent({
    name: `Animated${name}`,
    inheritAttrs: false,
    setup:
      (_, { attrs }) =>
      () =>
        h(AppIcon, { ...attrs, name }),
  })
}

export const ArrowDown = icon('ArrowDown')
export const ArrowUp = icon('ArrowUp')
export const Check = icon('Check')
export const ChevronDown = icon('ChevronDown')
export const ChevronLeft = icon('ChevronLeft')
export const ChevronRight = icon('ChevronRight')
export const Copy = icon('Copy')
export const Download = icon('Download')
export const Eye = icon('Eye')
export const EyeOff = icon('EyeOff')
export const GitBranch = icon('GitBranch')
export const History = icon('History')
export const ImagePlus = icon('ImagePlus')
export const LoaderCircle = icon('LoaderCircle')
export const MessageCircle = icon('MessageCircle')
export const Minus = icon('Minus')
export const PanelRight = icon('PanelRight')
export const Pencil = icon('Pencil')
export const Pin = icon('Pin')
export const PlugZap = icon('PlugZap')
export const Plus = icon('Plus')
export const RefreshCw = icon('RefreshCw')
export const RotateCcw = icon('RotateCcw')
export const Save = icon('Save')
export const ScanText = icon('ScanText')
export const Send = icon('Send')
export const Server = icon('Server')
export const Sparkles = icon('Sparkles')
export const Square = icon('Square')
export const TriangleAlert = icon('TriangleAlert')
export const Trash2 = icon('Trash2')
export const Undo2 = icon('Undo2')
export const UsersRound = icon('UsersRound')
export const X = icon('X')
export const ZoomIn = icon('ZoomIn')
