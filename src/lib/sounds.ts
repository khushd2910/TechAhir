'use client'

/**
 * Zero-asset sound effects synthesized with the Web Audio API.
 * All cues are short, soft-edged envelopes so rapid bidding never clips.
 */

let ctx: AudioContext | null = null
let enabled = true

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

interface ToneSpec {
  freq: number
  freqEnd?: number
  dur: number
  type?: OscillatorType
  gain?: number
  delay?: number
}

function play(tones: ToneSpec[]): void {
  if (!enabled) return
  const ac = getCtx()
  if (!ac) return
  const now = ac.currentTime
  for (const t of tones) {
    const start = now + (t.delay ?? 0)
    const osc = ac.createOscillator()
    const env = ac.createGain()
    osc.type = t.type ?? 'sine'
    osc.frequency.setValueAtTime(t.freq, start)
    if (t.freqEnd) osc.frequency.exponentialRampToValueAtTime(t.freqEnd, start + t.dur)
    env.gain.setValueAtTime(0.0001, start)
    env.gain.exponentialRampToValueAtTime(t.gain ?? 0.12, start + 0.015)
    env.gain.exponentialRampToValueAtTime(0.0001, start + t.dur)
    osc.connect(env).connect(ac.destination)
    osc.start(start)
    osc.stop(start + t.dur + 0.05)
  }
}

export const sounds = {
  get enabled(): boolean {
    return enabled
  },
  init(): void {
    if (typeof window !== 'undefined') {
      enabled = window.localStorage.getItem('ht-sound') !== 'off'
    }
  },
  toggle(): boolean {
    enabled = !enabled
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('ht-sound', enabled ? 'on' : 'off')
    }
    return enabled
  },
  /** Bid accepted — bright two-note chime */
  accept(): void {
    play([
      { freq: 660, dur: 0.12, type: 'triangle', gain: 0.14 },
      { freq: 880, dur: 0.18, type: 'triangle', gain: 0.14, delay: 0.09 },
    ])
  },
  /** Bid rejected — low double buzz */
  reject(): void {
    play([
      { freq: 160, freqEnd: 120, dur: 0.14, type: 'sawtooth', gain: 0.07 },
      { freq: 140, freqEnd: 100, dur: 0.16, type: 'sawtooth', gain: 0.07, delay: 0.12 },
    ])
  },
  /** Someone outbid you — descending warning */
  outbid(): void {
    play([
      { freq: 520, freqEnd: 340, dur: 0.22, type: 'square', gain: 0.05 },
    ])
  },
  /** Anti-snipe extension — rising ping */
  extend(): void {
    play([
      { freq: 440, freqEnd: 760, dur: 0.2, type: 'sine', gain: 0.1 },
    ])
  },
  /** Auction ended — gavel double knock */
  gavel(): void {
    play([
      { freq: 190, freqEnd: 70, dur: 0.1, type: 'triangle', gain: 0.22 },
      { freq: 170, freqEnd: 60, dur: 0.14, type: 'triangle', gain: 0.22, delay: 0.16 },
    ])
  },
  /** UI click — soft tick */
  click(): void {
    play([{ freq: 720, freqEnd: 640, dur: 0.05, type: 'sine', gain: 0.06 }])
  },
}
