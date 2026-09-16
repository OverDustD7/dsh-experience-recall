// Surface visibility: is a message this plugin injected still in the model's
// current context?
//
// SPEC 5.4.1 fixes the judgement here: never trust a boolean flag, because a
// rewind replaces the surface inside the same live session without emitting
// `agent/session-start`, so a session-scoped flag would stay set forever.
// dsh-mnemon reads `agent.session.surface?.nodes` plus `session.eventAt(seq)`
// for exactly this reason.
import { PLUGIN_NAME } from './config.js'


/** Whether any plugin message of ours matching `predicate(messageId)` is live. */
export function messageVisibleInSurface(session, predicate) {
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes) || typeof session?.eventAt !== 'function') return false
  const limit = nodes.length
  for (let index = 0; index < limit; index += 1) {
    const event = session.eventAt(nodes[index])
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== 'plugin' || source.plugin !== PLUGIN_NAME) continue
    if (predicate(event.data?.id) === true) return true
  }
  return false
}
