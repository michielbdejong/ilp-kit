'use strict'

module.exports = PeersControllerFactory

const forEach = require('co-foreach')
const Auth = require('../lib/auth')
const Log = require('../lib/log')
const Config = require('../lib/config')
const Connector = require('../lib/connector')
const PeerFactory = require('../models/peer')

const NotFoundError = require('../errors/not-found-error')
const InvalidBodyError = require('../errors/invalid-body-error')

PeersControllerFactory.constitute = [Auth, Config, Log, PeerFactory, Connector]
function PeersControllerFactory(auth, config, log, Peer, connector) {
  log = log('peers')

  return class PeersController {
    static init(router) {
      router.get('/peers', auth.checkAuth, this.checkAdmin, this.getAll)
      router.post('/peers', auth.checkAuth, this.checkAdmin, this.postResource)
      router.get('/peers/:id/settlement_methods', auth.checkAuth, this.checkAdmin, this.getSettlementMethods)
      router.delete('/peers/:id', auth.checkAuth, this.checkAdmin, this.deleteResource)

      // Public
      router.post('/peers/rpc', this.rpc)
      router.get('/peers/:destination', this.getResource)
    }

    // TODO move to auth
    static * checkAdmin(next) {
      if (this.req.user.username === config.data.getIn(['ledger', 'admin', 'user'])) {
        return yield next
      }

      throw new NotFoundError()
    }

    static * getAll() {
      // TODO pagination
      const peers = yield Peer.findAll({
        include: [{ all: true }],
        order: [['created_at', 'DESC']]
      })

      yield forEach(peers, function * (peer) {
        const peerInfo = yield connector.getPeer(peer)

        peer.balance = peerInfo.balance
        peer.online = peerInfo.online
      })

      this.body = peers
    }

    static* getResource() {
      const peer = yield Peer.findOne({ where: { destination: this.params.destination } })

      if (!peer) throw new NotFoundError('Unknown peer')

      this.body = {
        hostname: peer.hostname,
        currency: peer.currency
      }
    }

    static * postResource() {
      const peer = new Peer()

      peer.hostname = this.body.hostname.replace(/.*?:\/\//g, '')
      peer.limit = this.body.limit
      peer.currency = this.body.currency
      peer.destination = parseInt(Math.random() * 1000000)

      const dbPeer = yield peer.save()

      yield connector.connectPeer(dbPeer)

      this.body = dbPeer
    }

    static * putResource() {
      const id = this.params.id
      let peer = yield Peer.findOne({ where: { id } })
      const limit = this.body.limit

      if (!peer) throw new NotFoundError("Peer doesn't exist")
      if (!limit) throw new InvalidBodyError('Limit is not supplied')

      // Update in the db
      peer.limit = limit
      peer = Peer.fromDatabaseModel(yield peer.save())

      // Update the connector
      yield connector.removePeer(peer)
      yield connector.connectPeer(peer)

      const peerInfo = yield connector.getPeer(peer)

      peer.balance = peerInfo.balance
      peer.online = peerInfo.online

      this.body = peer
    }

    static * getSettlementMethods() {
      const id = this.params.id
      const peer = yield Peer.findOne({ where: { id } })

      if (!peer) throw new NotFoundError("Peer doesn't exist")

      this.body = yield connector.getSettlementMethods(peer)
    }

    static * deleteResource() {
      const id = this.params.id
      const peer = yield Peer.findOne({ where: { id } })

      if (!peer) throw new NotFoundError("Peer doesn't exist")

      yield connector.removePeer(peer)

      yield peer.destroy()

      this.body = this.params
    }

    static * rpc() {
      const prefix = this.query.prefix
      const method = this.query.method
      const params = this.body

      if (!prefix) throw new InvalidBodyError('Prefix is not supplied')
      if (!method) throw new InvalidBodyError('Method is not supplied')

      try {
        this.body = yield connector.rpc(prefix, method, params)
      } catch (e) {
        // if rpc error, e.g. server is not ready yet or trustline exceeded
        log.err('connector.rpc() failed: ', e.stack)
      }
    }
  }
}
