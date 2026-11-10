import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  preferences: defineTable({
    lookupKey: v.string(),
    keyVersion: v.literal('v1'),
    iv: v.string(),
    ciphertext: v.string(),
  }).index('by_lookup_key', ['lookupKey']),
})
