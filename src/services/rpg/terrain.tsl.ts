/**
 * 地形材质（TSL 节点着色器）。
 *
 * ## 为什么是一张 quad 而不是每格一个网格
 * 256×256 的世界有 65536 格，一格一个 mesh 会直接把浏览器跪掉。
 * 这里地面是**一整张平面**，另外挂一张 `DataTexture` 存视窗内每格的图块 id，
 * 片元着色器按 id 去图集取样。玩家跨过整格边界时才重写那张小贴图，
 * 平时一帧一个 drawcall。
 *
 * ## 图集取样为什么要夹一下
 * 图块是像素画、必须 NearestFilter。但格子边缘的 uv 正好落在图集相邻格的
 * 交界上，插值/mipmap 会把隔壁格的颜色渗进来（表现是草地边缘出现一圈蓝边）。
 * 所以在格内 uv 上留半个纹素的余量再映射到图集。
 *
 * 纯 service：不 import vue/pinia。
 */

import {
  Fn,
  clamp,
  float,
  floor,
  fract,
  mix,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import type * as THREE_NS from 'three'
import { ATLAS_COLS, TILE_PX } from './tiles'
import { BIOME } from './noise'

export interface TerrainMaterialArgs {
  atlas: THREE_NS.Texture
  /** 视窗内每格的图块 id，尺寸 view×view，R 通道存 id */
  index: THREE_NS.Texture
  /** 视窗边长，单位是格 */
  view: number
  /**
   * 视窗左下角的世界格坐标。**由调用方持有并就地 set()**，
   * uniform 节点会跟着这个对象走 —— 这样类型是确定的 THREE.Vector2，
   * 不必去碰 TSL 节点那个 `unknown` 的 .value。
   */
  origin: THREE_NS.Vector2
}

/**
 * 建地形材质。
 *
 * `origin` 传的是视窗左下角的世界格坐标（整数）。之所以要它，是因为水面动画
 * 必须按**世界坐标**算相位 —— 用视窗局部坐标的话，玩家一走动整片水的波纹
 * 就会跟着平移，看起来像水面在拖着玩家跑。
 */
export function createTerrainMaterial(args: TerrainMaterialArgs): MeshBasicNodeMaterial {
  const { atlas, index, view } = args
  const origin = uniform(args.origin)

  const material = new MeshBasicNodeMaterial()

  material.colorNode = Fn(() => {
    // 片元在视窗里的格坐标：0..view
    const t = uv().mul(float(view))
    const cell = floor(t)
    const inCell = fract(t)

    // 取该格的图块 id。index 贴图是 NearestFilter，采样点打在格心
    const idxUv = cell.add(0.5).div(float(view))
    // id 存在 R 通道，写入时已归一化成 0..1，这里乘回去
    const tileId = floor(texture(index, idxUv).r.mul(255).add(0.5))

    // 格内 uv 夹掉半个纹素，杜绝图集相邻格的颜色渗过来
    const pad = float(0.5 / TILE_PX)
    const safe = clamp(inCell, pad, float(1).sub(pad))
    const atlasUv = vec2(tileId.add(safe.x).div(float(ATLAS_COLS)), safe.y)
    const base = texture(atlas, atlasUv)

    // ── 水与浅滩的动态 ──
    // 相位按世界坐标算，玩家走动时波纹留在原地
    const world = origin.add(t)
    const wave = sin(world.x.mul(0.7).add(world.y.mul(0.5)).add(time.mul(1.6)))
      .mul(0.5)
      .add(0.5)

    const isWater = smoothstep(float(BIOME.water - 0.5), float(BIOME.water + 0.5), tileId)
    const isShallow = smoothstep(
      float(BIOME.shallow - 0.5),
      float(BIOME.shallow + 0.5),
      tileId,
    ).sub(isWater.mul(0))

    // 水面：整体压暗一点再叠一层随波动的高光，出「有厚度」的感觉
    const waterTint = mix(vec3(0.82, 0.88, 1.0), vec3(1.08, 1.12, 1.18), wave)
    // 浅滩：泡沫更白更碎，频率高一倍
    const foam = sin(world.x.mul(1.9).sub(world.y.mul(1.3)).add(time.mul(2.4)))
      .mul(0.5)
      .add(0.5)
    const shallowTint = mix(vec3(0.95, 0.98, 1.0), vec3(1.2, 1.24, 1.28), foam.mul(foam))

    // 只有对应生态才受影响，陆地原样
    let rgb = base.rgb
    rgb = mix(rgb, rgb.mul(waterTint), isWater)
    rgb = mix(rgb, rgb.mul(shallowTint), isShallow.mul(float(1).sub(isWater)))

    return vec4(rgb, 1)
  })()

  return material
}
