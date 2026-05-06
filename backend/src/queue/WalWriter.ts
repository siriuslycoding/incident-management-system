// backend/src/queue/WalWriter.ts
// Signals are appended to a flat file BEFORE entering the in-memory queue.
// On process restart, unprocessed signals are replayed from the WAL.
// This ensures no signal is silently lost during a deploy or crash.

import fs from 'fs'
import readline from 'readline'
import path from 'path'
import { config } from '../config'

export class WalWriter {
  private stream: fs.WriteStream
  private offset = 0

  constructor() {
    const dir = path.dirname(config.walPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    this.stream = fs.createWriteStream(config.walPath, { flags: 'a' })
    // Get current file size as starting offset
    try {
      this.offset = fs.statSync(config.walPath).size
    } catch { this.offset = 0 }
  }

  // Returns the byte offset of this entry (stored in MongoDB for replay)
  append(signal: unknown): number {
    const line = JSON.stringify({ signal, ts: Date.now() }) + '\n'
    const currentOffset = this.offset
    this.stream.write(line)
    this.offset += Buffer.byteLength(line)
    return currentOffset
  }

  // Called on startup: yields signals whose walOffset is not in processedOffsets
  async *replay(processedOffsets: Set<number>): AsyncGenerator<{ signal: unknown, offset: number }> {
    if (!fs.existsSync(config.walPath)) return
    const rl = readline.createInterface({
      input: fs.createReadStream(config.walPath),
      crlfDelay: Infinity
    })
    let offset = 0
    for await (const line of rl) {
      if (line.trim()) {
        if (!processedOffsets.has(offset)) {
          const parsed = JSON.parse(line)
          yield { signal: parsed.signal, offset }
        }
        offset += Buffer.byteLength(line + '\n')
      }
    }
  }

  close() { this.stream.close() }
}
