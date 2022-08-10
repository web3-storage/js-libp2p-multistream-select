import { logger } from '@libp2p/logger'
import errCode from 'err-code'
import * as multistream from './multistream.js'
import { handshake } from 'it-handshake'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { Uint8ArrayList } from 'uint8arraylist'
import { pushable } from 'it-pushable'
import merge from 'it-merge'
import { reader } from 'it-reader'
import { PROTOCOL_ID } from './constants.js'
import type { AbortOptions } from '@libp2p/interfaces'
import type { Duplex, Source } from 'it-stream-types'
import type { ProtocolStream } from './index.js'

const log = logger('libp2p:mss:select')

export async function select (stream: Duplex<Uint8Array>, protocols: string | string[], protocolId?: string, options?: AbortOptions) {
  protocols = Array.isArray(protocols) ? [...protocols] : [protocols]
  const { reader, writer, rest, stream: shakeStream } = handshake(stream)

  const protocol = protocols.shift()

  if (protocol == null) {
    throw new Error('At least one protocol must be specified')
  }

  if (protocolId != null) {
    log('select: write ["%s", "%s"]', protocolId, protocol)
    multistream.writeAll(writer, [uint8ArrayFromString(protocolId), uint8ArrayFromString(protocol)])
  } else {
    log('select: write "%s"', protocol)
    multistream.write(writer, uint8ArrayFromString(protocol))
  }

  let response = await multistream.readString(reader, options)
  log('select: read "%s"', response)

  // Read the protocol response if we got the protocolId in return
  if (response === protocolId) {
    response = await multistream.readString(reader, options)
    log('select: read "%s"', response)
  }

  // We're done
  if (response === protocol) {
    rest()
    return { stream: shakeStream, protocol }
  }

  // We haven't gotten a valid ack, try the other protocols
  for (const protocol of protocols) {
    log('select: write "%s"', protocol)
    multistream.write(writer, uint8ArrayFromString(protocol))
    const response = await multistream.readString(reader, options)
    log('select: read "%s" for "%s"', response, protocol)

    if (response === protocol) {
      rest() // End our writer so others can start writing to stream
      return { stream: shakeStream, protocol }
    }
  }

  rest()
  throw errCode(new Error('protocol selection failed'), 'ERR_UNSUPPORTED_PROTOCOL')
}

/**
 * Lazily negotiates a protocol.
 *
 * It *does not* block writes waiting for the other end to respond. Instead, it
 * simply assumes the negotiation went successfully and starts writing data.
 *
 * Use when it is known that the receiver supports the desired protocol.
 */
export function lazySelect (stream: Duplex<Uint8Array>, protocol: string): ProtocolStream {
  // This is a signal to write the multistream headers if the consumer tries to
  // read from the source
  const negotiateTrigger = pushable<Uint8Array>()
  let negotiated = false
  return {
    stream: {
      // eslint-disable-next-line @typescript-eslint/promise-function-async
      sink: source => stream.sink((async function * () {
        let first = true
        const merged = merge(source, negotiateTrigger) as Source<Uint8Array>
        for await (const chunk of merged) {
          if (first) {
            first = false
            negotiated = true
            const p1 = uint8ArrayFromString(PROTOCOL_ID)
            const p2 = uint8ArrayFromString(protocol)
            const list = new Uint8ArrayList(multistream.encode(p1), multistream.encode(p2))
            if (chunk.length > 0) list.append(chunk)
            yield list.slice()
          } else {
            yield chunk
          }
        }
      })()),
      source: (async function * () {
        if (!negotiated) negotiateTrigger.push(new Uint8Array())
        const byteReader = reader(stream.source)
        let response = await multistream.readString(byteReader)
        if (response === PROTOCOL_ID) {
          response = await multistream.readString(byteReader)
        }
        if (response !== protocol) {
          throw errCode(new Error('protocol selection failed'), 'ERR_UNSUPPORTED_PROTOCOL')
        }
        for await (const chunk of byteReader) {
          yield chunk.slice()
        }
      })()
    },
    protocol
  }
}
