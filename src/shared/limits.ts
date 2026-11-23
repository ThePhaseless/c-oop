export const SIGNAL = {
  maxPayload: 16 * 1024,   // bytes per WebSocket message
  maxTopics: 4,            // distinct subscriptions per connection
  maxSubscribers: 64,      // connections per topic
  burstBytes: 2 * 1024 * 1024,          // per connection: byte bucket capacity; a message costs its length + messageCost
  bytesPerSecond: 64 * 1024,            // per connection: byte refill
  messageCost: 256,                     // bytes added to the length of every message, on the connection and the room bucket
  topicBurstBytes: 512 * 1024 * 1024,   // per topic and message type: bucket of bytes sent out, (length + messageCost) * (subscribers - 1) per message
  topicBytesPerSecond: 8 * 1024 * 1024, // per topic and message type: refill
  maxConnections: 2000,
  idleSeconds: 60,
  backpressureBytes: 4 * 1024 * 1024,   // one connection may burst burstBytes; a subscriber on a slow link must survive that
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
export const MESSAGE_MAX = 64 * 1024 * 1024 // bytes of one reassembled data-channel or relay message; a longer one is dropped
export const STUCK_MS = 12_000        // unconnected peer counts as stuck after this
export const CONN_RETRY_MS = 48_000   // destroy a connection that stayed unconnected this long, so y-webrtc announces again; the wait doubles per failed attempt
export const CONN_FORGET_MS = 12_000  // a peer id absent this long is forgotten by the connection watch
export const CONN_RETRY_DOUBLINGS = 3 // CONN_RETRY_MS doubles at most this many times (384 s, 6.4 min)
export const RELAY_FRAME = 11_000     // plaintext bytes per relay frame
export const RELAY_FLUSH_MS = 100     // local changes are batched this long before they go to the relay
export const RELAY_JITTER_MS = 1000   // longest random wait before answering a relay request
export const RELAY_RETRY_MS = 10_000  // follow-up after a relay request
export const RELAY_RESYNC_MS = 5000   // least time between two relay requests of a connection (doubles while requests keep having to wait, up to 8 x this, 40 s), and in a full room between two answers with everyone's presence (80 ms per person in smaller ones)
export const RELAY_AUDIT_MS = 120_000 // mean time between audit requests of one browser
export const RELAY_RENEW_MS = 8000    // on a socket message, the own presence state is renewed when it is older than this
export const RELAY_START_MS = 2000    // the relay starts this long after boot when the stored copy has not loaded
export const RUNNER_GRACE_MS = 5_000  // wait this long for a never-seen runner before showing "runner left"
export const PEER_COLORS = ['#e02636', '#c25110', '#986d08', '#498220', '#0f845d', '#0d7da2', '#376ce9', '#9451e0', '#cc2bac'] as const
export const DEFAULT_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }]
