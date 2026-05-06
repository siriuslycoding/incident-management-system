// backend/src/db/mongo.ts
import mongoose, { Schema, Document } from 'mongoose'

export interface ISignal extends Document {
  workItemId: string | null    // null until debounce resolves
  componentId: string
  componentType: string
  errorCode: string
  payload: Record<string, unknown>
  severity: string
  ts: Date
  processed: boolean
  walOffset: number            // byte offset in WAL file for replay
}

const SignalSchema = new Schema<ISignal>({
  workItemId:    { type: String, default: null, index: true },
  componentId:   { type: String, required: true, index: true },
  componentType: { type: String, required: true },
  errorCode:     { type: String, required: true },
  payload:       { type: Schema.Types.Mixed, required: true },
  severity:      { type: String, required: true },
  ts:            { type: Date, default: Date.now, index: true },
  processed:     { type: Boolean, default: false },
  walOffset:     { type: Number, required: true }
}, {
  timeseries: {   // MongoDB native timeseries collection
    timeField: 'ts',
    metaField: 'componentId',
    granularity: 'seconds'
  }
})

export const Signal = mongoose.model<ISignal>('Signal', SignalSchema)

export async function connectMongo(url: string): Promise<void> {
  await mongoose.connect(url)
  console.info('MongoDB connected')
}

export { mongoose }
