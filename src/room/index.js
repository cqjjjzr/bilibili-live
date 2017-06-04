import WebSocket from 'ws'
import EventEmitter from 'events'

import _ from 'lodash'
import DMDecoder from './danmaku/decoder'
import DMEncoder from './danmaku/encoder'
import Util from '../util.js'

const DMPROTOCOL = 'ws'
const SDMPROTOCOL = 'wss'
const DMSERVER = 'broadcastlv.chat.bilibili.com'
const DMPORT = 2244
const SDMPORT = 2245
const DMPATH = 'sub'

const RECONNECT_DELAY = 3000
const HEARTBEAT_DELAY = 30000
const GIFT_END_DELAY = 3000
const FETCH_FANS_DELAY = 5000

export default class RoomService extends EventEmitter {
  constructor (config = {}) {
    super()
    this.info = {
      id: config.roomId || 23058,
      url: config.roomId || 23058
    }
    this.userId = config.userId || this.randUid()
    this.isDireact = config.isDireact || false
    this.useFansService = config.useFansService === false ? false : true
    this.socket = null
    this.isTerminated = false
    this.https = true

    this.heartbeatService = null
    this.fansService = null
    this.reconnectService = null

    this.giftMap = new Map()
    this.fansSet = new Set()
  }

  useHttps (use) {
    if (this.https !== use) {
      this.reconnect()
      this.https = use
    }
    Util.useHttps(use)
  }

  getInfo () {
    return this.info
  }

  getAdmin () {
    return Util.getRoomAdmin(this.info.id)
  }

  init () {
    if (this.isDireact) {
      this.connect()
      return Promise.resolve(this)
    } else {
      return Util.getRoomId(this.info.url).then(room => {
        this.info.id = room.id
        return Util.getRoomInfo(this.info.id)
      }).then(room => {
        this.info.title = room.title
        this.info.anchor = room.anchor
        this.connect()
        return this
      })
    }
  }

  randUid () {
    return 1E15 + Math.floor(2E15 * Math.random())
  }

  connect () {
    if (this.https) {
      this.socket = new WebSocket(`${DMPROTOCOL}://${DMSERVER}:${DMPORT}/${DMPATH}`)
    } else {
      this.socket = new WebSocket(`${DMPROTOCOL}://${DMSERVER}:${DMPORT}/${DMPATH}`)
    }
    this.handleEvents()
    if (this.useFansService) {
      this.fetchFans()
    }
  }

  disconnect () {
    clearTimeout(this.reconnectService)
    clearTimeout(this.heartbeatService)
    clearTimeout(this.fansService)
    this.socket.close()
  }

  reconnect () {
    this.disconnect()
    this.reconnectService = setTimeout(() => {
      this.connect()
    }, RECONNECT_DELAY)
  }

  terminate () {
    this.isTerminated = true
    this.disconnect()
  }

  handleEvents () {
    this.socket.on('open', () => {
      this.sendJoinRoom()
      this.emit('connect')
    })

    this.socket.on('message', (msg) => {
      DMDecoder.decodeData(msg).map(m => {
        if (m.type == 'connected') {
          this.sendHeartbeat()
        } else {
          if (m.type === 'gift') {
            this.packageGift(m)
          }
          this.emit('data', m)
        }
        this.emit(m.type, m)
      })
    })

    this.socket.on('close', (code, reason) => {
      this.emit('close', code, reason)
      if (!this.isTerminated) {
        this.reconnect()
      }
    })

    this.socket.on('error', (err) => {
      this.emit('error', err)
      if (!this.isTerminated) {
        this.reconnect()
      }
    })
  }

  sendJoinRoom () {
    this.socket.send(DMEncoder.encodeJoinRoom(this.info.id, this.userId))
  }

  sendHeartbeat () {
    this.socket.send(DMEncoder.encodeHeartbeat())
    this.heartbeatService = setTimeout(() => {
      this.sendHeartbeat()
    }, HEARTBEAT_DELAY)
  }

  fetchFans () {
    Util.getUserFans(this.info.anchor.id, 1).then(res => {
      let newFans = []
      if (this.fansSet.size) {
        newFans = res.fans.filter((fan) => {
          if (this.fansSet.has(fan.id)) {
            return false
          } else {
            this.fansSet.add(fan.id)
            return true
          }
        })
      } else {
        res.fans.forEach((fan) => {
          this.fansSet.add(fan.id)
        })
      }
      this.fansService = setTimeout(() => {
        this.fetchFans()
      }, FETCH_FANS_DELAY)
      let msg = {
        type: 'fans',
        ts: new Date().getTime(),
        total: res.total,
        newFans: newFans
      }
      this.emit('data', msg)
      this.emit('fans', msg)
    }).catch(res => {
      this.fansService = setTimeout(() => {
        this.fetchFans()
      }, FETCH_FANS_DELAY)
    })
  }

  packageGift (msg) {
    let key = `${msg.user.id}.${msg.gift.id}`
    let sameGiftEvent = this.giftMap.has(key)
    if (sameGiftEvent) {
      let giftEvent = this.giftMap.get(key)
      giftEvent.msg.gift.count = Number(giftEvent.msg.gift.count) + Number(msg.gift.count)
      giftEvent.event()
    } else {
      let giftEvent = {
        msg: _.merge({}, msg),
        event: _.debounce(() => {
          this.emit('giftBundle', giftEvent.msg)
          this.giftMap.delete(key)
        }, GIFT_END_DELAY)
      }
      giftEvent.event()
      this.giftMap.set(key, giftEvent)
    }
  }
}
