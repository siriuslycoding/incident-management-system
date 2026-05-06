// backend/src/queue/SignalQueue.ts
import { EventEmitter } from 'events'
import { config } from '../config'

export interface RawSignal {
  componentId: string
  componentType: string
  errorCode: string
  payload: Record<string, unknown>
  severity: string
  walOffset: number
}

export class SignalQueue extends EventEmitter {
  private queue: RawSignal[] = []
  private draining = false

  get size() { return this.queue.length }
  get isFull() { return this.queue.length >= config.queueMaxSize }

  // Returns false if queue is full (caller should return 429)
  push(signal: RawSignal): boolean {
    if (this.isFull) return false
    this.queue.push(signal)
    if (!this.draining) this.emit('drain')
    return true
  }

  shift(): RawSignal | undefined {
    return this.queue.shift()
  }

  setDraining(v: boolean) { this.draining = v }
}

export const signalQueue = new SignalQueue()
