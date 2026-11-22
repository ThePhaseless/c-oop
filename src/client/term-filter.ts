// Text on its way to the terminal comes from a program or from another peer, and xterm obeys what it is
// given: a scroll or repeat with a huge count blocks the page, cursor moves repaint the shared screen.
// Only printable text, \n \r \t \b and SGR (colour) sequences pass; every other control character or
// sequence is dropped. A sequence may be split across chunks, so the filter keeps its place between calls.
const SGR_MAX = 64 // parameter chars of one SGR; clang needs 6, a full true-colour pair 33
const PLAIN = /^[^\x00-\x07\x0b\x0c\x0e-\x1f\x7f-\x9f]*$/
const ESC = 0x1b, BEL = 0x07, LF = 0x0a, CSI = 0x9b, ST = 0x9c
const STRING_INTRO = [0x90, 0x98, 0x9d, 0x9e, 0x9f] // DCS, SOS, OSC, PM, APC; after ESC they are P X ] ^ _

/** One filter per stream of terminal text (a run): returns what may be written of each chunk. */
export function termFilter(): (chunk: string) => string {
  let state: 'text' | 'esc' | 'csi' | 'string' = 'text'
  let sgr: string | null = null // parameters of the CSI being read, null once it cannot be an SGR

  return chunk => {
    if (state === 'text' && PLAIN.test(chunk)) return chunk
    let out = ''
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i)
      const control = c < 0x20 || (c >= 0x7f && c <= 0x9f)
      if (state === 'string') {
        // Ends at BEL or ST; a newline ends it too, so one that is never closed costs a line, not the whole run.
        if (c === ESC) state = 'esc'
        else if (c === BEL || c === ST) state = 'text'
        else if (c === LF) { state = 'text'; out += '\n' }
        continue
      }
      if (state === 'csi' && !control) {
        if (c >= 0x40) { // the final byte
          if (c === 0x6d && sgr !== null) out += `\x1b[${sgr}m`
          state = 'text'
        } else if (sgr !== null) {
          const param = (c >= 0x30 && c <= 0x39) || c === 0x3a || c === 0x3b // digits : ;
          sgr = param && sgr.length < SGR_MAX ? sgr + chunk[i] : null
        }
        continue
      }
      if (state === 'esc' && !control) {
        if (c === 0x5b) { state = 'csi'; sgr = '' }
        else if (c === 0x50 || c === 0x58 || (c >= 0x5d && c <= 0x5f)) state = 'string'
        else if (c > 0x2f) state = 'text' // the final byte of a short escape; intermediates (0x20-0x2f) go on
        continue
      }
      // Plain text, or a control character, which also ends an unfinished sequence.
      state = 'text'
      if (c === ESC) state = 'esc'
      else if (c === CSI) { state = 'csi'; sgr = '' }
      else if (STRING_INTRO.includes(c)) state = 'string'
      else if (!control || c === 0x08 || c === 0x09 || c === LF || c === 0x0d) out += chunk[i]
    }
    return out
  }
}
