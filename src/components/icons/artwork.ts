import { glyphs, type IconNode } from './glyphs'

export type IconName = keyof typeof glyphs
type Part = {
  nodes: IconNode[]
  rest?: string
  hover?: string
  active?: string
  origin?: string
  opacity?: number
  activeOpacity?: number
  ambient?: boolean
}
type Artwork = { parts: Part[]; optical?: string; ambient?: boolean }
type Motion = Omit<Part, 'nodes'>

function part(name: IconName, indices: number[] | 'all', motion: Motion = {}): Part {
  const nodes = glyphs[name] as IconNode[]
  return { nodes: indices === 'all' ? nodes : indices.map((i) => nodes[i]!), ...motion }
}

function whole(name: IconName, hover: string, active = hover): Artwork {
  return { parts: [part(name, 'all', { hover, active })] }
}

// Geometry is inset to the same 18-unit visual body. Small glyphs keep their
// native bounds so an X/check doesn't look weaker than an enclosing circle.
const nativeGrid = new Set<IconName>([
  'Characters',
  'Drama',
  'Menu',
  'Orbit',
  'X',
  'Plus',
  'Minus',
  // 本来就是 3→21 的 18 单位视觉体，再套 .9 光学内缩会比同排箭头小一圈
  'ArrowDownToLine',
  'Check',
  'Square',
  'ChevronDown',
  'ChevronLeft',
  'ChevronRight',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
])
export const iconArtwork = Object.fromEntries(
  (Object.keys(glyphs) as IconName[]).map((name) => [
    name,
    {
      optical: nativeGrid.has(name) ? undefined : 'translate(1.2 1.2) scale(.9)',
      parts: [part(name, 'all', { hover: 'translateY(-1px)', active: 'scale(0.96)' })],
    },
  ]),
) as Record<IconName, Artwork>

function set(name: IconName, artwork: Artwork) {
  Object.assign(iconArtwork[name], artwork)
}

set('Characters', {
  ambient: true,
  parts: [
    part('Characters', [0], {
      hover: 'translateY(-.35px) scale(1.04)',
      active: 'translateY(.2px) scale(.94)',
      origin: '12px 12px',
      ambient: true,
    }),
    part('Characters', [1], {
      hover: 'translateY(-.15px) scaleX(1.06)',
      active: 'translateY(.1px) scaleX(.9)',
      origin: '12px 10px',
    }),
    part('Characters', [2], {
      hover: 'translateY(.25px) scaleX(1.08)',
      active: 'translateY(-.1px) scaleX(.88)',
      origin: '12px 14.3px',
    }),
  ],
})
set('Menu', {
  parts: [
    part('Menu', [0], {
      hover: 'translateX(1px)',
      active: 'translateY(5px) rotate(45deg)',
      origin: '12px 7px',
    }),
    part('Menu', [1], { hover: 'scaleX(.75)', active: 'scaleX(0)', activeOpacity: 0 }),
    part('Menu', [2], {
      hover: 'translateX(-1px)',
      active: 'translateY(-5px) rotate(-45deg)',
      origin: '12px 17px',
    }),
  ],
})
set('Drama', {
  ambient: true,
  parts: [
    part('Drama', [0], {
      hover: 'translateY(.2px) scale(1.02)',
      active: 'translateY(.35px) scale(.98)',
      origin: '12px 14px',
      ambient: true,
    }),
    part('Drama', [1], {
      hover: 'translate(-.35px -.7px) rotate(-3deg)',
      active: 'translate(.1px 1px) rotate(4deg)',
      origin: '12px 8px',
      ambient: true,
    }),
    part('Drama', [2], {
      hover: 'translate(-.35px -.7px) rotate(-3deg)',
      active: 'translate(.1px 1px) rotate(4deg)',
      origin: '12px 8px',
    }),
    part('Drama', [3], {
      hover: 'translateY(-.15px) scaleX(1.04)',
      active: 'translateY(.15px) scaleX(.94)',
      origin: '12px 14px',
    }),
  ],
})
set('UsersRound', {
  ambient: true,
  parts: [
    part('UsersRound', [0, 1], { hover: 'translateX(-.7px)', active: 'translateX(.5px)' }),
    part('UsersRound', [2], {
      hover: 'translateX(.7px)',
      active: 'translateX(-.5px)',
      ambient: true,
    }),
  ],
})
set('BookOpen', {
  ambient: true,
  parts: [
    {
      nodes: [
        ['path', { d: 'M12 7c0-2.2-1.8-4-4-4H3a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h6a3 3 0 0 1 3 3Z' }],
      ],
      hover: 'scaleX(.86)',
      active: 'scaleX(1.02)',
    },
    {
      nodes: [
        ['path', { d: 'M12 7c0-2.2 1.8-4 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3Z' }],
      ],
      hover: 'scaleX(.78)',
      active: 'scaleX(1.02)',
      ambient: true,
    },
  ],
})
set('Database', {
  ambient: true,
  parts: [
    part('Database', [0], {
      hover: 'translateY(-1px)',
      active: 'translateY(-.5px)',
      ambient: true,
    }),
    part('Database', [1], { hover: 'translateY(.6px)', active: 'translateY(.3px)' }),
    part('Database', [2], { hover: 'translateY(1px)', active: 'translateY(.6px)' }),
  ],
})
set('Cpu', {
  ambient: true,
  parts: [
    part('Cpu', [12]),
    part('Cpu', [13], { hover: 'scale(1.12)', active: 'scale(1.06)', ambient: true }),
    part('Cpu', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], { hover: 'scale(.96)' }),
  ],
})
set('Settings', {
  ambient: true,
  parts: [
    part('Settings', [0], { hover: 'rotate(35deg)', active: 'rotate(60deg)' }),
    part('Settings', [1], { hover: 'scale(.8)', active: 'scale(.9)', ambient: true }),
  ],
})
set('Orbit', {
  ambient: true,
  parts: [
    part('Orbit', [0]),
    part('Orbit', [1], { hover: 'scale(1.12)', active: 'scale(1.05)', ambient: true }),
    part('Orbit', [2], { hover: 'rotate(70deg)', active: 'rotate(135deg)' }),
  ],
})
set('Sun', {
  ambient: true,
  parts: [
    part('Sun', [0], { hover: 'scale(.9)', active: 'scale(1.06)', ambient: true }),
    part('Sun', glyphs.Sun.map((_, i) => i).slice(1), {
      hover: 'rotate(35deg)',
      active: 'rotate(60deg)',
    }),
  ],
})
set('Moon', {
  ambient: true,
  parts: [part('Moon', 'all', { hover: 'rotate(-15deg)', active: 'rotate(8deg)', ambient: true })],
})
set('Monitor', {
  ambient: true,
  parts: [
    part('Monitor', [0], { hover: 'translateY(-1px)', active: 'translateY(-.5px)', ambient: true }),
    part('Monitor', [1, 2], { hover: 'scaleX(1.1)' }),
  ],
})
set('Plus', {
  parts: [
    part('Plus', [0], { hover: 'scaleX(.8)', active: 'scaleX(1.08)' }),
    part('Plus', [1], { hover: 'scaleY(1.1)', active: 'scaleY(.9)' }),
  ],
})
// 与 Plus 的横杠同一套动作，两个按钮并排（缩小 / 放大）时手感才对得上
set('Minus', {
  parts: [part('Minus', [0], { hover: 'scaleX(.8)', active: 'scaleX(1.08)' })],
})
// 照 Download 的分件范式：底线钉住不动，箭头自己落下去，落点感才出得来
set('ArrowDownToLine', {
  parts: [
    part('ArrowDownToLine', [2]),
    part('ArrowDownToLine', [0, 1], { hover: 'translateY(2px)', active: 'translateY(3px)' }),
  ],
})
set('X', whole('X', 'rotate(90deg)', 'rotate(90deg) scale(.9)'))
set('Check', whole('Check', 'translateY(-1px) rotate(-6deg)', 'scale(1.08)'))
set('ChevronRight', whole('ChevronRight', 'translateX(1.5px)', 'rotate(90deg)'))
set('ChevronLeft', whole('ChevronLeft', 'translateX(-1.5px)'))
set('ChevronDown', whole('ChevronDown', 'translateY(1.5px)', 'rotate(180deg)'))
set('ArrowLeft', whole('ArrowLeft', 'translateX(-1.5px)'))
set('ArrowRight', whole('ArrowRight', 'translateX(1.5px)'))
set('ArrowUp', whole('ArrowUp', 'translateY(-1.5px)'))
set('ArrowDown', whole('ArrowDown', 'translateY(1.5px)'))
set('ArrowLeftRight', whole('ArrowLeftRight', 'rotate(180deg)'))
set('Copy', {
  parts: [
    part('Copy', [0], { hover: 'translate(1px, -1px)', active: 'translate(.5px, -.5px)' }),
    part('Copy', [1], { hover: 'translate(-.5px, .5px)' }),
  ],
})
set('Trash2', {
  parts: [
    part('Trash2', [3, 4], {
      hover: 'translateY(-2px) rotate(-8deg)',
      active: 'translateY(-1px)',
      origin: '7px 6px',
    }),
    part('Trash2', [0, 1, 2], { hover: 'rotate(3deg)' }),
  ],
})
set('ImagePlus', {
  parts: [
    part('ImagePlus', [2, 3, 4], { hover: 'translateY(.5px)' }),
    part('ImagePlus', [0, 1], {
      hover: 'rotate(90deg)',
      active: 'scale(1.12)',
      origin: '19px 5px',
    }),
  ],
})
set('Sparkles', {
  parts: (glyphs.Sparkles as IconNode[]).map((node, i) => ({
    nodes: [node],
    hover: i === 0 ? 'rotate(-8deg) scale(.94)' : 'scale(1.15)',
    active: i === 0 ? 'rotate(6deg)' : 'scale(.9)',
    ambient: i > 0,
  })),
})
set('Pencil', whole('Pencil', 'translate(1px, -1px) rotate(-8deg)', 'rotate(-12deg)'))
set('Send', whole('Send', 'translate(1px, -1px) rotate(-6deg)', 'translate(1.5px, -1.5px)'))
set('RotateCcw', whole('RotateCcw', 'rotate(-45deg)', 'rotate(-90deg)'))
set('RefreshCw', whole('RefreshCw', 'rotate(60deg)', 'rotate(120deg)'))
set('Undo2', whole('Undo2', 'translateX(-1.5px) rotate(-5deg)'))
set('Download', {
  parts: [
    part('Download', [1]),
    part('Download', [0, 2], { hover: 'translateY(2px)', active: 'translateY(1px)' }),
  ],
})
set('Eye', {
  parts: [
    part('Eye', [0], { hover: 'scaleY(.9)' }),
    part('Eye', [1], { hover: 'translateX(1px)', active: 'scale(1.1)' }),
  ],
})
set('EyeOff', whole('EyeOff', 'scaleY(.9)'))
set('Save', {
  parts: [
    part('Save', [0]),
    part('Save', [1], { hover: 'translateY(-1px)', active: 'translateY(-.5px)' }),
    part('Save', [2], { hover: 'translateY(.6px)', active: 'translateY(.3px)' }),
  ],
})
set('ScanText', {
  parts: [
    part('ScanText', [0, 1, 2, 3], { hover: 'scale(1.05)', active: 'scale(.96)' }),
    part('ScanText', [4], { hover: 'translateX(1px)', active: 'scaleX(.9)' }),
    part('ScanText', [5], { hover: 'translateX(-1px)', active: 'scaleX(.9)' }),
    part('ScanText', [6], { hover: 'translateX(1px)', active: 'scaleX(.9)' }),
  ],
})
set('Server', {
  parts: [
    part('Server', [0, 2], { hover: 'translateY(-.7px)', active: 'translateY(-.3px)' }),
    part('Server', [1, 3], { hover: 'translateY(.7px)', active: 'translateY(.3px)' }),
  ],
})
set('GitBranch', {
  parts: [
    part('GitBranch', [0, 2]),
    part('GitBranch', [1], { hover: 'scale(1.16)', active: 'scale(.9)', origin: '18px 6px' }),
  ],
})
set('PlugZap', {
  parts: [
    part('PlugZap', [0, 1, 2, 3], { hover: 'translate(.5px, -.5px)' }),
    part('PlugZap', [4], {
      hover: 'translateY(-1px) rotate(-8deg)',
      active: 'scale(1.08)',
      origin: '17px 7px',
    }),
  ],
})
set('Star', whole('Star', 'rotate(15deg) scale(1.05)', 'rotate(0deg) scale(1.05)'))
set('VolumeX', whole('VolumeX', 'rotate(-6deg)', 'scale(.9)'))
set('Volume2', whole('Volume2', 'scale(1.08)'))
set('Sprout', whole('Sprout', 'rotate(-8deg)', 'rotate(4deg)'))
