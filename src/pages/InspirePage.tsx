import { useEffect, useState, useCallback } from 'react'
import { useSceneStore } from '@/store/useSceneStore'
import {
  WRITING_PROMPTS,
  getWeatherIcon,
  getTreeIcon,
  getPedestrianIcon,
  formatTimestamp,
  getTimeOfDay,
} from '@/utils/sceneHelpers'
import { Lightbulb, RefreshCw, Quote, Bus, ArrowRight } from 'lucide-react'

export default function InspirePage() {
  const { randomScene, refreshRandom, loadAll, scenes } = useSceneStore()
  const [revealed, setRevealed] = useState(false)
  const [displayedPrompt, setDisplayedPrompt] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [isSpinning, setIsSpinning] = useState(false)

  useEffect(() => {
    loadAll()
  }, [loadAll])

  useEffect(() => {
    if (!revealed || !randomScene) return
    const idx = Math.floor(Math.random() * WRITING_PROMPTS.length)
    setDisplayedPrompt('')
    setIsTyping(true)

    const fullText = WRITING_PROMPTS[idx]
    let charIdx = 0
    const timer = setInterval(() => {
      charIdx++
      setDisplayedPrompt(fullText.slice(0, charIdx))
      if (charIdx >= fullText.length) {
        clearInterval(timer)
        setIsTyping(false)
      }
    }, 60)

    return () => clearInterval(timer)
  }, [revealed, randomScene])

  const handlePick = useCallback(() => {
    refreshRandom()
    setRevealed(true)
    setIsSpinning(false)
  }, [refreshRandom])

  const handleRefresh = useCallback(() => {
    setIsSpinning(true)
    setRevealed(false)
    setTimeout(() => {
      refreshRandom()
      setRevealed(true)
      setIsSpinning(false)
    }, 400)
  }, [refreshRandom])

  if (scenes.length === 0) {
    return (
      <div className="min-h-screen bg-teal-950 flex flex-col items-center justify-center px-6 text-center">
        <Bus className="w-16 h-16 text-dusk-400/40 mb-6" />
        <p className="text-mist-100 text-lg font-serif mb-2">还没有窗景记录</p>
        <p className="text-mist-400 text-sm">先去记录一段窗景，才能在这里采集灵感</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-teal-950 flex flex-col items-center px-4 py-8">
      {!revealed ? (
        <div className="flex-1 flex flex-col items-center justify-center">
          <button
            onClick={handlePick}
            className="group relative w-56 h-56 rounded-full bg-dusk-400/15 border-2 border-dusk-400/40
              hover:bg-dusk-400/25 hover:border-dusk-400/60 transition-all duration-500
              flex flex-col items-center justify-center gap-3
              animate-[float_3s_ease-in-out_infinite]
              shadow-[0_0_60px_rgba(212,175,125,0.08)]"
          >
            <div className="absolute inset-3 rounded-full border border-dusk-400/20" />
            <Bus className="w-10 h-10 text-dusk-400 group-hover:scale-110 transition-transform duration-300" />
            <span className="text-mist-100 font-serif text-lg tracking-wide">采一段窗景</span>
            <span className="text-dusk-400/60 text-xs">点击随机采集</span>
          </button>
          <style>{`
            @keyframes float {
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-12px); }
            }
          `}</style>
        </div>
      ) : randomScene ? (
        <div className="w-full max-w-lg flex flex-col items-center gap-6 animate-[fadeUp_0.6s_ease-out]">
          <style>{`
            @keyframes fadeUp {
              from { opacity: 0; transform: translateY(24px); }
              to { opacity: 1; transform: translateY(0); }
            }
            @keyframes spin-once {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
          `}</style>

          <div className="w-full rounded-2xl bg-dusk-400/10 border border-dusk-400/30 p-6 space-y-5">
            <div className="flex items-center justify-between text-sm text-mist-400">
              <div className="flex items-center gap-2">
                <ArrowRight className="w-3.5 h-3.5 text-dusk-400" />
                <span className="text-mist-100 font-medium">{randomScene.routeName}</span>
                <span className="text-mist-500">·</span>
                <span>{randomScene.segment}</span>
              </div>
              <div className="flex items-center gap-2">
                <span>{getTimeOfDay(randomScene.timestamp)}</span>
                <span className="text-mist-500">·</span>
                <span>{formatTimestamp(randomScene.timestamp).split(' ')[1]}</span>
                {getWeatherIcon(randomScene.weather)}
              </div>
            </div>

            <p className="text-mist-100 font-serif text-xl leading-relaxed tracking-wide">
              {randomScene.note}
            </p>

            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-dusk-400/10 text-mist-300 text-xs">
                {getTreeIcon(randomScene.treeDensity)}
                {randomScene.treeDensity}
              </span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-dusk-400/10 text-mist-300 text-xs">
                {getPedestrianIcon(randomScene.pedestrianStatus)}
                {randomScene.pedestrianStatus}
              </span>
              {randomScene.signText && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-dusk-400/10 text-mist-300 text-xs">
                  <Lightbulb className="w-3.5 h-3.5 text-dusk-400" />
                  {randomScene.signText}
                </span>
              )}
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-dusk-400/10 text-mist-300 text-xs">
                <Bus className="w-3.5 h-3.5 text-dusk-400" />
                {randomScene.seatDirection}侧
              </span>
            </div>
          </div>

          <div className="w-full rounded-xl bg-dusk-400/5 border border-dusk-400/15 p-5 flex gap-3">
            <Quote className="w-5 h-5 text-dusk-400/60 flex-shrink-0 mt-0.5" />
            <p className="font-serif italic text-dusk-300 text-base leading-relaxed">
              「{displayedPrompt}
              {isTyping && <span className="animate-pulse text-dusk-400">|</span>}
              」
            </p>
          </div>

          <button
            onClick={handleRefresh}
            className="flex items-center gap-2 px-6 py-3 rounded-full bg-dusk-400/15 border border-dusk-400/30
              hover:bg-dusk-400/25 hover:border-dusk-400/50 transition-all duration-300 text-mist-100"
          >
            <RefreshCw
              className={`w-4 h-4 text-dusk-400 ${isSpinning ? 'animate-[spin-once_0.4s_ease-in-out]' : ''}`}
            />
            <span className="font-serif text-sm">再采一段</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
