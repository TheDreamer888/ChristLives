import { mutationGeneric as mutation, queryGeneric as query } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { decryptPreference, encryptPreference, getLookupKey } from './encryption'

const product = v.union(
  v.literal('veytrion'),
  v.literal('sentryvora'),
  v.literal('terravoryx'),
  v.literal('petralume'),
)
const locale = v.union(v.literal('pt-PT'), v.literal('en'))

export const get = query({
  args: { product },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new ConvexError('AUTH_REQUIRED')

    const lookupKey = await getLookupKey(identity.tokenIdentifier, args.product)
    const record = await ctx.db
      .query('preferences')
      .withIndex('by_lookup_key', q => q.eq('lookupKey', lookupKey))
      .unique()

    if (!record) return null

    const preference = await decryptPreference(record)
    if (preference.owner !== identity.tokenIdentifier || preference.product !== args.product) {
      throw new ConvexError('PREFERENCES_RECORD_INVALID')
    }

    return { product: preference.product, locale: preference.locale }
  },
})

export const save = mutation({
  args: { product, locale },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new ConvexError('AUTH_REQUIRED')

    const encrypted = await encryptPreference({
      owner: identity.tokenIdentifier,
      product: args.product,
      locale: args.locale,
    })
    const existing = await ctx.db
      .query('preferences')
      .withIndex('by_lookup_key', q => q.eq('lookupKey', encrypted.lookupKey))
      .unique()

    if (existing) {
      await ctx.db.patch(existing._id, encrypted)
      return existing._id
    }

    return ctx.db.insert('preferences', encrypted)
  },
})
