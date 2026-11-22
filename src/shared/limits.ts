export const SIGNAL = {
  maxPayload: 16 * 1024,   // bytes per WebSocket message
  maxTopics: 4,            // distinct subscriptions per connection
  maxSubscribers: 64,      // connections per topic
  burst: 300,              // token bucket capacity (messages)
  perSecond: 30,           // token refill
  maxConnections: 2000,
  idleSeconds: 60,
  backpressureBytes: 1024 * 1024,
} as const
export const TOPIC_RE = /^[0-9a-f]{32}$/
export const SECRET_RE = /^[A-Za-z0-9_-]{22}$/
export const COLOR_RE = /^#[0-9a-f]{6}$/i
export const NAME_MAX = 24            // chars of a display name
export const CODE_MAX = 1_000_000     // chars of main.cpp; every peer cuts what is beyond
export const LINE_MAX = 4096          // chars of one stdin line
export const OUT_LIMIT = 256_000      // chars of shared terminal text per run
export const OUT_CHUNK = 16_000       // max chars per element of the `out` array
export const OUT_FLUSH_MS = 40        // output batching interval
export const FRAME_MAX = 60_000       // payload bytes per data-channel frame
export const MESSAGE_MAX = 64 * 1024 * 1024 // bytes of one reassembled data-channel message; a longer one is dropped
export const STUCK_MS = 12_000        // unconnected peer counts as stuck after this
export const CONN_RETRY_MS = 48_000   // destroy a connection that stayed unconnected this long, so y-webrtc announces again
export const CONN_FORGET_MS = 12_000  // a peer id absent this long is forgotten by the connection watch
export const RUNNER_GRACE_MS = 5_000  // wait this long for a never-seen runner before showing "runner left"
export const PEER_COLORS = ['#e02636', '#c25110', '#986d08', '#498220', '#0f845d', '#0d7da2', '#376ce9', '#9451e0', '#cc2bac'] as const
export const DEFAULT_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }]
