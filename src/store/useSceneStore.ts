import { create } from 'zustand'
import type { WindowScene, SceneFormData } from '@/types'
import { vault } from '@/services/vault'

interface SceneState {
  scenes: WindowScene[]
  routeNames: string[]
  currentRouteScenes: WindowScene[]
  selectedRoute: string
  randomScene: WindowScene | null

  loadAll: () => void
  saveScene: (data: SceneFormData) => Promise<void>
  deleteScene: (id: string) => Promise<void>
  selectRoute: (routeName: string) => void
  refreshRandom: () => void
  clearAll: () => void
}

function byRoute(scenes: WindowScene[], routeName: string): WindowScene[] {
  return scenes
    .filter((s) => s.routeName === routeName)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
}

function routeNamesOf(scenes: WindowScene[]): string[] {
  return Array.from(new Set(scenes.map((s) => s.routeName))).sort()
}

/** 保险箱锁定期间一律视为无数据,绝不读写本地存储 */
function readScenes(): WindowScene[] {
  return vault.getStatus() === 'unlocked' ? vault.getScenes() : []
}

export const useSceneStore = create<SceneState>((set, get) => ({
  scenes: [],
  routeNames: [],
  currentRouteScenes: [],
  selectedRoute: '',
  randomScene: null,

  loadAll: () => {
    const scenes = readScenes()
    const { selectedRoute } = get()
    set({
      scenes,
      routeNames: routeNamesOf(scenes),
      currentRouteScenes: selectedRoute ? byRoute(scenes, selectedRoute) : [],
    })
  },

  saveScene: async (data: SceneFormData) => {
    const scene: WindowScene = {
      ...data,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    }
    await vault.addScene(scene)
    get().loadAll()
  },

  deleteScene: async (id: string) => {
    await vault.deleteScene(id)
    get().loadAll()
  },

  selectRoute: (routeName: string) => {
    const scenes = readScenes()
    set({
      selectedRoute: routeName,
      currentRouteScenes: routeName ? byRoute(scenes, routeName) : [],
    })
  },

  refreshRandom: () => {
    const scenes = readScenes()
    const randomScene =
      scenes.length === 0 ? null : scenes[Math.floor(Math.random() * scenes.length)]
    set({ randomScene })
  },

  clearAll: () => {
    set({
      scenes: [],
      routeNames: [],
      currentRouteScenes: [],
      selectedRoute: '',
      randomScene: null,
    })
  },
}))
